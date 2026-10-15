import { execFile } from "node:child_process"
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

function rewrite(command: string, cwd: string, env: Environment): Promise<{ code: number; stdout: string } | undefined> {
  return new Promise((resolve) => {
    execFile("rtk", ["rewrite", command], { cwd, env, timeout: 2000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      const code = error && "code" in error && typeof error.code === "number" ? error.code : error ? undefined : 0
      resolve(code === undefined ? undefined : { code, stdout })
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

  if (event.env.RTK_DISABLED === "1") return

  // RTK's parser is POSIX-oriented. Only unambiguous bare native commands are
  // eligible in PowerShell; expressions, quoting and control flow stay intact.
  const simplePowerShellCommand = /^[A-Za-z][A-Za-z0-9_.-]*(?: +[A-Za-z0-9_./:=,@%+-]+)* *$/
  if (kind === "powershell" && !simplePowerShellCommand.test(event.command)) return

  const result = await rewrite(event.command, event.cwd, event.env)
  if (!result) return
  if (result.code === 2) throw new Error("RTK denied this command")
  if (result.code !== 0 && result.code !== 3) return

  const command = result.stdout.trimEnd()
  if (!command) return
  // RTK output remains subject to the host's normal shell permission check.
  // Restrict PowerShell rewrites to the same simple bare-command form.
  if (kind === "powershell" && !simplePowerShellCommand.test(command)) return
  event.command = command
}

export default Plugin.define({
  id: "opencode-shell",
  async setup(ctx) {
    await ctx.shell.hook("create.before", augment)
  },
})
