# paseo-plugin-zcode

[English](README.md)

一个 [Paseo](https://paseo.sh) 的 provider 插件，把 **ZCode**（智谱 Z.ai 的编码 agent，GLM 驱动）注册为 agent 后端。内部用 Paseo 的 `runAcpProvider()` 包装社区桥 [zcode-acp-server](https://github.com/william0wang/zcode-acp)——模型、模式、权限、插话（steering）和续话都走标准 ACP 能力映射。依赖的是我们维护的 fork [lekai63/zcode-acp](https://github.com/lekai63/zcode-acp)（`paseo` 分支，上游 + 端点 origin 修复）。

## 前置条件

- **Paseo >= 0.8.0**（provider 插件 API 是 0.8 新增，0.7.x 没有）
- daemon 开启插件：`~/.paseo/config.json` 根级 `"pluginsEnabled": true`，然后 `paseo reload`

桥会自动安装：`paseo plugin add` / `update` 时，manifest 的 `build` 会在托管检出目录里执行 `npm ci --omit=dev --allow-git=all`，按仓库锁文件从 `git+https://github.com/lekai63/zcode-acp.git#paseo` 拉取桥。检出内副本（`checkout/node_modules/zcode-acp-server`）是权威版本；全局安装（`npm i -g zcode-acp-server`）只作为回退。

`--allow-git=all` 是因为较新的 npm 默认 `allow-git=none`，会拒绝拉取 git 依赖。

## 安装

```bash
paseo plugin add lianxin255/paseo-plugin-zcode
paseo plugin ls        # 期望 paseo-plugin-zcode = running
```

然后正常派活：

```bash
paseo run --provider zcode "修复失败的测试"
```

## 配额 pill

client 入口会为每个 `zcode` agent 在输入框（context meter 旁）加一个 pill：标签实时显示 GLM Coding Plan **5 小时窗口**的剩余百分比；点开后可看到配额 API 返回的全部窗口（5h、weekly、MCP）的已用/剩余进度条和重置倒计时。数据来自 ZCode 桌面端同款接口 `/api/monitor/usage/quota/limit`，读取 `~/.zcode/v2/config.json` 中当前启用 provider 的 apiKey（第一个 enabled 的 provider，或被 `ZCODE_PROVIDER` 指定的那个，与桥的选取规则一致）。插件 server 端缓存 10 秒，client 每分钟轮询一次，popover 里的 **Refresh** 会绕过缓存强制刷新。

## 升级桥

桥锁定在 `lekai63/zcode-acp` 的提交（见 `package-lock.json`）。要升级：在 fork 的 `paseo` 分支上同步上游并修改，然后更新本仓库的依赖 ref 与锁文件。

## 桥的解析机制

Paseo 以注入 `require`、无 `__dirname`/`import.meta` 的方式执行插件 bundle，且 daemon 可能由 node CLI 安装或桌面 app（Electron）托管。插件**优先**使用检出内的桥副本 `checkout/node_modules/zcode-acp-server/dist/cli.js`（配对该检出所用的 `node`），只有在检出缺失时才回退到常见 npm 全局根目录（fnm、nvm、`/usr/local`、Homebrew）。全程不依赖 `PATH`，桥也永远不会经由 Electron 二进制启动。

## 已知限制

- provider id 为 `zcode`，会与 `~/.paseo/config.json` 里的 `providers.zcode` 条目冲突——安装前请删除旧条目。
- 桥首次启动可能较慢（npm 预热），插件为 ACP 握手预留了 180 秒。
- 图标为 Z.ai 官方 logo（来源：`z-cdn.chatglm.cn/z-ai/static/logo.svg`），仅用于指示本插件所包装的 agent。与智谱 AI 无隶属或背书关系。

## 许可证

[MIT](LICENSE)
