import { execFile } from "node:child_process"
import { Plugin } from "@opencode/plugin"
import type { ShellCreateBefore } from "@opencode/plugin/promise/shell"
import type { Context } from "@opencode/plugin/promise/plugin"
import { observe, probeFailure, versionProbe, type Observe, type Outcome, type ProbeFailure } from "./diagnostics"
import manifest from "../package.json"

type Environment = Record<string, string | undefined>
type ProbeResult<T> = { status: "ok"; value: T } | { status: ProbeFailure }

// Environment resolution may execute hooks in already trusted mise config.
function capture(file: string, args: string[], cwd: string, env: Environment, input?: string, fallback?: string): Promise<ProbeResult<string>> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, env, timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error && "code" in error && error.code === "ENOENT" && fallback) {
        resolve(capture(fallback, args, cwd, env, input))
        return
      }
      resolve(error ? { status: probeFailure(error) } : { status: "ok", value: stdout })
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(input)
  })
}

function rewrite(command: string, cwd: string, env: Environment): Promise<ProbeResult<{ code: number; stdout: string }>> {
  return new Promise((resolve) => {
    execFile("rtk", ["rewrite", command], { cwd, env, timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      const code = error && "code" in error && typeof error.code === "number" ? error.code : error ? undefined : 0
      resolve(code === undefined ? { status: error ? probeFailure(error) : "failed" } : { status: "ok", value: { code, stdout } })
    })
  })
}

function dialect(shell: string): "posix" | "powershell" | undefined {
  const name = shell.split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.exe$/, "")
  if (name === "pwsh" || name === "powershell") return "powershell"
  if (name === "bash" || name === "zsh" || name === "sh" || name === "dash") return "posix"
}

function environment(output: string | undefined): Environment | undefined {
  if (!output) return
  try {
    const value: unknown = JSON.parse(output)
    if (!value || typeof value !== "object" || Array.isArray(value)) return
    if (Object.values(value).some((entry) => typeof entry !== "string")) return
    return value as Environment
  } catch {
    return
  }
}

export async function augment(event: ShellCreateBefore, observer?: Observe): Promise<void> {
  const report = (outcome: Outcome) => observe(observer, outcome)
  report({ stage: "hook", result: "entered" })
  const kind = dialect(event.shell)
  if (!kind) { report({ stage: "hook", result: "unsupported_shell" }); return }

  const probeEnv = { ...event.env, MISE_AUTO_INSTALL: "0", MISE_EXEC_AUTO_INSTALL: "0", MISE_YES: "0" }
  // The documented JSON interface needs no child runtime. It reports additions
  // and overrides, not removals; inherited variables must therefore be retained.
  const probe = await capture("mise", ["env", "--json"], event.cwd, probeEnv)
  const managed = probe.status === "ok" ? environment(probe.value) : undefined
  report({ stage: "mise", result: probe.status !== "ok" ? probe.status : managed ? "applied" : "invalid_environment" })
  if (managed) {
    // Keep auto-install disabled for lazy mise shims in the executed command.
    managed.MISE_AUTO_INSTALL = "0"
    managed.MISE_EXEC_AUTO_INSTALL = "0"
    // Do not propagate the probe's trust-confirmation setting.
    delete managed.MISE_YES
    event.env = { ...event.env, ...managed }
  }

  if (event.env.RTK_DISABLED === "1") { report({ stage: "rtk", result: "disabled" }); return }

  // RTK's parser is POSIX-oriented. Only unambiguous bare native commands are
  // eligible in PowerShell; expressions, quoting and control flow stay intact.
  const simplePowerShellCommand = /^[A-Za-z][A-Za-z0-9_.-]*(?: +[A-Za-z0-9_./:=,@%+-]+)* *$/
  if (kind === "powershell" && !simplePowerShellCommand.test(event.command)) { report({ stage: "rtk", result: "complex_powershell" }); return }

  const rewritten = await rewrite(event.command, event.cwd, event.env)
  if (rewritten.status !== "ok") { report({ stage: "rtk", result: rewritten.status }); return }
  const result = rewritten.value
  if (result.code === 2) { report({ stage: "rtk", result: "denied", code: 2 }); throw new Error("RTK denied this command") }
  if (result.code !== 0 && result.code !== 3) { report({ stage: "rtk", result: "exit_skipped", code: result.code }); return }

  const command = result.stdout.trimEnd()
  if (!command) { report({ stage: "rtk", result: "empty_rewrite", code: result.code }); return }
  // RTK output remains subject to the host's normal shell permission check.
  // Restrict PowerShell rewrites to the same simple bare-command form.
  if (kind === "powershell" && !simplePowerShellCommand.test(command)) { report({ stage: "rtk", result: "unsafe_powershell_rewrite", code: result.code }); return }
  const unchanged = command === event.command
  event.command = command
  report({ stage: "rtk", result: unchanged ? "unchanged" : "applied", code: result.code })
}

export async function setup(ctx: Context, id = "opencode-shell"): Promise<void> {
  const debug = ctx.options.debug === true
  let last: Outcome[] = []
  const log = (record: object) => {
    if (debug) {
      try { console.info(JSON.stringify({ plugin: id, version: manifest.version, ...record })) } catch { /* Best effort only. */ }
    }
  }
  await ctx.shell.hook("create.before", async (event) => {
    const outcomes: Outcome[] = []
    try {
      await augment(event, (outcome) => { outcomes.push(outcome); log(outcome) })
    } finally { last = outcomes }
  })
  log({ stage: "setup", result: "hook_registered", opencodeVersion: ctx.app.version })
  await ctx.command.transform((editor) => {
    editor.add({
      name: "opencode-shell-diagnostics",
      description: "Read-only server baseline mise/RTK diagnostics without commands, paths or environment values",
      async execute({ sessionID, delivery }) {
        const snapshot = last.slice()
        const [mise, rtk] = await Promise.all([versionProbe("mise", ctx.location.directory), versionProbe("rtk", ctx.location.directory)])
        await ctx.session.synthetic({ sessionID, delivery, resume: false, text: [
          `${id} ${manifest.version}; OpenCode ${ctx.app.version}`,
          `Debug logging: ${debug ? "enabled" : "disabled"}; shell hook: registered`,
          "Baseline: OpenCode server process environment at the plugin location, not the actual shell event environment. No mise env probe is run here.",
          `mise: ${mise}; rtk: ${rtk}`,
          `Last completed hook (sanitized, instance-local; no environment retained): ${snapshot.length ? JSON.stringify(snapshot) : "not_observed"}`,
        ].join("\n") })
      },
    })
  })
}

export default Plugin.define({
  id: "opencode-shell",
  setup,
})
