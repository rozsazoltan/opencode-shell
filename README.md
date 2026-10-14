# opencode-shell

Minimal OpenCode V2 plugin that automatically applies [mise](https://github.com/jdx/mise) project environments to native shell execution and optionally filters supported commands with [snip](https://github.com/edouard-claude/snip).

Install mise and/or snip separately. Once `opencode-shell` is published to npm, enable it in your OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-shell"]
}
```

Mise works independently of snip; separately installed snip is resolved on the resulting PATH. Missing tools are not automatically installed and configurations are not automatically trusted. Only use trusted mise project configurations: environment resolution can execute their scripts and project hooks before shell permission approval. Resolution is refreshed for each invocation; failures leave the existing environment intact.

The plugin uses the documented `mise env --json` interface without requiring Node or another child runtime. It applies environment additions, overrides and PATH changes, but **cannot remove inherited variables**: mise's JSON output does not report removals. Projects relying on `env.VAR = false` must not rely on this plugin to unset that variable.

Automatic `snip run` wrapping uses the native V2 `shell.create.before` hook. OpenCode's permission scanner sees the **wrapped command**, not the original command; existing command-specific rules may match differently or require additional approval. The plugin does not approve requests or change permission rules.

Bash, Zsh and POSIX shells use snip's conservative rewrite engine. PowerShell supports only simple bare commands, with the required `&` operator for quoted executable paths. Unsupported shell dialects remain unchanged. Pipes, redirections and complex PowerShell expressions are not forcibly wrapped.

Development: Node 24, `npm ci`, `npm run typecheck`, `npm test`.

## License and acknowledgements

AGPL-3.0-or-later: this work is licensed under the GNU Affero General Public License, version 3 or any later version. See [LICENSE](LICENSE).

Based on Vincent Hardouin's [opencode-snip](https://github.com/VincentHardouin/opencode-snip), with its original MIT notice preserved in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES). Thanks to **jdx/mise** and **edouard-claude/snip**.
