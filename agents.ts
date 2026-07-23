import * as fs from "fs"
import * as path from "path"

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

  // Parse YAML frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!frontmatterMatch) return null

  const [, yamlStr, prompt] = frontmatterMatch
  const agent: Agent = { name: "", description: "", prompt: prompt.trim() }

  // Simple YAML parsing (no dependency)
  for (const line of yamlStr.split("\n")) {
    const match = line.match(/^(\w+):\s*(.*)$/)
    if (!match) continue

    const [, key, value] = match
    switch (key) {
      case "name":
        agent.name = value.trim()
        break
      case "description":
        agent.description = value.trim()
        break
      case "model":
        agent.model = value.trim()
        break
      case "tools":
        agent.tools = value.split(",").map(t => t.trim()).filter(Boolean)
        break
      case "toolsBlacklist":
        agent.toolsBlacklist = value.split(",").map(t => t.trim()).filter(Boolean)
        break
      case "skills":
        agent.skills = value.split(",").map(s => s.trim()).filter(Boolean)
        break
      case "worktree":
        agent.worktree = value.trim() === "true"
        break
    }
  }

  if (!agent.name || !agent.description) return null
  return agent
}

function discoverAgents(): Map<string, Agent> {
  const agents = new Map<string, Agent>()

  // User-level agents (~/.pi/agent/agents/*.md)
  const userDir = path.join(process.env.HOME || "~", ".pi", "agent", "agents")
  if (fs.existsSync(userDir)) {
    for (const file of fs.readdirSync(userDir)) {
      if (!file.endsWith(".md")) continue
      const agent = parseAgentFile(path.join(userDir, file))
      if (agent) agents.set(agent.name, agent)
    }
  }

  // Project-level agents (.pi/agents/*.md) - skipped for simplicity
  // Can be added later with agentScope config

  return agents
}

export function getAgentRegistry(): Map<string, Agent> {
  return discoverAgents()
}

export type { Agent }