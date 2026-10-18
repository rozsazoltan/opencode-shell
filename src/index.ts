import { execFile } from "node:child_process"
import { Plugin } from "@opencode/plugin"
import type { ShellCreateBefore } from "@opencode/plugin/promise/shell"
import type { Context } from "@opencode/plugin/promise/plugin"
import { hookSummary, observe, probeFailure, versionProbe, type Observe, type Outcome, type ProbeFailure } from "./diagnostics"
import manifest from "../package.json"
import { managedEnvironment, type Environment } from "./environment"

type ProbeResult<T> = { status: "ok"; value: T } | { status: ProbeFailure }

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

export async function augment(event: ShellCreateBefore, observer?: Observe): Promise<void> {
  const report = (outcome: Outcome) => observe(observer, outcome)
  report({ stage: "hook", result: "entered" })
  const kind = dialect(event.shell)
  if (!kind) { report({ stage: "hook", result: "unsupported_shell" }); return }

  const managed = await managedEnvironment(event.cwd, event.env)
  report({ stage: "mise", result: managed.status })
  event.env = managed.env

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
  await ctx.session.hook("context", async (event) => {
    event.system.push({
      type: "text",
      text: "When a patch application fails because expected lines do not match, reread the current affected file region before editing. Build a fresh, narrow patch from that content; do not repeat the unchanged failed patch or guess a replacement location. Preserve unrelated changes and normal permission checks.",
    })
  })
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
  const report = async (): Promise<string> => {
    const snapshot = last.slice()
    const managed = await managedEnvironment(ctx.location.directory, process.env)
    const [mise, rtk] = await Promise.all([versionProbe("mise", ctx.location.directory, managed.env, managed.mise), versionProbe("rtk", ctx.location.directory, managed.env)])
    return [
      `${id} ${manifest.version}; OpenCode ${ctx.app.version}`,
      `Debug logging: ${debug ? "enabled" : "disabled"}; shell hook: registered`,
      "Diagnostic environment: cwd-specific mise env applied to the OpenCode server environment at the plugin location; not the actual shell event environment.",
      `mise environment: ${managed.status}; mise: ${mise}; rtk: ${rtk}`,
      hookSummary(snapshot),
      "Diagnostic location and shell-event cwd or inherited environment may differ. The last hook is instance-wide, not session-specific.",
      "Command execution and RTK gain/tracking: not_measured. A successful rewrite only changes the command before host permission checks; it does not prove execution or tracking.",
      `Last completed hook (sanitized, instance-local; no environment retained): ${snapshot.length ? JSON.stringify(snapshot) : "not_observed"}`,
    ].join("\n")
  }
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "opencode_shell_diagnostics",
      description: "Bounded cwd-specific mise environment resolution (trusted config may run hooks), mise/RTK version probes and sanitized last-hook diagnostics; no arguments, commands, paths or environment values are returned",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { permission: "opencode_shell_diagnostics" },
      async execute() { return { content: await report() } },
    })
    editor.add({
      name: "opencode_shell_info",
      description: "Return the loaded opencode-shell plugin identity and runtime versions without probing executables or exposing environment data",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { permission: "opencode_shell_info" },
      async execute() {
        return { content: [`Plugin: ${id}`, `Plugin version: ${manifest.version}`, `OpenCode version: ${ctx.app.version}`].join("\n") }
      },
    })
  })
  await ctx.command.transform((editor) => {
    editor.add({
      name: "opencode-shell-diagnostics",
      description: "Ask the agent to invoke managed-environment mise/RTK diagnostics (trusted mise config may run hooks)",
      async execute({ sessionID, delivery }) {
        await ctx.session.prompt({ sessionID, delivery, text: "Invoke the `opencode_shell_diagnostics` tool and display its full report unchanged. Then briefly conclude from the report whether mise environment loading and RTK availability/rewriting work, explicitly distinguishing observed results from unmeasured command execution and RTK gain/tracking. Do not perform any additional investigation." })
      },
    })
  })
}

export default Plugin.define({
  id: "opencode-shell",
  setup,
})
