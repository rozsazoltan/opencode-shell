# opencode-shell

Minimal OpenCode V2 plugin that automatically applies [mise](https://github.com/jdx/mise) project environments to native shell execution and optionally filters supported commands with [snip](https://github.com/edouard-claude/snip).

Install mise and/or snip separately. Once `opencode-shell` is published to npm, enable it in your OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-shell"]
}
```

Mise works independently of snip; separately installed snip is resolved on the resulting PATH or from the server user's `~/bin` if absent from PATH. Missing tools are not automatically installed and configurations are not automatically trusted. Only use trusted mise project configurations: environment resolution can execute their scripts and project hooks before shell permission approval. Resolution is refreshed for each invocation; failures leave the existing environment intact.

The plugin uses the documented `mise env --json` interface without requiring Node or another child runtime. It applies environment additions, overrides and PATH changes, but **cannot remove inherited variables**: mise's JSON output does not report removals. Projects relying on `env.VAR = false` must not rely on this plugin to unset that variable.

Automatic `snip run` wrapping uses the native V2 `shell.create.before` hook. OpenCode's permission scanner sees the **wrapped command**, not the original command; existing command-specific rules may match differently or require additional approval. The plugin does not approve requests or change permission rules.

Bash, Zsh and POSIX shells use snip's conservative rewrite engine. PowerShell supports only simple bare commands, with the required `&` operator for quoted executable paths. Unsupported shell dialects remain unchanged. Pipes, redirections and complex PowerShell expressions are not forcibly wrapped.

## Development checks

Use Node 24 and npm:

```sh
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

Unit tests mock external processes; also verify behavior in OpenCode:

## Local smoke test (no npm publication needed)

1. In a test project's `opencode.jsonc`, load this checkout's source using an absolute path visible to the OpenCode server (use the Linux path for a WSL server):

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["/absolute/path/opencode-shell/src/index.ts"]
   }
   ```

2. In a trusted mise project, set `[env]` marker `OPENCODE_SHELL_SMOKE = "one"`. Ask the agent to run `printenv OPENCODE_SHELL_SMOKE` with the native shell tool (PowerShell: `$env:OPENCODE_SHELL_SMOKE`); expect `one`. Change it to `two` and repeat; expect `two`.
3. With snip installed in the server environment, ask the agent to run `git log -30` with the native shell tool. Expect a `snip run --` wrapper and filtered output; check `snip gain` in the same environment. `snip check -- cargo test` checks filter support without running a large test suite. If the command stays unwrapped, check the server PATH or `~/bin/snip`; unsupported commands and snip failures are left unchanged.
4. On PowerShell, a quoted snip executable should run via `& '...snip.exe' run -- git status` without a parser error; pipelines stay unwrapped.

## License and acknowledgements

AGPL-3.0-or-later: this work is licensed under the GNU Affero General Public License, version 3 or any later version. See [LICENSE](LICENSE).

Based on Vincent Hardouin's [opencode-snip](https://github.com/VincentHardouin/opencode-snip), with its original MIT notice preserved in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES). Thanks to **jdx/mise** and **edouard-claude/snip**.
