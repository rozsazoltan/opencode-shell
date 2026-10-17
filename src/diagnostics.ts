import { execFile } from "node:child_process"

export type ProbeFailure = "not_found" | "timeout_or_terminated" | "failed"

export function probeFailure(error: { code?: unknown; killed?: boolean }): ProbeFailure {
  return error.code === "ENOENT" ? "not_found" : error.killed ? "timeout_or_terminated" : "failed"
}

export type Outcome = {
  stage: "hook" | "mise" | "rtk"
  result: ProbeFailure | "entered" | "unsupported_shell" | "applied" | "unchanged" | "invalid_environment" | "disabled" | "complex_powershell" | "denied" | "exit_skipped" | "empty_rewrite" | "unsafe_powershell_rewrite"
  code?: number
}

export type Observe = (outcome: Outcome) => void

export function observe(observer: Observe | undefined, outcome: Outcome): void {
  try { observer?.(outcome) } catch { /* Diagnostics must never affect execution. */ }
}

export function versionProbe(file: "mise" | "rtk", cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const env = { ...process.env, MISE_AUTO_INSTALL: "0", MISE_EXEC_AUTO_INSTALL: "0", MISE_YES: "0" }
    try {
      execFile(file, ["--version"], { cwd, env, timeout: 2000, maxBuffer: 4096, windowsHide: true }, (error, stdout) => {
        if (error) {
          resolve(probeFailure(error))
          return
        }
        // Accept only the numeric version, never arbitrary executable output.
        const version = stdout.startsWith(`${file} `) ? stdout.slice(file.length + 1) : stdout
        const match = version.match(/^(\d{1,8}\.\d{1,8}\.\d{1,8})(?:\s|$)/)
        resolve(match ? `available ${match[1]}` : "available_version_unrecognized")
      })
    } catch { resolve("failed") }
  })
}
