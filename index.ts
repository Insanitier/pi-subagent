import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as crypto from "crypto"
import { spawn } from "child_process"

interface Agent {
  name: string
  description: string
  model?: string
  tools?: string[]
  toolsBlacklist?: string[]
  skills?: string[]
  worktree?: boolean
  prompt: string
}

function parseAgentFile(filePath: string): Agent | null {
  const content = fs.readFileSync(filePath, "utf-8")
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!frontmatterMatch) return null

  const [, yamlStr, prompt] = frontmatterMatch
  const agent: Agent = { name: "", description: "", prompt: prompt.trim() }

  for (const line of yamlStr.split("\n")) {
    const match = line.match(/^(\w+):\s*(.*)$/)
    if (!match) continue

    const [, key, value] = match
    switch (key) {
      case "name": agent.name = value.trim(); break
      case "description": agent.description = value.trim(); break
      case "model": agent.model = value.trim(); break
      case "tools": agent.tools = value.split(",").map(t => t.trim()).filter(Boolean); break
      case "toolsBlacklist": agent.toolsBlacklist = value.split(",").map(t => t.trim()).filter(Boolean); break
      case "skills": agent.skills = value.split(",").map(s => s.trim()).filter(Boolean); break
      case "worktree": agent.worktree = value.trim() === "true"; break
    }
  }

  return agent.name && agent.description ? agent : null
}

function discoverAgents(): Map<string, Agent> {
  const agents = new Map<string, Agent>()
  const userDir = path.join(os.homedir(), ".pi", "agent", "agents")
  const extDir = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent-lite", "agents")

  for (const dir of [userDir, extDir]) {
    if (!fs.existsSync(dir)) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".md")) continue
      const agent = parseAgentFile(path.join(dir, file))
      if (agent) agents.set(agent.name, agent)
    }
  }

  return agents
}

const SESSIONS_FILE = path.join(os.homedir(), ".pi", "agent", "subagent-sessions.json")

function loadSessions(): Record<string, any> {
  if (!fs.existsSync(SESSIONS_FILE)) return {}
  return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"))
}

function saveSessions(sessions: Record<string, any>) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2))
}

function isGitRepo(cwd: string): boolean {
  try {
    require("child_process").execSync("git rev-parse --git-dir", { cwd, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

async function runSubagent(options: any, agents: Map<string, Agent>): Promise<any> {
  const agentDef = agents.get(options.agent)
  if (!agentDef) return { success: false, output: "", error: `Agent "${options.agent}" not found` }

  const runId = crypto.randomBytes(4).toString("hex")
  const cwd = process.cwd()

  const model = options.model || agentDef.model
  const tools = options.tools || agentDef.tools?.join(",")
  const worktree = options.worktree ?? agentDef.worktree ?? false

  const args: string[] = ["--mode", "json"]
  if (model) args.push("--model", model)
  if (tools) args.push("--tools", tools)

  // Session
  if (options.session) {
    const sessions = loadSessions()
    if (sessions[options.session]) {
      args.push("--resume", sessions[options.session].sessionFile)
    } else {
      args.push("-p")
    }
  } else {
    args.push("-p", "--no-session")
  }

  // Prompt
  const promptFile = path.join(os.tmpdir(), `subagent-prompt-${runId}.md`)
  fs.writeFileSync(promptFile, agentDef.prompt)
  args.push("--append-system-prompt", promptFile)

  // Worktree
  let worktreePath: string | undefined
  let actualCwd = cwd

  if (worktree && isGitRepo(cwd)) {
    const branchName = `subagent-${runId}`
    worktreePath = path.join(cwd, ".worktrees", runId)
    fs.mkdirSync(path.join(cwd, ".worktrees"), { recursive: true })
    require("child_process").execSync(`git worktree add ${worktreePath} -b ${branchName}`, { cwd })
    actualCwd = worktreePath
  }

  return new Promise((resolve) => {
    const proc = spawn("pi", [...args, options.task], {
      cwd: actualCwd,
      detached: options.background,
      stdio: ["pipe", "pipe", "pipe"]
    })

    let stdout = ""
    let stderr = ""

    proc.stdout?.on("data", (d) => stdout += d.toString())
    proc.stderr?.on("data", (d) => stderr += d.toString())

    proc.on("close", (code) => {
      fs.unlinkSync(promptFile)
      if (worktreePath) {
        try { require("child_process").execSync(`git worktree remove ${worktreePath}`, { cwd }) } catch {}
      }
      resolve({ success: code === 0, output: stdout, error: code !== 0 ? stderr : undefined })
    })

    proc.on("error", (err) => {
      fs.unlinkSync(promptFile)
      if (worktreePath) {
        try { require("child_process").execSync(`git worktree remove ${worktreePath}`, { cwd }) } catch {}
      }
      resolve({ success: false, output: "", error: err.message })
    })
  })
}

// Main extension registration
export default function register(api: any) {
  const agents = discoverAgents()

  api.registerTool({
    name: "subagent",
    description: "Execute tasks using subagents. Supports single, parallel, and chain modes.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent name for single mode" },
        task: { type: "string", description: "Task for single mode" },
        tasks: { type: "array", description: "Tasks for parallel mode" },
        chain: { type: "array", description: "Steps for chain mode. Use {previous} to reference previous output." },
        model: { type: "string", description: "Override model" },
        tools: { type: "string", description: "Override tools whitelist" },
        toolsBlacklist: { type: "string", description: "Override tools blacklist" },
        skills: { type: "string", description: "Override skills whitelist" },
        session: { type: "string", description: "Persistent session name" },
        background: { type: "boolean", description: "Run in background" },
        initialContext: { type: "string", enum: ["empty", "parent"] },
        worktree: { type: "boolean", description: "Force enable/disable worktree" }
      }
    },
    async execute(params: any) {
      // Single mode
      if (params.agent && params.task) {
        return await runSubagent({
          agent: params.agent,
          task: params.task,
          model: params.model,
          tools: params.tools,
          toolsBlacklist: params.toolsBlacklist,
          skills: params.skills,
          session: params.session,
          background: params.background,
          initialContext: params.initialContext,
          worktree: params.worktree
        }, agents)
      }

      // Parallel mode
      if (params.tasks) {
        const results = await Promise.all(
          params.tasks.map((t: any) => runSubagent({
            ...t,
            model: t.model || params.model,
            tools: t.tools || params.tools,
            worktree: t.worktree ?? params.worktree
          }, agents))
        )
        return { results }
      }

      // Chain mode
      if (params.chain) {
        let prev = ""
        const chainResults = []
        for (const step of params.chain) {
          const task = step.task.replace(/\{previous\}/g, prev)
          const result = await runSubagent({
            ...step,
            task,
            model: step.model || params.model,
            tools: step.tools || params.tools,
            worktree: step.worktree ?? params.worktree
          }, agents)
          chainResults.push(result)
          if (!result.success) return { error: `Chain failed: ${step.agent}`, chainResults }
          prev = result.output
        }
        return { chainResults, finalOutput: prev }
      }

      return { error: "Provide agent+task, tasks[], or chain[]" }
    }
  })

  api.registerCommand({
    name: "subagent",
    description: "List available agents and sessions",
    execute() {
      const agentList = Array.from(agents.entries())
        .map(([name, a]) => `  ${name}: ${a.description}`)
        .join("\n")

      const sessions = loadSessions()
      const sessionList = Object.entries(sessions)
        .map(([name, s]: [string, any]) => `  ${name}: ${s.agent} (${s.taskCount} tasks)`)
        .join("\n")

      return [
        "Available Agents:",
        agentList || "  (none)",
        "",
        "Persistent Sessions:",
        sessionList || "  (none)"
      ].join("\n")
    }
  })
}