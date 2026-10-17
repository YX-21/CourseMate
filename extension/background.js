/**
 * CourseMate background service worker
 * ------------------------------------
 * 职责：
 *   1. 解题代理：content script -> 本机 MCP 桥接（127.0.0.1:<port>/solve）。
 *      接口地址与请求参数由 MCP 侧的 config.json 提供，浏览器侧不接触。
 *   2. 设置存储：cm_settings（倍速 / 自动跳转 / 自动填充 / 自动提交）
 *   3. 运行开关：cm_running（所有 frame 通过 storage.onChanged 同步）
 */

const DEFAULT_SETTINGS = {
  playbackRate: 1.5, // 视频倍速
  autoJump: true, // 完成后自动跳到下一节
  autoFill: true, // 自动填充答案
  autoSubmit: false, // 自动提交（默认关闭，避免误提交）
};
const DEFAULT_RUNNING = { running: false, startedAt: 0 };

/* ------------------------------ 解题代理 ------------------------------ */

async function solveExercise(data = {}) {
  const { cm_bridgePort = 17321 } = await chrome.storage.local.get({
    cm_bridgePort: 17321,
  });
  const port = Number(cm_bridgePort) || 17321;

  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/solve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data }),
    });
  } catch (e) {
    throw new Error(
      `无法连接本机搜题服务（127.0.0.1:${port}）。请确认 MCP 正在运行。` +
        `（${e && e.message ? e.message : e}）`
    );
  }

  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`搜题服务返回非 JSON（HTTP ${res.status}）`);
  if (json.ok === false && json.error) throw new Error(json.error);
  return json;
}

/* ------------------------------ 消息路由 ------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;

  const ok = (result) => sendResponse({ ok: true, result });
  const fail = (error) => sendResponse({ ok: false, error: String(error?.message || error) });

  switch (msg.type) {
    case "cm:solve":
      solveExercise(msg.data)
        .then(ok)
        .catch(fail);
      return true; // 异步响应

    case "cm:getSettings":
      chrome.storage.local
        .get({ cm_settings: DEFAULT_SETTINGS })
        .then((v) => ok(v.cm_settings))
        .catch(fail);
      return true;

    case "cm:setSettings":
      chrome.storage.local
        .get({ cm_settings: DEFAULT_SETTINGS })
        .then((v) => {
          const next = { ...v.cm_settings, ...(msg.patch || {}) };
          return chrome.storage.local.set({ cm_settings: next }).then(() => next);
        })
        .then(ok)
        .catch(fail);
      return true;

    case "cm:getRunning":
      chrome.storage.local
        .get({ cm_running: DEFAULT_RUNNING })
        .then((v) => ok(v.cm_running))
        .catch(fail);
      return true;

    case "cm:setRunning":
      chrome.storage.local
        .get({ cm_running: DEFAULT_RUNNING })
        .then((v) => {
          const next = { ...v.cm_running, ...(msg.patch || {}) };
          return chrome.storage.local.set({ cm_running: next }).then(() => next);
        })
        .then(ok)
        .catch(fail);
      return true;

    default:
      return false;
  }
});

console.info("[CourseMate] background ready");
