# CourseMate

> 免登录的网课自动化框架，AI 智能体可实时指挥 —— 平台改版时，它能自己修自己。

[![License](https://img.shields.io/badge/License-All%20Rights%20Reserved-red.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-chaoxing%20%7C%20zhihuishu-green.svg)]
[![Node](https://img.shields.io/badge/node-%E3%89%A518.0-brightgreen.svg)]

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

## ✨ 特点

- 🚫 **免登录** — 不需要账号 / VIP / Cookie，导入扩展即用
- 🤖 **AI 可指挥** — 标准 MCP 接口，OpenCode、Claude 等智能体能读进度、下指令
- 🧠 **能随平台成长** — 平台改版时，AI 能自己定位失效选择器、改代码、重载插件
- 🔧 **AI 能改插件本身** — 不止发指令，还能直接调整倍速、开关，甚至引擎逻辑
- 🔄 **全自动** — 视频 → 答题 → 提交 → 下一节，全程无感
- 🎯 **双平台** — 超星学习通 / 学校云 + 智慧树
- 🔒 **全程本地** — 桥接只监听 `127.0.0.1`，数据不出本机
- 📦 **零依赖** — 无需 `npm install`，Node 直接跑
- 🔑 **接口自配** — 搜题服务地址自行填写，不绑定任何厂商

## 🚀 快速开始

### 1. 加载扩展

1. Edge / Chrome 打开 `edge://extensions/`（或 `chrome://extensions/`）
2. 打开右上角「**开发人员模式**」
3. 点「**加载解压缩的扩展**」，选择 `extension` 目录
4. 打开课程页面，右下角出现紫色圆球「课」即成功

### 2. 配置搜题接口（可选）

接口地址**不在源码中**，需自行填入本地配置：

```bash
cp mcp/config.example.json mcp/config.json
```

编辑 `mcp/config.json`，填入你所用搜题服务的地址与参数。不配置也能刷视频、跳节，只是答题会提示未配置。

> `config.json` 已被 `.gitignore` 排除，不会随仓库上传。

### 3. 注册 MCP

在 OpenCode 配置文件的 `mcp` 段加入：

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

路径换成你本机的绝对路径，重启 OpenCode 后生效。Claude Desktop、Cursor 等同理。

### 4. 开始刷课

对 AI 说 `用 coursemate 开始刷课`，之后可以说：

```
把倍速调到 1.5
现在进度怎么样
```

也可以直接点右下角圆球，用面板按钮手动控制。

## 🛠 MCP 工具

| 工具 | 作用 |
| --- | --- |
| `solve_question` | 调用搜题接口拿答案，**无需登录** |
| `bridge_status` | 查看插件是否在线、当前设置与最近事件 |
| `settings_get` / `settings_set` | 读取 / 修改四个开关，立即生效 |
| `brush_command` | `"start"` \| `"stop"`，下发到所有课程页面 |
| `task_status` | 查询进度、最近填答记录、异常 |

## ⚙️ 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `playbackRate` | `1` | 视频倍速，每 2 秒校正一次 |
| `autoJump` | `true` | 本节完成后自动跳下一节 |
| `autoFill` | `true` | 自动填充答案 |
| `autoSubmit` | `false` | 填完自动提交，默认关闭。**不可逆动作**，建议先抽查准确率再开启 |

修改方式：插件弹窗、页面浮动面板，或 MCP 的 `settings_set`。

## 🖥 平台支持

| 平台 | 视频倍速 | 自动跳节 | 作业填答 | 考试填答 | 弹窗测验 |
| --- | :---: | :---: | :---: | :---: | :---: |
| 超星学习通 / 学校云 | ✅ | ✅ | ✅ | ✅ | — |
| 智慧树 | ✅ | ✅ | ✅ | ✅ | ✅ |

## 🧩 工作原理

| 文件 | 职责 |
| --- | --- |
| `extension/background.js` | 解题请求转发至本机 MCP、设置与运行状态存储 |
| `extension/content/common.js` | 全局 API、浮动面板、MCP 桥接客户端、视频守卫 |
| `extension/content/chaoxing.js` | 超星引擎：任务队列、视频、作业填答、跳节 |
| `extension/content/zhs.js` | 智慧树引擎：资源队列、复习与考试填答、章节跳转 |
| `extension/content/cx-video-guard.js` | 播放辅助（MAIN world） |
| `extension/content/zhs-popup-quiz.js` | 智慧树视频内弹窗测验自动应答（MAIN world） |
| `mcp/index.js` | stdio JSON-RPC server + HTTP 桥接（端口 `17321`） |

详细协议见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

改代码后的刷新流程：`edge://extensions/` 点 🔄 → 课程页按 **F5**。日志：DevTools Console 过滤 `[CourseMate`。

## ❓ FAQ

**断开 MCP 会影响刷课吗？**
不会。插件独立运行，断开只是让 AI 无法远程读状态、改设置。

**支持 Chrome 吗？**
支持。MV3 标准实现。

## ⚠️ 准确率与风险

搜题接口的命中率决定准确率，题库未命中会返回错误答案，且**置信度标记不可信**。

**建议**：首次使用先拿自己的课程题抽查 5~10 题，确认命中率后再开启自动提交。

## 📄 免责声明

- 仅供**个人学习流程自动化**研究使用
- 使用者须遵守所在学校的课程与考试规定，**自行承担一切后果**
- 本项目与任何商业刷课 / 搜题产品及课程平台**无关联**

## ⚖️ License

开源发布，供学习与研究使用。详见 [LICENSE](LICENSE)。

---

- 技术交流
- 邮箱：ayi2121@qq.com
