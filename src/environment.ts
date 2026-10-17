import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { probeFailure, type ProbeFailure } from "./diagnostics"

export type Environment = Record<string, string | undefined>

// Windows environment names are case-insensitive; never leave Path and PATH
// competing for Node's case-insensitive child-process lookup.
export function mergeEnvironment(base: Environment, additions: Environment, windows = process.platform === "win32"): Environment {
  const result: Environment = {}
  for (const [key, value] of [...Object.entries(base), ...Object.entries(additions)]) {
    if (windows) for (const existing of Object.keys(result)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete result[existing]
    }
    result[key] = value
  }
  return result
}

export async function managedEnvironment(cwd: string, inherited: Environment): Promise<{
  env: Environment; mise: string; status: ProbeFailure | "applied" | "invalid_environment"
}> {
  const probeEnv = mergeEnvironment(inherited, { MISE_AUTO_INSTALL: "0", MISE_EXEC_AUTO_INSTALL: "0", MISE_YES: "0" })
  const capture = (file: string): Promise<{ output: string } | { failure: ProbeFailure }> => new Promise((resolve) => {
    try {
      const child = execFile(file, ["env", "--json"], { cwd, env: probeEnv, timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
        resolve(error ? { failure: probeFailure(error) } : { output: stdout })
      })
      child.stdin?.on("error", () => {})
      child.stdin?.end()
    } catch { resolve({ failure: "failed" }) }
  })
  let mise = "mise"
  let result = await capture(mise)
  // The official Unix installer uses this one fixed location. Windows package
  // managers have no single documented install path; use PATH there.
  if ("failure" in result && result.failure === "not_found" && process.platform !== "win32") {
    const candidate = join(homedir(), ".local", "bin", "mise")
    try {
      await access(candidate, constants.X_OK)
      mise = candidate
      result = await capture(mise)
    } catch { /* Optional installation absent. */ }
  }
  if ("failure" in result) return { env: mergeEnvironment(inherited, {}), mise, status: result.failure }
  try {
    const value: unknown = JSON.parse(result.output)
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((entry) => typeof entry !== "string")) throw new Error()
    const managed = value as Environment
    for (const key of Object.keys(managed)) if (key.toUpperCase() === "MISE_YES") delete managed[key]
    return { env: mergeEnvironment(mergeEnvironment(inherited, managed), { MISE_AUTO_INSTALL: "0", MISE_EXEC_AUTO_INSTALL: "0" }), mise, status: "applied" }
  } catch { return { env: mergeEnvironment(inherited, {}), mise, status: "invalid_environment" } }
}
