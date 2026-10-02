# OpenCode V2 plugins

Personal OpenCode plugins. The `v2` branch contains the V2 implementations; `main` retains the V1 plugins.

## Plugins

- **session-tools**: List recorded sessions and extract relevant context from another session using a model request.
- **github-pr**: Watch GitHub PR reviews, comments, checks, merges, and closures from an OpenCode session. Requires an authenticated `gh` CLI. See [its README](plugins/github-pr/README.md).
- **jev**: Delegate structured decisions to TypeSafe's hosted Jev API. Requires a separately configured API key. See [its README](plugins/jev/README.md).
- **ddgs**: Register a DuckDuckGo websearch provider with page extraction. Requires the `ddgs` Python CLI on the OpenCode service's PATH.

## Setup

Requires OpenCode V2 and Bun. Clone this repository and install its dependencies:

```sh
git clone --branch v2 git@github.com:blaknite/opencode-plugins.git
cd opencode-plugins
bun install --frozen-lockfile
```

Add the plugin directories to `plugins` in your existing global `~/.config/opencode/opencode.jsonc`, replacing `/path/to/opencode-plugins` with your checkout path:

```jsonc
{
  "plugins": [
    "/path/to/opencode-plugins/plugins/session-tools",
    "/path/to/opencode-plugins/plugins/github-pr",
    "/path/to/opencode-plugins/plugins/jev",
    "/path/to/opencode-plugins/integrations/ddgs"
  ]
}
```

Only enable the plugins you want. DDGS selects itself as the default websearch provider when loaded. Avoid also copying these plugins into OpenCode's automatically discovered plugin directory, which would load them twice.

Restart the OpenCode service after changing plugin configuration:

```sh
opencode service restart
```

To sync another machine, check out `v2`, pull updates, and run `bun install --frozen-lockfile`. Configure credentials and external CLI authentication separately on each machine.

This repository contains plugin source, tests, documentation, and dependency metadata only. Personal OpenCode configuration, prompts, commands, skills, credentials, service files, and runtime state are not synced here.

## Verification

```sh
bun run test
bun run typecheck
```
