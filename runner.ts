import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as crypto from "crypto"
import { execSync, spawn, ChildProcess } from "child_process"

interface RunOptions {
  agent: string
  task: string
  model?: string
  tools?: string
  toolsBlacklist?: string
  skills?: string
  session?: string
  background?: boolean
  initialContext?: "empty" | "parent"
  worktree?: boolean
}

interface RunResult {
  success: boolean
  output: string
  error?: string
  sessionFile?: string
  worktreePath?: string
}

// Global session storage
const SESSIONS_FILE = path.join(os.homedir(), ".pi", "agent", "subagent-sessions.json")

interface SessionInfo {
  sessionFile: string
  agent: string
  createdAt: string
  lastUsedAt: string
  taskCount: number
}

function loadSessions(): Record<string, SessionInfo> {
  if (!fs.existsSync(SESSIONS_FILE)) return {}
  return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"))
}

function saveSessions(sessions: Record<string, SessionInfo>) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2))
}

function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --git-dir", { cwd, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function createWorktree(cwd: string, runId: string): string {
  const branchName = `subagent-${runId}`
  const worktreePath = path.join(cwd, ".worktrees", runId)

  fs.mkdirSync(path.join(cwd, ".worktrees"), { recursive: true })
  execSync(`git worktree add ${worktreePath} -b ${branchName}`, { cwd })
  return worktreePath
}

function removeWorktree(cwd: string, runId: string, worktreePath: string) {
  try {
    execSync(`git worktree remove ${worktreePath}`, { cwd })
    // Clean up branch
    execSync(`git branch -D subagent-${runId}`, { cwd })
  } catch (e) {
    // Ignore cleanup errors
  }
}

export async function runSubagent(options: RunOptions, agents: Map<any, any>): Promise<RunResult> {
  const agentDef = agents.get(options.agent)
  if (!agentDef) {
    return { success: false, output: "", error: `Agent "${options.agent}" not found` }
  }

  const runId = crypto.randomBytes(4).toString("hex")
  const cwd = process.cwd()

  // Resolve options (agent defaults → call overrides)
  const model = options.model || agentDef.model
  const tools = options.tools || agentDef.tools?.join(",")
  const toolsBlacklist = options.toolsBlacklist || agentDef.toolsBlacklist?.join(",")
  const skills = options.skills || agentDef.skills?.join(",")
  const useWorktree = options.worktree ?? agentDef.worktree ?? false

  // Build pi args
  const args: string[] = ["--mode", "json"]

  if (model) {
    args.push("--model", model)
  }

  // Tool filtering
  if (tools) {
    args.push("--tools", tools)
  }
  // Note: toolsBlacklist needs custom handling in prompt or tool filtering logic

  // Skills filtering
  if (skills) {
    args.push("--skills", skills)
  }

  // Session handling
  let sessionFile: string | undefined
  if (options.session) {
    const sessions = loadSessions()
    const existing = sessions[options.session]

    if (existing) {
      sessionFile = existing.sessionFile
      existing.lastUsedAt = new Date().toISOString()
      existing.taskCount++
      saveSessions(sessions)
      args.push("--resume", sessionFile)
    } else {
      // First time - will create session
      args.push("-p")
    }
  } else {
    args.push("-p", "--no-session")
  }

  // Initial context
  if (options.initialContext === "parent") {
    // TODO: Get parent context and append to prompt
    // For now, skip this feature
  }

  // Write prompt to temp file
  const promptFile = path.join(os.tmpdir(), `subagent-prompt-${runId}.md`)
  fs.writeFileSync(promptFile, agentDef.prompt)

  args.push("--append-system-prompt", promptFile)

  // Worktree setup
  let worktreePath: string | undefined
  let actualCwd = cwd

  if (useWorktree && isGitRepo(cwd)) {
    worktreePath = createWorktree(cwd, runId)
    actualCwd = worktreePath
  }

  // Spawn pi process
  const result = await new Promise<RunResult>((resolve) => {
    const proc = spawn("pi", [...args, options.task], {
      cwd: actualCwd,
      detached: options.background,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_SUBAGENT: "1",
      }
    })

    let stdout = ""
    let stderr = ""

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString()
    })

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on("close", (code: number | null) => {
      // Cleanup
      fs.unlinkSync(promptFile)

      if (worktreePath) {
        removeWorktree(cwd, runId, worktreePath)
      }

      if (code === 0) {
        resolve({
          success: true,
          output: stdout,
          sessionFile: options.session ? getSessionFile(options.session) : undefined,
          worktreePath
        })
      } else {
        resolve({
          success: false,
          output: stdout,
          error: stderr || `Process exited with code ${code}`,
          sessionFile: options.session ? getSessionFile(options.session) : undefined,
          worktreePath
        })
      }
    })

    proc.on("error", (err: Error) => {
      fs.unlinkSync(promptFile)
      if (worktreePath) {
        removeWorktree(cwd, runId, worktreePath)
      }
      resolve({ success: false, output: "", error: err.message })
    })
  })

  // Save session if needed
  if (options.session && !loadSessions()[options.session]) {
    const sessions = loadSessions()
    sessions[options.session] = {
      sessionFile: getSessionFile(options.session),
      agent: options.agent,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      taskCount: 1
    }
    saveSessions(sessions)
  }

  return result
}

function getSessionFile(sessionName: string): string {
  const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions")
  fs.mkdirSync(sessionsDir, { recursive: true })
  return path.join(sessionsDir, `${sessionName}.jsonl`)
}

export { RunOptions, RunResult }