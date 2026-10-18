# opencode-shell

Minimal OpenCode V2 plugin that automatically applies [mise](https://github.com/jdx/mise) project environments to native shell execution and optionally rewrites supported commands with [RTK](https://github.com/rtk-ai/rtk).


## Install

Install [mise](https://github.com/jdx/mise) and, optionally, RTK:

```sh
mise use -g rtk@latest
```

Then add the plugin to your OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@rozsazoltan/opencode-shell"]
}
```

Mise and RTK work independently: without mise the existing environment is kept; without RTK commands are not rewritten. RTK must be available on the server's managed `PATH`. Set `RTK_DISABLED=1` to bypass rewriting.

Shell activation is not required, including in Desktop. Before each supported shell command, the plugin runs `mise env --json` for that command's cwd with its inherited environment, then resolves RTK using the enriched environment. Nothing is cached or assigned to global `process.env`. If mise is not on PATH, Unix hosts also try the [official installer's](https://mise.jdx.dev/getting-started.html) fixed `~/.local/bin/mise` location. Windows requires mise on the server PATH: package-manager-specific paths are not guessed. No shell profiles are sourced or tools automatically installed.

## Diagnostics

Diagnostics are silent by default. To opt in to sanitized JSON console records, use:

```json
{
  "plugins": [{ "package": "@rozsazoltan/opencode-shell", "options": { "debug": true } }]
}
```

For visible tool output, ask the OpenCode agent: **“Invoke the `opencode_shell_diagnostics` tool with `{}` and show its diagnostic report.”** This no-argument tool returns the report as text through OpenCode's normal tool-result API, even with debug disabled. Its permission category is `opencode_shell_diagnostics`; normal host permissions still apply. It does not grant or bypass permissions.

The slash command `/opencode-shell-diagnostics` submits a request asking the agent to invoke `opencode_shell_diagnostics`, display its full report unchanged, then briefly conclude whether mise environment loading and RTK availability/rewriting work, distinguishing observed results from unmeasured command execution and RTK gain/tracking without additional investigation. It starts the normal agent/tool flow, including an LLM call and the tool's normal host permission checks. The command itself does not generate the report or run diagnostic probes; those run when the agent invokes the tool.

Diagnostics use the same cwd-specific environment-resolution logic at the plugin location, starting from the OpenCode server environment: bounded `mise env --json`, then `mise --version` and `rtk --version` in the managed environment. They do not install tools, approve trust, or execute supplied command arguments. **Environment resolution can run scripts in already trusted mise configurations**, just like the shell hook; only invoke diagnostics in trusted projects. Auto-install and automatic trust confirmation are disabled. Executables on the managed PATH must still be trusted.

The diagnostic location and inherited environment can differ from a shell event's cwd and environment, so this is not an exact replay of the last shell event. The report also includes the last completed hook's sanitized outcomes for this plugin instance (including a denied hook), or `not_observed`. Concurrent hooks report whichever completes last; no commands or environment snapshots are retained.

The RTK version probe now uses the environment after mise, not the unmodified server baseline. The report separately identifies observed RTK availability in the last hook's environment from its numeric rewrite exit code. A skipped rewrite does not measure RTK availability. This last-hook observation is instance-wide, not session-specific. Rewrite `applied` means command text changed; `unchanged` means it did not. Neither proves that OpenCode approved or executed the command, or that RTK recorded token savings: execution and tracking are explicitly `not_measured`.

Debug records contain plugin/OpenCode versions, registration and hook outcomes, fixed skip reasons, and RTK exit codes. They exclude command text, paths, environment values, subprocess output, and raw errors. Logging failures do not affect shell execution. The local dev entrypoint supports the same option and command under the `opencode-shell-dev` ID.

Records are emitted through `console.info`. Host log routing has not been verified for this plugin; do not assume a particular destination. OpenCode's [troubleshooting guide](https://opencode.ai/v2/docs/troubleshooting#read-logs) documents its server logs. Check your host's behavior before relying on capture, and review logs before sharing them.

## Shell behavior

- Use only trusted mise projects: resolving their environment may run scripts before shell permission approval. Mise can add or override variables here, but cannot unset inherited ones (`env.VAR = false`).
- RTK rewrites supported commands; OpenCode checks permissions against the **rewritten command**, which may need separate approval. RTK's allow decision never grants host permission; a deny result stops execution.
- Complex PowerShell commands and unsupported shells are left unchanged.
- RTK supports custom filters in a project's `.rtk/filters.toml` or the user's `~/.config/rtk/filters.toml`. Trust the relevant global and local configuration with `rtk trust`; configuration edits require trusting it again.

## Patch recovery guidance

Each model context receives guidance to reread current file lines after a patch mismatch and create a fresh, narrow patch. The plugin cannot inspect patch failures or retry them; this prompt guidance does not guarantee recovery.

## Versions

Find published versions on [npm](https://www.npmjs.com/package/@rozsazoltan/opencode-shell) and changes in [GitHub Releases](https://github.com/rozsazoltan/opencode-shell/releases). Versions follow SemVer.

## Releases

The release workflow stages each tagged version on npm for human approval; it does not publish directly. After the workflow succeeds, approve the staged version at [npm staged packages](https://www.npmjs.com/settings/rozsazoltan/staged-packages), then rerun the release workflow on `master`. Once npm reports the version as published, that rerun creates the GitHub Release instead of starting another version bump. If a workflow retry occurs before approval, it will fail safely because the staged version already reserves that version; approve the existing stage and rerun rather than creating or deleting another stage.

For an unpublished release tag, the workflow can recover from a later `master` tip: it verifies the tag commit is an ancestor of `master`, checks the tagged package manifest and lockfile, and stages from that exact tagged commit. Divergent tags or mismatched tagged files are rejected for manual recovery.

## Contributing

Use Node 24 and npm to install dependencies and run the existing checks:

```sh
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

For local development, this repository's `.opencode/opencode.json` disables the installed `opencode-shell` plugin and loads `src/dev`, which registers the same shell augmentation under the distinct `opencode-shell-dev` ID. The production plugin ID and global configuration remain unchanged.

To test from another project, set `"plugins": ["-opencode-shell", "/absolute/path/opencode-shell/src/dev"]` in its `opencode.jsonc`. In a trusted mise project, add `OPENCODE_SHELL_SMOKE = "one"` under `[env]` and ask the agent to run `printenv OPENCODE_SHELL_SMOKE` with the native shell tool (PowerShell: `$env:OPENCODE_SHELL_SMOKE`). With RTK installed, run `git log -30` the same way, then use `/opencode-shell-diagnostics` to inspect the last hook's rewrite outcome. Compare `rtk gain` before and after execution to check tracking separately.

## License and acknowledgements

AGPL-3.0-or-later: this work is licensed under the GNU Affero General Public License, version 3 or any later version. See [LICENSE](LICENSE).

Thanks to [rtk-ai/rtk](https://github.com/rtk-ai/rtk) for RTK, [jdx/mise](https://github.com/jdx/mise), and [VincentHardouin/opencode-snip](https://github.com/VincentHardouin/opencode-snip) for the original plugin inspiration. [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) contains the original plugin's MIT notice.
