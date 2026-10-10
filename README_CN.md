# paseo-plugin-zcode

[English](README.md)

一个 [Paseo](https://paseo.sh) 的 provider 插件，把 **ZCode**（智谱 Z.ai 的编码 agent，GLM 驱动）注册为 agent 后端。内部用 Paseo 的 `runAcpProvider()` 包装社区桥 [zcode-acp-server](https://github.com/william0wang/zcode-acp)——模型、模式、权限、插话（steering）和续话都走标准 ACP 能力映射。依赖的是我们维护的 fork [lekai63/zcode-acp](https://github.com/lekai63/zcode-acp)（`paseo` 分支，上游 + 端点 origin 修复）。

## 前置条件

- **Paseo >= 0.11.0**（依赖 daemon 解析的 provider 启动命令、provider `status` 与 usage source；Paseo 0.8–0.10 请使用插件 v0.4.x）
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
paseo run --provider zcode-acp "修复失败的测试"
```

## 用量来源（usage source）

server 入口注册了一个 `zcode-acp` **usage source**（usage source 的 id 在整个 daemon 内唯一），GLM Coding Plan 配额会出现在 Paseo 的 Usage 弹窗和侧边栏用量里，与内置来源并列（5h 和 weekly 为摘要窗口，MCP 显示在卡片中）。数据来自 ZCode 桌面端同款接口 `/api/monitor/usage/quota/limit`，读取 `~/.zcode/v2/config.json` 中当前启用 provider 的 apiKey（第一个 enabled 的 provider，或被 `ZCODE_PROVIDER` 指定的那个，与桥的选取规则一致；`ZCODE_HOME` 会替换 `~/.zcode`）。

账号即该 provider（`ZCode · <provider>`），账号 key 是配置路径 + provider id 的哈希，上报的 input 只包含这个存储定位符——`fetch` 每次都重新读取 apiKey，daemon 会把报告缓存五分钟。会话级发现会从该 zcode 会话自己的启动环境里解析 `ZCODE_HOME` / `ZCODE_PROVIDER`。

## 子代理(subagent)卡片

`zcode` 每次通过 `Agent`/`Task` 派发子代理时，子代理都跑在独立子会话里。桥（`zcode-acp`）会跟踪它们——父会话流上镜像出来的子会话工具事件，加上权威目录 `session/subagents`——并在每次状态变化时发出供应商通知 `_zcode/subagent`。插件的 ACP transformer（`server/subagents.ts`）把它转换成 Paseo 原生的**子代理卡片**（`ProviderToolCallDetail { type: "sub_agent" }`）：机器人图标、`<类型>: <描述>` 标题、可展开的活动日志（子代理自己的工具调用），以及用量页脚（`n tools · n tokens · n s`）。

卡片复用派发那一次的 tool call id，因此会**与 ACP 流里已有的 `Agent` 卡片合并**，而不是多出一行——那张 `Agent`/`Task` 卡片直接变成子代理卡片。不认识该 vendor 方法的编辑器会忽略它，Zed/Martty 的行为不变。

## 升级桥

桥锁定在 `lekai63/zcode-acp` 的提交（见 `package-lock.json`）。要升级：在 fork 的 `paseo` 分支上同步上游并修改，然后更新本仓库的依赖 ref 与锁文件。

## 内置(vendored)ACP 适配层与 steer 支持

`server/acp-adapter/` 是 paseo v0.11.2 `runAcpProvider` 适配层（`packages/plugin/src/server/acp.ts` + `acp-internal/connection.ts`，Apache-2.0）的本地拷贝，附带官方 shim 缺失的一项能力：**`prompt.steer`**。paseo 默认发送行为就是 `steer`，而官方 ACP 适配层从不声明该能力，导致对 ACP 后端 agent 的运行中插话直接报 "Provider does not support prompt.steer"。

fork 的行为是"转向"而非拒绝：`delivery: "steer"` 的 prompt 复用运行中 turn 的身份，立即发出新的 `session/prompt`（zcode-acp 桥会抢占式停掉被取代的后端 turn），返回 `prompt_result { type: "steer" }`；代数计数器会吞掉被取代请求的终止事件，turn 不会显示为已取消。`clearPendingPermissions` 会在转向前取消挂起的权限弹窗。这是基于抢占的 steer——模型带着完整历史重跑，不是生成中注入（app-server 0.16+ 已无注入 API）。

除 import 路径与一处构造器参数属性展开（Node type-stripping 只支持可擦除语法）外，其余与上游一致。升级 `@getpaseo/plugin` 时，请 diff 对应 tag 的两个源文件与本地拷贝，按 `Local change vs upstream` 标记重新套用。`server/acp-adapter.test.ts` 用一个模拟抢占的假 agent 覆盖了 steer 契约。

## 桥的解析机制

Paseo 以注入 `require`、无 `__dirname`/`import.meta` 的方式执行插件 bundle，且 daemon 可能由 node CLI 安装或桌面 app（Electron）托管。插件**优先**使用检出内的桥副本 `checkout/node_modules/zcode-acp-server/dist/cli.js`（配对该检出所用的 `node`），只有在检出缺失时才回退到常见 npm 全局根目录（fnm、nvm、`/usr/local`、Homebrew）。全程不依赖 `PATH`，桥也永远不会经由 Electron 二进制启动。若完全找不到安装，provider 会回退为 `PATH` 上的 `zcode-acp-server`，由 daemon 把"找不到"作为 provider 诊断信息报告（`paseo provider diagnostic zcode`），而不是让整个插件加载失败。

解析出的 `[node, cli.js]` 是 provider 声明的默认 `command`。daemon 据此解析实际启动命令（并套用 `agents.providers.zcode` 中的覆盖项），适配层严格按该命令启动，环境为 daemon 净化后的环境再叠加会话级 env。由于 daemon 只校验 `node` 可执行文件，provider 的 `status` 会额外检查桥脚本是否存在。

## 已知限制

- provider id 为 `zcode-acp`（显示名 "ZCode (ACP)"）；`zcode` 这个 id 留给直接驱动 ZCode Services Server 的 provider，两者可以装在同一个 daemon 上。改名前创建的 agent 记录里 provider 是 `zcode`，需要在 daemon 的 agent 记录里迁移为 `zcode-acp`。`~/.paseo/config.json` 中**不带** `extends` 的 `agents.providers.zcode-acp` 条目会定制本插件的 provider（`enabled`、`command`、`env`、名称、模型）；**带** `extends` 的条目则定义一个独立 provider 并遮蔽本插件。
- 桥首次启动可能较慢（npm 预热），插件为 ACP 握手预留了 180 秒。
- 图标为 Z.ai 官方 logo（来源：`z-cdn.chatglm.cn/z-ai/static/logo.svg`），仅用于指示本插件所包装的 agent。与智谱 AI 无隶属或背书关系。

## 许可证

[MIT](LICENSE)
