/**
 * CourseMate content/common.js
 * ---------------------------------------------------------------------------
 * 在所有匹配的 frame 中运行，提供：
 *   - window.CourseMate  全局接口（供各平台脚本调用）
 *   - 设置与运行状态的跨 frame 同步（chrome.storage.local + onChanged）
 *   - 仅在 top frame：浮动控制面板 + 与 MCP server 的本地桥接（长轮询）
 */

(() => {
  "use strict";
  if (window.__coursemateLoaded) return;
  window.__coursemateLoaded = true;

  const isTop = (() => {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  })();

  const DEFAULT_SETTINGS = {
    playbackRate: 1.5,
    autoJump: true,
    autoFill: true,
    autoSubmit: false, // 默认关闭，避免误提交
  };
  const DEFAULT_RUNNING = { running: false, startedAt: 0 };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    running: { ...DEFAULT_RUNNING },
    status: {}, // 平台脚本上报的状态快照
    frames: {}, // iframe 上报的状态，key = frameId
    lastAnswers: [], // 最近填答记录
  };

  const settingsListeners = [];
  const runListeners = [];
  const statusListeners = [];

  /* ------------------------- 设置 / 运行状态 ------------------------- */

  function applySettings(next) {
    state.settings = { ...DEFAULT_SETTINGS, ...next };
    for (const cb of settingsListeners) {
      try {
        cb(state.settings);
      } catch (e) {
        console.warn("[CourseMate] settings listener error", e);
      }
    }
  }

  function applyRunning(next) {
    const was = state.running.running;
    state.running = { ...DEFAULT_RUNNING, ...next };
    if (was !== state.running.running) {
      for (const cb of runListeners) {
        try {
          cb(state.running);
        } catch (e) {
          console.warn("[CourseMate] run listener error", e);
        }
      }
    }
  }

  chrome.storage.local
    .get({ cm_settings: DEFAULT_SETTINGS, cm_running: DEFAULT_RUNNING })
    .then((v) => {
      applySettings(v.cm_settings);
      applyRunning(v.cm_running);
    })
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.cm_settings) applySettings(changes.cm_settings.newValue);
    if (changes.cm_running) applyRunning(changes.cm_running.newValue);
  });

  /* ------------------------------ 对外接口 ------------------------------ */

  const CourseMate = {
    get settings() {
      return state.settings;
    },
    get running() {
      return state.running;
    },
    get isTop() {
      return isTop;
    },

    /** 平台脚本：更新自己的状态快照（phase / currentTask / total / note ...） */
    setStatus(patch) {
      state.status = { ...state.status, ...patch, at: Date.now() };
      if (!isTop && window.top && window.top !== window) {
        try {
          window.top.postMessage(
            { source: "coursemate", kind: "frame-status", payload: state.status },
            "*"
          );
        } catch {}
      }
      for (const cb of statusListeners) {
        try {
          cb(state.status);
        } catch {}
      }
    },

    getStatus() {
      return state.status;
    },

    /** 平台脚本：向 MCP 侧推送事件（如填答完成） */
    report(type, data) {
      if (isTop) {
        bridgeEvent(type, data);
      } else {
        try {
          window.top.postMessage({ source: "coursemate", kind: "event", type, data }, "*");
        } catch {}
      }
    },

    /** 平台脚本：记录一条填答历史（供面板与 task_status 展示） */
    logAnswer(entry) {
      state.lastAnswers = state.lastAnswers.concat({ ...entry, at: Date.now() }).slice(-20);
    },

    getAnswers() {
      return state.lastAnswers;
    },

    /** 平台脚本：调用解题接口（经 background 代理，免 CORS） */
    solve(data) {
      return chrome.runtime
        .sendMessage({ type: "cm:solve", data })
        .then((r) => {
          if (r && r.ok) return r.result;
          throw new Error(r?.error || "solve failed");
        });
    },

    onSettingsChange(cb) {
      settingsListeners.push(cb);
      cb(state.settings);
      return () => settingsListeners.splice(settingsListeners.indexOf(cb), 1);
    },

    onRunChange(cb) {
      runListeners.push(cb);
      cb(state.running);
      return () => runListeners.splice(runListeners.indexOf(cb), 1);
    },

    onStatusChange(cb) {
      statusListeners.push(cb);
      return () => statusListeners.splice(statusListeners.indexOf(cb), 1);
    },

    /** 便捷工具：把倍速应用到指定 <video> */
    applyRate(video, rate) {
      if (!video) return;
      try {
        video.defaultPlaybackRate = rate;
        video.playbackRate = rate;
      } catch {}
    },

    /**
     * 挂载视频守卫：应用倍速、阻止页面脚本改写倍速、维持播放。
     * 平台脚本检测到 <video> 后调用一次即可。
     */
    mountVideoGuard(video) {
      if (!video || video.__cmGuarded) return false;
      video.__cmGuarded = true;

      // 倍速保持：页面脚本常通过 ratechange/seeked/seeking 回调把 playbackRate 改回去，
      // 这里不再向页面侧转发这几个事件，让设置的倍速稳定生效
      const blocked = ["ratechange", "seeked", "seeking"];
      const origAdd = video.addEventListener.bind(video);
      video.addEventListener = (type, listener, opts) =>
        blocked.includes(type) ? undefined : origAdd(type, listener, opts);
      try {
        Object.defineProperty(video, "onratechange", { get: () => null, set: () => {}, configurable: true });
        Object.defineProperty(video, "onseeked", { get: () => null, set: () => {}, configurable: true });
        Object.defineProperty(video, "onseeking", { get: () => null, set: () => {}, configurable: true });
      } catch {}

      const apply = () => {
        const rate = Number(state.settings.playbackRate) || 1;
        try {
          video.defaultPlaybackRate = rate;
          if (Math.abs(video.playbackRate - rate) > 0.01) video.playbackRate = rate;
        } catch {}
      };
      apply();
      video.addEventListener("play", apply);
      video.addEventListener("loadedmetadata", apply);
      setInterval(apply, 2000);

      // 播放保持：意外暂停时恢复（仅在刷课运行中）
      // 注意：不检查 readyState —— 视频尚未缓冲时 play() 同样应该被调用，
      // 否则会卡在"已暂停但无数据"的状态永远不开始。
      const keepAlive = () => {
        if (!state.running.running) return;
        if (video.paused && !video.ended) {
          const p = video.play();
          if (p && p.catch) p.catch(() => {});
        }
      };
      video.addEventListener("pause", () => setTimeout(keepAlive, 800));
      setInterval(keepAlive, 3000);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) setTimeout(keepAlive, 300);
      });

      video.addEventListener("ended", () => {
        CourseMate.setStatus({ phase: "视频播放完成", videoEnded: true });
        CourseMate.report("video-ended", { url: location.href, title: document.title });
      });

      console.info("[CourseMate] video guard mounted, rate =", state.settings.playbackRate);
      return true;
    },
  };

  window.CourseMate = CourseMate;

  /* --------------------- iframe -> top 状态汇总 --------------------- */

  if (isTop) {
    window.addEventListener("message", (ev) => {
      const d = ev.data;
      if (!d || d.source !== "coursemate") return;
      if (d.kind === "frame-status") {
        state.frames[ev.origin + "|" + (d.payload?.url || "")] = d.payload;
      } else if (d.kind === "event") {
        if (d.type === "answer") CourseMate.logAnswer(d.data || {});
        bridgeEvent(d.type, d.data);
      }
    });
  }

  /* --------------------------- 桥接客户端 --------------------------- */

  let bridgePort = 17321;
  const sid = (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 16);
  let bridgeOnline = false;
  const pendingEvents = [];

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function bridgeEvent(type, data) {
    if (!isTop) return;
    pendingEvents.push({ type, data });
  }

  async function flushEvents() {
    while (pendingEvents.length) {
      const ev = pendingEvents.shift();
      try {
        await fetch(`http://127.0.0.1:${bridgePort}/event`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sid, ...ev }),
        });
      } catch {
        pendingEvents.unshift(ev);
        return;
      }
    }
  }

  function detectPlatform() {
    const h = location.host;
    if (/chaoxing|xuexitong/i.test(h)) return "chaoxing";
    if (/zhihuishu/i.test(h)) return "zhihuishu";
    return "unknown";
  }

  async function reportState() {
    const body = {
      sid,
      info: {
        url: location.href,
        title: document.title,
        platform: detectPlatform(),
        ua: navigator.userAgent,
      },
      state: {
        settings: state.settings,
        running: state.running,
        status: state.status,
        frames: Object.values(state.frames),
        lastAnswers: state.lastAnswers.slice(-5),
      },
    };
    await fetch(`http://127.0.0.1:${bridgePort}/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function handleCommand(cmd) {
    switch (cmd.method) {
      case "setSettings":
        await chrome.runtime.sendMessage({ type: "cm:setSettings", patch: cmd.params || {} });
        break;
      case "brush": {
        const start = cmd.params?.action === "start";
        await chrome.runtime.sendMessage({
          type: "cm:setRunning",
          patch: { running: start, startedAt: start ? Date.now() : 0 },
        });
        break;
      }
      case "ping":
        break;
      default:
        console.warn("[CourseMate] unknown command", cmd);
    }
    try {
      await fetch(`http://127.0.0.1:${bridgePort}/ack`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sid, id: cmd.id, ok: true }),
      });
    } catch {}
  }

  async function pollLoop() {
    for (;;) {
      let res;
      try {
        res = await fetch(
          `http://127.0.0.1:${bridgePort}/poll?sid=${encodeURIComponent(sid)}`,
          { method: "GET" }
        );
      } catch {
        if (bridgeOnline) {
          bridgeOnline = false;
          updatePanelBridgeDot();
        }
        await sleep(4000);
        continue;
      }
      if (!bridgeOnline) {
        bridgeOnline = true;
        updatePanelBridgeDot();
      }
      let payload = {};
      try {
        payload = await res.json();
      } catch {}
      for (const cmd of payload.cmds || []) {
        try {
          await handleCommand(cmd);
        } catch (e) {
          console.warn("[CourseMate] command failed", cmd, e);
        }
      }
      await flushEvents();
      try {
        await reportState();
      } catch {}
      // 拉到命令时立刻再拉一次，保证响应及时
      if ((payload.cmds || []).length === 0) await sleep(400);
    }
  }

  /* ---------------------------- 浮动面板 ---------------------------- */

  function el(tag, style, text) {
    const n = document.createElement(tag);
    if (style) n.setAttribute("style", style);
    if (text != null) n.textContent = text;
    return n;
  }

  const PANEL_ID = "coursemate-panel-root";

  function updatePanelBridgeDot() {
    const dot = document.getElementById("cm-bridge-dot");
    if (!dot) return;
    dot.style.background = bridgeOnline ? "#22c55e" : "#f59e0b";
    dot.title = bridgeOnline ? "已连接 CourseMate MCP" : "未连接 MCP（桥接端口 " + bridgePort + "）";
    const txt = document.getElementById("cm-bridge-text");
    if (txt) txt.textContent = bridgeOnline ? "MCP 已连接" : "MCP 未连接";
  }

  function buildPanel() {
    if (!isTop || document.getElementById(PANEL_ID)) return;
    if (document.body && document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", buildPanel, { once: true });
      return;
    }
    if (!document.body) return;

    const root = el("div", "");
    root.id = PANEL_ID;
    root.setAttribute(
      "style",
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;font-family:'Segoe UI','Microsoft YaHei',sans-serif;font-size:13px;"
    );

    // 折叠球
    const ball = el("div", "", "课");
    ball.setAttribute(
      "style",
      "width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;box-shadow:0 4px 14px rgba(124,58,237,.45);user-select:none;"
    );
    root.appendChild(ball);

    // 面板
    const panel = el("div", "");
    panel.setAttribute(
      "style",
      "display:none;position:absolute;right:0;bottom:52px;width:272px;background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);padding:12px 14px;color:#374151;"
    );

    const head = el("div", "", "");
    head.setAttribute("style", "display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;");
    const title = el("div", "", "CourseMate 自动刷课");
    title.setAttribute("style", "font-weight:600;color:#6d28d9;");
    const bridgeWrap = el("div", "", "");
    bridgeWrap.setAttribute("style", "display:flex;align-items:center;gap:6px;color:#6b7280;font-size:12px;");
    const dot = el("span", "width:8px;height:8px;border-radius:50%;background:#f59e0b;");
    dot.id = "cm-bridge-dot";
    const bridgeText = el("span", "", "MCP 未连接");
    bridgeText.id = "cm-bridge-text";
    bridgeWrap.append(dot, bridgeText);
    head.append(title, bridgeWrap);
    panel.appendChild(head);

    // 平台 / 状态
    const infoLine = el("div", "", "");
    infoLine.setAttribute("style", "color:#6b7280;font-size:12px;margin-bottom:10px;");
    const platformText = el("span", "", "平台：—");
    platformText.id = "cm-platform";
    const statusText = el("span", "margin-left:8px;", "状态：待机");
    statusText.id = "cm-status";
    infoLine.append(platformText, statusText);
    panel.appendChild(infoLine);

    // 倍速
    const rateRow = el("div", "", "视频倍速");
    rateRow.setAttribute("style", "display:flex;align-items:center;justify-content:space-between;margin:8px 0;");
    const rateSel = el("select", "padding:4px 8px;border:1px solid #e5e7eb;border-radius:8px;color:#374151;background:#fff;");
    for (const r of [1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
      const o = el("option", "", `${r} 倍`);
      o.value = String(r);
      rateSel.appendChild(o);
    }
    rateSel.id = "cm-rate";
    rateSel.addEventListener("change", () => {
      chrome.runtime.sendMessage({
        type: "cm:setSettings",
        patch: { playbackRate: Number(rateSel.value) },
      });
    });
    rateRow.appendChild(rateSel);
    panel.appendChild(rateRow);

    // 开关
    const switches = [
      ["autoJump", "完成后自动跳转"],
      ["autoFill", "自动填充答案"],
      ["autoSubmit", "自动提交"],
    ];
    for (const [key, label] of switches) {
      const row = el("div", "", "");
      row.setAttribute("style", "display:flex;align-items:center;justify-content:space-between;margin:8px 0;");
      row.appendChild(el("span", "", label));
      const sw = el("div", "");
      sw.id = "cm-sw-" + key;
      sw.setAttribute(
        "style",
        "width:38px;height:20px;border-radius:999px;background:#d1d5db;position:relative;cursor:pointer;transition:background .2s;"
      );
      const knob = el("div", "position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .2s;box-shadow:0 1px 3px rgba(0,0,0,.3);");
      sw.appendChild(knob);
      sw.addEventListener("click", () => {
        const cur = state.settings[key] === true;
        chrome.runtime.sendMessage({ type: "cm:setSettings", patch: { [key]: !cur } });
      });
      row.appendChild(sw);
      panel.appendChild(row);
    }

    // 开始 / 停止
    const btn = el("div", "", "开始刷课");
    btn.id = "cm-brush-btn";
    btn.setAttribute(
      "style",
      "margin-top:10px;text-align:center;padding:9px 0;border-radius:10px;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;font-weight:600;cursor:pointer;user-select:none;"
    );
    btn.addEventListener("click", () => {
      const start = !state.running.running;
      chrome.runtime.sendMessage({
        type: "cm:setRunning",
        patch: { running: start, startedAt: start ? Date.now() : 0 },
      });
    });
    panel.appendChild(btn);

    // 答题日志
    const logBox = el("div", "", "");
    logBox.id = "cm-log";
    logBox.setAttribute(
      "style",
      "margin-top:10px;max-height:120px;overflow:auto;color:#6b7280;font-size:12px;line-height:1.6;border-top:1px solid #f3f4f6;padding-top:6px;"
    );
    panel.appendChild(logBox);

    root.append(ball, panel);
    document.body.appendChild(root);

    let open = false;
    ball.addEventListener("click", () => {
      open = !open;
      panel.style.display = open ? "block" : "none";
      if (open) refreshPanel();
    });

    function refreshPanel() {
      const s = state.settings;
      const rate = document.getElementById("cm-rate");
      if (rate && document.activeElement !== rate) rate.value = String(s.playbackRate);
      for (const [key] of switches) {
        const sw = document.getElementById("cm-sw-" + key);
        if (!sw) continue;
        const on = s[key] === true;
        sw.style.background = on ? "#8b5cf6" : "#d1d5db";
        sw.firstElementChild.style.left = on ? "20px" : "2px";
      }
      const p = document.getElementById("cm-platform");
      if (p) p.textContent = "平台：" + (detectPlatform() === "chaoxing" ? "超星" : detectPlatform() === "zhihuishu" ? "智慧树" : "未知");
      const st = document.getElementById("cm-status");
      if (st) {
        const ph = state.status.phase || (state.running.running ? "运行中" : "待机");
        st.textContent = "状态：" + ph;
      }
      const b = document.getElementById("cm-brush-btn");
      if (b) {
        b.textContent = state.running.running ? "停止刷课" : "开始刷课";
        b.style.background = state.running.running
          ? "linear-gradient(135deg,#ef4444,#f97316)"
          : "linear-gradient(135deg,#7c3aed,#a855f7)";
      }
      const lg = document.getElementById("cm-log");
      if (lg) {
        const items = state.lastAnswers.slice(-6).reverse();
        lg.innerHTML = "";
        if (!items.length) {
          lg.appendChild(el("div", "", "暂无填答记录"));
        } else {
          for (const a of items) {
            const t = new Date(a.at).toTimeString().slice(0, 8);
            const line = el("div", "", `${t}  ${a.summary || a.answer || JSON.stringify(a).slice(0, 60)}`);
            lg.appendChild(line);
          }
        }
      }
      updatePanelBridgeDot();
    }

    CourseMate.onSettingsChange(() => open && refreshPanel());
    CourseMate.onRunChange(() => open && refreshPanel());
    CourseMate.onStatusChange(() => open && refreshPanel());
    setInterval(() => open && refreshPanel(), 1500);
  }

  buildPanel();

  /* ---------------------------- 启动桥接 ---------------------------- */
  if (isTop) {
    chrome.storage.local.get({ cm_bridgePort: 17321 }).then((v) => {
      bridgePort = Number(v.cm_bridgePort) || 17321;
      pollLoop();
    });
  }
})();
