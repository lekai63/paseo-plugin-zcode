# paseo-plugin-zcode

[中文说明](README_CN.md)

A [Paseo](https://paseo.sh) provider plugin that registers **ZCode** (Z.ai's coding agent, backed by GLM) as an agent backend. It wraps the community [zcode-acp-server](https://www.npmjs.com/package/zcode-acp-server) ACP bridge with Paseo's `runAcpProvider()` shim — models, modes, permissions, steering and session resume come through the standard ACP capability mapping.

## Prerequisites

- **Paseo >= 0.8.0** (the provider plugin API does not exist in 0.7.x)
- Plugins enabled on the daemon: root-level `"pluginsEnabled": true` in `~/.paseo/config.json`, then `paseo reload`

The bridge installs itself: on `paseo plugin add` / `update`, the manifest `build` runs `npm ci --omit=dev` inside the managed checkout, which pulls `zcode-acp-server` from the committed lockfile. A global install (`npm i -g zcode-acp-server`) is optional — the plugin prefers the checkout-local copy and falls back to well-known global roots.

## Install

```bash
paseo plugin add lianxin255/paseo-plugin-zcode
paseo plugin ls        # expect paseo-plugin-zcode = running
```

Then run agents as usual:

```bash
paseo run --provider zcode "Fix the failing test"
```

## Upgrade the bridge

```bash
npm i -g zcode-acp-server@latest   # the plugin picks it up as-is
```

## How the bridge is resolved

Paseo evaluates plugin bundles with an injected `require` and no `__dirname`/`import.meta`, and the daemon can be hosted either by a node CLI install or by the desktop app (Electron). The plugin therefore locates the bridge by scanning the well-known npm global roots — fnm, nvm, `/usr/local`, Homebrew — pairing each root with its own `node` binary, with the worker-script anchor (`createRequire(process.argv[1])`) tried first. Nothing depends on `PATH`, so the provider works no matter how the daemon was started, and the bridge never launches through an Electron binary.

## Notes & limitations

- The provider id is `zcode`. A `providers.zcode` entry in `~/.paseo/config.json` would collide — remove it before installing.
- The first bridge start can take a while (npm warm-up); the plugin allows 180 s for the ACP handshake.
- The icon is Z.ai's official logo mark (source: `z-cdn.chatglm.cn/z-ai/static/logo.svg`), used nominatively to indicate which agent this plugin wraps. Not affiliated with or endorsed by Zhipu AI.

## License

[MIT](LICENSE)
