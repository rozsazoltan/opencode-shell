import { execFile } from "node:child_process"
import { managedEnvironment, type Environment } from "./environment"

const TTL = 60_000
const MAX_ENTRIES = 128
const MAX_OUTPUT = 256 * 1024
const MAX_TOOLS = 64

export type InventoryResult = { status: "available"; tools: string[] } | { status: "unavailable" }
type CacheEntry = { expires: number; tools: string[] }

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
      this.entries.set(cwd, { expires: Date.now() + TTL, tools })
      while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!)
      return { status: "available", tools: [...tools] }
    } catch {
      this.entries.delete(cwd)
      return { status: "unavailable" }
    }
  }
}
