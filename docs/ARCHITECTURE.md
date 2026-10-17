# 架构说明

本文档描述 CourseMate 的内部结构与协议。普通使用只需看 [README](../README.md)。

## 分层

```
┌──────────────────┐    stdio JSON-RPC     ┌─────────────────────┐    HTTP 长轮询     ┌──────────────────────┐
│     MCP 客户端    │ ────────────────────► │   coursemate-mcp     │ ◄─────────────── │   CourseMate 插件      │
│  OpenCode / 其他  │                       │                      │   127.0.0.1:17321 │                      │
└──────────────────┘                       └──────────┬───────────┘                   └──────────┬───────────┘
                                                       │                                              │
                                    插件的答题请求统一 POST /solve 转发给 MCP ◄─────────────────────┘
                                                       │
                                                       ▼
                                       搜题接口（地址与请求参数写在 mcp/config.json，不入库）
```

| 层 | 进程 | 职责 |
| --- | --- | --- |
| MCP server | Node，随客户端启动 | 实现 6 个工具、转发桥接指令、聚合会话状态 |
| 浏览器插件 | service worker + content script | 真正操作 DOM、调用搜题接口 |
| 搜题接口 | 远端 | 返回答案 |

**为什么用 HTTP 长轮询而不是 native messaging / CDP？**

- native messaging 需要安装 host manifest，分发成本高
- CDP 要求浏览器带 `--remote-debugging-port` 启动，Edge 155 起默认配置档会拒绝
- HTTP 长轮询只需一个端口，插件和 server 都能独立重启，天然解耦

## 桥接协议

服务端口默认 `17321`，仅监听 `127.0.0.1`。

| 端点 | 方法 | 方向 | 说明 |
| --- | --- | --- | --- |
| `/poll` | GET | 插件 → server | 长轮询取命令。有命令立即返回，否则挂起至 `POLL_HOLD_MS`（20s）后返回空数组 |
| `/state` | POST | 插件 → server | 上报完整状态快照（设置、运行状态、页面状态、最近填答） |
| `/event` | POST | 插件 → server | 上报离散事件（填答完成、跳节等），服务端保留最近 50 条 |
| `/ack` | POST | 插件 → server | 命令执行回执（当前为 fire-and-forget，结果走 `/state` 或 `/event`） |
| `/solve` | POST | 插件 → server | 解题代理。body 为 `{ data: {...} }`，server 补全接口参数后调用远端。未配置接口时返回 `503` |
| `/health` | GET | 任意 | 健康检查，返回 `{ ok, server, version }` |

### 命令类型

`/poll` 返回 `{ cmds: [...] }`，每条命令形如：

```json
{ "id": "cmd_1", "type": "setSettings", "params": { "playbackRate": 1.5 } }
```

| type | params | 插件行为 |
| --- | --- | --- |
| `setSettings` | 任意设置子集 | 写入 `chrome.storage.local`，触发 `onChanged`，平台引擎即时生效 |
| `brush` | `{ action: "start" \| "stop" }` | 切换运行状态，主循环 tick 据此启停 |
| `ping` | — | 心跳，用于验证通道可用 |

### 轮询节奏

插件端在**拿到命令后立即再拉一次**（0.4s），空闲时 20s 长轮询挂起。这样既保证指令低延迟，又不空转。

## 内容脚本世界划分

MV3 的 content script 默认运行在 **ISOLATED world** —— 与页面的 JavaScript 上下文隔离，看不到 `window.__vue__` 之类的状态。两处需要 MAIN world：

| 文件 | world | 注入时机 | 原因 |
| --- | --- | --- | --- |
| `cx-video-guard.js` | MAIN | `document_start` | 播放辅助 |
| `zhs-popup-quiz.js` | MAIN | `document_end` | 需读取智慧树 Vue 实例的 `answerUs` 字段拿到正确答案 |

其余脚本走 ISOLATED world，通过 DOM 与页面交互。

## 存储键

全部使用 `chrome.storage.local`，前缀 `cm_`：

| 键 | 内容 | 读写方 |
| --- | --- | --- |
| `cm_settings` | 四个开关（`playbackRate` `autoJump` `autoFill` `autoSubmit`） | background 写，content script 监听 `onChanged` |
| `cm_running` | `{ running: boolean, startedAt: number }` | background 写，content script 监听 |
| `cm_bridgePort` | 桥接端口，默认 `17321` | popup 读写，content script 启动时读 |

## 平台引擎工作流

超星（`chaoxing.js`）与智慧树（`zhs.js`）结构一致，都是**任务队列 + 主循环**：

```
tick（超星 1.2s，智慧树 2.5s）
 │
 ├─ 当前页是作业页？
 │    └─ 是 → 答题 + 提交 → 点「下一节」
 │
 ├─ 当前页是学习页？
 │    ├─ 扫描任务队列（视频 / 作业 / 讨论 …）
 │    ├─ 与上次指纹比对，变化则清空「已处理」集合
 │    ├─ 过滤掉已完成 / 已处理的任务，取第一个待办
 │    ├─ 是视频 → 倍速、保活、检测完成
 │    └─ 是作业 → 填答 + 提交，标记已处理
 │
 └─ 队列为空 → 自动跳下一节
```

### 任务去重

`processed` 集合以 `location.href + 任务 key` 为标识，防止同一份作业被反复填答 / 提交。路由（换节）时指纹变化会自动清空。

另有 `already-done` 兜底：若一页题目全部已有答案，说明处理过了，不再点击提交按钮。

### 视频守卫

`mountVideoGuard`（在 `common.js`）对每个 video 元素只挂一次，负责：

- **限速**：每 2s 校正 `playbackRate` 到设置值
- **保活**：意外暂停时恢复播放（不检查 `readyState`，否则会卡在「已暂停但无数据」的死锁）

## 平台适配设计

新平台遵循同一套结构：每个平台一个引擎文件，由 `manifest.json` 的 `content_scripts`
按域名挂载 `content/common.js` + 对应引擎；需要 MAIN world 的部分单独成文件并加
`"world": "MAIN"`。引擎通过 `CM.setStatus` / `CM.logAnswer` / `CM.report` 上报状态，
MCP 侧无需改动。

`common.js` 暴露的全局 API：

| API | 说明 |
| --- | --- |
| `CM.settings` | 当前设置（getter，实时） |
| `CM.running` | 当前运行状态（getter） |
| `CM.isTop` | 是否顶层 frame（getter） |
| `CM.setStatus(patch)` | 更新状态快照；子 frame 会 `postMessage` 转发给顶层 |
| `CM.getStatus()` | 读取当前状态快照 |
| `CM.logAnswer(record)` | 记录一条填答历史（保留最近 20 条） |
| `CM.getAnswers()` | 读取填答历史 |
| `CM.report(type, data)` | 上报离散事件到 `/event`；子 frame 经顶层转发 |
| `CM.solve(payload)` | 调用搜题接口（走 background 代理，免 CORS） |
| `CM.mountVideoGuard(video)` | 给 video 元素挂守卫（幂等） |
| `CM.bridge.connect(port)` | 建立 / 重建桥接 |

**跨 frame 通信**：任务常在 iframe 内，`all_frames: true` 会让每个 frame 各跑一份 content script。子 frame 的状态与事件通过 `postMessage({ source: "coursemate" })` 转发给顶层，由顶层统一上报，避免每个 frame 都去轮询桥接。

## MCP 实现要点

`mcp/index.js` 零依赖，包含三部分：

- **stdio JSON-RPC**：实现 `initialize` / `tools/list` / `tools/call` 三个必需方法，按行分帧
- **HTTP 桥接**：`node:http` 起服务，维护 `sessions` / `queues` / `waiters` 三个 Map
- **搜题客户端**：`fetch` 发 multipart 表单，请求字段由 `config.json` 补全

**调用方式完全由 `config.json` 决定。** 本项目不内置任何接口信息 —— 地址、请求字段、鉴权方式都取决于你所配置的服务。若你的服务需要签名或登录态，按需修改 `solveExercise` 即可，它是唯一需要为适配新服务而改动的函数。
