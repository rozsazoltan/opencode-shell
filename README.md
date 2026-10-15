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

## What to know

- Use only trusted mise projects: resolving their environment may run scripts before shell permission approval. Mise can add or override variables here, but cannot unset inherited ones (`env.VAR = false`).
- RTK rewrites supported commands; OpenCode checks permissions against the **rewritten command**, which may need separate approval. RTK's allow decision never grants host permission; a deny result stops execution.
- Complex PowerShell commands and unsupported shells are left unchanged.
- RTK supports custom filters in a project's `.rtk/filters.toml` or the user's `~/.config/rtk/filters.toml`. Trust the relevant global and local configuration with `rtk trust`; configuration edits require trusting it again.

## Versions

Find published versions on [npm](https://www.npmjs.com/package/@rozsazoltan/opencode-shell) and changes in [GitHub Releases](https://github.com/rozsazoltan/opencode-shell/releases). Versions follow SemVer.

## Contributing

Use Node 24 and npm to install dependencies and run the existing checks:

```sh
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

For a local OpenCode check, set `"plugins": ["/absolute/path/opencode-shell/src"]` in a test project's `opencode.jsonc`. In a trusted mise project, add `OPENCODE_SHELL_SMOKE = "one"` under `[env]` and ask the agent to run `printenv OPENCODE_SHELL_SMOKE` with the native shell tool (PowerShell: `$env:OPENCODE_SHELL_SMOKE`). With RTK installed, run `git log -30` the same way and check for an RTK rewrite.

## License and acknowledgements

AGPL-3.0-or-later: this work is licensed under the GNU Affero General Public License, version 3 or any later version. See [LICENSE](LICENSE).

Thanks to [rtk-ai/rtk](https://github.com/rtk-ai/rtk) for RTK, [jdx/mise](https://github.com/jdx/mise), and [VincentHardouin/opencode-snip](https://github.com/VincentHardouin/opencode-snip) for the original plugin inspiration. [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) contains the original plugin's MIT notice.
