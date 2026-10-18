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

Shell activation is not required, including in Desktop. Before each supported shell command, the plugin runs `mise env --json` for that command's cwd with its inherited environment, then resolves RTK using the enriched environment. Nothing is cached or assigned to global `process.env`. If mise is not on PATH, hosts also try the [official installers'](https://mise.jdx.dev/installing-mise.html) fixed location: `~/.local/bin/mise` on Unix or `~\.local\bin\mise.exe` on Windows (PowerShell installer). Package-manager-specific paths are not guessed. No shell profiles are sourced or tools automatically installed.

Windows environment names, including `Path`/`PATH`, are merged case-insensitively. Environment probes time out after two seconds; missing mise, failures and invalid output retain the inherited environment. A missing mise installation cannot provide Python. `Get-Command python3` resolving to a WindowsApps alias does not by itself prove a download or identify why mise was unavailable. For other installation locations, put mise on the OpenCode server's PATH and restart that server; terminal activation alone does not update an already running server.

## Installation approval

The plugin uses OpenCode V2's supported permission `evaluate` hook to escalate identifiable shell tool installations and installer downloads to `ask`, after normal rules and before execution. Configured denies remain final; unrelated permission decisions are unchanged. Matching requests require user approval even when normal rules or saved approvals would allow them. The plugin never replies to permission requests itself.

Detection covers recognizable mise installation/use/upgrade commands, common system package-manager installs, Cargo installs, global Node package operations, Python installer commands, package runners, MSI execution, and recognizable installer downloads or download-to-shell pipelines. It is a heuristic over the host scanner's shell command resources, **not a shell parser or a security sandbox**. Flags, wrappers, aliases, scripts, computed commands, alternative tools, archive downloads and non-shell download APIs may escape detection. Later plugins can also change permission decisions. Ordinary project dependency operations are not universally intercepted; Python install commands are conservatively prompted because their scope is ambiguous.

The agent also receives guidance before each agent-loop model request: ask explicitly before tool installs/upgrades or standalone installer downloads, including attempts not recognized by detection. Describe the tool, source and scope first. Missing tools are not authorization to install them. This guidance is not enforcement. Existing trusted mise configuration may execute scripts during environment resolution, before shell permission approval; only use trusted projects. The plugin's automatic mise probes disable auto-install, not arbitrary side effects in trusted configuration.

Each context request also receives a bounded inventory of selected installed mise tools from the plugin location, using `mise ls -c -i -J`. It is refreshed after 60 seconds and cached in memory per plugin instance; session context events do not expose a supported cwd in this SDK, so project-specific session cwd cannot be reported. Inventory contains sanitized tool/version pairs only, never paths, environment values or raw output. It indicates selected installed versions, not executable names or aliases: check existing commands and aliases first (for example, python versus python3; npm/npx may be available through node, but mappings are not guaranteed). Use mise for approved installs; never auto-install, auto-approve or blindly rewrite aliases. A service restart clears cache. Other plugins may run context hooks in any order, and model compliance is not guaranteed.

## Diagnostics

Use `/opencode-shell-info` to ask the agent to call `opencode_shell_info` and report which plugin ID and package version this server loaded. It reports the OpenCode version too and performs no subprocess probes. For the dev plugin it also reports the entry file's modification time and current workspace commit; these do not prove that loaded code matches the current worktree when the file changed after loading. It does not report a build timestamp.

Diagnostics are silent by default. To opt in to sanitized JSON console records, use:

```json
{
  "plugins": [{ "package": "@rozsazoltan/opencode-shell", "options": { "debug": true } }]
}
```

For visible tool output, ask the OpenCode agent: **“Invoke the `opencode_shell_diagnostics` tool with `{}` and show its diagnostic report.”** This no-argument tool returns the report as text through OpenCode's normal tool-result API, even with debug disabled. Its permission category is `opencode_shell_diagnostics`; normal host permissions still apply. It does not grant or bypass permissions.

The slash command `/opencode-shell-diagnostics` submits a request asking the agent to invoke `opencode_shell_diagnostics`, display its full report unchanged, then briefly conclude whether mise environment loading and RTK availability/rewriting work, distinguishing observed results from unmeasured command execution and RTK gain/tracking without additional investigation. It starts the normal agent/tool flow, including an LLM call and the tool's normal host permission checks. The command itself does not generate the report or run diagnostic probes; those run when the agent invokes the tool.

Use `/opencode-shell-inventory` to ask the agent to invoke `opencode_shell_inventory` and display its report unchanged. The permission-controlled, no-argument tool reports the current cached snapshot and exact most recently injected inventory payload; it never refreshes inventory or runs probes. It labels empty, fresh and expired cache state, age, and plugin-location scope. The last injected payload is instance-wide, not session-specific; the report confirms injection only and does not claim the agent read or remembered it.

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

## Versions

Find published versions on [npm](https://www.npmjs.com/package/@rozsazoltan/opencode-shell) and changes in [GitHub Releases](https://github.com/rozsazoltan/opencode-shell/releases). Versions follow SemVer.

## Releases

Trigger a release from the **Actions** tab: open the **Release** workflow, choose **Run workflow** on `master`, and select `patch`, `minor`, `major`, or `current`. A bump choice updates `package.json` and `package-lock.json` with SemVer, commits them as `chore(release): vX.Y.Z`, pushes the commit and the annotated `vX.Y.Z` tag to `master`, and automatically starts a `current` run. Choose `current` directly to release the committed package version without changing the version or creating a commit; it creates the version tag only if missing. npm approval stays manual: approve the staged version at [npm staged packages](https://www.npmjs.com/settings/rozsazoltan/staged-packages). If you decide not to publish a staged version, delete its GitHub Release manually; there is no automatic deletion workflow.

A bumped release is a two-run chain because npm provenance binds the attestation to the run's commit: the run that stages the package must check out the exact tagged commit, so it cannot also be the run that creates the version commit. The first (prepare) run bumps, commits, tags, and dispatches the second (`current`, or stage) run, and never stages or publishes. A `current` run never bumps or commits. There is no separate version input; the manifest and lockfile select the version.

Before staging, the run requires a clean tree with `HEAD` equal to the workflow SHA, `origin/master`, and the `vX.Y.Z` tag commit, plus a consistent manifest and lockfile. A missing tag is created at that SHA only for a version with no existing GitHub Release or public npm publication; existing local and remote tag objects must agree. Tag creation or explicitly confirmed recovery happens only after installation, typecheck, tests, build (if present), and pack validation succeed. It validates the registry and stages the version with `npm stage publish --provenance --access public --tag latest`. Successful staging creates the GitHub Release immediately, **before npm approval**. Ordinary retries never overwrite tags or existing GitHub Releases; the release is created only when it is missing. Public npm publication skips staging independently of the GitHub Release: a missing Release is repaired, or the run finishes without changes when both already exist. These published retries may retain an older tag without staging or generating provenance for newer source. An existing Release alone never skips npm staging.

**Existing staged versions cannot be skipped automatically with the workflow's OIDC credentials.** [npm documents](https://docs.npmjs.com/cli/v11/commands/npm-stage/#trust-relationship-permissions) that trust tokens can publish or stage but cannot list or view stages. A reserved npm version is not proof of successful staging, so retrying before approval may fail with a version reservation error, which is not ignored. Authentication, registry, and unknown staging errors also fail the run. Inspect the pending package at npm manually; approve it only if it is the intended artifact, then retry after it appears in the public registry. The workflow does not add a token secret or bypass npm approval.

If `master` has advanced past an unpublished version tag, ordinary `current` runs stop rather than moving the tag or attesting different source. Prefer a bump to release newer source as a new version. For an explicitly confirmed failed-release recovery, `recover_unpublished` defaults to **false** and is valid only with `current`. Checking it attests that you manually verified **no pending or approved npm stage, no public npm publication of this version, and no GitHub Release**. OIDC cannot verify stage absence; do not check this input if the stage state is unknown. A GitHub Release must not be deleted merely to bypass this safeguard.

To recover `0.3.0` after merging a fix into `master`:

1. Inspect [npm staged packages](https://www.npmjs.com/settings/rozsazoltan/staged-packages), npm's public versions, and GitHub Releases. Confirm there is no pending or approved stage, published `0.3.0`, or GitHub Release for `v0.3.0`. If any exists or its state is uncertain, stop; use the existing artifact or release a new version instead.
2. Open **Actions → Release → Run workflow**, select `master`, choose `release_type: current`, and check `recover_unpublished` only after that confirmation. Start a **new** run; rerunning the old run does not include the fix.
3. The workflow requires the old tag commit to be an ancestor of the new workflow SHA, with matching package name/version and lockfile. After checks succeed, it rechecks public npm/GitHub state and replaces the tag with an annotated tag at exactly that SHA using an atomic push and an explicit lease on the old remote tag object. A changed remote tag or unsupported atomic push fails; it never deletes the tag first. It then stages with provenance for that exact SHA; review and approve the new npm stage manually.

Recovery refuses an already public npm version or any GitHub Release and cannot automatically detect a concurrent/manual npm stage. Coordinate release operators; the human stage-absence confirmation must remain true until staging finishes. Registry/API errors fail closed. If tag protection disallows replacement, use a bump or separately review repository policy; the workflow does not bypass protection. An existing release or published version with a missing tag still requires manual recovery.

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
