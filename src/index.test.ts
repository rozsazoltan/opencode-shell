import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ShellCreateBefore } from "@opencode/plugin/promise/shell"

const calls = vi.hoisted(() => ({ run: vi.fn(), access: vi.fn() }))
vi.mock("node:child_process", () => ({ execFile: calls.run }))
vi.mock("node:fs/promises", () => ({ access: calls.access }))
import plugin, { augment } from "./index"
import devPlugin from "./dev/index"
import { versionProbe } from "./diagnostics"
import { managedEnvironment, mergeEnvironment } from "./environment"
import { homedir } from "node:os"
import { join } from "node:path"

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

beforeEach(() => { vi.restoreAllMocks(); calls.run.mockReset(); calls.access.mockReset().mockRejectedValue(new Error("absent")) })

describe("managed environment resolution", () => {
  it.each(["ENOENT", "EACCES"])("preserves optional-tool passthrough on %s without broad discovery", async (code) => {
    calls.run.mockImplementation((_file, _args, _options, callback) => {
      callback(Object.assign(new Error("private-error"), { code }), "secret")
      return { stdin: { on: vi.fn(), end: vi.fn() } }
    })
    const inherited = { PATH: "/desktop", KEEP: "yes" }
    const result = await managedEnvironment("/project", inherited)
    expect(result.env).toEqual(inherited)
    expect(result.status).toBe(code === "ENOENT" ? "not_found" : "failed")
    expect(calls.run).toHaveBeenCalledTimes(1)
    if (code === "EACCES") expect(calls.access).not.toHaveBeenCalled()
  })

  it("merges Windows Path overrides without duplicate case variants", () => {
    expect(mergeEnvironment({ Path: "old", PATH: "duplicate", KEEP: "yes" }, { PATH: "managed", keep: "updated" }, true)).toEqual({ PATH: "managed", keep: "updated" })
  })

  it.skipIf(process.platform === "win32")("uses only the documented user installer location after PATH misses", async () => {
    calls.access.mockResolvedValue(undefined)
    calls.run.mockImplementation((file, args, options, callback) => {
      expect(args).toEqual(["env", "--json"])
      expect(options.cwd).toBe("/project")
      callback(file === "mise" ? Object.assign(new Error("absent"), { code: "ENOENT" }) : null, '{"PATH":"/managed"}')
      return { stdin: { on: vi.fn(), end: vi.fn() } }
    })
    const result = await managedEnvironment("/project", { PATH: "/desktop" })
    expect(result.status).toBe("applied")
    expect(result.mise).toBe(join(homedir(), ".local", "bin", "mise"))
    expect(calls.access).toHaveBeenCalledTimes(1)
    expect(calls.run).toHaveBeenCalledTimes(2)
  })

  it("resolves each cwd independently and never changes the inherited or process environment", async () => {
    const inherited = { PATH: "/desktop", KEEP: "yes" }
    const original = { ...process.env }
    calls.run.mockImplementation((_file, _args, options, callback) => {
      callback(null, JSON.stringify({ PATH: `${options.cwd}/tools` }))
      return { stdin: { on: vi.fn(), end: vi.fn() } }
    })
    expect((await managedEnvironment("/one", inherited)).env.PATH).toBe("/one/tools")
    expect((await managedEnvironment("/two", inherited)).env.PATH).toBe("/two/tools")
    expect(inherited).toEqual({ PATH: "/desktop", KEEP: "yes" })
    expect(process.env).toEqual(original)
  })
})

function context(debug: unknown = false) {
  let hook: (event: ShellCreateBefore) => Promise<void>
  let command: { name: string; execute(input: { sessionID: string; delivery: "steer" | "queue" }): Promise<void> }
  const synthetic = vi.fn()
  const prompt = vi.fn()
  let tool: { name: string; input: unknown; options: unknown; execute(): Promise<{ content: string }> }
  const ctx = {
    options: { debug }, app: { version: "2.0.21" }, location: { directory: "/private-project" },
    shell: { hook: vi.fn((_name, callback) => { hook = callback }) },
    command: { transform: vi.fn((callback) => callback({ add: (definition: typeof command) => { command = definition } })) },
    tool: { transform: vi.fn((callback) => callback({ add: (definition: typeof tool) => { tool = definition } })) },
    session: { synthetic, prompt, hook: vi.fn(async (_name, callback) => callback({ system: [] })) },
  }
  return { ctx: ctx as unknown as Parameters<typeof plugin.setup>[0], synthetic, prompt, hook: () => hook, command: () => command, tool: () => tool }
}

describe("privacy-safe diagnostics", () => {
  it.each([plugin, devPlugin])("returns the shared sanitized diagnostic report as a tool result for $id", async (entry) => {
    const fixture = context()
    await entry.setup(fixture.ctx)
    outputs('{"TOKEN":"env-secret","PATH":"/private-managed"}', { code: 3, stdout: "rtk git status" })
    await fixture.hook()(event())
    calls.run.mockClear()
    calls.run.mockImplementation((file, args, _options, callback) => {
      if (args[0] === "env") { callback(null, '{"PATH":"/diagnostic-managed"}'); return }
      expect(args).toEqual(["--version"])
      expect(_options.env.PATH).toBe("/diagnostic-managed")
      callback(file === "rtk" ? Object.assign(new Error("raw-secret"), { code: "ENOENT" }) : null, "mise 2026.1.1")
    })
    expect(fixture.tool()).toMatchObject({ name: "opencode_shell_diagnostics", input: { type: "object", properties: {}, additionalProperties: false }, options: { permission: "opencode_shell_diagnostics" } })
    const { content } = await fixture.tool().execute()
    expect(calls.run).toHaveBeenCalledTimes(3)
    expect(fixture.synthetic).not.toHaveBeenCalled()
    expect(fixture.prompt).not.toHaveBeenCalled()
    expect(content).toContain(entry.id)
    expect(content).toContain("rtk: not_found")
    expect(content).toContain("after mise: available")
    expect(content).toContain("rewrite=applied; rewrite exit=3")
    expect(content).toContain("Command execution and RTK gain/tracking: not_measured")
    for (const secret of ["env-secret", "/private-managed", "/diagnostic-managed", "raw-secret", "rtk git status", "/private-project"]) expect(content).not.toContain(secret)
  })

  it.each([plugin, devPlugin])("submits an agent tool request without upfront report probes for $id", async (entry) => {
    for (const delivery of ["steer", "queue"] as const) {
      const fixture = context()
      await entry.setup(fixture.ctx)
      const result = await fixture.command().execute({ sessionID: "session", delivery })
      expect(result).toBeUndefined()
      expect(fixture.prompt).toHaveBeenCalledExactlyOnceWith({
        sessionID: "session", delivery,
        text: "Invoke the `opencode_shell_diagnostics` tool and display its full report unchanged. Then briefly conclude from the report whether mise environment loading and RTK availability/rewriting work, explicitly distinguishing observed results from unmeasured command execution and RTK gain/tracking. Do not perform any additional investigation.",
      })
      expect(fixture.synthetic).not.toHaveBeenCalled()
      expect(calls.run).not.toHaveBeenCalled()
      expect(calls.access).not.toHaveBeenCalled()
    }
  })

  it("separates baseline from actual rewrite capability in the tool report", async () => {
    const fixture = context()
    await plugin.setup(fixture.ctx)
    outputs('{"PATH":"/managed-secret","TOKEN":"env-secret"}', { code: 3, stdout: "rtk git status" })
    await fixture.hook()(event())
    calls.run.mockImplementation((file, args, _options, callback) => {
      if (args[0] === "env") { callback(null, "{}"); return }
      expect(args).toEqual(["--version"])
      callback(file === "rtk" ? Object.assign(new Error("private-error"), { code: "ENOENT" }) : null, "mise 2026.1.1")
    })
    const { content } = await fixture.tool().execute()
    expect(content).toContain("mise environment: applied; mise: available 2026.1.1; rtk: not_found")
    expect(content).toContain("mise=applied; RTK availability in the shell event environment after mise: available")
    expect(content).toContain("rewrite=applied; rewrite exit=3")
    expect(content).toContain("Command execution and RTK gain/tracking: not_measured")
    for (const secret of ["/managed-secret", "env-secret", "private-error", "rtk git status"]) expect(content).not.toContain(secret)
  })

  it.each([
    ["disabled", "not_measured (rewrite skipped)"],
    ["not_found", "not_found"],
    ["timeout_or_terminated", "not_confirmed"],
  ])("does not infer RTK availability from a %s hook", async (reason, capability) => {
    const fixture = context()
    await plugin.setup(fixture.ctx)
    if (reason === "disabled") {
      outputs('{"RTK_DISABLED":"1"}')
    } else {
      outputs(undefined, { error: Object.assign(new Error("secret"), reason === "not_found" ? { code: "ENOENT" } : { killed: true }) })
    }
    await fixture.hook()(event())
    calls.run.mockImplementation((_file, _args, _options, callback) => callback(null, "0.1.0"))
    const { content } = await fixture.tool().execute()
    expect(content).toContain(`after mise: ${capability}; rewrite=${reason}`)
  })

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
      if (args[0] === "env") { callback(null, "{}"); return }
      expect(args).toEqual(["--version"])
      callback(null, "rtk 0.30.0 stdout-secret")
    })
    const { content } = await fixture.tool().execute()
    expect(content).toContain("not the actual shell event environment")
    expect(content).toContain("denied")
    expect(content).not.toContain("stdout-secret")
    expect(content).not.toContain("secret-path")
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

  it("reports fixed managed-environment failures and no hook observation", async () => {
    const fixture = context("true")
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    await devPlugin.setup(fixture.ctx)
    calls.run.mockImplementation((file, args, _options, callback) => {
      if (args[0] === "env") { callback(Object.assign(new Error("private-error"), { code: "ENOENT" }), ""); return }
      expect(args).toEqual(["--version"])
      callback(file === "mise" ? Object.assign(new Error("private-error"), { code: "ENOENT" }) : null, "rtk 0.30.0\n")
    })
    const { content: text } = await fixture.tool().execute()
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
