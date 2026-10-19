# paseo-plugin-zcode

[中文说明](README_CN.md)

A [Paseo](https://paseo.sh) provider plugin that registers **ZCode** (Z.ai's coding agent, backed by GLM) as an agent backend. It wraps the community [zcode-acp-server](https://www.npmjs.com/package/zcode-acp-server) ACP bridge with Paseo's `runAcpProvider()` shim — models, modes, permissions, steering and session resume come through the standard ACP capability mapping.

## Prerequisites

- **Paseo >= 0.8.0** (the provider plugin API does not exist in 0.7.x)
- **Node.js >= 22** on the daemon host (the bridge uses `node:sqlite`)
- The **ZCode desktop app or CLI** installed and signed in (credentials at `~/.zcode/v2/config.json`)
- Plugins enabled on the daemon: root-level `"pluginsEnabled": true` in `~/.paseo/config.json`, then `paseo reload`

The bridge installs itself: on `paseo plugin add` / `update`, the manifest `build` runs `npm ci --omit=dev` inside the managed checkout, which pulls the `zcode-acp-server` version pinned in this repo's lockfile (currently ^0.72.0). A global install (`npm i -g zcode-acp-server`) is optional — the plugin prefers the checkout-local copy (under `checkout/node_modules/`) and falls back to well-known global roots.

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

The checkout-local copy wins, so upgrading the bridge means updating this plugin:

```bash
paseo plugin update paseo-plugin-zcode   # re-runs npm ci from the committed lockfile
```

To pull a newer bridge than the lockfile pins, bump `zcode-acp-server` in `package.json`, regenerate the lockfile, and release; or install a newer bridge globally and remove the checkout copy (not recommended — the global copy then becomes invisible to `paseo plugin update`).

## How the bridge is resolved

Paseo evaluates plugin bundles with an injected `require` and no `__dirname`/`import.meta`, and the daemon can be hosted either by a node CLI install or by the desktop app (Electron). The plugin locates the bridge by scanning the well-known npm global roots — fnm, nvm, mise, Volta, scoop, `/usr/local`, Homebrew, apt, linuxbrew, the Windows `nodejs`/`%APPDATA%` layouts — with the worker-script anchor (`createRequire(process.argv[1])`) tried first. It then runs the bridge with a node binary chosen by a live `require('node:sqlite')` probe (Node ≥ 22), so it never launches through the Electron binary when the daemon is app-hosted. The bridge is started through a generated `zcode-acp-server` shim that sets `ZCODE_BIN` before importing the real entry, on every platform. Nothing depends on `PATH` for the bridge itself, so the provider works no matter how the daemon was started.

If the bridge cannot be found, the provider reports `unavailable` with an install hint instead of failing the whole plugin load, so `paseo provider ls` shows the reason.

## Notes & limitations

- The provider id is `zcode`. A `providers.zcode` entry in `~/.paseo/config.json` would collide — remove it before installing.
- The first bridge start can take a while (npm warm-up); the plugin allows 180 s for the ACP handshake.
- ZCode's app-bundle CLI is reached through an extensionless symlink (macOS/Linux) or a `.cmd` shim (Windows), so the bridge's own provider-table injection misses it and the backend dies at boot with "无法定位 CLI ZCode Built-in Provider Config". The plugin works around this on **all platforms**: it resolves the real `zcode.cjs` and launches the bridge through a generated `zcode-acp-server` shim that sets `ZCODE_BIN` before importing the bridge. This needs the ZCode desktop app installed at its default location (`/Applications/ZCode.app`, `%LOCALAPPDATA%\Programs\ZCode`) or a `zcode` entry on `PATH` that resolves to a `.cjs`/`.js` file. If yours is a non-standard layout, set `agents.providers.zcode.env.ZCODE_BIN` to the real `zcode.cjs` yourself.
- The icon is Z.ai's official logo mark (source: `z-cdn.chatglm.cn/z-ai/static/logo.svg`), used nominatively to indicate which agent this plugin wraps. Not affiliated with or endorsed by Zhipu AI.

## License

[MIT](LICENSE)
