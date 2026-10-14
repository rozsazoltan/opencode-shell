import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import type { ShellCreateBefore } from "@opencode/plugin/promise/shell"

type Environment = Record<string, string | undefined>

// Environment resolution may execute hooks in already trusted mise config.
function capture(file: string, args: string[], cwd: string, env: Environment, input?: string, fallback?: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, env, timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error && "code" in error && error.code === "ENOENT" && fallback) {
        resolve(capture(fallback, args, cwd, env, input))
        return
      }
      resolve(error ? undefined : stdout)
    })
    child.stdin?.on("error", () => {})
    child.stdin?.end(input)
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

export async function augment(event: ShellCreateBefore): Promise<void> {
  const kind = dialect(event.shell)
  if (!kind) return

  const probeEnv = { ...event.env, MISE_AUTO_INSTALL: "0", MISE_EXEC_AUTO_INSTALL: "0", MISE_YES: "0" }
  // The documented JSON interface needs no child runtime. It reports additions
  // and overrides, not removals; inherited variables must therefore be retained.
  const managed = environment(await capture("mise", ["env", "--json"], event.cwd, probeEnv))
  if (managed) {
    // Keep auto-install disabled for lazy mise shims in the executed command.
    managed.MISE_AUTO_INSTALL = "0"
    managed.MISE_EXEC_AUTO_INSTALL = "0"
    // Do not propagate the probe's trust-confirmation setting.
    delete managed.MISE_YES
    event.env = { ...event.env, ...managed }
  }

  // Direct snip invocations are already filtered, including our PowerShell form.
  if (/^\s*(?:&\s+)?(?:"(?:[^"\r\n]*[\\/])?snip(?:\.exe)?"|'(?:[^'\r\n]|'')*snip(?:\.exe)?'|(?:[^\s"']*[\\/])?snip(?:\.exe)?)\s+run\s+--(?:\s|$)/i.test(event.command)) return

  // snip's parser is POSIX-oriented. Only unambiguous bare native commands are
  // eligible in PowerShell; expressions, quoting and control flow stay intact.
  if (kind === "powershell" && !/^[A-Za-z][A-Za-z0-9_.-]*(?: +[A-Za-z0-9_./:=,@%+-]+)* *$/.test(event.command)) return
  // Desktop-started servers may omit ~/bin from PATH; try it only when snip is not found.
  const output = await capture("snip", ["hook"], event.cwd, event.env, JSON.stringify({ tool_name: "Bash", tool_input: { command: event.command } }), join(homedir(), "bin", process.platform === "win32" ? "snip.exe" : "snip"))
  if (!output) return
  try {
    const command: unknown = JSON.parse(output).hookSpecificOutput?.updatedInput?.command
    if (typeof command !== "string" || !command) return
    if (kind === "posix") event.command = command
    else {
      // Accept only the documented simple snip invocation, never arbitrary
      // POSIX rewrites. Single quotes prevent PowerShell path interpolation.
      const match = /^"([^"\r\n]+)" run -- (.+)$/.exec(command)
      if (match && match[2] === event.command) {
        event.command = `& '${match[1].replaceAll("'", "''")}' run -- ${match[2]}`
      }
    }
  } catch {
    // Missing/old snip or malformed output leaves the command unchanged.
  }
}

export default Plugin.define({
  id: "opencode-shell",
  async setup(ctx) {
    await ctx.shell.hook("create.before", augment)
  },
})
