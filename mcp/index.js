#!/usr/bin/env node
/**
 * CourseMate MCP Server
 * ---------------------
 * 让 AI 代理能够：
 *   1. 直接调用搜题/解题接口（无需登录）
 *   2. 通过本地 HTTP 桥接，与浏览器中的 CourseMate 插件通信
 *      （读写设置：视频倍速 / 完成后自动跳转 / 自动填充答案 / 自动提交）
 *      （启停刷课、查询任务进度）
 *
 * 零第三方依赖。stdio JSON-RPC (MCP) + 本地 HTTP 桥接服务。
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const BRIDGE_PORT = Number(process.env.COURSEMATE_PORT || 17321);
const VERSION = "0.1.0";
const SESSION_TTL = 45_000; // 超过 45 秒未轮询视为离线
const POLL_HOLD_MS = 20_000; // 长轮询挂起时间

/* ------------------------------------------------------------------ */
/*  搜题接口配置                                                        */
/* ------------------------------------------------------------------ */
/*
 * 接口地址与请求参数不在源码中硬编码，需自行填入本目录下的 config.json
 * （参照 config.example.json）。config.json 已被 .gitignore 排除，不会入库。
 */

const CONFIG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "config.json"
);

const DEFAULT_SOLVE_CONFIG = {
  solveUrl: "", // 搜题接口地址
  appId: "",
  vcname: "",
  os: "",
  vc: "",
  sourceAppId: "",
  llmType: "",
  questionFrom: "coursemate-mcp",
};

/** @type {typeof DEFAULT_SOLVE_CONFIG} */
let solveConfig = { ...DEFAULT_SOLVE_CONFIG };

function loadSolveConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    solveConfig = { ...DEFAULT_SOLVE_CONFIG, ...parsed };
    return true;
  } catch {
    solveConfig = { ...DEFAULT_SOLVE_CONFIG };
    return false;
  }
}

const hasSolveConfig = () => Boolean(solveConfig.solveUrl && solveConfig.appId);

function solveConfigHint() {
  return (
    "未配置搜题接口。请复制 mcp/config.example.json 为 mcp/config.json，" +
    "填入你自己的接口地址与请求参数后重启 MCP。" +
    `（期望路径：${CONFIG_PATH}）`
  );
}

/* ------------------------------------------------------------------ */
/*  桥接状态                                                            */
/* ------------------------------------------------------------------ */

/** @type {Map<string, {sid:string, info:object, lastSeen:number, state:object, events:object[]}>} */
const sessions = new Map();
/** @type {Map<string, Array<{id:string, method:string, params:object}>>} */
const queues = new Map();
/** @type {Map<string, Array<Function>>} */
const waiters = new Map();

let cmdSeq = 0;

function pruneSessions() {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL) {
      sessions.delete(sid);
      queues.delete(sid);
    }
  }
}

function enqueue(sid, method, params) {
  const id = `cmd_${++cmdSeq}`;
  const cmd = { id, method, params };
  const q = queues.get(sid) || [];
  q.push(cmd);
  queues.set(sid, q);
  const ws = waiters.get(sid);
  if (ws && ws.length) {
    const resolve = ws.shift();
    resolve({ cmds: [cmd] });
  }
  return id;
}

function broadcast(method, params) {
  pruneSessions();
  const ids = [];
  for (const sid of sessions.keys()) ids.push(enqueue(sid, method, params));
  return ids;
}

/* ------------------------------------------------------------------ */
/*  解题接口（免登录直连）                                              */
/* ------------------------------------------------------------------ */

async function solveExercise(args) {
  if (!hasSolveConfig()) throw new Error(solveConfigHint());

  const {
    questionText = "",
    options = [],
    questionType = "单选题",
    questionFrom = "",
    imageBase64 = null,
    picMD5 = "",
    questionId = "",
    historyResult = "",
    blankNum = 0,
    chapterName = "",
    courseName = "",
    courseId = "",
    exciseUrl = "",
    llmType = "",
    ceYanName = "",
    questionTextHtml = "",
  } = args || {};

  const fd = new FormData();
  const opts = Array.isArray(options) ? options : String(options).split(/\s*\|\s*/).filter(Boolean);
  const fields = {
    appId: solveConfig.appId,
    vcname: solveConfig.vcname,
    os: solveConfig.os,
    sourceAppId: solveConfig.sourceAppId,
    vc: solveConfig.vc,
    picMD5,
    historyResult,
    questionText: String(questionText),
    questionId,
    options: JSON.stringify(opts),
    questionType,
    questionFrom: questionFrom || solveConfig.questionFrom,
    blankNum: String(blankNum),
    llmType: llmType || solveConfig.llmType,
    exciseUrl,
    chapterName,
    courseName,
    courseId,
    ceYanName,
    questionTextHtml,
  };
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);

  if (imageBase64) {
    const b64 = String(imageBase64).replace(/^data:[^,]*,/, "");
    const bin = Buffer.from(b64, "base64");
    fd.append("image", new Blob([bin], { type: "application/octet-stream" }), "q.png");
  } else {
    fd.append("image", "");
  }

  const res = await fetch(solveConfig.solveUrl, { method: "POST", body: fd });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`搜题接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  return { httpStatus: res.status, ...json };
}

/* ------------------------------------------------------------------ */
/*  MCP 工具定义                                                        */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: "solve_question",
    description:
      "调用搜题接口获取题目答案（无需登录）。支持文字题与图片题。" +
      "questionType 推荐取值：单选题/多选题/判断题/填空题/简答题。" +
      "返回 errNo（0=成功，4002=额度限制，3/303=登录失效）与 data.option（选项字母）、data.answer（文字答案）。",
    inputSchema: {
      type: "object",
      properties: {
        questionText: { type: "string", description: "题干纯文本" },
        options: {
          oneOf: [
            { type: "array", items: { type: "string" } },
            { type: "string" },
          ],
          description: "选项列表，例如 [\"A. xxx\",\"B. yyy\"]；也可用 | 分隔的字符串",
        },
        questionType: {
          type: "string",
          enum: ["单选题", "多选题", "判断题", "填空题", "简答题", "未知"],
          description: "题型",
        },
        imageBase64: { type: "string", description: "图片题：图片 base64（可含 data: 前缀）" },
        questionFrom: { type: "string", description: "来源标识，默认 coursemate-mcp" },
        courseName: { type: "string" },
        chapterName: { type: "string" },
      },
      required: ["questionText"],
    },
  },
  {
    name: "bridge_status",
    description:
      "查询浏览器中的 CourseMate 插件桥接状态：是否在线、所在标签页、当前设置与最近事件。" +
      "如果插件离线，需要用户在浏览器中加载 coursemate/extension 目录并打开任意课程页面。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "settings_get",
    description: "读取插件当前的四个开关：playbackRate（视频倍速）、autoJump（完成后自动跳转）、autoFill（自动填充答案）、autoSubmit（自动提交）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "settings_set",
    description: "设置刷课开关（只传需要修改的字段）。设置会立即在插件中生效并持久化。",
    inputSchema: {
      type: "object",
      properties: {
        playbackRate: { type: "number", description: "视频倍速，如 1 / 1.25 / 1.5 / 2" },
        autoJump: { type: "boolean", description: "视频完成后自动跳到下一节" },
        autoFill: { type: "boolean", description: "自动填充答案" },
        autoSubmit: { type: "boolean", description: "自动提交答案（不可逆）" },
        sid: { type: "string", description: "可选：只对指定插件会话生效" },
      },
    },
  },
  {
    name: "brush_command",
    description:
      "对课程页面下发刷课命令。action=start 开始刷课（含自动填答提交），stop 停止。" +
      "插件会作用于所有已连接的课程页面（或指定 sid）。",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop"] },
        sid: { type: "string", description: "可选：只对指定插件会话生效" },
      },
      required: ["action"],
    },
  },
  {
    name: "task_status",
    description:
      "查询刷课任务进度：每个页面的运行状态、当前处理类型（video/audio/work/...）、已处理任务数、最近一次填答记录、异常信息。",
    inputSchema: { type: "object", properties: {} },
  },
];

/* ------------------------------------------------------------------ */
/*  工具实现                                                            */
/* ------------------------------------------------------------------ */

function sessionBrief([sid, s]) {
  return {
    sid,
    lastSeenAgoMs: Date.now() - s.lastSeen,
    url: s.info?.url || null,
    title: s.info?.title || null,
    platform: s.info?.platform || null,
    topFrame: s.info?.topFrame ?? null,
    state: s.state || {},
    events: (s.events || []).slice(-10),
  };
}

async function callTool(name, args) {
  switch (name) {
    case "solve_question":
      return await solveExercise(args);

    case "bridge_status": {
      pruneSessions();
      return {
        bridgePort: BRIDGE_PORT,
        connected: sessions.size,
        sessions: [...sessions].map(sessionBrief),
      };
    }

    case "settings_get": {
      pruneSessions();
      const first = [...sessions.values()][0];
      return {
        connected: sessions.size,
        settings: first?.state?.settings ?? null,
        perSession: [...sessions].map(([sid, s]) => ({ sid, settings: s.state?.settings ?? null })),
      };
    }

    case "settings_set": {
      const { sid, ...patch } = args || {};
      pruneSessions();
      if (sessions.size === 0) {
        return {
          ok: false,
          hint: "没有在线的插件会话。请在浏览器中打开 CourseMate 插件所在的课程页面。",
        };
      }
      const ids = sid ? [enqueue(sid, "setSettings", patch)] : broadcast("setSettings", patch);
      return { ok: true, commandIds: ids, targets: sid ? [sid] : [...sessions.keys()] };
    }

    case "brush_command": {
      const { action, sid } = args || {};
      pruneSessions();
      if (sessions.size === 0) {
        return {
          ok: false,
          hint: "没有在线的插件会话。请先在浏览器中打开课程页面。",
        };
      }
      const ids = sid ? [enqueue(sid, "brush", { action })] : broadcast("brush", { action });
      return { ok: true, action, commandIds: ids };
    }

    case "task_status": {
      pruneSessions();
      return {
        connected: sessions.size,
        sessions: [...sessions].map(sessionBrief),
      };
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/* ------------------------------------------------------------------ */
/*  本地 HTTP 桥接服务                                                  */
/* ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

const bridge = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      return res.end();
    }

    // 插件轮询：长轮询挂起直到有命令或超时
    if (req.method === "GET" && url.pathname === "/poll") {
      const body = await readBody(req).catch(() => ({}));
      const q = url.searchParams;
      const sid = q.get("sid") || body.sid || `s${Math.random().toString(36).slice(2)}`;
      const info = body.info || {};
      const existing = sessions.get(sid) || { sid, info: {}, lastSeen: 0, state: {}, events: [] };
      existing.info = { ...existing.info, ...info };
      existing.lastSeen = Date.now();
      sessions.set(sid, existing);

      const queue = queues.get(sid) || [];
      if (queue.length) {
        queues.set(sid, []);
        return sendJson(res, { cmds: queue });
      }
      const held = await new Promise((resolve) => {
        const ws = waiters.get(sid) || [];
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          resolve(null);
        }, POLL_HOLD_MS);
        ws.push((payload) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(payload);
        });
        waiters.set(sid, ws);
      });
      if (held) return sendJson(res, held);
      return sendJson(res, { cmds: [] });
    }

    // 插件上报状态
    if (req.method === "POST" && url.pathname === "/state") {
      const body = await readBody(req);
      const { sid, state, info } = body;
      if (!sid) return sendJson(res, { ok: false }, 400);
      const existing = sessions.get(sid) || { sid, info: {}, lastSeen: 0, state: {}, events: [] };
      existing.lastSeen = Date.now();
      if (state) existing.state = state;
      if (info) existing.info = { ...existing.info, ...info };
      sessions.set(sid, existing);
      return sendJson(res, { ok: true });
    }

    // 插件事件（填答完成、任务跳转等）
    if (req.method === "POST" && url.pathname === "/event") {
      const body = await readBody(req);
      const { sid, type, data } = body;
      if (!sid) return sendJson(res, { ok: false }, 400);
      const existing = sessions.get(sid);
      if (existing) {
        existing.lastSeen = Date.now();
        existing.events = (existing.events || []).concat({ t: Date.now(), type, data }).slice(-50);
      }
      return sendJson(res, { ok: true });
    }

    // 插件回执命令执行结果
    if (req.method === "POST" && url.pathname === "/ack") {
      const body = await readBody(req);
      // 目前采用 fire-and-forget；结果通过 /state 或 /event 反馈
      return sendJson(res, { ok: true });
    }

    // 插件解题代理：background 转发至此，接口参数只存在于本进程的 config.json
    if (req.method === "POST" && url.pathname === "/solve") {
      if (!hasSolveConfig()) {
        return sendJson(res, { ok: false, error: solveConfigHint() }, 503);
      }
      const body = await readBody(req);
      const json = await solveExercise(body?.data || body || {});
      return sendJson(res, json);
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, { ok: true, server: "coursemate-mcp", version: VERSION });
    }

    sendJson(res, { ok: false, error: "not found" }, 404);
  } catch (e) {
    sendJson(res, { ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
});

bridge.on("error", (e) => {
  log(`bridge server error: ${e.message}`);
});

/* ------------------------------------------------------------------ */
/*  MCP (stdio JSON-RPC)                                               */
/* ------------------------------------------------------------------ */

function log(msg) {
  // stderr 仅用于调试，不污染 MCP 协议流
  process.stderr.write(`[coursemate] ${msg}\n`);
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"
  );
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  // 通知无需响应
  if (method && method.startsWith("notifications/")) return;

  if (method === "initialize") {
    return respond(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "coursemate", version: VERSION },
    });
  }

  if (method === "ping") return respond(id, {});

  if (method === "tools/list") {
    return respond(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const result = await callTool(name, args);
      return respond(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      return respond(id, {
        content: [{ type: "text", text: `错误：${e && e.message ? e.message : String(e)}` }],
        isError: true,
      });
    }
  }

  if (id !== undefined) respondError(id, -32601, `method not found: ${method}`);
});

rl.on("close", () => {
  bridge.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 300).unref();
});

const configLoaded = loadSolveConfig();

bridge.listen(BRIDGE_PORT, "127.0.0.1", () => {
  log(`MCP ready (stdio); bridge listening on http://127.0.0.1:${BRIDGE_PORT}`);
  log(
    configLoaded && hasSolveConfig()
      ? `solve config loaded: ${CONFIG_PATH}`
      : `solve 未配置（仅桥接可用）：${solveConfigHint()}`
  );
});

process.on("uncaughtException", (e) => log(`uncaught: ${e.stack || e}`));
process.on("unhandledRejection", (e) => log(`unhandled: ${e && e.stack ? e.stack : e}`));
