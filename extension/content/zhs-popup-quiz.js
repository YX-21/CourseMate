/**
 * CourseMate content/zhs-popup-quiz.js   (MAIN world, document_end)
 * ---------------------------------------------------------------------------
 * 智慧树视频内弹题（#playTopic-dialog）自动作答。
 *
 * 弹题对话框的 Vue 实例里
 *   vm.topicInfo.lessonTestQuestionUseInterfaceDtos[0]
 *     .testQuestion.questionOptions[]  选项（含 sortUs 字母）
 *     .answerUs[]                      正确答案的字母集合
 * 即答案本来就在页面数据里，不需要调解题接口。
 * 通过 vm.topicClickQot(option) 逐项点选，再 vm.testDialog = false 关闭对话框。
 *
 * 这里改为自动检测触发，无需外部 postMessage。
 */

(() => {
  "use strict";
  if (window.__cmZhsQuiz) return;
  window.__cmZhsQuiz = true;

  let lastToken = "";

  function answerQuiz() {
    try {
      const dialog = document.querySelector("#playTopic-dialog");
      if (!dialog) return;
      const vm = dialog.__vue__?.$parent?.$parent;
      const dto = vm?.topicInfo?.lessonTestQuestionUseInterfaceDtos?.[0];
      const options = dto?.testQuestion?.questionOptions;
      const answers = dto?.answerUs;

      if (!vm || !options?.length || !answers?.length) return;

      // 用对话框内容做指纹，避免重复作答
      const token = JSON.stringify(options.map((o) => o.sortUs)) + JSON.stringify(answers);
      if (token === lastToken) return;
      lastToken = token;

      const correct = options.filter((o) => o.sortUs && answers.includes(o.sortUs));
      if (!correct.length) return;

      console.info(
        "[CourseMate] 智慧树视频弹题，自动作答：",
        correct.map((o) => o.sortUs).join(",")
      );

      correct.forEach((opt, i) => {
        setTimeout(() => {
          try {
            vm.topicClickQot?.(opt);
          } catch (e) {
            console.warn("[CourseMate] 点选弹题失败", e);
          }
        }, 800 * i);
      });

      setTimeout(() => {
        try {
          vm.testDialog = false;
        } catch {}
      }, 800 * correct.length + 3000);
    } catch (e) {
      console.warn("[CourseMate] 弹题处理异常", e);
    }
  }

  setInterval(answerQuiz, 1500);
})();
