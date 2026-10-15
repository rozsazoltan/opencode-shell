import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ShellCreateBefore } from "@opencode/plugin/promise/shell"

const calls = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock("node:child_process", () => ({ execFile: calls.run }))
import plugin, { augment } from "./index"

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

beforeEach(() => { calls.run.mockReset() })

describe("native shell augmentation", () => {
  it("registers only the native shell hook", async () => {
    const hook = vi.fn()
    await plugin.setup({ shell: { hook } } as unknown as Parameters<typeof plugin.setup>[0])
    expect(hook).toHaveBeenCalledWith("create.before", augment)
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
