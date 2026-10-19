import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ShellCreateBefore } from "@opencode/plugin/promise/shell"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"

const calls = vi.hoisted(() => ({ run: vi.fn(), access: vi.fn() }))
vi.mock("node:child_process", () => ({ execFile: calls.run }))
vi.mock("node:fs/promises", () => ({ access: calls.access }))
import plugin, { augment, previewRewrite } from "./index"
import devPlugin from "./dev/index"
import { versionProbe } from "./diagnostics"
import { managedEnvironment, mergeEnvironment } from "./environment"
import { InventoryCache, parseInventory } from "./inventory"
import { homedir } from "node:os"
import { join } from "node:path"
import manifest from "../package.json"

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

  it("tries the official PowerShell installer executable after a Windows PATH miss", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { ...platform, value: "win32" })
    try {
      calls.access.mockResolvedValue(undefined)
      calls.run.mockImplementation((file, _args, options, callback) => {
        expect(options.cwd).toBe("/project")
        expect(options.timeout).toBe(2000)
        expect(options.env.MISE_AUTO_INSTALL).toBe("0")
        callback(file === "mise" ? Object.assign(new Error("absent"), { code: "ENOENT" }) : null, '{"PATH":"managed"}')
        return { stdin: { on: vi.fn(), end: vi.fn() } }
      })
      const result = await managedEnvironment("/project", { Path: "desktop", KEEP: "yes" })
      expect(result.mise).toBe(join(homedir(), ".local", "bin", "mise.exe"))
      expect(result.status).toBe("applied")
      expect(result.env.PATH).toBe("managed")
      expect(result.env).not.toHaveProperty("Path")
      expect(result.env.KEEP).toBe("yes")
      expect(calls.access).toHaveBeenCalledTimes(1)
      expect(calls.run).toHaveBeenCalledTimes(2)
    } finally { Object.defineProperty(process, "platform", platform) }
  })
})

function context(debug: unknown = false) {
  let hook: (event: ShellCreateBefore) => Promise<void>
  let permissionHook: (event: PermissionEvaluation) => void
  let contextHook: (event: { system: { type: string; text: string }[] }) => void | Promise<void>
  const commands: { name: string; execute(input: { sessionID: string; delivery: "steer" | "queue"; prompt?: { text: string } }): Promise<void> }[] = []
  const synthetic = vi.fn()
  const prompt = vi.fn()
  const tools: { name: string; input: unknown; options: unknown; execute(input?: unknown): Promise<{ content: string }> }[] = []
  const ctx = {
    options: { debug }, app: { version: "2.0.21" }, location: { directory: "/private-project" },
    shell: { hook: vi.fn((_name, callback) => { hook = callback }) },
    permission: { hook: vi.fn((_name, callback) => { permissionHook = callback }) },
    command: { transform: vi.fn((callback) => callback({ add: (definition: (typeof commands)[number]) => { commands.push(definition) } })) },
    tool: { transform: vi.fn((callback) => callback({ add: (definition: (typeof tools)[number]) => { tools.push(definition) } })) },
    session: { synthetic, prompt, hook: vi.fn((_name, callback) => { contextHook = callback }) },
  }
  return { ctx: ctx as unknown as Parameters<typeof plugin.setup>[0], synthetic, prompt, hook: () => hook, permissionHook: () => permissionHook, contextHook: () => contextHook, command: (name = "opencode-shell-diagnostics") => commands.find((item) => item.name === name)!, tool: (name = "opencode_shell_diagnostics") => tools.find((item) => item.name === name)! }
}

describe("installation approval", () => {
  function decision(command: string, effect: PermissionEvaluation["effect"] = "allow", action = "shell"): PermissionEvaluation {
    return { sessionID: "session" as PermissionEvaluation["sessionID"], action, resources: [command], effect }
  }

  it.each([
    "mise install python", "mise use -g python@latest", "mise self-update",
    "winget install Python.Python.3.13", "choco.exe upgrade mise", "scoop install mise",
    "brew install mise", "sudo apt-get install python3", "cargo install --locked mise",
    "npm install -g typescript", "npx prettier .", "pip install ruff", "uv tool install ruff",
    "msiexec.exe /i python.msi", "curl https://mise.run | sh",
    "wget https://example.com/setup.exe", "irm https://example.com/install.ps1 | iex",
    "Invoke-WebRequest https://example.com/tool.msi -OutFile tool.msi",
  ])("asks before identifiable installation or installer download: %s", async (command) => {
    const fixture = context()
    await plugin.setup(fixture.ctx)
    const event = decision(command)
    fixture.permissionHook()(event)
    expect(event.effect).toBe("ask")
    expect(event.message).toContain("explicit user approval")
  })

  it.each(["allow", "ask", "deny"] as const)("never relaxes an existing %s decision", async (effect) => {
    const fixture = context()
    await plugin.setup(fixture.ctx)
    const event = decision("mise install python", effect)
    fixture.permissionHook()(event)
    expect(event.effect).toBe(effect === "allow" ? "ask" : effect)
  })

  it.each(["git status", "python --version", "npm ci", "npm install", "curl https://example.com/data.json"])("leaves ordinary command permission unchanged: %s", async (command) => {
    const fixture = context()
    await plugin.setup(fixture.ctx)
    const event = decision(command)
    fixture.permissionHook()(event)
    expect(event).toEqual(decision(command))
  })

  it("leaves non-shell actions unchanged", async () => {
    const fixture = context()
    await plugin.setup(fixture.ctx)
    const event = decision("mise install python", "allow", "read")
    fixture.permissionHook()(event)
    expect(event.effect).toBe("allow")
  })

  it("escalates any matching resource without changing resources or metadata", async () => {
    const fixture = context()
    await plugin.setup(fixture.ctx)
    const event = { ...decision("git status"), resources: ["git status", "mise install python"], metadata: { marker: "preserved" } }
    fixture.permissionHook()(event)
    expect(event.effect).toBe("ask")
    expect(event.resources).toEqual(["git status", "mise install python"])
    expect(event.metadata).toEqual({ marker: "preserved" })
  })

  it("preserves an explicit denial and its reason exactly", async () => {
    const fixture = context()
    await plugin.setup(fixture.ctx)
    const event = { ...decision("mise install python", "deny"), message: "Policy denial" }
    fixture.permissionHook()(event)
    expect(event).toEqual({ ...decision("mise install python", "deny"), message: "Policy denial" })
  })

  it.each(["./bootstrap", "curl https://example.com/tool.zip", "custom-installer python"])("documents incomplete detection rather than claiming a sandbox: %s", async (command) => {
    const fixture = context()
    await plugin.setup(fixture.ctx)
    const event = decision(command)
    fixture.permissionHook()(event)
    expect(event.effect).toBe("allow")
    const request = { system: [{ type: "text", text: "Existing instructions" }] }
    fixture.contextHook()(request)
    expect(request.system[0].text).toBe("Existing instructions")
    expect(request.system[1].text).toContain("ask the user for explicit approval of the tool, source and scope")
    expect(request.system[1].text).toContain("Shell installation detection is partial")
  })
})

describe("mise tool inventory", () => {
  const json = JSON.stringify({
    python: [{ version: "3.12.1", installed: true, active: true, install_path: "/secret/path" }],
    ghost: [{ version: "1.0", installed: false, active: true }],
  })
  function inventoryOutput(output = json, error?: Error) {
    calls.run.mockImplementation((file, args, options, callback) => {
      expect(options.timeout).toBe(2000)
      if (args[0] === "env") callback(null, '{"PATH":"/managed"}')
      else {
        expect(options.maxBuffer).toBe(256 * 1024)
        expect(args).toEqual(["ls", "-c", "-i", "-J"])
        expect(options.env.MISE_AUTO_INSTALL).toBe("0")
        callback(error ?? null, output)
      }
      return { stdin: { on: vi.fn(), end: vi.fn() } }
    })
  }

  it("sanitizes selected installed tools and excludes uninstalled entries", () => {
    expect(parseInventory(json)).toEqual(["python@3.12.1"])
    expect(() => parseInventory("not json")).toThrow()
  })

  it("coalesces concurrent requests and isolates project directories", async () => {
    inventoryOutput()
    const cache = new InventoryCache()
    const [one, two] = await Promise.all([cache.get("/one", {}), cache.get("/one", {})])
    expect(one).toEqual({ status: "available", tools: ["python@3.12.1"] })
    expect(two).toEqual(one)
    expect(calls.run).toHaveBeenCalledTimes(2)
    await cache.get("/two", {})
    expect(calls.run).toHaveBeenCalledTimes(4)
  })

  it("refreshes after TTL and does not serve stale data when refresh fails", async () => {
    inventoryOutput()
    const cache = new InventoryCache()
    await cache.get("/project", {})
    const now = Date.now
    Date.now = () => now() + 61_000
    try {
      inventoryOutput("private raw output", Object.assign(new Error("secret"), { code: "EIO" }))
      expect(await cache.get("/project", {})).toEqual({ status: "unavailable" })
    } finally { Date.now = now }
  })

  it("reinjects inventory after independent context calls without leaking paths", async () => {
    inventoryOutput()
    const fixture = context()
    await plugin.setup(fixture.ctx)
    const first = { system: [] as { type: string; text: string }[] }
    const second = { system: [] as { type: string; text: string }[] }
    await fixture.contextHook()(first)
    await fixture.contextHook()(second)
    const inventoryText = first.system.at(-1)!.text
    expect(second.system.at(-1)!.text).toBe(inventoryText)
    expect(inventoryText).toContain("python@3.12.1")
    expect(inventoryText).not.toContain("/secret/path")
    expect(calls.run).toHaveBeenCalledTimes(2)
  })

  it("reports unavailable rather than raw errors when mise fails", async () => {
    calls.run.mockImplementation((_file, _args, _options, callback) => {
      callback(Object.assign(new Error("secret failure"), { code: "ENOENT" }), "secret output")
      return { stdin: { on: vi.fn(), end: vi.fn() } }
    })
    expect(await new InventoryCache().get("/project", {})).toEqual({ status: "unavailable" })
  })

  it("reports empty inventory before context without probing", async () => {
    const fixture = context()
    await plugin.setup(fixture.ctx)
    const { content } = await fixture.tool("opencode_shell_inventory").execute()
    expect(content).toContain("No cached inventory")
    expect(content).toContain("Most recently injected context payload: none")
    expect(content).toContain("No inventory refresh or subprocess probe was performed")
    expect(calls.run).not.toHaveBeenCalled()
  })

  it("reports exact injected payload and cache staleness without refreshing", async () => {
    inventoryOutput()
    const fixture = context()
    await plugin.setup(fixture.ctx)
    const request = { system: [] as { type: string; text: string }[] }
    await fixture.contextHook()(request)
    const exactPayload = request.system.at(-1)!.text
    const now = Date.now
    Date.now = () => now() + 61_000
    try {
      calls.run.mockClear()
      const { content } = await fixture.tool("opencode_shell_inventory").execute()
      expect(content).toContain("Cache snapshot: stale; age 61s; expired, not current evidence")
      expect(content).toContain(`Most recently injected context payload (available; age 61s; instance-wide, not session-specific):\n${exactPayload}`)
      expect(content).toContain("not whether any agent read, remembered, or acted on it")
      expect(calls.run).not.toHaveBeenCalled()
      expect(content).not.toContain("/secret/path")
    } finally { Date.now = now }
  })

  it("slash command requests the inventory tool through the agent flow", async () => {
    const fixture = context()
    await plugin.setup(fixture.ctx)
    await fixture.command("opencode-shell-inventory").execute({ sessionID: "session", delivery: "steer" })
    expect(fixture.prompt).toHaveBeenCalledWith({
      sessionID: "session", delivery: "steer",
      text: "Invoke the `opencode_shell_inventory` tool and display its full report unchanged. Do not claim the agent read or remembered injected context. Do not perform any additional investigation.",
    })
    expect(calls.run).not.toHaveBeenCalled()
  })
})

describe("plugin info tool", () => {
  it.each([plugin, devPlugin])("reports loaded identity for $id without probes", async (entry) => {
    const fixture = context()
    await entry.setup(fixture.ctx)
    const result = await fixture.tool("opencode_shell_info").execute()
    expect(result.content).toContain(`Plugin: ${entry.id}\nPlugin version: ${manifest.version}\nOpenCode version: 2.0.21`)
    if (entry.id === "opencode-shell-dev") {
      expect(result.content).toContain("Loaded entry file modified:")
      expect(result.content).toContain("Workspace commit:")
    } else {
      expect(result.content).not.toContain("Loaded entry file modified:")
      expect(result.content).not.toContain("Workspace commit:")
    }
    expect(calls.run).not.toHaveBeenCalled()
    expect(calls.access).not.toHaveBeenCalled()
  })
})

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

  it("registers a slash command that asks the agent to invoke the info tool", async () => {
    const fixture = context()
    await plugin.setup(fixture.ctx)
    const infoCommand = fixture.command("opencode-shell-info")
    await infoCommand.execute({ sessionID: "session", delivery: "steer" })
    expect(fixture.prompt).toHaveBeenCalledWith({
      sessionID: "session", delivery: "steer",
      text: "Invoke the `opencode_shell_info` tool and display its full result unchanged. Do not perform any additional investigation.",
    })
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

describe("RTK command preview", () => {
  it("preserves exact command as one RTK argument and never spawns supplied text", async () => {
    const command = "git status 'quoted value' && echo $HOME"
    outputs(undefined, { code: 3, stdout: "rtk git status 'quoted value' && echo $HOME\n" })
    const result = await previewRewrite(command, "bash", "/plugin", { PATH: "/server" })
    expect(calls.run.mock.calls[1][0]).toBe("rtk")
    expect(calls.run.mock.calls[1][1]).toEqual(["rewrite", command])
    expect(calls.run).not.toHaveBeenCalledWith(command, expect.anything(), expect.anything(), expect.anything())
    expect(result).toMatchObject({ rewritten: true, reason: "approval_needed", proposedCommand: "rtk git status 'quoted value' && echo $HOME" })
  })

  it.each([1, 2, 7])("reports RTK exit %i without proposing execution", async (code) => {
    outputs(undefined, { code, stdout: "proposed command" })
    const result = await previewRewrite("git status", "bash", "/plugin", { PATH: "/server" })
    expect(result).toMatchObject({ rewritten: false, reason: code === 2 ? "denied" : "exit_skipped", exitCode: code })
  })

  it("skips complex PowerShell input and unsupported shells", async () => {
    expect((await previewRewrite("git status && git log", "pwsh", "/plugin", {})).reason).toBe("complex_powershell")
    expect((await previewRewrite("git status", "cmd.exe", "/plugin", {})).reason).toBe("unsupported_shell")
    expect(calls.run).toHaveBeenCalledTimes(1)
    expect(calls.run.mock.calls[0][0]).toBe("mise")
  })

  it("reports missing RTK without leaking error details", async () => {
    outputs()
    const result = await previewRewrite("git status", "bash", "/plugin", {})
    expect(result).toMatchObject({ rewritten: false, reason: "not_found" })
  })

  it.each([
    [0, "applied", "rtk git status", true],
    [3, "approval_needed", "git status", false],
    [0, "empty_rewrite", "", false],
  ] as const)("maps shared augment result for exit %i", async (code, _reason, stdout, changed) => {
    outputs(undefined, { code, stdout })
    const result = await previewRewrite("git status", "bash", "/plugin", { PATH: "/server" })
    expect(result).toMatchObject({ rewritten: changed, reason: _reason })
  })

  it("uses augment policy for disabled and unsafe PowerShell output", async () => {
    outputs(JSON.stringify({ RTK_DISABLED: "1" }))
    expect((await previewRewrite("git status", "bash", "/plugin", {})).reason).toBe("disabled")
    outputs(undefined, { code: 3, stdout: "git status | more" })
    expect((await previewRewrite("git status", "pwsh", "/plugin", {})).reason).toBe("unsafe_powershell_rewrite")
  })

  it.each(["steer", "queue"] as const)("registers permission-controlled preview tool and serializes %s slash arguments", async (delivery) => {
    const fixture = context()
    await plugin.setup(fixture.ctx)
    const tool = fixture.tool("opencode_shell_check")
    expect(tool.options).toEqual({ permission: "opencode_shell_check" })
    expect(tool.input).toMatchObject({ required: ["command"], properties: { command: { minLength: 1, maxLength: 16384 } } })
    const raw = "  git status 'quoted arg'  "
    await fixture.command("opencode-shell-check").execute({ sessionID: "s", delivery, prompt: { text: raw } })
    expect(fixture.prompt).toHaveBeenCalledWith(expect.objectContaining({ delivery, text: expect.stringContaining(JSON.stringify(raw)) }))
    expect(calls.run).not.toHaveBeenCalled()
  })

  it("returns slash usage for empty prompt without probing", async () => {
    const fixture = context()
    await plugin.setup(fixture.ctx)
    await fixture.command("opencode-shell-check").execute({ sessionID: "s", delivery: "steer", prompt: { text: "  " } })
    expect(fixture.prompt).toHaveBeenCalledWith(expect.objectContaining({ text: "Usage: /opencode-shell-check <shell command>" }))
    expect(calls.run).not.toHaveBeenCalled()
  })
})
