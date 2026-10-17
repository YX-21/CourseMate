# CourseMate

> 免登录的网课自动化框架，AI 智能体可实时指挥 —— 平台改版时，它能自己修自己。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-chaoxing%20%7C%20zhihuishu-green.svg)](#%EF%B8%8F-平台支持)
[![Node](https://img.shields.io/badge/node-%E3%89%A518.0-brightgreen.svg)](#-快速开始)

## 💡 为什么不一样

市面上的刷课插件是**成品** —— 平台一改版就废，只能干等开发者更新。

CourseMate 是**活的**：

| | 传统刷课插件 | CourseMate |
| --- | --- | --- |
| 安装 | 要账号、要 VIP | 免登录，导入扩展即用 |
| 控制 | 只能点页面上的按钮 | AI 用自然语言指挥 |
| 平台改版 | 直接失效，等更新 | 让 AI 读 DOM、修选择器，几分钟适配 |
| 数据去向 | 上传到服务器 | 全程本机，桥接只监听 `127.0.0.1` |
| 扩展性 | 等开发者发新版 | AI 就是开发者 |

## ✨ 亮点

- 🚫 **免登录** — 不依赖任何账号 / VIP / Cookie，导入浏览器扩展即用
- 🤖 **AI 可指挥** — 标准 MCP 接口，OpenCode、Claude 等智能体能实时读进度、下指令
- 🔄 **全自动闭环** — 视频 → 答题 → 提交 → 下一节 → 循环，全程无感
- 🧠 **能随平台成长** — 网课平台改版时，AI 能自己定位失效选择器、改代码、重载插件
- 🔧 **AI 能改插件本身** — 不止发指令，还能直接调整倍速、开关，甚至引擎逻辑
- 🎯 **双平台** — 超星学习通 / 学校云（`chaoxing.com`、`xuexitong.com`）+ 智慧树（`zhihuishu.com`）
- 🔒 **全程本地 + 最小权限** — 桥接只监听回环地址，数据不出本机；插件仅申请 `storage`
- 📦 **零依赖** — 无需 `npm install`，Node 直接跑
- 🔑 **接口自配** — 搜题服务地址由你自己填，不绑定任何厂商
- 🛡 **健壮** — 任务去重、失败跳过、平台反检测（限速 / 防暂停 / 防倍速重置）

## 🏗 架构

一套「**AI 代理驱动**」的课程自动化工具：

- **插件**（免登录）跑在浏览器里，负责真正动 DOM —— 倍速播放、自动跳转、填答案、点提交
- **MCP server** 跑在本机，负责搜题接口调用 + 与插件桥接，让 AI 能直接下达指令、查询进度

```
┌──────────────────┐    stdio (JSON-RPC)     ┌─────────────────────┐    HTTP 长轮询     ┌──────────────────────┐
│     OpenCode      │ ───────────────────────► │   coursemate-mcp     │ ◄─────────────── │   CourseMate 插件      │
│  Claude / 任意    │        6 个 MCP 工具      │                      │   127.0.0.1:17321 │   · 视频倍速守卫        │
│  MCP 客户端       │ ◄─────────────────────── │   · 搜题接口直连      │                   │   · 填答 / 提交引擎     │
└──────────────────┘                          │   · 指令队列 / 状态   │                   │   · 任务队列扫描        │
                                              └──────────┬───────────┘                   └──────────┬───────────┘
                                                         │                                              │
                                  插件的答题请求统一 POST /solve 转发给 MCP ◄─────────────────────────┘
                                                         │
                                                         ▼
                                      搜题接口（地址与请求参数写在 mcp/config.json，不入库）
```

## 🚀 快速开始

### 1. 获取代码

```bash
git clone https://github.com/<你的用户名>/coursemate.git
cd coursemate
```

无需 `npm install` —— 全部零依赖。

### 2. 配置搜题接口

接口地址与请求参数**不在源码中**，需自行填入本地配置：

```bash
cp mcp/config.example.json mcp/config.json
```

然后编辑 `mcp/config.json`，填入你所使用搜题服务的地址与参数：

```json
{
  "solveUrl": "https://<你的搜题服务>/solve",
  "appId": "<你的 appId>",
  "vcname": "",
  "os": "Windows",
  "vc": "",
  "sourceAppId": "",
  "llmType": "",
  "questionFrom": "coursemate-mcp"
}
```

> ⚠️ `config.json` 已被 `.gitignore` 排除，不会随仓库上传。没有它时插件仍可刷视频、跳节，只是答题会提示未配置。

### 3. 加载插件

1. Edge / Chrome 打开 `edge://extensions/`（或 `chrome://extensions/`）
2. 打开右上角「**开发人员模式**」
3. 点「**加载解压缩的扩展**」，选择 `<仓库>/extension` 目录
4. 打开任意课程页面，右下角出现紫色圆球「课」即成功

> 💡 如果你还装着其他同类刷课 / 搜题扩展，建议先停用它，避免两套面板注入同一个页面。

### 4. 注册 MCP

在 OpenCode 配置文件（`~/.config/opencode/opencode.json`，Windows 为 `C:\Users\<你>\.config\opencode\opencode.json`）的 `mcp` 段加入：

```json
{
  "mcp": {
    "coursemate": {
      "type": "local",
      "command": [
        "C:\\Program Files\\nodejs\\node.exe",
        "D:\\path\\to\\coursemate\\mcp\\index.js"
      ],
      "enabled": true
    }
  }
}
```

> ⚠️ 把 `node.exe` 和 `index.js` 换成你本机的实际绝对路径。重启 OpenCode 后生效。

其他支持 MCP 的客户端（Claude Desktop、Cursor 等）同理，指向 `mcp/index.js` 即可。

### 5. 开始刷课

打开课程页面，对 AI 说：

```
用 coursemate 开始刷课
```

AI 会调用 `brush_command` 启动，然后你可以：

```
把倍速调到 1.5
现在进度怎么样
答完题记得继续下一节
```

或者直接点右下角的紫色圆球，用面板上的按钮手动控制。

## 🛠 MCP 工具

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `solve_question` | `questionText`（必填）、`options`、`questionType`、`blankNum`、`imageBase64` | 调用搜题接口拿答案，**无需登录** |
| `bridge_status` | — | 查看插件是否在线、在哪些标签页、当前设置与最近事件 |
| `settings_get` | — | 读取四个开关的当前值 |
| `settings_set` | `playbackRate` / `autoJump` / `autoFill` / `autoSubmit`（任意子集） | 修改开关，立即生效并持久化 |
| `brush_command` | `action`: `"start"` \| `"stop"` | 下发到所有已连接的课程页面 |
| `task_status` | — | 查询进度：当前任务类型、已处理数量、最近填答记录、异常 |

`questionType` 取值：`单选题` / `多选题` / `判断题` / `填空题` / `简答题`。

## ⚙️ 配置项

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `playbackRate` | number | `1` | 视频倍速，每 2 秒校正一次（平台改回去会被压住） |
| `autoJump` | boolean | `true` | 本节完成后自动跳到下一节 |
| `autoFill` | boolean | `true` | 自动填充答案 |
| `autoSubmit` | boolean | `true` | 填完自动提交。**不可逆动作**，建议先抽查准确率再开启 |

修改方式：插件弹窗、页面浮动面板，或 MCP 的 `settings_set`。设置存在 `chrome.storage.local`，跨页面持久。

## 🖥 平台支持

| 平台 | 视频倍速 | 自动跳节 | 作业填答 | 考试填答 | 视频内弹窗测验 |
| --- | :---: | :---: | :---: | :---: | :---: |
| 超星学习通 / 学校云 | ✅ | ✅ | ✅ | ✅ | — |
| 智慧树 | ✅ | ✅ | ✅ | ✅ | ✅ |

超星的作业既可能在学习页内的 iframe 完成，也可能跳转到独立的 `/work/dowork` 页面 —— 两种路径都已处理，答完会自动点「下一节」继续。

## 🧩 工作原理

| 文件 | 世界 | 职责 |
| --- | --- | --- |
| `extension/background.js` | service worker | 解题请求转发至本机 MCP（`POST /solve`）、设置与运行状态存储、消息路由 |
| `extension/content/common.js` | ISOLATED | 全局 `CourseMate` API、浮动面板、MCP 桥接客户端、视频守卫（限速 / 反检测 / 保活） |
| `extension/content/chaoxing.js` | ISOLATED | 超星引擎：任务队列扫描、视频处理、作业填答与提交、跳节 |
| `extension/content/zhs.js` | ISOLATED | 智慧树引擎：资源队列（视频 / PDF / PPT）、复习与考试填答、章节跳转 |
| `extension/content/cx-video-guard.js` | **MAIN** | 补丁 `video` 元素事件，阻断平台的 `ratechange` / `seeked` / `seeking` 干预 |
| `extension/content/zhs-popup-quiz.js` | **MAIN** | 智慧树视频内弹窗测验自动应答（需读取页面 `__vue__` 状态） |
| `mcp/index.js` | Node | stdio JSON-RPC server + HTTP 桥接（端口 `17321`）+ 搜题接口调用，零依赖 |
| `mcp/config.json` | — | **本地配置**，存放搜题接口地址与请求参数，已被 `.gitignore` 排除 |

**为什么用两个 world？** ISOLATED world 里 content script 看不到页面的 JavaScript 变量；需要读 Vue 实例或拦截原生事件的部分，必须注入到 MAIN world。

详细协议（桥接端点、命令类型、状态结构、存储键）见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 🔧 开发与调试

```bash
# 语法检查
node --check extension/content/chaoxing.js

# 手动测试 MCP（JSON-RPC over stdio）
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | node mcp/index.js

# 单独跑桥接服务（不走 MCP）
node mcp/index.js
```

改代码后的刷新流程：

1. `edge://extensions/` → 点 CourseMate 卡片的 🔄 刷新
2. 回到课程页按 **F5**（content script 需重新注入）
3. 刷课开关存在 `chrome.storage.local`，页面加载后会**自动接着跑**

调试日志：

- 插件侧：DevTools Console 过滤 `[CourseMate`
- MCP 侧：`console.error` 输出，不影响 stdio 通道

## ❓ FAQ

**面板上的「MCP 已连接」是什么？**
插件与本机 `127.0.0.1:17321` 之间的桥接状态。只监听回环地址，数据不出本机。

**断开 MCP 会影响刷课吗？**
不会。插件独立运行刷课功能，断开只是让 AI 无法远程读状态、改设置。黄点 / 红点时功能照常。

**题目显示乱码？**
超星用 `font-cxsecret` 自定义字体打乱题干（防复制）。这类题建议改用 `solve_question` 的 `imageBase64` 参数走图片识别。

**只想填答案不想自动提交？**
`settings_set { autoSubmit: false }`，或在面板上关掉「自动提交」。

**支持 Chrome 吗？**
支持。MV3 标准实现，`chrome://extensions/` 加载即可。

## ⚠️ 准确率与风险

### 搜题接口的命中率决定准确率

接口本身稳定（同一题多次调用结果一致），但题库未命中时可能返回错误答案：

| 测试题 | 接口返回 | 判定 |
| --- | --- | :---: |
| 我国现行宪法哪年颁布 | `C`（1982年） | ✅ |
| 中国古代四大发明 | `A.B.C.D.` | ✅ |
| 商品价格上升对供给量的影响 | `A`（增加） | ✅ |
| 《红楼梦》作者 | `曹雪芹` | ✅ |
| 下列属于可再生能源的是 | `B`（石油） | ❌ 应为 C |
| 直辖市有哪些 | `ABCD` | ❌ 应含重庆 |

> 🔴 **置信度标记不可信** —— 实测错题同样会被标为「高置信」，不可依赖。

**建议**：首次使用时先拿自己的课程题抽查 5~10 题，看命中率再决定是否开启 `autoSubmit`；关键考试请保持「自动填充 + 手动提交」。

### 答案形态的兼容

填答引擎需处理多种答案形态，均已做归一化（字母优先、文字兜底双路匹配）：

| 题型 | 可能收到的答案 | 示例 |
| --- | --- | --- |
| 单选 / 多选 | 单个字母或字母串，可能带分隔符 | `"C"`、`"ABCD"`、`"A.B.C.D."` |
| 判断 | 字母或「对 / 错」文字 | `"A"`、`"对"` |
| 填空 / 简答 | 直接返回文字 | `"北京"` |
| 未识别题型 | 选项的文字内容而非字母 | `"曹雪芹"` |

## 📄 免责声明

- 本项目仅供**个人学习流程自动化**研究使用
- 使用者须遵守所在学校的课程与考试规定，**自行承担一切后果**
- 搜题服务由使用者自行配置，本项目不保证其可用性，也不对其内容负责
- 本项目与任何商业刷课 / 搜题产品及课程平台**无关联**

## ⚖️ License
可通过邮箱联系我获取完整版，无需配置，开箱即用
邮箱：ayi2121@qq.com


[MIT](LICENSE)
