import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ShellCreateBefore } from "@opencode/plugin/promise/shell"

const calls = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock("node:child_process", () => ({ execFile: calls.run }))
import plugin, { augment } from "./index"

function event(command = "git status", shell = "/bin/bash"): ShellCreateBefore {
  return { command, shell, cwd: "/project", env: { PATH: "/external", KEEP: "yes" }, timeout: 10000 }
}

function outputs(mise?: string, snip?: string) {
  calls.run.mockImplementation((file, _args, _options, callback) => {
    const output = file === "mise" ? mise : snip
    callback(output === undefined ? new Error("unavailable") : null, output ?? "")
    return { stdin: { on: vi.fn(), end: vi.fn() } }
  })
}

function rewrite(command: string) {
  return JSON.stringify({ hookSpecificOutput: { updatedInput: { command } } })
}

beforeEach(() => { calls.run.mockReset() })

describe("native shell augmentation", () => {
  it("registers only the native shell hook", async () => {
    const hook = vi.fn()
    await plugin.setup({ shell: { hook } } as unknown as Parameters<typeof plugin.setup>[0])
    expect(hook).toHaveBeenCalledWith("create.before", augment)
  })

  it("applies mise without snip, preserving complex command text and inherited variables", async () => {
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

  it("uses separately installed snip when mise is unavailable", async () => {
    outputs(undefined, rewrite('"/external/snip" run -- git status'))
    const input = event()
    await augment(input)
    expect(input.command).toBe('"/external/snip" run -- git status')
    expect(input.env).toEqual({ PATH: "/external", KEEP: "yes" })
  })

  it("resolves snip using the managed environment", async () => {
    outputs(JSON.stringify({ PATH: "/managed:/external" }), rewrite('"/managed/snip" run -- git status'))
    await augment(event())
    expect(calls.run.mock.calls[1][2].env.PATH).toBe("/managed:/external")
  })

  it("fixes quoted PowerShell executable invocation and escapes apostrophes", async () => {
    outputs(undefined, rewrite('"C:\\User\'s tools\\snip.exe" run -- git status'))
    const input = event("git status", "C:\\Windows\\powershell.exe")
    await augment(input)
    expect(input.command).toBe("& 'C:\\User''s tools\\snip.exe' run -- git status")
  })

  it.each(["git log | head", "$env:FOO='x'; git status", "git status && git log", "git log $(git rev-parse HEAD)", "& 'snip.exe' run -- git status"])("leaves complex PowerShell syntax intact: %s", async (command) => {
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
    outputs("not json", "not json")
    const input = event()
    await augment(input)
    expect(input).toEqual(event())
  })

  it.each(['"/external/snip" run -- git status', "snip run -- git status", "& 'C:\\User''s tools\\snip.exe' run -- git status"])("does not double wrap: %s", async (command) => {
    outputs(undefined, rewrite('"/external/snip" run -- snip run -- git status'))
    const input = event(command)
    await augment(input)
    expect(input.command).toBe(command)
    expect(calls.run).toHaveBeenCalledTimes(1)
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

  it("rejects unrelated PowerShell rewrites", async () => {
    outputs(undefined, rewrite('"C:\\snip.exe" run -- git log'))
    const input = event("git status", "pwsh")
    await augment(input)
    expect(input.command).toBe("git status")
  })
})
