import { execFile } from "node:child_process"
import { managedEnvironment, type Environment } from "./environment"

const TTL = 60_000
const MAX_ENTRIES = 128
const MAX_OUTPUT = 256 * 1024
const MAX_TOOLS = 64

export type InventoryResult = { status: "available"; tools: string[] } | { status: "unavailable" }
type CacheEntry = { created: number; expires: number; tools: string[] }

export function parseInventory(output: string): string[] {
  const parsed: unknown = JSON.parse(output)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid inventory")
  const tools: string[] = []
  for (const [name, records] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:@+/-]{0,79}$/.test(name) || !Array.isArray(records)) continue
    for (const record of records) {
      if (!record || typeof record !== "object" || (record as { installed?: unknown }).installed !== true || (record as { active?: unknown }).active !== true) continue
      const version = (record as { version?: unknown }).version
      if (typeof version === "string" && /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,79}$/.test(version)) tools.push(`${name}@${version}`)
    }
  }
  return [...new Set(tools)].sort().slice(0, MAX_TOOLS)
}

export function formatInventory(result: InventoryResult): string {
  const tools = result.status === "available" && result.tools.length
    ? result.tools.join(", ")
    : result.status === "available" ? "none reported" : "unavailable; check through normal commands"
  return `Current selected installed mise tools at plugin location: ${tools}. Inventory is evidence of selected installed tool versions, not proof of executable names or aliases. Check existing commands and aliases first (for example, python versus python3; npm/npx may be available through node, but mappings are not guaranteed). Prefer mise for approved installs. Never auto-install, auto-approve, or blindly rewrite aliases. Inventory refreshes per context request after 60 seconds; cache is instance-local and does not survive service restart. Other plugins may run context hooks in any order, and model compliance is not guaranteed.`
}

function run(mise: string, cwd: string, env: Environment): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      execFile(mise, ["ls", "-c", "-i", "-J"], { cwd, env, timeout: 2000, maxBuffer: MAX_OUTPUT, windowsHide: true }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      })
    } catch (error) { reject(error) }
  })
}

export class InventoryCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly pending = new Map<string, Promise<InventoryResult>>()

  inspect(cwd: string): { status: "empty" | "fresh" | "stale"; tools?: string[]; ageMs?: number } {
    const entry = this.entries.get(cwd)
    if (!entry) return { status: "empty" }
    return { status: entry.expires > Date.now() ? "fresh" : "stale", tools: [...entry.tools], ageMs: Math.max(0, Date.now() - entry.created) }
  }

  async get(cwd: string, inherited: Environment): Promise<InventoryResult> {
    const cached = this.entries.get(cwd)
    if (cached && cached.expires > Date.now()) return { status: "available", tools: [...cached.tools] }
    const existing = this.pending.get(cwd)
    if (existing) return existing
    const refresh = this.refresh(cwd, inherited).finally(() => this.pending.delete(cwd))
    this.pending.set(cwd, refresh)
    return refresh
  }

  private async refresh(cwd: string, inherited: Environment): Promise<InventoryResult> {
    try {
      const managed = await managedEnvironment(cwd, inherited)
      if (managed.status !== "applied") throw new Error("mise unavailable")
      const tools = parseInventory(await run(managed.mise, cwd, managed.env))
      this.entries.delete(cwd)
      const created = Date.now()
      this.entries.set(cwd, { created, expires: created + TTL, tools })
      while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!)
      return { status: "available", tools: [...tools] }
    } catch {
      this.entries.delete(cwd)
      return { status: "unavailable" }
    }
  }
}
