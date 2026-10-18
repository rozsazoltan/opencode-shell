import { Schema } from "effect"
import { Skill } from "@opencode/schema/skill"
import type { Context } from "@opencode/plugin/promise/plugin"
import { fileURLToPath } from "node:url"

const guidance = "A recent shell result was large or noisy. If useful, author a project-local RTK filter in .rtk/filters.toml. First inspect the installed RTK version and `rtk --help`/`rtk verify --help`; preserve existing filters. Use narrowly scoped `[filters.my-tool]` entries with anchored `match_command`, and synthetic nonsecret `[[tests.my-tool]]` input/expected fixtures, including failure cases. Preserve errors, warnings, and security-relevant lines. Do not create global filters or claim verification proves safety. Run `rtk verify --require-all`; report failures accurately. Ask the user to review the exact diff and run `rtk trust` themselves. Never run trust, `--yes`, trust overrides, or any trust/store mutation. Trust is manual and applies only after the reviewed content is approved; any edit invalidates that approval."

const skillContent = `# RTK project filter authoring

Use this workflow only when the user asks for a project-local RTK output filter or when the plugin points out a large or noisy shell result.

## Safe workflow

1. Inspect the installed RTK version and the local \`rtk --help\` and \`rtk verify --help\` output. Do not assume CLI behavior that the installed version does not document.
2. Check the user's requested scope and inspect existing \`.rtk/filters.toml\` before proposing changes. Preserve existing filters and unrelated file content.
3. Propose a narrowly scoped filter for one command. Use the documented TOML form, such as \`[filters.my-tool]\`, a short description, and a restrictive \`match_command = '^my-tool\\b'\`. Follow installed-version documentation for all filter fields.
4. Add synthetic, nonsecret inline test fixtures under \`[[tests.my-tool]]\`, with \`name\`, \`input\`, and \`expected\`. Cover ordinary output and failure output. Preserve errors, warnings, and security-relevant lines.
5. Make or propose edits only with ordinary permission-checked file tools. Explain that this is agent-authored proposed filter content, not deterministic synthesis or automatic activation.
6. Run \`rtk verify --require-all\` in the project, if available and authorized. Report exact success or failure honestly. Verification runs inline tests and requires tests for each filter; it does not prove filter safety, broad correctness, or that RTK actually applies untrusted project filters.
7. Show the exact diff and ask the user to review it. The user must independently run \`rtk trust\` to trust the exact local filter content. Never run \`rtk trust\`, \`--yes\`, trust overrides, or any trust/store mutation on the user's behalf. Never say a filter is trusted before the user does this.
8. Any later edit changes the trusted content; ask the user to review and trust it again themselves.

Never create or modify global filters. Never retain shell output as filter input; use synthetic fixtures. Never claim \`rtk verify\` establishes safety or activation.\n`

function isShellTool(name: string): boolean {
  return name === "shell" || name === "bash"
}

function isNoisyResult(result: { content?: string | readonly { type: string; text?: string }[] }): boolean {
  if (typeof result.content === "string") return result.content.length >= 16_000 || result.content.split("\n", 201).length > 200
  if (!result.content) return false
  let chars = 0
  let lines = 0
  for (const item of result.content) {
    if (item.type !== "text" || typeof item.text !== "string") continue
    chars += item.text.length
    lines += item.text.split("\n", Math.max(1, 201 - lines)).length - 1
    if (chars >= 16_000 || lines >= 200) return true
  }
  return false
}

export async function registerFilterWorkflow(ctx: Context): Promise<void> {
  const pending = new Set<string>()
  const notified = new Set<string>()
  const remember = (set: Set<string>, sessionID: string) => {
    set.delete(sessionID)
    set.add(sessionID)
    if (set.size > 128) set.delete(set.values().next().value!)
  }
  await ctx.tool.hook("execute.after", (event) => {
    if (event.status === "completed" && isShellTool(event.tool) && isNoisyResult(event.result) && !notified.has(event.sessionID)) remember(pending, event.sessionID)
  })
  await ctx.session.hook("context", (event) => {
    if (!pending.delete(event.sessionID)) return
    remember(notified, event.sessionID)
    event.system.push({ type: "text", text: guidance })
  })
  await ctx.skill.transform((editor) => {
    editor.add({
      id: Schema.decodeUnknownSync(Skill.ID)("rtk-filter-authoring"),
      name: Schema.decodeUnknownSync(Skill.Name)("rtk-filter-authoring"),
      description: "Safely author, verify, review, and manually trust project-local RTK output filters",
      autoinvoke: false,
      path: Schema.decodeUnknownSync(Skill.Info)({
        id: "rtk-filter-authoring",
        name: "rtk-filter-authoring",
        path: fileURLToPath(import.meta.url),
        content: skillContent,
      }).path,
      content: skillContent,
    })
  })
  await ctx.command.transform((editor) => {
    editor.add({
      name: "opencode-shell-filters",
      description: "Load RTK project filter authoring guidance and follow its manual trust workflow",
      async execute({ sessionID, delivery }) {
        await ctx.session.prompt({ sessionID, delivery, text: "Load the `rtk-filter-authoring` skill and follow its safe project-local RTK filter workflow. Do not trust or mutate RTK trust state." })
      },
    })
  })
}
