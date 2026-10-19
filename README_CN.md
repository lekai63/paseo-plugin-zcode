# paseo-plugin-zcode

[English](README.md)

一个 [Paseo](https://paseo.sh) 的 provider 插件，把 **ZCode**（智谱 Z.ai 的编码 agent，GLM 驱动）注册为 agent 后端。内部用 Paseo 的 `runAcpProvider()` 包装社区桥 [zcode-acp-server](https://www.npmjs.com/package/zcode-acp-server)——模型、模式、权限、插话（steering）和续话都走标准 ACP 能力映射。

## 前置条件

- **Paseo >= 0.8.0**（provider 插件 API 是 0.8 新增，0.7.x 没有）
- daemon 主机上 **Node.js >= 22**（桥使用 `node:sqlite`）
- daemon 开启插件：`~/.paseo/config.json` 根级 `"pluginsEnabled": true`，然后 `paseo reload`

桥会自动安装：`paseo plugin add` / `update` 时，manifest 的 `build` 会在托管检出目录里执行 `npm ci --omit=dev`，按仓库锁文件拉取 `zcode-acp-server`（当前锁定 ^0.72.0）。全局安装（`npm i -g zcode-acp-server`）变为可选——插件优先使用检出内副本（位于 `checkout/node_modules/` 下），其次回退到常见全局根目录。

## 安装

```bash
paseo plugin add lianxin255/paseo-plugin-zcode
paseo plugin ls        # 期望 paseo-plugin-zcode = running
```

然后正常派活：

```bash
paseo run --provider zcode "修复失败的测试"
```

## 升级桥

检出内副本优先，所以升级桥就是升级本插件：

```bash
paseo plugin update paseo-plugin-zcode   # 按仓库锁文件重新 npm ci
```

想用比锁文件更新的桥：改 `package.json` 里 `zcode-acp-server` 版本、重新生成锁文件并发版；或全局装新版后删掉检出内副本（不推荐——全局副本从此不受 `paseo plugin update` 管）。

## 桥的解析机制

Paseo 以注入 `require`、无 `__dirname`/`import.meta` 的方式执行插件 bundle，且 daemon 可能由 node CLI 安装或桌面 app（Electron）托管。本插件因此改为扫描常见 npm 全局根目录（fnm、nvm、mise、`/usr/local`、Homebrew），并配对各根目录自带的 `node` 二进制；worker 脚本锚点（`createRequire(process.argv[1])`）作为首选尝试。检出内副本没有归属的全局根目录，因此会配对已安装的、主版本号 >= 22 的最新 `node` 二进制（桥需要 `node:sqlite` 等 22+ API）。全程不依赖 `PATH`，无论 daemon 由谁拉起都能工作，桥也永远不会经由 Electron 二进制启动。

找不到桥时，provider 会报告 `unavailable` 并附安装提示，而不是让整个插件加载失败——`paseo provider ls` 能直接看到原因。

## 已知限制

- provider id 为 `zcode`，会与 `~/.paseo/config.json` 里的 `providers.zcode` 条目冲突——安装前请删除旧条目。
- 桥首次启动可能较慢（npm 预热），插件为 ACP 握手预留了 180 秒。
- 图标为 Z.ai 官方 logo（来源：`z-cdn.chatglm.cn/z-ai/static/logo.svg`），仅用于指示本插件所包装的 agent。与智谱 AI 无隶属或背书关系。

## 许可证

[MIT](LICENSE)
