/**
 * CourseMate content/cx-video-guard.js   (MAIN world, document_start)
 * ---------------------------------------------------------------------------
 * 超星播放器会监听 ratechange / seeked / seeking 来检测倍速被篡改，
 * 一旦发现就把速率复位并上报。这里在页面脚本注册监听器之前，
 * 把这三类事件的 addEventListener 与 on* setter 全部屏蔽。
 *
 * 对应原始插件的 videoplayrate.js（逆向结论：仅此一处倍速反检测，
 * SideBar 中没有其他 playbackRate 干预）。
 */

(() => {
  "use strict";
  if (window.__cmVideoGuardInstalled) return;
  window.__cmVideoGuardInstalled = true;

  const BLOCKED = ["ratechange", "seeked", "seeking"];

  const origAdd = HTMLMediaElement.prototype.addEventListener;
  HTMLMediaElement.prototype.addEventListener = function (type, listener, options) {
    if (BLOCKED.includes(type)) return undefined;
    return origAdd.call(this, type, listener, options);
  };

  for (const key of ["onratechange", "onseeked", "onseeking"]) {
    try {
      Object.defineProperty(HTMLMediaElement.prototype, key, {
        configurable: true,
        get: () => null,
        set: () => {},
      });
    } catch {}
  }

  console.info("[CourseMate] 超星播放器倍速反检测已生效");
})();
