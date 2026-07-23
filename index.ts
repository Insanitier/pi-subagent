import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as crypto from "crypto"
import { spawn } from "child_process"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

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

function discoverAgents(): Agent[] {
  const agents: Agent[] = []
  const seen = new Set<string>()
  const userDir = path.join(os.homedir(), ".pi", "agent", "agents")
  const extDir = path.join(os.homedir(), ".pi", "agent", "extensions", "subagent-lite", "agents")

  for (const dir of [extDir, userDir]) {
    if (!fs.existsSync(dir)) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".md")) continue
      const agent = parseAgentFile(path.join(dir, file))
      if (agent && !seen.has(agent.name)) {
        agents.push(agent)
        seen.add(agent.name)
      }
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

function getFinalOutput(output: string): string {
  // Parse JSON mode output to extract final assistant message
  const lines = output.split("\n").filter(l => l.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i])
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const content = event.message.content
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === "text") return part.text
          }
        }
      }
    } catch {
      continue
    }
  }
  return output || "(no output)"
}

async function runSingleAgent(
  agents: Agent[],
  agentName: string,
  task: string,
  cwd: string,
): Promise<{ success: boolean; output: string; error?: string }> {
  const agent = agents.find(a => a.name === agentName)
  if (!agent) {
    const available = agents.map(a => a.name).join(", ") || "none"
    return { success: false, output: "", error: `Unknown agent: "${agentName}". Available: ${available}` }
  }

  const runId = crypto.randomBytes(4).toString("hex")
  const args: string[] = ["--mode", "json", "-p", "--no-session"]

  if (agent.model) args.push("--model", agent.model)
  if (agent.tools?.length) args.push("--tools", agent.tools.join(","))

  // Write prompt to temp file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"))
  const promptFile = path.join(tmpDir, `prompt-${agent.name}.md`)
  fs.writeFileSync(promptFile, agent.prompt)
  args.push("--append-system-prompt", promptFile)

  // Worktree
  let worktreePath: string | undefined
  let actualCwd = cwd

  if (agent.worktree && isGitRepo(cwd)) {
    worktreePath = path.join(cwd, ".worktrees", runId)
    fs.mkdirSync(path.join(cwd, ".worktrees"), { recursive: true })
    try {
      require("child_process").execSync(`git worktree add ${worktreePath} -b subagent-${runId}`, { cwd })
      actualCwd = worktreePath
    } catch (e) {
      // Worktree creation failed, continue without it
      worktreePath = undefined
    }
  }

  return new Promise((resolve) => {
    const proc = spawn("pi", [...args, `Task: ${task}`], {
      cwd: actualCwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    proc.stdout?.on("data", (d) => stdout += d.toString())
    proc.stderr?.on("data", (d) => stderr += d.toString())

    proc.on("close", (code) => {
      // Cleanup
      try { fs.unlinkSync(promptFile) } catch {}
      try { fs.rmdirSync(tmpDir) } catch {}
      if (worktreePath) {
        try { require("child_process").execSync(`git worktree remove ${worktreePath}`, { cwd }) } catch {}
      }

      if (code === 0) {
        resolve({ success: true, output: getFinalOutput(stdout) })
      } else {
        resolve({ success: false, output: getFinalOutput(stdout), error: stderr || `Exit code ${code}` })
      }
    })

    proc.on("error", (err) => {
      try { fs.unlinkSync(promptFile) } catch {}
      try { fs.rmdirSync(tmpDir) } catch {}
      if (worktreePath) {
        try { require("child_process").execSync(`git worktree remove ${worktreePath}`, { cwd }) } catch {}
      }
      resolve({ success: false, output: "", error: err.message })
    })
  })
}

export default function (pi: ExtensionAPI) {
  const agents = discoverAgents()

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate tasks to specialized subagents with isolated context. Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent name for single mode" },
        task: { type: "string", description: "Task for single mode" },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              agent: { type: "string" },
              task: { type: "string" }
            },
            required: ["agent", "task"]
          },
          description: "Array of {agent, task} for parallel execution"
        },
        chain: {
          type: "array",
          items: {
            type: "object",
            properties: {
              agent: { type: "string" },
              task: { type: "string" }
            },
            required: ["agent", "task"]
          },
          description: "Array of {agent, task} for sequential execution with {previous} placeholder"
        }
      }
    },

    async execute(_toolCallId: string, params: any) {
      const hasChain = (params.chain?.length ?? 0) > 0
      const hasTasks = (params.tasks?.length ?? 0) > 0
      const hasSingle = Boolean(params.agent && params.task)
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle)

      if (modeCount !== 1) {
        const available = agents.map(a => `"${a.name}"`).join(", ") || "none"
        return {
          content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode (agent+task, tasks[], or chain[]).\nAvailable agents: ${available}` }],
          isError: true
        }
      }

      // Chain mode
      if (hasChain) {
        let previousOutput = ""
        const results: string[] = []

        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i]
          const task = step.task.replace(/\{previous\}/g, previousOutput)

          const result = await runSingleAgent(agents, step.agent, task, process.cwd())
          results.push(result.output)

          if (!result.success) {
            return {
              content: [{ type: "text", text: `Chain failed at step ${i + 1} (${step.agent}): ${result.error}` }],
              isError: true
            }
          }
          previousOutput = result.output
        }

        return { content: [{ type: "text", text: results[results.length - 1] }] }
      }

      // Parallel mode
      if (hasTasks) {
        const results = await Promise.all(
          params.tasks.map(async (t: any) => {
            const result = await runSingleAgent(agents, t.agent, t.task, process.cwd())
            return { agent: t.agent, ...result }
          })
        )

        const output = results.map((r, i) =>
          `### ${r.agent}\n${r.success ? r.output : `Error: ${r.error}`}`
        ).join("\n\n")

        const hasError = results.some(r => !r.success)
        return { content: [{ type: "text", text: output }], isError: hasError }
      }

      // Single mode
      const result = await runSingleAgent(agents, params.agent, params.task, process.cwd())
      return {
        content: [{ type: "text", text: result.success ? result.output : `Error: ${result.error}` }],
        isError: !result.success
      }
    }
  })

  pi.registerCommand({
    name: "subagent",
    description: "List available agents and sessions",
    execute() {
      const agentList = agents.map(a => `  ${a.name}: ${a.description}`).join("\n")

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