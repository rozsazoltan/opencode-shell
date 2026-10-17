import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ShellCreateBefore } from "@opencode/plugin/promise/shell"

const calls = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock("node:child_process", () => ({ execFile: calls.run }))
import plugin, { augment } from "./index"
import devPlugin from "./dev/index"
import { versionProbe } from "./diagnostics"

function event(command = "git status", shell = "/bin/bash"): ShellCreateBefore {
  return { command, shell, cwd: "/project", env: { PATH: "/external", KEEP: "yes" }, timeout: 10000 }
}

function outputs(mise?: string, rtk?: { code?: number; stdout?: string; error?: Error }) {
  calls.run.mockImplementation((file, _args, _options, callback) => {
    if (file === "mise") {
      callback(mise === undefined ? new Error("unavailable") : null, mise ?? "")
    } else {
      const error = rtk?.error ?? (rtk?.code === 0 ? null : rtk?.code === undefined ? Object.assign(new Error("unavailable"), { code: "ENOENT" }) : Object.assign(new Error("RTK exited"), { code: rtk.code }))
      callback(error, rtk?.stdout ?? "")
    }
    return { stdin: { on: vi.fn(), end: vi.fn() } }
  })
}

beforeEach(() => { vi.restoreAllMocks(); calls.run.mockReset() })

function context(debug: unknown = false) {
  let hook: (event: ShellCreateBefore) => Promise<void>
  let command: { name: string; execute(input: { sessionID: string; delivery: "steer" }): Promise<void> }
  const synthetic = vi.fn()
  const ctx = {
    options: { debug }, app: { version: "2.0.21" }, location: { directory: "/private-project" },
    shell: { hook: vi.fn((_name, callback) => { hook = callback }) },
    command: { transform: vi.fn((callback) => callback({ add: (definition: typeof command) => { command = definition } })) },
    session: { synthetic },
  }
  return { ctx: ctx as unknown as Parameters<typeof plugin.setup>[0], synthetic, hook: () => hook, command: () => command }
}

describe("privacy-safe diagnostics", () => {
  it.each([0, 3])("reports unchanged RTK output for exit %i without changing the command", async (code) => {
    outputs(undefined, { code, stdout: "git status\n" })
    const observer = vi.fn()
    const input = event()
    await augment(input, observer)
    expect(input.command).toBe("git status")
    expect(observer).toHaveBeenLastCalledWith({ stage: "rtk", result: "unchanged", code })
  })

  it.each(["mise", "rtk"] as const)("classifies %s hook probe failures without leaking errors", async (stage) => {
    for (const [metadata, expected] of [
      [{ code: "ENOENT" }, "not_found"],
      [{ killed: true }, "timeout_or_terminated"],
      [{ code: "EACCES" }, "failed"],
    ] as const) {
      calls.run.mockImplementation((file, _args, _options, callback) => {
        if (file === stage) callback(Object.assign(new Error("raw-error-secret"), metadata), "raw-output-secret")
        else callback(null, file === "mise" ? "{}" : "git status")
        return { stdin: { on: vi.fn(), end: vi.fn() } }
      })
      const observer = vi.fn()
      const input = event("command-secret")
      await augment(input, observer)
      expect(observer).toHaveBeenCalledWith({ stage, result: expected })
      const recorded = JSON.stringify(observer.mock.calls)
      for (const secret of ["raw-error-secret", "raw-output-secret", "command-secret", "/project", "/external"]) expect(recorded).not.toContain(secret)
      if (stage === "rtk") expect(input.command).toBe("command-secret")
    }
  })

  it("distinguishes invalid mise JSON from probe failures and isolates observer failures", async () => {
    outputs("malformed-json-secret", { code: 0, stdout: "git status" })
    const observer = vi.fn()
    const input = event()
    await augment(input, observer)
    expect(observer).toHaveBeenCalledWith({ stage: "mise", result: "invalid_environment" })
    expect(JSON.stringify(observer.mock.calls)).not.toContain("malformed-json-secret")
    expect(input.env).toEqual(event().env)
    await expect(augment(event(), () => { throw new Error("observer-secret") })).resolves.toBeUndefined()
  })

  it.each([
    ["cmd.exe", "git status", "unsupported_shell"],
    ["pwsh", "git status | more", "complex_powershell"],
  ])("logs the fixed skip reason for %s", async (shell, command, reason) => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    const fixture = context(true)
    await plugin.setup(fixture.ctx)
    outputs()
    await fixture.hook()(event(command, shell))
    expect(JSON.stringify(log.mock.calls)).toContain(reason)
  })

  it("sanitizes timeout, malformed output and synchronous probe failures", async () => {
    calls.run.mockImplementation((_file, _args, _options, callback) => callback(Object.assign(new Error("secret"), { killed: true }), "secret"))
    expect(await versionProbe("mise", "/private")).toBe("timeout_or_terminated")
    calls.run.mockImplementation((_file, _args, _options, callback) => callback(null, "/private secret 1.2.3"))
    expect(await versionProbe("rtk", "/private")).toBe("available_version_unrecognized")
    calls.run.mockImplementation(() => { throw new Error("secret") })
    expect(await versionProbe("rtk", "/private")).toBe("failed")
  })

  it.each([plugin, devPlugin])("registers silent diagnostics and shell augmentation for $id", async (entry) => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    const fixture = context()
    await entry.setup(fixture.ctx)
    outputs(undefined, { code: 0, stdout: "git status --short" })
    const input = event()
    await fixture.hook()(input)
    expect(input.command).toBe("git status --short")
    expect(fixture.command().name).toBe("opencode-shell-diagnostics")
    expect(log).not.toHaveBeenCalled()
  })

  it("logs only safe reasons and retains only sanitized hook outcomes", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    const fixture = context(true)
    await plugin.setup(fixture.ctx)
    outputs('{"SECRET":"env-secret","PATH":"/secret-path"}', { code: 2, stdout: "stdout-secret" })
    const input = event("command-secret")
    input.env.SECRET = "inherited-secret"
    await expect(fixture.hook()(input)).rejects.toThrow("RTK denied")
    const recorded = JSON.stringify(log.mock.calls)
    expect(recorded).toContain('denied')
    expect(recorded).toContain('applied')
    for (const secret of ["command-secret", "env-secret", "stdout-secret", "inherited-secret", "/secret-path", "/project", "SECRET"]) expect(recorded).not.toContain(secret)
    calls.run.mockImplementation((_file, args, _options, callback) => {
      expect(args).toEqual(["--version"])
      callback(null, "rtk 0.30.0 stdout-secret")
    })
    await fixture.command().execute({ sessionID: "session", delivery: "steer" })
    const result = fixture.synthetic.mock.calls[0][0]
    expect(result.resume).toBe(false)
    expect(result.text).toContain("not the actual shell event environment")
    expect(result.text).toContain("denied")
    expect(result.text).not.toContain("stdout-secret")
    expect(result.text).not.toContain("secret-path")
  })

  it("ignores logger failures without changing deny or rewrite semantics", async () => {
    vi.spyOn(console, "info").mockImplementation(() => { throw new Error("logger-secret") })
    const fixture = context(true)
    await plugin.setup(fixture.ctx)
    for (const code of [0, 1, 2, 3]) {
      outputs(undefined, { code, stdout: "git status --short" })
      const input = event()
      if (code === 2) await expect(fixture.hook()(input)).rejects.toThrow("RTK denied this command")
      else await fixture.hook()(input)
      expect(input.command).toBe(code === 0 || code === 3 ? "git status --short" : "git status")
    }
  })

  it("reports fixed baseline failures and no observation without running mise env", async () => {
    const fixture = context("true")
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    await devPlugin.setup(fixture.ctx)
    calls.run.mockImplementation((file, args, _options, callback) => {
      expect(args).toEqual(["--version"])
      callback(file === "mise" ? Object.assign(new Error("private-error"), { code: "ENOENT" }) : null, "rtk 0.30.0\n")
    })
    await fixture.command().execute({ sessionID: "session", delivery: "steer" })
    const text = fixture.synthetic.mock.calls[0][0].text
    expect(text).toContain("opencode-shell-dev")
    expect(text).toContain("mise: not_found; rtk: available 0.30.0")
    expect(text).toContain("not_observed")
    expect(text).not.toContain("private-error")
    expect(log).not.toHaveBeenCalled()
  })
})

describe("native shell augmentation", () => {
  it("registers the native shell hook", async () => {
    const fixture = context()
    await plugin.setup(fixture.ctx)
    expect(fixture.hook()).toBeTypeOf("function")
  })

  it("applies mise while preserving complex command text and inherited variables", async () => {
    outputs(JSON.stringify({ PATH: "/managed:/external", ADDED: "value", MISE_YES: "0" }))
    const input = event("cd sub && node -v | head > version.txt")
    await augment(input)
    expect(input.command).toBe("cd sub && node -v | head > version.txt")
    expect(input.env).toEqual({ PATH: "/managed:/external", KEEP: "yes", ADDED: "value", MISE_AUTO_INSTALL: "0", MISE_EXEC_AUTO_INSTALL: "0" })
  })

  it("uses cwd and event environment, with installation and trust approval disabled", async () => {
    outputs()
    await augment(event())
    expect(calls.run.mock.calls[0][2]).toMatchObject({ cwd: "/project", env: { PATH: "/external", MISE_AUTO_INSTALL: "0", MISE_EXEC_AUTO_INSTALL: "0", MISE_YES: "0" } })
    expect(calls.run.mock.calls[0][1]).toEqual(["env", "--json"])
  })

  it.each([0, 3])("applies RTK stdout when rewrite exits %i", async (code) => {
    outputs(JSON.stringify({ PATH: "/managed:/external" }), { code, stdout: "git status --short\n" })
    const input = event()
    await augment(input)
    expect(input.command).toBe("git status --short")
    expect(calls.run.mock.calls[1][0]).toBe("rtk")
    expect(calls.run.mock.calls[1][1]).toEqual(["rewrite", "git status"])
    expect(calls.run.mock.calls[1][2]).toMatchObject({ cwd: "/project", env: { PATH: "/managed:/external" } })
  })

  it("passes through RTK exit code 1", async () => {
    outputs(undefined, { code: 1, stdout: "git status --short" })
    const input = event()
    await augment(input)
    expect(input.command).toBe("git status")
  })

  it("denies RTK exit code 2", async () => {
    outputs(undefined, { code: 2, stdout: "git status --short" })
    await expect(augment(event())).rejects.toThrow("RTK denied this command")
  })

  it("passes through unknown RTK errors", async () => {
    outputs(undefined, { error: new Error("unexpected failure") })
    const input = event()
    await augment(input)
    expect(input.command).toBe("git status")
  })

  it("skips RTK when disabled", async () => {
    outputs()
    const input = event()
    input.env.RTK_DISABLED = "1"
    await augment(input)
    expect(input.command).toBe("git status")
    expect(calls.run).toHaveBeenCalledTimes(1)
    expect(calls.run.mock.calls[0][0]).toBe("mise")
  })

  it.each(["git log | head", "$env:FOO='x'; git status", "git status && git log", "git log $(git rev-parse HEAD)", "& 'rtk' rewrite git status"])("leaves complex PowerShell syntax intact: %s", async (command) => {
    outputs(JSON.stringify({ PATH: "/managed" }))
    const input = event(command, "pwsh")
    await augment(input)
    expect(input.command).toBe(command)
    expect(calls.run).toHaveBeenCalledTimes(1)
  })

  it("leaves unknown dialects entirely unchanged", async () => {
    const input = event("git status", "cmd.exe")
    await augment(input)
    expect(calls.run).not.toHaveBeenCalled()
  })

  it("does not cache environment across commands", async () => {
    outputs(JSON.stringify({ PATH: "/one" }))
    const first = event()
    await augment(first)
    outputs(JSON.stringify({ PATH: "/two" }))
    const second = event()
    await augment(second)
    expect(first.env.PATH).toBe("/one")
    expect(second.env.PATH).toBe("/two")
  })

  it("fails open on malformed probe output", async () => {
    outputs("not json")
    const input = event()
    await augment(input)
    expect(input).toEqual(event())
  })

  it("preserves the caller's mise confirmation setting", async () => {
    outputs(JSON.stringify({ PATH: "/managed", MISE_YES: "0" }))
    const input = event()
    input.env.MISE_YES = "1"
    await augment(input)
    expect(input.env.MISE_YES).toBe("1")
  })

  it.each(["[]", "null", '{"PATH":42}'])("rejects invalid mise environment: %s", async (output) => {
    outputs(output)
    const input = event()
    await augment(input)
    expect(input.env).toEqual(event().env)
  })

  it("applies an unambiguous rewrite in PowerShell", async () => {
    outputs(undefined, { code: 0, stdout: "git status --short\n" })
    const input = event("git status", "C:\\Windows\\powershell.exe")
    await augment(input)
    expect(input.command).toBe("git status --short")
  })
})
