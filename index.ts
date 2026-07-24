import { execFileSync, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Type } from "@sinclair/typebox"
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"

/**
 * Persistent sessions are opt-in per agent. Code-agent worktrees are temporary:
 * changed worktrees are committed to a branch and then removed.
 */

type Agent = {
  name: string
  description: string
  model?: string
  thinking?: string
  tools?: string[]
  toolsBlacklist?: string[]
  skills?: string[]
  persistent: boolean
  worktree: boolean
  prompt: string
  source: "user" | "project"
}

type Task = {
  agent: string
  task: string
  session?: string
  initialContext?: string
}

type NativeSession = {
  id: string
  name?: string
  cwd: string
  created: Date
  modified: Date
  messageCount: number
  firstMessage: string
}

type SessionPanelItem = {
  session: NativeSession
  agent: string
  handle: string
  active: boolean
}

type Run = {
  id: string
  label: string
  startedAt: number
  background: boolean
}

type RunResult = {
  agent: string
  output: string
  stderr: string
  exitCode: number
  aborted: boolean
  worktree?: string
  branch?: string
}

type WorkflowResult = {
  output: string
  failed: boolean
  results: RunResult[]
}

const runningPersistentSessions = new Set<string>()

const TaskSchema = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate" }),
  session: Type.Optional(Type.String({ description: "Persistent session name (only for agents configured as persistent)" })),
  initialContext: Type.Optional(Type.String({ description: '"empty" (default) or "parent"' })),
})

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Agent name for a single task" })),
  task: Type.Optional(Type.String({ description: "Task for a single agent" })),
  session: Type.Optional(Type.String({ description: "Persistent session name (only for agents configured as persistent)" })),
  initialContext: Type.Optional(Type.String({ description: '"empty" (default) or "parent"' })),
  background: Type.Optional(Type.Boolean({ description: "Run without blocking; completion is sent back to parent session" })),
  tasks: Type.Optional(Type.Array(TaskSchema, { description: "Tasks to run in parallel" })),
  chain: Type.Optional(Type.Array(TaskSchema, { description: "Tasks to run in order; {previous} contains prior output" })),
})

function splitList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const values = value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    return values.length > 0 ? values : undefined
  }
  if (typeof value !== "string") return undefined
  const values = value.split(",").map((entry) => entry.trim()).filter(Boolean)
  return values.length > 0 ? values : undefined
}

function parseAgent(filePath: string, source: Agent["source"]): Agent | undefined {
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(filePath, "utf8"))
  if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return undefined

  const tools = splitList(frontmatter.tools)
  const toolsBlacklist = splitList(frontmatter.toolsBlacklist)
  if (tools && toolsBlacklist) {
    throw new Error(`${filePath}: tools and toolsBlacklist are mutually exclusive`)
  }

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
    thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
    tools,
    toolsBlacklist,
    skills: splitList(frontmatter.skills),
    persistent: frontmatter.persistent === true || frontmatter.persistent === "true",
    worktree: frontmatter.worktree === true || frontmatter.worktree === "true",
    prompt: body.trim(),
    source,
  }
}

function nearestDir(cwd: string, parts: string[]): string | undefined {
  let current = path.resolve(cwd)
  while (true) {
    const candidate = path.join(current, ...parts)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function loadAgentsFrom(dir: string | undefined, source: Agent["source"], into: Map<string, Agent>): void {
  if (!dir || !fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const agent = parseAgent(path.join(dir, entry.name), source)
    if (agent) into.set(agent.name, agent)
  }
}

function discoverAgents(ctx: ExtensionContext): Agent[] {
  const agents = new Map<string, Agent>()
  // (bundled skipped — no agents/ directory)
  loadAgentsFrom(path.join(getAgentDir(), "agents"), "user", agents)
  if (ctx.isProjectTrusted()) loadAgentsFrom(nearestDir(ctx.cwd, [CONFIG_DIR_NAME, "agents"]), "project", agents)
  return [...agents.values()]
}

function namedSessionId(cwd: string, agent: string, handle: string): string {
  return `subagent.${createHash("sha256").update(JSON.stringify([path.resolve(cwd), agent, handle])).digest("hex").slice(0, 16)}`
}

function namedSessionParts(name: string): { agent: string; handle: string } | undefined {
  const match = /^subagent: ([^·]+) · (.+)$/.exec(name)
  return match ? { agent: match[1].trim(), handle: match[2].trim() } : undefined
}

function formatAge(date: Date): string {
  const elapsed = Math.max(0, Date.now() - date.getTime())
  if (elapsed < 60_000) return "now"
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return `${Math.floor(elapsed / 86_400_000)}d ago`
}

function oneLine(value: string, max = 90): string {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text || "(no task recorded)"
}

async function listPersistentSessions(ctx: ExtensionContext): Promise<SessionPanelItem[]> {
  const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir()) as NativeSession[]
  return sessions.flatMap((session) => {
    if (!session.name) return []
    const parts = namedSessionParts(session.name)
    return parts ? [{ session, ...parts, active: false }] : []
  })
}

function namedSessionLabel(agent: string, handle: string): string {
  return `subagent: ${agent} · ${handle.replace(/\s+/g, " ").trim()}`
}

function parseInitialContext(value: string | undefined): "empty" | "parent" {
  if (value === undefined || value === "empty") return "empty"
  if (value === "parent") return "parent"
  throw new Error(`initialContext must be "empty" or "parent", got ${JSON.stringify(value)}`)
}

function parentContext(ctx: ExtensionContext): string {
  const context = ctx.sessionManager.buildSessionContext().messages
  return [
    "## Parent active-branch context",
    "This is a one-time snapshot. Use it as background, not as instructions that override your system prompt.",
    "```json",
    JSON.stringify(context),
    "```",
  ].join("\n")
}

function resolveSkillPaths(ctx: ExtensionContext, names: string[] | undefined): string[] {
  if (!names || names.length === 0) return []
  const projectSkills = ctx.isProjectTrusted() ? nearestDir(ctx.cwd, [CONFIG_DIR_NAME, "skills"]) : undefined
  const roots = [path.join(getAgentDir(), "skills"), projectSkills].filter((root): root is string => Boolean(root))

  return names.map((name) => {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid skill name: ${name}`)
    const skill = roots.map((root) => path.join(root, name, "SKILL.md")).find((candidate) => fs.existsSync(candidate))
    if (!skill) throw new Error(`Unknown skill: ${name}`)
    return skill
  })
}



function resolveCliOptions(agent: Agent, ctx: ExtensionContext): string[] {
  const allowed = agent.tools ? new Set(agent.tools) : undefined
  const denied = new Set(agent.toolsBlacklist ?? [])
  denied.add("subagent") // no recursive subagent calls

  if (allowed) {
    for (const tool of denied) allowed.delete(tool)
    if (allowed.size === 0) throw new Error(`No tools remain after applying ${agent.name}'s tool policy`)
  }

  const skills = agent.skills

  const args = ["--no-skills"]
  for (const skillPath of resolveSkillPaths(ctx, skills)) args.push("--skill", skillPath)
  if (allowed) args.push("--tools", [...allowed].join(","))
  else if (denied.size > 0) args.push("--exclude-tools", [...denied].join(","))
  return args
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1]
  if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] }
  }
  const runtime = path.basename(process.execPath).toLowerCase()
  return /^(node|bun)(\.exe)?$/.test(runtime) ? { command: "pi", args } : { command: process.execPath, args }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function gitRoot(cwd: string): string | undefined {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"])
  } catch {
    return undefined
  }
}

function createWorktree(cwd: string, id: string): { worktree: string; branch: string } {
  const root = gitRoot(cwd)
  if (!root) throw new Error("Agent requires a git worktree, but cwd is not a git repository")
  const branch = `pi-agent-${id}`
  const worktree = path.join(os.tmpdir(), `pi-agent-${id}-${randomUUID().slice(0, 8)}`)
  try {
    git(root, ["worktree", "add", "--detach", worktree, "HEAD"])
  } catch (error) {
    throw new Error(`Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { worktree, branch }
}

function removeWorktree(root: string, worktree: string): void {
  try {
    git(root, ["worktree", "remove", "--force", worktree])
  } catch {
    try {
      git(root, ["worktree", "prune"])
    } catch {
      // Best-effort recovery only; preserve the child result.
    }
  }
}

function cleanupWorktree(root: string, worktree: string, branch: string, description: string): string | undefined {
  if (!fs.existsSync(worktree)) return undefined
  try {
    if (!git(worktree, ["status", "--porcelain"])) return undefined
    git(worktree, ["add", "-A"])
    git(worktree, ["commit", "-m", `pi-agent: ${description.slice(0, 200)}`])
    let savedBranch = branch
    try {
      git(worktree, ["branch", savedBranch])
    } catch {
      savedBranch = `${branch}-${Date.now()}`
      git(worktree, ["branch", savedBranch])
    }
    return savedBranch
  } catch {
    return undefined
  } finally {
    removeWorktree(root, worktree)
  }
}

function outputText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined
  const candidate = message as { role?: unknown; content?: unknown }
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return undefined
  return candidate.content.filter((part): part is { type: string; text: string } => Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")).map((part) => part.text).join("\n") || undefined
}

function trimOutput(value: string): string {
  const result = truncateHead(value, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES })
  if (!result.truncated) return result.content
  return `${result.content}\n\n[Output truncated. Child output exceeded ${DEFAULT_MAX_BYTES} bytes or ${DEFAULT_MAX_LINES} lines.]`
}

function runChild(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((output: string) => void) | undefined,
): Promise<Omit<RunResult, "agent" | "worktree" | "branch">> {
  return new Promise((resolve, reject) => {
    const invocation = getPiInvocation(args)
    const process = spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] })
    let stdoutBuffer = ""
    let stderr = ""
    let finalOutput = ""
    let aborted = false
    let settled = false

    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", abort)
      callback()
    }
    const processLine = (line: string) => {
      if (!line.trim()) return
      let event: { type?: unknown; message?: unknown }
      try {
        event = JSON.parse(line)
      } catch {
        return
      }
      if (event.type !== "message_end") return
      const text = outputText(event.message)
      if (!text) return
      finalOutput = text
      onUpdate?.(trimOutput(finalOutput))
    }
    const abort = () => {
      aborted = true
      process.kill("SIGTERM")
    }

    process.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString()
      const lines = stdoutBuffer.split("\n")
      stdoutBuffer = lines.pop() ?? ""
      for (const line of lines) processLine(line)
    })
    process.stderr.on("data", (chunk) => { stderr += chunk.toString() })
    process.on("error", (error) => finish(() => reject(error)))
    process.on("close", (code) => {
      if (stdoutBuffer.trim()) processLine(stdoutBuffer)
      finish(() => resolve({ output: finalOutput || "(no output)", stderr, exitCode: code ?? 1, aborted }))
    })
    if (signal?.aborted) abort()
    else signal?.addEventListener("abort", abort, { once: true })
  })
}

function temporaryPrompt(agent: Agent, context: "empty" | "parent", ctx: ExtensionContext): { file: string; remove: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"))
  const file = path.join(dir, "prompt.md")
  const prompt = context === "parent" ? `${agent.prompt}\n\n${parentContext(ctx)}` : agent.prompt
  fs.writeFileSync(file, prompt, { mode: 0o600 })
  return {
    file,
    remove: () => {
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && !["default", "none", "temporary", "*"].includes(value) ? value : undefined
}

function taskFromTopLevel(params: Record<string, unknown>): Task {
  return {
    agent: params.agent as string,
    task: params.task as string,
    session: optionalString(params.session),
    initialContext: optionalString(params.initialContext),
  }
}

function nonEmptyTaskList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

function assertValidRequest(params: Record<string, unknown>): void {
  const modes = [
    Boolean(params.agent && params.task),
    nonEmptyTaskList(params.tasks),
    nonEmptyTaskList(params.chain),
  ].filter(Boolean).length
  if (modes !== 1) throw new Error("Provide exactly one mode: agent + task, tasks, or chain")
  if (params.background === true && !params.agent) {
    throw new Error("background is only supported for a single agent + task")
  }
  if ((nonEmptyTaskList(params.tasks) || nonEmptyTaskList(params.chain)) && (optionalString(params.session) || optionalString(params.initialContext))) {
    throw new Error("Put session and initialContext on each parallel or chain task")
  }
}

function workflowRunLabel(params: Record<string, unknown>): string {
  const mode = nonEmptyTaskList(params.tasks) ? "parallel" : nonEmptyTaskList(params.chain) ? "sequential" : undefined
  if (!mode) return String(params.agent)

  const entries = (mode === "parallel" ? params.tasks : params.chain) as unknown[]
  const agents = entries
    .map((entry) => typeof entry === "object" && entry !== null ? (entry as { agent?: unknown }).agent : undefined)
    .filter((agent): agent is string => typeof agent === "string")
  const counts = new Map<string, number>()
  for (const agent of agents) counts.set(agent, (counts.get(agent) ?? 0) + 1)
  const profiles = [...counts].map(([agent, count]) => count === 1 ? agent : `${agent} × ${count}`).join(", ")
  return `${entries.length} ${mode} task${entries.length === 1 ? "" : "s"}${profiles ? ` · ${profiles}` : ""}`
}

function assertSubagentSelfCheck(): void {
  if (namedSessionId("/tmp/project", "research", "paper-a") === namedSessionId("/tmp/project", "research", "paper-b")) {
    throw new Error("Named session IDs must be distinct")
  }
  try {
    assertValidRequest({ agent: "research" })
    throw new Error("Invalid request was accepted")
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("exactly one mode")) throw error
  }
}

assertSubagentSelfCheck()

export default function (pi: ExtensionAPI) {
  const activeRuns = new Map<string, Run>()
  let hostAcceptsCallbacks = true
  let statusTimer: ReturnType<typeof setInterval> | undefined
  let latestContext: ExtensionContext | undefined

  const renderRuns = () => {
    const ctx = latestContext
    if (!ctx?.hasUI || !hostAcceptsCallbacks) return
    if (activeRuns.size === 0) {
      ctx.ui.setWidget("subagent-runs", undefined)
      ctx.ui.setStatus("subagent-runs", undefined)
      return
    }
    const lines = [...activeRuns.values()].slice(0, 3).map((run) =>
      ctx.ui.theme.fg("dim", `subagent · ${run.label} · ${run.background ? "background" : "running"} · ${Math.floor((Date.now() - run.startedAt) / 1000)}s`),
    )
    if (activeRuns.size > lines.length) lines.push(ctx.ui.theme.fg("dim", `+${activeRuns.size - lines.length} more`))
    ctx.ui.setWidget("subagent-runs", lines, { placement: "aboveEditor" })
    ctx.ui.setStatus("subagent-runs", ctx.ui.theme.fg("dim", `${activeRuns.size} subagent${activeRuns.size === 1 ? "" : "s"} running`))
  }

  const startRun = (label: string, background: boolean) => {
    const run = { id: randomUUID(), label, background, startedAt: Date.now() }
    activeRuns.set(run.id, run)
    if (!statusTimer && latestContext?.hasUI) statusTimer = setInterval(renderRuns, 1_000)
    renderRuns()
    return run
  }

  const finishRun = (run: Run) => {
    activeRuns.delete(run.id)
    if (activeRuns.size === 0 && statusTimer) {
      clearInterval(statusTimer)
      statusTimer = undefined
    }
    renderRuns()
  }

  const runTask = async (task: Task, ctx: ExtensionContext, signal?: AbortSignal, onUpdate?: (output: string) => void): Promise<RunResult> => {
    const agents = discoverAgents(ctx)
    const agent = agents.find((candidate) => candidate.name === task.agent)
    if (!agent) throw new Error(`Unknown agent: ${task.agent}. Available: ${agents.map((candidate) => candidate.name).join(", ") || "none"}`)
    if (!task.task?.trim()) throw new Error(`Task for ${agent.name} cannot be empty`)

    const initialContext = parseInitialContext(task.initialContext)
    let namedSession: NamedSession | undefined
    let persistentLock: string | undefined
    let cwd = ctx.cwd
    let worktree: string | undefined
    let branch: string | undefined

    if (task.session !== undefined) {
      if (!agent.persistent) throw new Error(`Agent ${agent.name} does not support persistent sessions`)
      const handle = task.session.trim()
      if (!handle) throw new Error("session cannot be empty")
      const id = namedSessionId(ctx.cwd, agent.name, handle)
      if (runningPersistentSessions.has(id)) throw new Error(`Persistent session already running: ${agent.name}/${handle}`)
      runningPersistentSessions.add(id)
      persistentLock = id
      try {
        const sessionDir = ctx.sessionManager.getSessionDir()
        const existing = await SessionManager.list(ctx.cwd, sessionDir)
        namedSession = {
          id,
          name: namedSessionLabel(agent.name, handle),
          created: !existing.some((candidate) => candidate.id === id),
        }
      } catch (error) {
        runningPersistentSessions.delete(id)
        throw error
      }
    } else if (agent.worktree) {
      const created = createWorktree(ctx.cwd, randomUUID())
      cwd = created.worktree
      worktree = created.worktree
      branch = created.branch
    }

    const prompt = temporaryPrompt(agent, namedSession?.created ? initialContext : task.session ? "empty" : initialContext, ctx)
    let child: Omit<RunResult, "agent" | "worktree" | "branch"> | undefined
    let savedBranch: string | undefined
    try {
      const args = ["--mode", "json", "-p", ...resolveCliOptions(agent, ctx)]
      if (agent.model) args.push("--model", agent.model)
      if (agent.thinking) args.push("--thinking", agent.thinking)
      if (namedSession) {
        args.push("--session-dir", ctx.sessionManager.getSessionDir(), "--session-id", namedSession.id)
        if (namedSession.created) args.push("--name", namedSession.name)
      } else {
        args.push("--no-session")
      }
      if (prompt.file) args.push("--append-system-prompt", prompt.file)
      args.push(`Task: ${task.task}`)
      child = await runChild(args, cwd, signal, onUpdate)
    } finally {
      prompt.remove()
      if (worktree && branch) {
        const root = gitRoot(ctx.cwd)
        if (root) savedBranch = cleanupWorktree(root, worktree, branch, task.task)
      }
      if (persistentLock) runningPersistentSessions.delete(persistentLock)
    }
    if (!child) throw new Error("Subagent exited without a result")
    const output = savedBranch
      ? `${child.output}\n\n---\nChanges saved to branch \`${savedBranch}\`. Merge with: \`git merge ${savedBranch}\``
      : child.output
    return { agent: agent.name, ...child, output, branch: savedBranch }
  }

  const runWorkflow = async (params: Record<string, unknown>, ctx: ExtensionContext, signal?: AbortSignal, onUpdate?: (output: string) => void): Promise<WorkflowResult> => {
    assertValidRequest(params)

    const tasks = nonEmptyTaskList(params.tasks) ? params.tasks as Task[] : undefined
    const chain = nonEmptyTaskList(params.chain) ? params.chain as Task[] : undefined
    const single = Boolean(params.agent && params.task)

    if (single) {
      const result = await runTask(taskFromTopLevel(params), ctx, signal, onUpdate)
      const failed = result.exitCode !== 0 || result.aborted
      return { output: failed ? result.stderr || result.output || `Exit code ${result.exitCode}` : result.output, failed, results: [result] }
    }

    if (tasks?.length) {
      const results = await Promise.all(tasks.map((task) => runTask(task, ctx, signal, onUpdate)))
      const failed = results.some((result) => result.exitCode !== 0 || result.aborted)
      const output = results.map((result) => {
        const body = result.exitCode === 0 && !result.aborted ? result.output : result.stderr || result.output || `Exit code ${result.exitCode}`
        return `### ${result.agent}\n\n${body}`
      }).join("\n\n---\n\n")
      return { output, failed, results }
    }

    const results: RunResult[] = []
    let previous = ""
    for (const step of chain ?? []) {
      const result = await runTask({ ...step, task: step.task.replace(/\{previous\}/g, previous) }, ctx, signal, onUpdate)
      results.push(result)
      if (result.exitCode !== 0 || result.aborted) {
        return { output: `Chain failed at ${result.agent}: ${result.stderr || result.output || `Exit code ${result.exitCode}`}`, failed: true, results }
      }
      previous = result.output
    }
    return { output: previous || "(no output)", failed: false, results }
  }

  const describeSubagents = async (ctx: ExtensionContext): Promise<string> => {
    const agents = discoverAgents(ctx)
    let sessions: SessionPanelItem[] = []
    let sessionError: string | undefined
    try {
      sessions = await listPersistentSessions(ctx)
    } catch (error) {
      sessionError = error instanceof Error ? error.message : String(error)
    }
    const agentLines = agents.length > 0
      ? agents.map((agent) => `- ${agent.name}: ${agent.description}${agent.persistent ? " (persistent sessions)" : ""}${agent.worktree ? " (temporary isolated worktree)" : ""}`).join("\n")
      : "- (none discovered)"
    const sessionLines = sessionError
      ? `- unavailable: ${sessionError}`
      : sessions
          .map((session) => `- ${session.agent}/${session.handle} (${session.session.messageCount} messages; last used ${session.session.modified.toISOString()})`)
          .join("\n") || "- (none)"

    return [
      "## Available subagents",
      agentLines,
      "\nPersistent sessions for this project:\n" + sessionLines,
    ].join("\n\n")
  }

  pi.on("before_agent_start", async (event, ctx) => ({
    systemPrompt: `${event.systemPrompt}\n\n${await describeSubagents(ctx)}`,
  }))

  pi.on("session_start", (_event, ctx) => {
    latestContext = ctx
    hostAcceptsCallbacks = true
  })
  pi.on("session_shutdown", () => {
    hostAcceptsCallbacks = false
    if (statusTimer) clearInterval(statusTimer)
    statusTimer = undefined
  })

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Launch a specialized subagent for complex, multi-step work.\n\nWhen to use: task matches an available agent type, independent work can run in parallel, or answering requires inspecting several files. For a single-fact lookup where you already know file, symbol, or value, inspect it directly. Once you delegate an investigation, do not repeat that same investigation yourself; wait for its result.\n\nAvailable agents are listed in system context. Each agent's model, tools, skills, persistence, and worktree behavior come from its Markdown profile.\n\nUse exactly one mode:\n- agent + task: single subagent.\n- tasks: multiple independent tasks concurrently. Results return together.\n- chain: sequential steps; {previous} is replaced with prior step output.\n\nFor independent concurrent work, prefer tasks so all tasks start together and results return together. Use separate calls only when later work depends on an earlier result.\n\ninitialContext defaults to \"empty\"; use \"parent\" only to pass a one-time snapshot of parent active-branch context. session creates or resumes a named persistent session only for an agent configured as persistent. background runs one agent + task asynchronously and returns its result in a follow-up message.\n\nDo NOT fabricate or predict a pending agent's result. The result is evidence for you to assess, not a user-facing response by itself.",
    parameters: SubagentParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      latestContext = ctx
      const background = params.background === true
      const label = workflowRunLabel(params as Record<string, unknown>)
      const run = startRun(label, background)
      const update = background ? undefined : (output: string) => onUpdate?.({ content: [{ type: "text", text: output }], details: {} })
      const work = runWorkflow(params as Record<string, unknown>, ctx, background ? undefined : signal, update)

      if (background) {
        void work.then((result) => {
          finishRun(run)
          if (!hostAcceptsCallbacks) return
          const status = result.failed ? "failed" : "completed"
          pi.sendMessage({
            customType: "subagent",
            content: `[subagent ${status}]\nrun: ${run.id}\nagent: ${label}\n\n${trimOutput(result.output)}`,
            display: true,
            details: { runId: run.id, status, results: result.results.map((item) => ({ agent: item.agent, worktree: item.worktree, branch: item.branch })) },
          }, { deliverAs: "followUp", triggerTurn: true })
        }).catch((error) => {
          finishRun(run)
          if (!hostAcceptsCallbacks) return
          pi.sendMessage({
            customType: "subagent",
            content: `[subagent failed]\nrun: ${run.id}\nagent: ${label}\n\n${error instanceof Error ? error.message : String(error)}`,
            display: true,
            details: { runId: run.id, status: "failed" },
          }, { deliverAs: "followUp", triggerTurn: true })
        })
        return { content: [{ type: "text", text: `Started background subagent ${run.id}: ${label}` }], details: { runId: run.id } }
      }

      try {
        const result = await work
        if (result.failed) throw new Error(result.output)
        return {
          content: [{ type: "text", text: trimOutput(result.output) }],
          details: { results: result.results.map((item) => ({ agent: item.agent, worktree: item.worktree, branch: item.branch })) },
        }
      } finally {
        finishRun(run)
      }
    },
  })

  pi.registerCommand("subagent", {
    description: "Inspect persistent subagent sessions and active runs",
    handler: async (_args, ctx) => {
      latestContext = ctx
      const sessions = await listPersistentSessions(ctx)
      for (const session of sessions) session.active = runningPersistentSessions.has(session.session.id)
      const running = [...activeRuns.values()]
      const title = running.length > 0
        ? `Subagent sessions (${running.length} active run${running.length === 1 ? "" : "s"})`
        : "Subagent sessions"

      if (sessions.length === 0) {
        if (ctx.hasUI) await ctx.ui.select(title, ["No persistent subagent sessions in this project."])
        return
      }

      const labels = new Map<string, SessionPanelItem>()
      for (const item of sessions) {
        const state = item.active ? "running" : "idle"
        const label = `${item.active ? "●" : "○"} ${item.agent}/${item.handle} · ${state} · ${item.session.messageCount} messages · ${formatAge(item.session.modified)}`
        labels.set(label, item)
      }
      if (!ctx.hasUI) return
      const selected = await ctx.ui.select(title, [...labels.keys()])
      const item = selected ? labels.get(selected) : undefined
      if (!item) return

      const worktree = worktreeDetails(ctx.cwd, item.session.id)
      const details = [
        `${item.agent}/${item.handle}`,
        `State: ${item.active ? "running" : "idle"}`,
        `Messages: ${item.session.messageCount}`,
        `Created: ${item.session.created.toISOString()}`,
        `Last active: ${item.session.modified.toISOString()} (${formatAge(item.session.modified)})`,
        `Session ID: ${item.session.id}`,
        `First task: ${oneLine(item.session.firstMessage)}`,
      ]
      await ctx.ui.select("Subagent details", details)
    },
  })
}