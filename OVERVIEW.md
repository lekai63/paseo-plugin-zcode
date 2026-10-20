# paseo-plugin-zcode

Paseo provider plugin that adds **ZCode** (Z.ai's GLM coding agent) as an agent
backend by wrapping the `zcode-acp-server` ACP bridge — the maintained fork
[lekai63/zcode-acp](https://github.com/lekai63/zcode-acp) (`paseo` branch).
Models, modes, permissions, resume, steering and streaming run over the
standard Agent Client Protocol.

## What you get

- A `zcode-acp` provider in Paseo: streaming turns, editing modes (Plan /
  Build / Edit / Guarded / Yolo), permission prompts, session resume,
  mid-turn steering, native sub-agent cards, and model and thinking catalogs
  discovered live from your ZCode install.
- A GLM Coding Plan usage card in the Usage screen and `paseo usage`.
- Settings → Plugins → ZCode (ACP) screens: runtime info and update checks,
  diagnostics, and account management (plans, reset cards, model providers).
- ZCode owns everything else: sign-in, credentials, tools, model access and
  conversation storage stay in `~/.zcode`, exactly as in the ZCode desktop
  app. No API keys are configured in Paseo.

## Requirements

Paseo ≥ 0.11.0 on the daemon; Node.js ≥ 22 on the daemon host; ZCode (desktop
app or CLI) installed and signed in; plugins enabled
(`"pluginsEnabled": true` in `~/.paseo/config.json`).

> This plugin registers the provider id `zcode-acp` (label "ZCode (ACP)"), so
> it can coexist on one daemon with providers that drive ZCode's Services
> Server under the bare `zcode` id (e.g. the registry's
> supermomonga/zcode-provider).

## How it works and where data goes

1. Installation prepares the checkout with `npm ci --omit=dev
   --allow-git=all` (committed lockfile), installing the pinned bridge from
   `git+https://github.com/lekai63/zcode-acp.git#paseo` (Apache-2.0).
2. On load, the plugin finds the bridge (its own checkout copy first, then
   well-known npm global roots) and launches it as `[node, cli.js]` — never
   through an Electron binary, and never depending on `PATH`.
3. The bridge itself resolves the ZCode CLI entry (`zcode` on PATH,
   realpathed, or the desktop-app bundle locations), injects the provider-table
   env the CLI needs to boot, and spawns `zcode app-server --stdio`; Paseo
   talks ACP to the bridge. `ZCODE_BIN` in
   `agents.providers.zcode-acp.env` overrides the discovery.
4. Model requests and authentication are handled by ZCode itself against the
   Z.ai/BigModel endpoints you are signed into — the plugin adds no network
   hops. The only request the plugin itself makes is a GET of the official GLM
   quota endpoint (`open.bigmodel.cn` / `api.z.ai`) to populate the usage card.
   That request is sent **only when the active ZCode provider's base URL is
   exactly one of those two official hosts**; for any other provider
   (custom gateways, self-hosted or local endpoints) the card reports
   `unavailable` without contacting the network, so a third-party key is never
   attached to an official endpoint. The plugin sends nothing else and has no
   telemetry of its own.

The bridge this plugin launches has two network behaviors of its own, both
inherited from `zcode-acp-server` and independent of this plugin:
it makes one anonymous workflow-config request carrying only platform and
version information, and it can run a remote-access mode (a relay for phone and
web clients) that stays **off** unless you explicitly configure it with a token.
Neither is enabled or triggered by this plugin.

Unofficial integration; not affiliated with or endorsed by Zhipu AI / Z.ai.

## More

README.md (English) and README_CN.md (Chinese) cover configuration overrides
(`agents.providers.zcode-acp.env.ZCODE_BIN`), troubleshooting, and the
development workflow (`npm run smoke` drives a real ACP session).
