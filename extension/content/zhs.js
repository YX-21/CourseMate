/**
 * CourseMate content/zhs.js   —— 智慧树 (zhihuishu.com)
 * ---------------------------------------------------------------------------
 * 参考同类商业刷课扩展的智慧树引擎结构实现。
 *
 * 页面类型：
 *   learnPage                              学习页（视频 / PDF / PPT 资源串）
 *   studentReviewTestOrExam                作业测验
 *   smartcourseexam.zhihuishu.com/ReviewExam  考试
 *   onlineexamh5new stuExamWeb             考试（doexamination / dohomework）
 *
 * 关键选择器：
 *   资源列表  .resources-list .basic-info-video-card-container
 *   资源类型  当前项 .icon-box 的 classList[1]  → video / book / other / web
 *   视频      .preview-section .video-player-wrapper video
 *   PDF       .preview-section .book-mark .book-container（滚动容器）
 *   PPT       .preview-section .ppt-preview-container .next-page-btn / .page-total
 *   章节      .section-item-collapse-info（.active 为当前节）
 *   作业题目  .questionContent  +  .letterSortNum（题号+题型）
 *   作业选项  多选 .checkbox-views .el-checkbox；单选/判断 .radio-view li
 *   下一题    .reviewTestOrExam .exam-test .ET-content .content-center .ETC-left .pre-next .next-t
 *   交卷      .header-content .reviewDone
 */

(() => {
  "use strict";
  if (window.__cmZhsEngine) return;
  window.__cmZhsEngine = true;

  const CM = window.CourseMate;
  if (!CM) return;

  let isTop = false;
  try {
    isTop = window.top === window;
  } catch {
    isTop = false;
  }
  if (!isTop) return;

  /* ------------------------------ 小工具 ------------------------------ */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (sel, root) => {
    try {
      return (root || document).querySelector(sel);
    } catch {
      return null;
    }
  };
  const qa = (sel, root) => {
    try {
      return Array.from((root || document).querySelectorAll(sel));
    } catch {
      return [];
    }
  };
  const isVisible = (el) => {
    if (!el) return false;
    try {
      const st = (el.ownerDocument.defaultView || window).getComputedStyle(el);
      return st.display !== "none" && st.visibility !== "hidden";
    } catch {
      return false;
    }
  };
  const clickEl = (el) => {
    if (!el) return false;
    try {
      el.removeAttribute("href");
    } catch {}
    try {
      el.click();
      return true;
    } catch {
      return false;
    }
  };
  const fmtTime = (s) => {
    if (!isFinite(s)) return "--:--";
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  };
  const note = (phase, extra) => CM.setStatus({ platform: "zhihuishu", phase, ...(extra || {}) });

  /* ------------------------------ 页面判定 ------------------------------ */

  const pageType = () => {
    const h = location.href;
    if (h.includes("zhihuishu.com/learnPage")) return "learn";
    if (h.includes("zhihuishu.com/studentReviewTestOrExam/")) return "review";
    if (h.includes("smartcourseexam.zhihuishu.com/ReviewExam")) return "exam";
    if (h.includes("onlineexamh5new")) return "exam";
    if (h.includes("smartcoursestudent.zhihuishu.com/point/")) return "point";
    return "other";
  };

  /* =========================== 学习页：资源串 =========================== */

  const R = {
    index: 0, // 当前处理到第几个待办资源
    list: [], // 待办资源在 DOM 中的下标
    type: "", // 当前资源类型 video / book(PDF) / other(PPT) / web
    running: false,
    videoEl: null,
  };

  /** 资源卡片：跳过已完成的（.video-wrap 含「已完成」） */
  function collectResources() {
    const cards = qa(".resources-list .basic-info-video-card-container");
    if (!cards.length) return [];
    return cards
      .map((el, i) => {
        const done = (q(".video-wrap", el)?.innerText || "").includes("已完成");
        return done ? null : i;
      })
      .filter((i) => i !== null);
  }

  const allResourceItems = () => qa(".resources-list .basic-info-video-card-container");

  /** 当前资源项与其类型（类型取 .icon-box 的第二个 class） */
  function currentResource() {
    const items = allResourceItems();
    const idx = R.list[R.index];
    const el = items[idx];
    if (!el) return null;
    const icon = q(".icon-box", el);
    const cls = icon && icon.classList[1] ? icon.classList[1].trim() : "";
    return { el, idx, type: cls };
  }

  /* ------------------------------ 视频 ------------------------------ */

  function handleVideoDone() {
    note("本资源视频已完成");
    R.index += 1;
    runNextResource();
  }

  async function startVideo() {
    await sleep(5000); // 原插件同样等 5s 让播放器就绪
    const video = q(".preview-section .video-player-wrapper video") || q("video");
    if (!video) {
      note("未找到视频元素，2 秒后重试");
      await sleep(2000);
      if (R.running) return startVideo();
      return;
    }
    R.videoEl = video;
    CM.mountVideoGuard(video);
    try {
      video.muted = true;
    } catch {}

    const rate = Number(CM.settings.playbackRate) || 1;
    try {
      video.playbackRate = rate;
    } catch {}

    // 播放被浏览器策略拒绝 → 静音后重试（原插件 et() 的做法）
    try {
      const p = video.play();
      if (p && p.catch) {
        p.catch(() => {
          video.muted = true;
          const p2 = video.play();
          if (p2 && p2.catch) p2.catch(() => {});
        });
      }
    } catch {}

    if (!video.__cmZhsPauseHook) {
      video.__cmZhsPauseHook = true;
      // 原插件逻辑：剩余时长 > 1s 视为异常暂停；否则视为播完 → 下一资源
      video.addEventListener("pause", () => {
        if (!R.running) return;
        const left = parseInt(String(video.duration || 0)) - parseInt(String(video.currentTime || 0));
        if (left > 1) {
          note("检测到异常暂停，准备恢复播放");
        } else {
          handleVideoDone();
        }
      });
      video.addEventListener("ended", () => {
        if (R.running) handleVideoDone();
      });
    }

    note(`视频播放中 ${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}（${rate}x）`, {
      videoRate: rate,
      videoProgress: video.duration ? Math.round((video.currentTime / video.duration) * 100) : 0,
    });
  }

  /* ------------------------------ PDF ------------------------------ */

  async function startPdf() {
    note("PDF 文档阅读中（逐页滚动）");
    await sleep(2000);
    const container = q(".preview-section .book-mark .book-container");
    const pages = qa(".preview-section .book-mark .canvas-wrapper");
    if (!container || !pages.length) {
      note("未找到 PDF 容器，跳过");
      R.index += 1;
      return runNextResource();
    }
    const rect = pages[0].getBoundingClientRect();
    const mt = parseInt(getComputedStyle(pages[0]).marginTop, 10) || 0;
    const step = Math.max(rect.height + mt, 100);

    let guard = 0;
    while (R.running && guard++ < 600) {
      const next = Math.min(container.scrollTop + step, container.scrollHeight - container.clientHeight);
      container.scrollTo({ top: next, behavior: "smooth" });
      await sleep(1000);
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) break;
    }
    note("PDF 已滚动到末页");
    R.index += 1;
    runNextResource();
  }

  /* ------------------------------ PPT ------------------------------ */

  async function startPpt() {
    note("PPT 逐页翻页中");
    await sleep(2000);
    const total = parseInt(q(".preview-section .ppt-preview-container .page-total")?.innerText || "0", 10);
    let i = 0;
    while (R.running && (!total || i < total + 2)) {
      const next = q(".preview-section .ppt-preview-container .next-page-btn");
      if (!next) break;
      clickEl(next);
      i += 1;
      note(`PPT 已翻到第 ${i} / ${total || "?"} 页`);
      await sleep(5000);
      if (total && i >= total) break;
    }
    note("PPT 处理完成");
    R.index += 1;
    runNextResource();
  }

  /* --------------------------- 资源调度 --------------------------- */

  function runNextResource() {
    if (!R.running) return;

    if (R.index >= R.list.length) {
      note("本节所有资源已处理完毕");
      autoJumpNextSection();
      return;
    }

    const cur = currentResource();
    if (!cur) {
      note("当前资源定位失败，尝试下一节");
      return autoJumpNextSection();
    }
    R.type = cur.type;

    // 原插件：index !== 0 时才做类型白名单校验（首个资源直接执行）
    if (R.index !== 0 && !["video", "other", "book"].includes(R.type)) {
      note(`资源类型「${R.type}」暂不支持，已跳过`);
      R.index += 1;
      return runNextResource();
    }

    note(`处理第 ${R.index + 1} / ${R.list.length} 个资源（类型 ${R.type || "未知"}）`);
    clickEl(cur.el);

    if (R.type === "video") startVideo();
    else if (R.type === "book") startPdf();
    else if (R.type === "other") startPpt();
    else {
      // 首个资源若是 web 类型，原插件也直接进入 web 流程（跳过）
      note(`类型「${R.type || "未知"}」无需本地处理，跳过`);
      R.index += 1;
      runNextResource();
    }
  }

  async function initLearnPage() {
    note("学习页初始化中…");
    await sleep(6000); // 原插件同样等 6s

    // 关闭「继续阅读」弹层
    const dialog = q(".read-note-dialog");
    if (dialog && isVisible(dialog)) clickEl(q("button", dialog));

    // 等待 .preview-content 出现高度
    for (let i = 0; i < 30; i++) {
      const el = q(".preview-content");
      if (el && el.getBoundingClientRect().height > 0) break;
      await sleep(1000);
    }

    R.list = collectResources();
    R.index = 0;
    if (!R.list.length) {
      note("本节没有待处理资源，尝试跳到下一节");
      return autoJumpNextSection();
    }
    note(`共 ${R.list.length} 个待处理资源`);
    R.running = true;
    runNextResource();
  }

  /* --------------------------- 完成后自动跳节 --------------------------- */

  function autoJumpNextSection(force) {
    if (!CM.settings.autoJump && !force) {
      note("本节已完成（自动跳转已关闭）");
      return;
    }
    const items = qa(".section-item-collapse-info");
    const active = q(".section-item-collapse-info.active");
    if (!active) {
      note("未找到当前章节，任务结束");
      return;
    }
    const next = items[Array.from(items).indexOf(active) + 1];
    if (next) {
      note("本节完成，自动跳转到下一节");
      clickEl(next);
      R.list = [];
      R.index = 0;
      R.running = false;
      setTimeout(() => {
        if (CM.running.running && pageType() === "learn") initLearnPage();
      }, 6000);
    } else {
      note("已是最后一节 —— 整门课处理完毕");
      R.running = false;
    }
  }

  /* =========================== 作业测验 =========================== */

  const TYPE_LIST = ["单选题", "多选题", "判断题", "填空题", "简答"];

  async function runReviewPage() {
    const box = q(".questionContent");
    if (!box || !(box.innerText || "").trim()) {
      note("等待题目加载…");
      return;
    }

    const meta = q(".letterSortNum", box);
    const metaText = meta ? meta.innerText : "";
    const num = (metaText.match(/\d+/) || [])[0] || "?";
    const type = (metaText.match(/[\u4e00-\u9fa5]+/) || [])[0] || "";

    // 已答检测：单选/判断的选中态，多选的 checked，填空的输入值
    const radios = qa(".radio-view li", box);
    const checks = qa(".checkbox-views .el-checkbox", box);
    const blanks = qa(".fillAnswer li input", box);
    const answered =
      radios.some((li) => /radio-view__|is-checked|active/.test(li.className || "")) ||
      checks.some((c) => /is-checked|checked/.test(c.className || "")) ||
      blanks.some((i) => (i.value || "").trim().length > 0);

    if (answered) {
      return nextReviewQuestion();
    }
    if (!CM.settings.autoFill) {
      note("自动填充已关闭，等待手动作答");
      return;
    }

    const questionText = (box.innerText || "").trim();
    let options = [];
    if (type === "多选题") options = checks.map((e) => (e.innerText || "").trim());
    else if (type === "单选题" || type === "判断题") options = radios.map((e) => (e.innerText || "").trim());

    note(`正在解答第 ${num} 题（${type || "未知"}）`);

    let data;
    try {
      const res = await CM.solve({
        questionText,
        options,
        questionType: type || "未知",
        questionFrom: "zhsWorkExcise",
        exciseUrl: location.href,
      });
      if (!res || res.errNo !== 0) throw new Error(`errNo=${res ? res.errNo : "?"}`);
      data = res.data || {};
    } catch (e) {
      CM.logAnswer({ summary: `第${num}题 解题失败：${e.message}` });
      return nextReviewQuestion();
    }

    const ok = applyReviewAnswer(box, type, data);
    const summary = `第${num}题 ${type || ""}：${data.option || data.answer || ""}`;
    CM.logAnswer({ summary, answer: data.option || data.answer });
    CM.report("answer", { summary });
    if (!ok) CM.logAnswer({ summary: `第${num}题 回填失败` });

    // 原插件：答题后 5s 再点下一题
    await sleep(5000);
    nextReviewQuestion();
  }

  /** 回填（原插件 K 函数）：字母匹配点选；填空按 # 拆分写入 input */
  function applyReviewAnswer(box, type, data) {
    const option = String(data.option || "").trim();
    const answer = String(data.answer || data.option || "").trim();

    if (type === "多选题") {
      const letters = option.toUpperCase().split("").filter((c) => /[A-Z]/.test(c));
      let any = false;
      qa(".checkbox-views .el-checkbox", box).forEach((c, i) => {
        const letter = String.fromCharCode(65 + i);
        if (letters.includes(letter)) any = clickEl(c) || any;
      });
      return any;
    }

    if (type === "单选题" || type === "判断题") {
      const items = qa(".radio-view li", box);
      // 接口可能返回字母（"A"）也可能直接返回选项文字
      const clean = answer.replace(/^[A-Za-z][.、．,，:：)）]?\s*/, "").trim();
      const target = items.find((li) => {
        const t = (li.innerText || "").trim();
        if (new RegExp("^" + option[0] + "[.、．,，:：]", "i").test(t)) return true;
        if (clean && clean.length > 1 && t.includes(clean)) return true;
        if (answer.length <= 3 && t.includes(answer)) return true;
        return false;
      });
      return clickEl(target || items[0]);
    }

    // 填空 / 简答：option 用 # 分隔多空，回填时换成 、
    const parts = answer.split("#");
    const inputs = qa(".fillAnswer li input", box);
    if (inputs.length) {
      inputs.forEach((inp, i) => {
        const v = (parts[i] != null ? parts[i] : parts[0] || "").replace(/#/g, "、");
        inp.value = v;
        for (const ev of ["focus", "input", "change", "keyup", "blur"]) {
          inp.dispatchEvent(new Event(ev, { bubbles: true }));
        }
      });
      return true;
    }
    return false;
  }

  /** 下一题（原插件 X 函数）；没有下一题则交卷 */
  async function nextReviewQuestion() {
    await sleep(5000);
    if (!CM.running.running) return;

    const next = q(".reviewTestOrExam .exam-test .ET-content .content-center .ETC-left .pre-next .next-t");
    if (next) {
      clickEl(next);
      await sleep(3000);
      return runReviewPage();
    }

    // 没有下一题 = 本卷做完
    if (!CM.settings.autoSubmit) {
      note("自动提交已关闭，不执行交卷");
      return;
    }
    // ReviewExam 页面原插件不点交卷
    if (location.href.includes("smartcourseexam.zhihuishu.com/ReviewExam")) {
      note("考试预览页不做交卷，请手动确认");
      return;
    }
    const done = q(".header-content .reviewDone");
    if (done) {
      note("本卷已完成，正在交卷…");
      clickEl(done);
      CM.logAnswer({ summary: "作业已交卷" });
      CM.report("submitted", { url: location.href });
    } else {
      note("未找到交卷按钮，请手动确认");
    }
  }

  /* =========================== 考试页（stuExamWeb） =========================== */

  async function runExamPage() {
    // 当前可见的题目容器
    const subjects = qa(".examPaper_subject").filter((el) => {
      let p = el.parentElement;
      return p ? p.style.display !== "none" : true;
    });
    const subject = subjects[0];
    if (!subject) {
      note("等待考试题目加载…");
      return;
    }

    const typeText = (q(".subject_type span", subject)?.innerText || "").replace(/[【】]/g, "");
    const num = (q(".subject_num", subject)?.innerText || "").trim();
    // 题干可能在 shadowRoot 内
    const describeHost = q(".subject_describe", subject);
    const describe = describeHost?.shadowRoot
      ? describeHost.shadowRoot.textContent
      : describeHost?.innerText || "";
    const options = qa(".nodeLab", subject).map((e) => (e.innerText || "").trim());

    const answered = qa(".subject_node .node_detail.onChecked", subject).length > 0;
    if (answered) return nextExamQuestion();
    if (!CM.settings.autoFill) {
      note("自动填充已关闭，等待手动作答");
      return;
    }

    note(`正在解答 ${num}（${typeText || "未知"}）`);
    let data;
    try {
      const res = await CM.solve({
        questionText: describe,
        options,
        questionType: typeText || "未知",
        exciseUrl: location.href,
      });
      if (!res || res.errNo !== 0) throw new Error(`errNo=${res ? res.errNo : "?"}`);
      data = res.data || {};
    } catch (e) {
      CM.logAnswer({ summary: `${num} 解题失败：${e.message}` });
      return nextExamQuestion();
    }

    const option = String(data.option || "").toUpperCase();
    let any = false;
    qa(".nodeLab", subject).forEach((lab, i) => {
      const letter = String.fromCharCode(65 + i);
      if (option.includes(letter)) {
        setTimeout(() => clickEl(lab), 500 * i); // 原插件多选 500ms 错峰
        any = true;
      }
    });
    CM.logAnswer({ summary: `${num} ${typeText}：${data.option || data.answer || ""}` });
    CM.report("answer", { summary: `${num}：${data.option || ""}` });
    if (!any) CM.logAnswer({ summary: `${num} 回填失败` });

    await sleep(3000);
    nextExamQuestion();
  }

  async function nextExamQuestion() {
    const btns = qa(".switch-btn-box button");
    const next = btns[1];
    const isLast = next && /保存/.test(next.innerText || "");

    if (!next || isLast) {
      if (!CM.settings.autoSubmit) {
        note("自动提交已关闭，不执行交卷");
        return;
      }
      const submit = q(".btnStyleXSumit");
      if (!submit) {
        note("未找到交卷按钮，请手动确认");
        return;
      }
      note("本卷已完成，正在交卷…");
      clickEl(submit);
      await sleep(1500);
      const confirm = q(".el-message-box__wrapper .el-button--primary");
      clickEl(confirm);
      CM.logAnswer({ summary: "考试已交卷" });
      CM.report("submitted", { url: location.href });
      return;
    }

    clickEl(next);
    await sleep(5000);
    runExamPage();
  }

  /* =========================== 主循环 =========================== */

  let lastUrl = "";
  let reviewBusy = false;

  async function tick() {
    if (!CM.running.running) {
      if (R.running) {
        R.running = false;
        if (R.videoEl) {
          try {
            R.videoEl.pause();
          } catch {}
        }
      }
      CM.setStatus({ phase: "待机" });
      return;
    }

    const href = location.href;
    if (href !== lastUrl) {
      lastUrl = href;
      note("页面已切换");
      if (pageType() === "learn" && !R.running) {
        initLearnPage();
        return;
      }
    }

    const t = pageType();
    if (t === "review" || t === "exam") {
      if (reviewBusy) return;
      reviewBusy = true;
      try {
        if (t === "review") await runReviewPage();
        else await runExamPage();
      } catch (e) {
        console.warn("[CourseMate:zhs] review error", e);
        note(`异常：${e && e.message ? e.message : e}`);
      } finally {
        reviewBusy = false;
      }
      return;
    }

    if (t === "learn" && !R.running) {
      initLearnPage();
      return;
    }

    if (t === "learn" && R.videoEl && !R.videoEl.paused) {
      const v = R.videoEl;
      note(`视频播放中 ${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`, {
        videoProgress: v.duration ? Math.round((v.currentTime / v.duration) * 100) : 0,
      });
    }
  }

  setInterval(tick, 2500);

  CM.onRunChange((r) => {
    if (r.running) {
      note("刷课已启动");
      CM.logAnswer({ summary: "智慧树刷课已启动" });
      try {
        sessionStorage.setItem("enableVideo", "true"); // 原插件的重入标记
      } catch {}
    } else {
      note("刷课已停止");
      R.running = false;
      if (R.videoEl) {
        try {
          R.videoEl.pause();
        } catch {}
      }
      try {
        sessionStorage.removeItem("enableVideo");
      } catch {}
    }
  });

  note("就绪");
})();
