/**
 * CourseMate content/cx-video-guard.js   (MAIN world, document_start)
 * ---------------------------------------------------------------------------
 * 在页面脚本注册监听器之前接管 HTMLMediaElement 的
 * ratechange / seeked / seeking 事件注册，避免播放倍速被页面脚本改写。
 *
 * 仅此一处需要处理，页面其他位置没有 playbackRate 相关逻辑。
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

  console.info("[CourseMate] 超星播放器倍速保持已生效");
})();
