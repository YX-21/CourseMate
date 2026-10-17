/**
 * CourseMate content/chaoxing.js   —— 超星 / 学校云 (chaoxing.com, xuexitong.com)
 * ---------------------------------------------------------------------------
 * 超星平台的自动化引擎：任务队列扫描、视频处理、作业填答与跳节。
 *
 * 页面结构（三层同源 iframe，可直接 contentDocument 访问）：
 *   studentstudy 页:  #iframe  →  /ananas/modules/<模块>/ 任务 iframe  →  <video>
 *   dowork 作业页:    #iframe  →  任务 iframe  →  #frame_content  →  .singleQuesId
 *
 * 开关语义（作用于本插件自己的设置）：
 *   autoJump     完成后自动跳到下一节
 *   autoFill     自动填充答案
 *   autoSubmit   自动提交（false 时只做「暂时保存」）
 *   playbackRate 视频倍速
 */

(() => {
  "use strict";
  if (window.__cmCxEngine) return;
  window.__cmCxEngine = true;

  const CM = window.CourseMate;
  if (!CM) return;

  // 引擎只在顶层 frame 运行（跨 frame 直接操作子 iframe 的 DOM）
  let isTop = false;
  try {
    isTop = window.top === window;
  } catch {
    isTop = false;
  }
  if (!isTop) return;

  /* ------------------------------ 小工具 ------------------------------ */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const q = (root, sel) => {
    try {
      return root ? root.querySelector(sel) : null;
    } catch {
      return null;
    }
  };
  const qa = (root, sel) => {
    try {
      return root ? Array.from(root.querySelectorAll(sel)) : [];
    } catch {
      return [];
    }
  };

  const frameDoc = (f) => {
    try {
      return f && f.contentDocument ? f.contentDocument : null;
    } catch {
      return null;
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

  /** 去 href 后点击，防止 <a> 触发真实跳转/新窗口 */
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
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  };

  const note = (phase, extra) => {
    CM.setStatus({ platform: "chaoxing", phase, ...(extra || {}) });
  };

  /* ---------------------------- 任务类型分类 ---------------------------- */

  // /ananas/modules/<module>/ → 处理方式
  // video/audio/pdf → 视频类；work/pack → 答题类；bbs* → 讨论；其余 → 跳过
  function classify(kind) {
    if (/^(video|audio|pdf)$/.test(kind)) return "video";
    if (/^(work|pack)$/.test(kind)) return "exam";
    if (/^bbs(reply|topic|topiclist)$/.test(kind)) return "exam";
    return "skip";
  }

  function scanTasks() {
    const main = q(document, "#iframe");
    const mainDoc = frameDoc(main);
    // 主内容区还没加载出来：返回 null（区别于「确实没有任务」的 []）
    if (!mainDoc) return null;

    const frames = qa(mainDoc, "iframe");
    const tasks = [];
    frames.forEach((f, i) => {
      const src = f.getAttribute("src") || f.src || "";
      if (!src) return;
      const m = src.match(/\/ananas\/modules\/([^/?#]+)/i);
      const kind = m ? m[1].toLowerCase() : "";
      if (!kind) return;
      if (/topicAttachment|insertbbs/.test(kind)) return; // 这两类不参与任务队列

      const helper = classify(kind);
      tasks.push({
        key: `t${i}:${kind}:${src}`,
        index: i,
        kind,
        helper,
        src,
        el: f,
      });
    });
    return tasks;
  }

  /* --------------------------- 视频任务 --------------------------- */

  /** 暂停弹层清理 */
  function clearPauseArtifacts(doc) {
    const picBtn = q(doc, ".sp_video_pic a.jb_btn") || q(doc, ".sp_video_pic .jb_btn_92");
    if (picBtn) {
      clickEl(picBtn);
      return true;
    }
    const anno = q(doc, ".ans-videoannotation");
    if (anno && q(anno, ".comment_tit") && /批注/.test(anno.textContent || "")) {
      const cont = q(anno, ".continueLearn");
      if (cont) {
        clickEl(cont);
        return true;
      }
    }
    return false;
  }

  /** 视频是否已被超星标记为完成：.ans-job-finished + .ans-job-icon */
  function videoFinished(iframeDoc, video) {
    if (video && video.ended) return true;
    // 完成图标挂在视频容器（blockquote）上
    let node = video ? video.parentElement : iframeDoc;
    for (let d = 0; d < 6 && node; d++) {
      if (q(node, ".ans-job-finished") && q(node, ".ans-job-icon")) return true;
      node = node.parentElement;
    }
    return false;
  }

  /** 封面大播放按钮：视频未开始时播放器通常盖一层 play 按钮，必须先点掉 */
  function clickBigPlay(doc) {
    const sels = [
      ".play-btn",
      ".prism-big-play-btn",
      ".vjs-big-play-button",
      ".video-play-btn",
      ".big-play-btn",
      ".playButton",
      ".x-container-default .play-btn",
      ".prism-player .play-btn",
    ];
    for (const s of sels) {
      const el = q(doc, s);
      if (el && isVisible(el)) return clickEl(el);
    }
    return false;
  }

  function handleVideoTask(task) {
    const doc = frameDoc(task.el);
    if (!doc) return "no-frame";
    const video = q(doc, "video");
    if (!video) return "no-video";

    CM.mountVideoGuard(video);
    try {
      video.muted = true;
    } catch {}

    const rate = Number(CM.settings.playbackRate) || 1;
    try {
      if (Math.abs(video.playbackRate - rate) > 0.01) video.playbackRate = rate;
    } catch {}

    if (videoFinished(doc, video)) return "finished";

    try {
      if (video.paused && !video.ended) {
        clearPauseArtifacts(doc);
        clickBigPlay(doc);
        const p = video.play();
        if (p && p.catch) p.catch(() => {});
      }
    } catch {}

    CM.setStatus({
      phase: `视频播放中 ${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}（${rate}x）`,
      videoRate: rate,
      videoProgress: video.duration ? Math.round((video.currentTime / video.duration) * 100) : 0,
    });
    return "playing";
  }

  /* ------------------------ 答题任务 ------------------------ */

  // input[id^="answertype"].value → 题型
  const TYPE_MAP = {
    0: "单选题",
    1: "多选题",
    2: "填空题",
    3: "判断题",
    4: "简答",
    5: "名词解释",
    6: "论述",
    7: "计算",
    8: "其他",
    9: "分录题",
    10: "资料题",
    11: "连线题",
    14: "完形填空",
    15: "阅读理解",
  };

  const isObjective = (t) => [0, 1, 3].includes(t);
  const isBlank = (t) => [2, 9, 10].includes(t);

  /** 定位作业 DOM：dowork 独立页或 studentstudy 内的任务 iframe，都收敛到 #frame_content */
  function getWorkDoc() {
    let doc = document;
    const main = q(document, "#iframe");
    const mainDoc = frameDoc(main);
    if (mainDoc) {
      doc = mainDoc;
      // dowork 页面：#iframe 内还有一层任务 iframe
      const sub = q(mainDoc, "iframe");
      const subDoc = frameDoc(sub);
      if (subDoc && q(subDoc, "#frame_content")) doc = subDoc;
    }
    const fc = q(doc, "#frame_content");
    if (fc) {
      const fcDoc = frameDoc(fc);
      if (fcDoc && q(fcDoc, ".singleQuesId")) return fcDoc;
      if (q(fc, ".singleQuesId")) return doc;
    }
    if (q(doc, ".singleQuesId")) return doc;
    return null;
  }

  function isAnswered(qi, type) {
    if (type === 0 || type === 3) return !!q(qi, 'input[name^="answer"]:checked');
    if (type === 1) return qa(qi, 'input[name^="answercheck"]:checked').length > 0;
    if (type === 2 || type === 9 || type === 10) {
      return qa(qi, ".blankItemDiv textarea").some((t) => (t.value || "").trim().length > 0);
    }
    if (type === 11) return !!q(qi, ".chosen-single span");
    return qa(qi, ".Zy_ulTk textarea").some((t) => (t.value || "").trim().length > 0);
  }

  /** 在选项文本中找字母（"A. xxx" / "A、xxx" / "A xxx"） */
  const findOptionByLetter = (options, letter) => {
    const up = String(letter || "").toUpperCase().trim();
    for (const li of options) {
      const txt = (li.innerText || "").trim();
      const m = txt.match(/([A-Za-z])\s*[.、．,，:：)）]?\s*/);
      if (m && m[1].toUpperCase() === up) return li;
    }
    return null;
  };

  /** 把答案写回 DOM */
  function applyAnswer(qi, type, data) {
    const option = String(data.option || "").trim();
    const answer = String(data.answer || data.option || "").trim();

    if (type === 0) {
      const items = qa(qi, ".before-after");
      // 正常情况接口返回字母（"A"）；有时会直接返回选项文字（"实体经济"）
      let li = findOptionByLetter(items, option[0]);
      if (!li && answer) {
        const clean = answer.replace(/^[A-Za-z][.、．,，:：)）]?\s*/, "").trim();
        li = items.find((x) => {
          const t = (x.innerText || "").trim();
          return t.includes(answer) || (clean && clean.length > 1 && t.includes(clean));
        });
      }
      const target = (li && (q(li, 'input[name^="answer"]') || li)) || null;
      if (!target) return false;
      if (/check_answer/.test(target.className || "")) return true;
      return clickEl(target);
    }

    if (type === 1) {
      const letters = option.toUpperCase().split("").filter((c) => /[A-Z]/.test(c));
      if (!letters.length) return false;
      let any = false;
      for (const li of qa(qi, ".before-after-checkbox")) {
        const txt = (li.innerText || "").trim();
        const m = txt.match(/([A-Za-z])/);
        if (!m) continue;
        if (letters.includes(m[1].toUpperCase())) {
          const input = q(li, 'input[name^="answercheck"]') || li;
          if (input.checked !== true) any = clickEl(input) || any;
        }
      }
      return any;
    }

    if (type === 3) {
      // 判断题答案可能是 "A"/"B" 或 "对"/"错"/"正确"/"错误"
      const hint = /[对正]/.test(answer) ? "对" : /[错]/.test(answer) ? "错" : answer[0];
      const li = qa(qi, ".before-after").find((x) => (x.innerText || "").includes(hint));
      const target = (li && (q(li, 'input[name^="answer"]') || li)) || null;
      return target ? clickEl(target) : false;
    }

    if (type === 2 || type === 9 || type === 10) {
      // 多空用 # 分隔（经验值）
      const parts = answer.split("#").map((s) => s.trim());
      const blanks = qa(qi, ".blankItemDiv");
      if (!blanks.length) return false;
      let any = false;
      blanks.forEach((b, i) => {
        const text = parts[i] != null ? parts[i] : parts[0] || "";
        const ta = q(b, "textarea");
        if (ta) {
          ta.value = text;
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          ta.dispatchEvent(new Event("change", { bubbles: true }));
          any = true;
        }
        const inp = q(b, ".InpDIV");
        if (inp) {
          inp.innerHTML = `<p>${text}</p>`;
          any = true;
        }
        const rich = q(b, "iframe");
        const rdoc = frameDoc(rich);
        if (rdoc) {
          const p = q(rdoc.body, "p") || rdoc.body;
          p.innerHTML = text;
          any = true;
        }
      });
      return any;
    }

    // 主观题（简答/名词解释/论述/计算/其他）
    const li = q(qi, ".Zy_ulTk li") || qi;
    const ta = q(li, "textarea");
    if (ta) {
      ta.value = answer.replace(/#/g, ",");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    const fr = q(li, "iframe");
    const fdoc = frameDoc(fr);
    if (fdoc) {
      const p = q(fdoc.body, "p") || fdoc.body;
      p.innerHTML = answer;
      return true;
    }
    return false;
  }

  /**
   * 解题接口失败时的兜底：随便填一个，保证题不空着。
   * 返回可直接交给 applyAnswer 的答案串。
   * 注意：这是随机填的，正确率等同于乱选。
   */
  function fallbackAnswer(qi, type) {
    const items =
      type === 1 ? qa(qi, ".before-after-checkbox") : qa(qi, ".before-after");
    const letters = items
      .map((o) => ((o.innerText || "").trim().match(/([A-Za-z])/) || [])[1])
      .filter(Boolean)
      .map((c) => c.toUpperCase());

    // 判断题：随机「对 / 错」（A=对，B=错）
    if (type === 3) return Math.random() < 0.5 ? "A" : "B";

    // 单选：随机一个选项
    if (type === 0) {
      if (letters.length) return letters[Math.floor(Math.random() * letters.length)];
      return "A";
    }

    // 多选：随机挑 1~2 个
    if (type === 1) {
      if (letters.length) {
        const pool = [...letters].sort(() => Math.random() - 0.5);
        return pool.slice(0, Math.min(pool.length, 1 + Math.floor(Math.random() * 2))).join("");
      }
      return "A";
    }

    // 填空 / 主观题：无可选项，填占位文字
    return "略";
  }

  /**
   * 把接口错误拼成可诊断的文案。
   * 之前只记 errNo=xxxx，真实原因（errstr/msg/httpStatus）全被丢掉，
   * 导致下次再失败仍然查不出为什么。
   */
  function solveErrMsg(res) {
    if (!res) return "解题失败：搜题服务无返回";
    const parts = [`errNo=${res.errNo}`];
    if (res.errstr) parts.push(`errstr=${res.errstr}`);
    if (res.msg) parts.push(`msg=${res.msg}`);
    if (res.message) parts.push(`message=${res.message}`);
    if (res.httpStatus) parts.push(`http=${res.httpStatus}`);
    return parts.join(" ");
  }

  async function solveOne({ questionText, options, type, questionId, blankNum, index, total }) {
    const res = await CM.solve({
      questionText,
      options,
      questionType: TYPE_MAP[type] || "未知",
      questionId,
      blankNum,
      questionFrom: "workExcise",
      courseName: CM.courseName || "",
      chapterName: CM.chapterName || "",
    });
    if (!res || res.errNo !== 0) throw new Error(solveErrMsg(res));
    return res.data || {};
  }

  /** 作业页主流程：逐题填答 → 暂存/提交 */
  async function runWorkDocument(fcDoc) {
    const qs = qa(fcDoc, ".singleQuesId");
    if (!qs.length) return "no-questions";

    let solved = 0;
    let failed = 0;

    for (let i = 0; i < qs.length; i++) {
      if (!CM.running.running) return "aborted";

      const qi = qs[i];
      const typeInput = q(qi, 'input[id^="answertype"]');
      const type = Number(typeInput ? typeInput.value : -1);

      if (isAnswered(qi, type)) continue;
      if (!CM.settings.autoFill) {
        note("自动填充已关闭，跳过答题", { index: i + 1 });
        return "manual";
      }

      const questionId = qi.getAttribute("data") || "";
      const titleEl = q(qi, ".Zy_TItle");
      const questionText = ((titleEl && titleEl.innerText) || "").trim();
      const options = qa(qi, ".before-after, .before-after-checkbox")
        .map((o) => (o.innerText || "").trim())
        .filter(Boolean);
      const blankNum = qa(qi, ".blankItemDiv").length;

      note(`正在解答第 ${i + 1} / ${qs.length} 题（${TYPE_MAP[type] || "未知"}）`);

      let data;
      try {
        data = await solveOne({ questionText, options, type, questionId, blankNum, index: i, total: qs.length });
      } catch (e) {
        // 解题失败 → 不跳过，随便填一个，保证这题不空着
        const fb = fallbackAnswer(qi, type);
        const ok = applyAnswer(qi, type, { option: fb, answer: fb });
        const summary = `第${i + 1}题 解题失败（${e.message}），已随机填入 ${fb}`;
        CM.logAnswer({ summary, answer: fb, questionText: questionText.slice(0, 40) });
        CM.report("answer", { summary, answer: fb });
        note(`第 ${i + 1} 题解题失败，已随机填入：${fb}`);
        if (ok) solved++;
        else failed++;
        await sleep(1500);
        continue;
      }

      const ok = applyAnswer(qi, type, data);
      const summary =
        TYPE_MAP[type] === "填空题" || isBlank(type)
          ? `第${i + 1}题 填空：${(data.answer || data.option || "").slice(0, 30)}`
          : `第${i + 1}题 ${TYPE_MAP[type] || ""}：${data.option || data.answer || ""}`;
      CM.logAnswer({ summary, answer: data.option || data.answer, questionText: questionText.slice(0, 40) });
      CM.report("answer", { summary, answer: data.option || data.answer });

      if (ok) solved++;
      else {
        failed++;
        CM.logAnswer({
          summary: `第${i + 1}题 回填失败（答案：${data.option || data.answer || "空"}）`,
        });
      }

      // 题间节流（经验值）：客观题 5s，填空类 10s
      await sleep(isObjective(type) ? 3000 : 5000);
    }

    note(`填答完成：成功 ${solved}，失败 ${failed}，共 ${qs.length}`);

    // 一题都没填 = 之前已经处理过，不再重复提交
    if (solved === 0 && failed === 0) {
      note("本页题目均已有答案，跳过重复提交");
      return "already-done";
    }

    // 提交策略
    const unsafe = failed > 0;
    if (!CM.settings.autoSubmit || unsafe) {
      const save = q(fcDoc, ".btnSave.workBtnIndex") || q(fcDoc, ".btnSave") || q(document, "#submitFocus a");
      note(unsafe ? "存在未成功的题目，仅执行「暂时保存」" : "自动提交已关闭，仅执行「暂时保存」");
      clickEl(save);
      return "saved";
    }

    const submit = q(fcDoc, ".btnSubmit.workBtnIndex") || q(fcDoc, ".btnSubmit");
    if (!submit) {
      note("未找到提交按钮");
      return "no-submit";
    }
    note("正在提交…");
    clickEl(submit);
    await sleep(2000);

    // 提交确认弹窗在顶层 document：#popcontent / #popok / #popno
    const pop = q(document, "#popcontent");
    if (pop && isVisible(pop)) {
      const text = pop.innerText || "";
      if (/未做完|未完成/.test(text)) {
        note("平台提示有未做完的题目，取消提交");
        clickEl(q(document, "#popno"));
        clickEl(q(fcDoc, ".btnSave.workBtnIndex"));
        return "blocked";
      }
      clickEl(q(document, "#popok"));
    }
    await sleep(1500);
    note("已提交");
    return "submitted";
  }

  /* --------------------------- 完成后自动跳下一节 --------------------------- */

  async function autoJumpNext() {
    if (!CM.settings.autoJump) {
      note("本节已完成（自动跳转已关闭）");
      return;
    }
    const next = q(document, "#prevNextFocusNext");
    if (!next) {
      note("本节已完成，且没有下一节 —— 整门课处理完毕");
      return;
    }
    if (!isVisible(next)) {
      note("本节已完成，已是最后一节 —— 整门课处理完毕");
      return;
    }
    note("本节完成，2 秒后跳转到下一节…");
    await sleep(2000);
    clickEl(next);
    await sleep(1500);
    const blocked = handleJobFinishTip();
    note(blocked ? "任务点未完成，已返回继续学习" : "已跳转到下一节");
  }

  /** 通用推进：点「下一节」（#prevNextFocusNext），没有则返回上一页 */
  async function goNext() {
    const next = q("#prevNextFocusNext");
    if (next && isVisible(next)) {
      note("进入下一节");
      clickEl(next);
      await sleep(2500);
      if (handleJobFinishTip()) note("任务点未完成，已返回继续学习");
      return true;
    }
    note("本页没有「下一节」按钮，返回上一页");
    history.back();
    await sleep(2500);
    return false;
  }

  /**
   * 超星「当前章节还有任务点未完成，是否去完成？」拦截弹窗。
   * 必须点「去学习」—— 任务没做完，点「下一节」会直接放行、漏掉任务点。
   * 返回 true 表示这个弹窗被拦下处理了。
   */
  function handleJobFinishTip() {
    const tip = q(document, ".jobFinishTip");
    if (!tip || !isVisible(tip)) return false;

    const candidates = qa("a, button, span, div, li", tip);
    const learn = candidates.find((el) => {
      if (!isVisible(el)) return false;
      const t = (el.innerText || "").trim();
      return t === "去学习" || t === "继续学习" || t === "去完成";
    });

    if (learn) {
      note("本节任务点未完成 → 点击「去学习」，返回未完成任务");
      clickEl(learn);
      return true;
    }

    // 找不到「去学习」时绝不退化成点「下一节」，停在原地交给用户
    note("检测到「任务点未完成」弹窗，但没找到「去学习」按钮 —— 已停住");
    return false;
  }

  /* ------------------------------- 主循环 ------------------------------- */

  let busy = false;
  let fingerprint = "";
  let lastVideoKey = "";

  // 已处理完成的任务（防止同一份作业被反复填答/提交）
  const processed = new Set();
  const taskKey = (t) => `${location.href}|${t.key}`;

  async function tick() {
    if (!CM.running.running) {
      CM.setStatus({ phase: "待机" });
      return;
    }
    if (busy) return;
    busy = true;
    try {
      const href = location.href;

      // ---- 作业页（独立 dowork 页）：答完 → 提交 → 点「下一节」 ----
      if (/\/work\/dowork/.test(href)) {
        const key = `dowork|${href}`;
        if (processed.has(key)) {
          note("本页作业已处理完毕，进入下一节");
          await goNext();
          return;
        }
        const fcDoc = getWorkDoc();
        if (fcDoc) {
          const result = await runWorkDocument(fcDoc);
          processed.add(key);
          if (
            result === "submitted" ||
            result === "saved" ||
            result === "blocked" ||
            result === "already-done"
          ) {
            note("作业已提交，2 秒后进入下一节");
            await sleep(2500);
            await goNext();
          }
        } else {
          note("等待作业内容加载…");
        }
        return;
      }

      // ---- 学习页：任务队列（视频 → 作业 → 视频 …）----
      if (/\/mycourse\/studentstudy/.test(href)) {
        const tasks = scanTasks();
        if (!tasks) {
          note("学习页主内容尚未加载，等待…");
          return;
        }

        // 路由变化 → 重置队列与已处理记录
        const fp = tasks.map((t) => t.key).join("|");
        if (fp !== fingerprint) {
          fingerprint = fp;
          processed.clear();
          note(`检测到 ${tasks.length} 个学习任务`);
        }

        const pending = tasks.filter((t) => t.helper !== "skip" && !processed.has(taskKey(t)));
        let current = null;
        let reachable = 0;
        for (const t of pending) {
          const doc = frameDoc(t.el);
          if (!doc) continue; // iframe 还没加载好
          reachable++;
          if (t.helper === "video" && videoFinished(doc, q(doc, "video"))) continue;
          if (t.helper === "exam" && q(doc, ".testTit_status_complete")) continue;
          current = t;
          break;
        }

        if (!current) {
          // 有待办任务但 iframe 一个都打不开 → 还在加载，别急着跳节
          if (pending.length > 0 && reachable === 0) {
            note(`有 ${pending.length} 个任务的 iframe 尚未加载，等待…`);
            return;
          }

          // 本节还有插件不处理的任务类型 → 不自动跳节，否则会漏掉任务点
          const skipped = tasks.filter((t) => t.helper === "skip");
          if (skipped.length) {
            const kinds = [...new Set(skipped.map((t) => t.kind))].join(" / ");
            note(`本节还有 ${skipped.length} 个未支持的任务（${kinds}），不自动跳节`);
            return;
          }

          await autoJumpNext();
          return;
        }

        if (current.helper === "video") {
          const r = handleVideoTask(current);
          if (r === "finished") {
            note("本节视频已完成");
            processed.add(taskKey(current));
            if (current.key !== lastVideoKey) {
              lastVideoKey = current.key;
              CM.logAnswer({ summary: `视频完成（${current.kind}）` });
            }
          }
          return;
        }

        if (current.helper === "exam") {
          // 任务 iframe 内的作业：优先处理 #frame_content 里的题目
          const doc = frameDoc(current.el);
          const inner = q(doc, "#frame_content");
          const innerDoc = frameDoc(inner) || (q(doc, ".singleQuesId") ? doc : null);
          if (innerDoc) {
            const result = await runWorkDocument(innerDoc);
            // 答完并提交后标记完成，轮询转去处理下一个任务（视频）
            if (result === "submitted" || result === "saved" || result === "blocked") {
              processed.add(taskKey(current));
              note("作业任务完成，继续处理后续任务");
              CM.logAnswer({ summary: "作业完成，继续刷课" });
            }
            return;
          }
          note(`任务类型 ${current.kind} 暂不支持，已跳过`);
          processed.add(taskKey(current));
          return;
        }
        return;
      }

      note("当前页面不是超星学习页或作业页");
    } catch (e) {
      console.warn("[CourseMate:chaoxing] tick error", e);
      note(`异常：${e && e.message ? e.message : e}`);
    } finally {
      busy = false;
    }
  }

  setInterval(tick, 1200);

  CM.onRunChange((r) => {
    if (r.running) {
      note("刷课已启动");
      CM.logAnswer({ summary: "刷课已启动" });
    } else {
      note("刷课已停止");
      CM.logAnswer({ summary: "刷课已停止" });
    }
  });

  // 课程名缓存（原 cx.js 的作用）：/mycourse/stu?courseid 页读取
  if (/\/mycourse\/stu/.test(location.href)) {
    const id = q(document, "#courseid");
    const name = q(document, ".nav_side .classDl dd");
    if (id && id.value) CM.courseId = id.value;
    if (name && name.innerText) CM.courseName = name.innerText.trim();
  }

  note("就绪");
})();
