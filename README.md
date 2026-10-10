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
paseo run --provider zcode "Fix the failing test"
```

## Quota pill

The client entry adds a composer pill to every `zcode` agent, next to the
context meter. The pill label shows the GLM Coding Plan **5-hour** remaining
percentage; opening it lists every window the quota API reports (5h, weekly,
MCP) with used/left bars and reset countdowns. The data comes from the same
endpoint the ZCode desktop app uses (`/api/monitor/usage/quota/limit`), reading
the active provider's apiKey from `~/.zcode/v2/config.json` — the first enabled
provider, or the one pinned by `ZCODE_PROVIDER`, exactly like the bridge. The
plugin server caches snapshots for 10 s and the client polls once a minute; the
popover's **Refresh** button bypasses the cache.

## Usage source

The server entry also registers a `zcode` **usage source**, so the same GLM
Coding Plan windows appear in Paseo's Usage modal and sidebar usage next to the
built-in sources (5-hour and weekly as summary windows, MCP on the card). The
account is the active ZCode provider (`ZCode · <provider>`); its key is a hash
of the config path and provider id, and the report inputs carry only that
store locator — `fetch` re-reads the apiKey on every call. Session-scoped
discovery resolves `ZCODE_HOME` / `ZCODE_PROVIDER` from the zcode session's own
launch environment. The pill and the usage source share one per-login cache, so
they never double the upstream requests.

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

## Vendored ACP adapter (steer support)

`server/acp-adapter/` is a vendored copy of paseo v0.11.2's `runAcpProvider` adapter (`packages/plugin/src/server/acp.ts` + `acp-internal/connection.ts`, Apache-2.0), carrying one local feature the stock shim lacks: **`prompt.steer`**. Paseo's default send behavior is `steer`, and the stock ACP adapter never advertises that capability, so a mid-turn message to an ACP-backed agent fails with "Provider does not support prompt.steer".

The fork steers instead of refusing: a `delivery: "steer"` prompt reuses the running turn's identity, sends the new `session/prompt` straight away (the zcode-acp bridge preempts the superseded backend turn), reports `prompt_result { type: "steer" }`, and a generation counter swallows the superseded request's terminal event so the turn never reads as cancelled. `clearPendingPermissions` cancels outstanding permission popups before steering. This is preempt-based steering — the model re-runs with full history — not mid-generation injection (app-server 0.16+ has no inject API).

Upstream files are otherwise untouched apart from import paths and one constructor-parameter-property expansion (Node type-stripping is erasable-syntax only). When bumping `@getpaseo/plugin`, diff the pinned tag's two source files against the vendored copies and re-apply the `Local change vs upstream` markers. `server/acp-adapter.test.ts` covers the steer contract against a fake preempting agent.

## How the bridge is resolved

Paseo evaluates plugin bundles with an injected `require` and no `__dirname`/`import.meta`, and the daemon can be hosted either by a node CLI install or by the desktop app (Electron). The plugin **prefers** the checkout-local copy `checkout/node_modules/zcode-acp-server/dist/cli.js` (paired with that checkout's `node`), and only falls back to the well-known npm global roots — fnm, nvm, `/usr/local`, Homebrew — when the checkout is missing. Nothing depends on `PATH`, so the provider works no matter how the daemon was started, and the bridge never launches through an Electron binary. If no install is found at all, the provider falls back to `zcode-acp-server` on `PATH`, and the daemon reports the miss as the provider's diagnostic (`paseo provider diagnostic zcode`) instead of the plugin failing to load.

The resolved `[node, cli.js]` pair is the provider's declared default `command`. The daemon resolves the effective launch from it — applying any `agents.providers.zcode` overrides — and the adapter spawns exactly that launch with the daemon's sanitized environment plus the per-session env. The provider's `status` additionally checks that the bridge script exists, since the daemon only verifies the `node` executable.

## Notes & limitations

- The provider id is `zcode`. An `agents.providers.zcode` entry in `~/.paseo/config.json` **without** `extends` customizes this plugin's provider (`enabled`, `command`, `env`, label, models); an entry **with** `extends` defines a separate provider that shadows the plugin.
- The first bridge start can take a while (npm warm-up); the plugin allows 180 s for the ACP handshake.
- The icon is Z.ai's official logo mark (source: `z-cdn.chatglm.cn/z-ai/static/logo.svg`), used nominatively to indicate which agent this plugin wraps. Not affiliated with or endorsed by Zhipu AI.

## License

[MIT](LICENSE)
