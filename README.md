# paseo-plugin-zcode

[English](#english) | [中文](#中文)

<a id="english"></a>

## English

A [Paseo](https://paseo.sh) provider plugin that registers **ZCode** (Z.ai's coding agent, backed by GLM) as an agent backend. It wraps the community [zcode-acp-server](https://www.npmjs.com/package/zcode-acp-server) ACP bridge with Paseo's `runAcpProvider()` shim — models, modes, permissions, steering and session resume come through the standard ACP capability mapping.

### Prerequisites

- **Paseo >= 0.8.0** (the provider plugin API does not exist in 0.7.x)
- **The bridge installed from npm**: `npm i -g zcode-acp-server`
- Plugins enabled on the daemon: root-level `"pluginsEnabled": true` in `~/.paseo/config.json`, then `paseo reload`

### Install

```bash
paseo plugin add lianxin255/paseo-plugin-zcode
paseo plugin ls        # expect paseo-plugin-zcode = running
```

Then run agents as usual:

```bash
paseo run --provider zcode "Fix the failing test"
```

### Upgrade the bridge

```bash
npm i -g zcode-acp-server@latest   # the plugin picks it up as-is
```

### How the bridge is resolved

Paseo executes plugin bundles with an injected `require` and no `__dirname`/`import.meta`. This plugin resolves the bridge entry via `createRequire(process.argv[1])` — the worker script's module ancestor chain covers the npm global install directory — and launches it as `[process.execPath, <cli.js>]`. Nothing depends on `PATH`, so the provider works no matter how the daemon was started (CLI, launchd, GUI).

### Notes & limitations

- The provider id is `zcode`. A `providers.zcode` entry in `~/.paseo/config.json` would collide — remove it before installing.
- The first bridge start can take a while (npm warm-up); the plugin allows 180 s for the ACP handshake.
- The icon is Z.ai's official logo mark (source: `z-cdn.chatglm.cn/z-ai/static/logo.svg`), used nominatively to indicate which agent this plugin wraps. Not affiliated with or endorsed by Zhipu AI.

<a id="中文"></a>

## 中文

一个 [Paseo](https://paseo.sh) 的 provider 插件，把 **ZCode**（智谱 Z.ai 的编码 agent，GLM 驱动）注册为 agent 后端。内部用 Paseo 的 `runAcpProvider()` 包装社区桥 [zcode-acp-server](https://www.npmjs.com/package/zcode-acp-server)——模型、模式、权限、插话（steering）和续话都走标准 ACP 能力映射。

### 前置条件

- **Paseo >= 0.8.0**（provider 插件 API 是 0.8 新增，0.7.x 没有）
- **从 npm 安装桥**：`npm i -g zcode-acp-server`
- daemon 开启插件：`~/.paseo/config.json` 根级 `"pluginsEnabled": true`，然后 `paseo reload`

### 安装

```bash
paseo plugin add lianxin255/paseo-plugin-zcode
paseo plugin ls        # 期望 paseo-plugin-zcode = running
```

然后正常派活：

```bash
paseo run --provider zcode "修复失败的测试"
```

### 升级桥

```bash
npm i -g zcode-acp-server@latest   # 插件自动使用新版本
```

### 桥的解析机制

Paseo 以注入 `require`、无 `__dirname`/`import.meta` 的方式执行插件 bundle。本插件用 `createRequire(process.argv[1])` 定位桥入口——plugin worker 脚本的 node_modules 祖先链覆盖 npm 全局安装目录——并以 `[process.execPath, <cli.js>]` 启动。全程不依赖 `PATH`，无论 daemon 由 CLI、launchd 还是 GUI 拉起都能工作。

### 已知限制

- provider id 为 `zcode`，会与 `~/.paseo/config.json` 里的 `providers.zcode` 条目冲突——安装前请删除旧条目。
- 桥首次启动可能较慢（npm 预热），插件为 ACP 握手预留了 180 秒。
- 图标为 Z.ai 官方 logo（来源：`z-cdn.chatglm.cn/z-ai/static/logo.svg`），仅用于指示本插件所包装的 agent。与智谱 AI 无隶属或背书关系。

## License

[MIT](LICENSE)
