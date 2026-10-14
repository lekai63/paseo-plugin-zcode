# paseo-plugin-zcode

[中文说明](README_CN.md)

A [Paseo](https://paseo.sh) provider plugin that registers **ZCode** (Z.ai's coding agent, backed by GLM) as an agent backend. It wraps the community [zcode-acp-server](https://github.com/william0wang/zcode-acp) ACP bridge with Paseo's `runAcpProvider()` shim — models, modes, permissions, steering and session resume come through the standard ACP capability mapping. The dependency is our maintained fork [lekai63/zcode-acp](https://github.com/lekai63/zcode-acp) (`paseo` branch: upstream plus the endpoint-origin fix).

## Prerequisites

- **Paseo >= 0.11.0** (daemon-resolved provider launch, provider `status`, and usage sources; use plugin v0.4.x on Paseo 0.8–0.10)
- Plugins enabled on the daemon: root-level `"pluginsEnabled": true` in `~/.paseo/config.json`, then `paseo reload`

The bridge installs itself: on `paseo plugin add` / `update`, the manifest `build` runs `npm ci --omit=dev --allow-git=all` inside the managed checkout, pulling the bridge from `git+https://github.com/lekai63/zcode-acp.git#paseo` per the committed lockfile. The checkout-local copy (`checkout/node_modules/zcode-acp-server`) is authoritative; a global install (`npm i -g zcode-acp-server`) is only a fallback.

`--allow-git=all` is needed because recent npm defaults to `allow-git=none` and refuses to fetch git dependencies.

## Install

```bash
paseo plugin add lianxin255/paseo-plugin-zcode
paseo plugin ls        # expect paseo-plugin-zcode = running
```

Then run agents as usual:

```bash
paseo run --provider zcode-acp "Fix the failing test"
```

## Usage source

The server entry registers a `zcode-acp` **usage source** (usage-source ids are daemon-wide), so GLM Coding Plan quota
appears in Paseo's Usage modal and sidebar usage next to the built-in sources
(5-hour and weekly as summary windows, MCP on the card). The data comes from
the same endpoint the ZCode desktop app uses
(`/api/monitor/usage/quota/limit`), with the active provider's apiKey from
`~/.zcode/v2/config.json` — the first enabled provider, or the one pinned by
`ZCODE_PROVIDER`, exactly like the bridge (`ZCODE_HOME` replaces `~/.zcode`).

The account is that provider (`ZCode · <provider>`); its key is a hash of the
config path and provider id, and the report inputs carry only that store
locator — `fetch` re-reads the apiKey on every call, and the daemon caches
reports for five minutes. Session-scoped discovery resolves `ZCODE_HOME` /
`ZCODE_PROVIDER` from the zcode session's own launch environment.

## Settings screens

**Settings → Plugins → ZCode (ACP)** has three screens. Their data comes from the plugin server, which runs the bridge's own `dist/` modules in a short-lived `node` child (plugin bundles cannot import the bridge's ESM modules directly).

- **Runtime**: the installed ZCode Desktop version (`app.asar` package.json, as the bridge reports it) and its bundled agent CLI, the bridge version and pinned commit, and Node.js / Bun.
  - **Check for updates** reads the official release manifest and links the packages for this platform. Installing a `.deb`/`.rpm` needs root, so it stays manual.
  - **Browser Use and Computer Use** switches both official plugins in ZCode's `cli/config.json`. They only work inside ZCode Desktop, and while either is on, every session also starts the node_repl helper: a session measured ~700 MB with it and ~490 MB without. The switch applies to sessions opened afterwards, and to ZCode Desktop and the ZCode CLI on the same machine.
- **Diagnostics** (read-only):
  - provider health and the latest official request-signing check from the agent log;
  - version consistency, including a stale `ZCODE_APP_VERSION` in the daemon environment;
  - each open session's process tree and memory (Linux `/proc`);
  - which providers have a key (never the key);
  - agent errors from the last hour, and the log and config paths.

- **Account**:
  - **Sign-in and plans:** whether ZCode's credential store on this machine is readable and signed in, and ZCode Desktop's verdict for each plan (Coding Plan, Start Plan). Signing in itself happens in ZCode Desktop.
  - **Reset cards:** for an available Coding Plan, the 5-hour and weekly reset cards left, with their nearest expiry and last use, next to the current window usage. Using a card takes two taps. The server requires the nonce from the latest status read, allows one spend per plan at a time, and derives the idempotency key from that nonce, so a retried tap never spends a second card.
  - **Model providers:** the built-in providers (read-only, managed by ZCode Desktop), and personal providers you can enable or disable, re-key or delete. **Add a provider** creates one from ZCode's bundled templates (Z.ai, BigModel, Kimi, MiniMax, DeepSeek, Alibaba Cloud, OpenAI, Anthropic, xAI, OpenRouter, OpenCode, …) the way ZCode Desktop does. The rule references the template, so the endpoint and model list stay ZCode's own, and the key keeps the template's access type (a Coding Plan template stays a Coding Plan provider).
  - Providers are stored in `~/.zcode/v2/provider_config.json`, shared with ZCode Desktop. The provider's catalog key tracks that file, so the model picker updates within a few seconds. Keys are only ever sent to the server, never returned.

## Sub-agent cards

`zcode` runs every `Agent`/`Task` dispatch as a child session. The bridge
(`zcode-acp`) tracks them — mirrored child tool events on the parent stream
plus the authoritative `session/subagents` directory — and publishes a vendor
notification (`_zcode/subagent`) per state change. The plugin's ACP transformer
(`server/subagents.ts`) turns each one into Paseo's native **sub-agent card**
(`ProviderToolCallDetail { type: "sub_agent" }`): bot icon,
`<type>: <description>` title, and an expandable activity log with the
sub-agent's tool calls, plus a usage footer (`n tools · n tokens · n s`).

The card reuses the dispatch's tool-call id, so it **merges with the `Agent`
card** the ACP stream already created instead of adding a second row; the
`Agent`/`Task` card simply becomes the sub-agent card. Editors that do not
understand the vendor method ignore it, so Zed/Martty behaviour is unchanged.

## Upgrade the bridge

The bridge is pinned to a commit of `lekai63/zcode-acp` (see `package-lock.json`). To upgrade, sync upstream on the fork's `paseo` branch, make the changes there, then update this repo's dependency ref and lockfile.

## Vendored ACP adapter (steer support, resume fix)

`server/acp-adapter/` is a vendored copy of paseo v0.11.2's `runAcpProvider` adapter (`packages/plugin/src/server/acp.ts` + `acp-internal/connection.ts`, Apache-2.0), carrying one local feature the stock shim lacks: **`prompt.steer`**. Paseo's default send behavior is `steer`, and the stock ACP adapter never advertises that capability, so a mid-turn message to an ACP-backed agent fails with "Provider does not support prompt.steer".

The fork steers instead of refusing: a `delivery: "steer"` prompt reuses the running turn's identity and reports `prompt_result { type: "steer" }`; `clearPendingPermissions` cancels outstanding permission popups first. Delivery is native when the bridge advertises it (`agentCapabilities._meta.zcode.guide`): the text goes to `_zcode/guide`, which hands it to the running ZCode turn as a guide — ZCode's own follow-up mode. The model reads it at its next step boundary (after the current tool batch, or right after a text step) without the turn being stopped, and the bridge keeps the running `session/prompt` open until the guided message got its reply. When the bridge declines (images or other non-text content, slash commands, no live backend turn), the fork falls back to preempting: it sends the message as a new `session/prompt` (the bridge stops the superseded backend turn), and a generation counter swallows the superseded request's terminal event so the turn never reads as cancelled.

It also fixes resume: upstream binds the native session id only after `session/load` answers, but an ACP agent replays the conversation as `session/update` notifications *before* that response, so the adapter's session-id guard dropped the whole replay and a resumed session (an unarchived agent, or any agent reopened after a daemon restart) showed an empty timeline. The fork binds the id before the load, drains queued notifications before reporting the session ready, and turns replayed `user_message_chunk`s into `user_message` items (live ones stay ignored — the adapter emits its own prompt item).

Upstream files are otherwise untouched apart from import paths and one constructor-parameter-property expansion (Node type-stripping is erasable-syntax only). When bumping `@getpaseo/plugin`, diff the pinned tag's two source files against the vendored copies and re-apply the `Local change vs upstream` markers. `server/acp-adapter.test.ts` covers both steer paths (guide and preempt fallback) and the history replay of a resumed session against a fake agent.

## How the bridge is resolved

Paseo evaluates plugin bundles with an injected `require` and no `__dirname`/`import.meta`, and the daemon can be hosted either by a node CLI install or by the desktop app (Electron). The plugin **prefers** the checkout-local copy `checkout/node_modules/zcode-acp-server/dist/cli.js` (paired with that checkout's `node`), and only falls back to the well-known npm global roots — fnm, nvm, `/usr/local`, Homebrew — when the checkout is missing. Nothing depends on `PATH`, so the provider works no matter how the daemon was started, and the bridge never launches through an Electron binary. If no install is found at all, the provider falls back to `zcode-acp-server` on `PATH`, and the daemon reports the miss as the provider's diagnostic (`paseo provider diagnostic zcode`) instead of the plugin failing to load.

The resolved `[node, cli.js]` pair is the provider's declared default `command`. The daemon resolves the effective launch from it — applying any `agents.providers.zcode` overrides — and the adapter spawns exactly that launch with the daemon's sanitized environment plus the per-session env. The provider's `status` additionally checks that the bridge script exists, since the daemon only verifies the `node` executable.

## Notes & limitations

- The provider id is `zcode-acp` (label "ZCode (ACP)"); the bare `zcode` id is left to providers that drive ZCode's Services Server directly, so both can be installed on one daemon. Agents created before the rename carry provider `zcode` and must be migrated to `zcode-acp` in the daemon's agent records. An `agents.providers.zcode-acp` entry in `~/.paseo/config.json` **without** `extends` customizes this plugin's provider (`enabled`, `command`, `env`, label, models); an entry **with** `extends` defines a separate provider that shadows the plugin.
- The first bridge start can take a while (npm warm-up); the plugin allows 180 s for the ACP handshake.
- The icon is Z.ai's official logo mark (source: `z-cdn.chatglm.cn/z-ai/static/logo.svg`), used nominatively to indicate which agent this plugin wraps. Not affiliated with or endorsed by Zhipu AI.

## License

[MIT](LICENSE)
