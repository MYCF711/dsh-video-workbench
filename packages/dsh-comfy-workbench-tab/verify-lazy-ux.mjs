/**
 * 校验：懒人链路的四项体验保障
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这四条都是 2026-10-25 实测发现、且【用户能直接感觉到】的缺陷：
 *
 *   ① 提示词技能没被引用
 *      三个工作流各有一个专属提示词规范技能（krea2-prompt-suite /
 *      h3-prompt-writing / qwen-image-2-1-prompter），本机现成有，
 *      而 comfy-mode-dispatch 里一个字都没提 ⇒ LLM 反推提示词全靠通用理解，
 *      写出来的词模型不吃。
 *
 *   ② 工作台状态没按会话隔离
 *      sessionStorage 的 key 写死，不按 DSH 会话分 ⇒ 会话 A 的提示词
 *      出现在会话 B。而 sessionId 一直在 props 里。
 *
 *   ③ 刷新页面 = 正在跑的任务人间蒸发
 *      任务状态只在 React 内存里；ComfyUI 里还在跑（yz 一次 178 秒）。
 *      用户看到空白 → 以为没生成 → 再点一次 → 两个任务抢 16GB 显存。
 *
 *   ④ 「已接管」提示 8 秒后消失
 *      用户刷新后慢一点切到工作台就看不到，只剩进度条自己在动。
 *
 * 全部静默失效 —— 界面上没有任何异常。
 * ══════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const TAB = path.join(REPO, "packages", "dsh-comfy-workbench-tab");
const BRIDGE = path.join(REPO, "packages", "dsh-comfy-bridge");
const PRESET = path.join(REPO, "packages", "dsh-comfy-preset");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};
const must = (c, m) => { if (!c) throw new Error(m); };

/** 剥掉注释 —— 本项目老坑：注释里写着旧写法，直接搜会假红/假绿 */
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const skillPath = path.join(PRESET, "skills", "comfy-mode-dispatch", "SKILL.md");
const skill = fs.readFileSync(skillPath, "utf8");
const wbPath = path.join(TAB, "src", "WorkbenchView.js");
const wb = fs.readFileSync(wbPath, "utf8");
const wbCode = strip(wb);
const bridgeSrc = fs.readFileSync(path.join(BRIDGE, "src", "index.js"), "utf8");
const bridgeCode = strip(bridgeSrc);

console.log("\n=== ① 提示词技能被引用 ===\n");

t("技能里明确指向 krea2-prompt-suite（生图）", () => {
  must(skill.includes("krea2-prompt-suite"), "没提 krea2-prompt-suite —— krea2 的提示词会写歪");
});
t("技能里明确指向 h3-prompt-writing（视频）", () => {
  must(skill.includes("h3-prompt-writing"), "没提 h3-prompt-writing —— H3 的结构化三件套会漏");
});
t("技能里明确指向 qwen-image-2-1-prompter（改图）", () => {
  must(skill.includes("qwen-image-2-1-prompter"), "没提 qwen-image-2-1-prompter —— 改图会写成生图");
});
t("技能里写明「写提示词前必须先读」这条硬规则", () => {
  must(/写提示词[^\n]{0,10}必须[^\n]{0,20}读/.test(skill), "没有「必须先读」的硬约束，LLM 会跳过");
});
t("description 里带上了「帮我写提示词」类触发词", () => {
  must(/触发词[^\n]*帮我写提示词/.test(skill), "触发词没覆盖「帮我写提示词」—— 用户这么说时可能匹配不到");
});

console.log("\n=== ② 会话隔离 ===\n");

t("有 persistKeyFor(sessionId) 这个函数", () => {
  must(/function persistKeyFor\s*\(\s*sessionId\s*\)/.test(wbCode), "没有按会话派生 key 的函数");
});
t("key 真的拼了 sessionId（不是写死）", () => {
  must(/return\s+`\$\{PERSIST_KEY\}:\$\{sid\}`/.test(wbCode.replace(/\s+/g, " "))
    || /PERSIST_KEY\}:\$\{sid\}/.test(wbCode),
    "key 没拼 sessionId —— 会话之间会串");
});
t("loadPersisted / savePersisted 都接收 sessionId", () => {
  must(/function loadPersisted\(sessionId\)/.test(wbCode), "loadPersisted 没接 sessionId");
  must(/function savePersisted\(sessionId, patch\)/.test(wbCode), "savePersisted 没接 sessionId");
});
t("调用点真的传了 sessionId", () => {
  must(/loadPersisted\(sessionId\)/.test(wbCode), "读的时候没传 sessionId");
  /**
   * ★★ 2026-10-25 变异测试抓出的真盲区：
   *   原来这里写 `/savePersisted\(sessionId,/`，而**函数定义**
   *   `function savePersisted(sessionId, patch)` 也匹配这个模式。
   *   ⇒ 把调用点改成 `savePersisted({`（不传 sessionId）后断言依然通过。
   *
   *   判据：断言要区分「定义」和「调用」。
   *     定义行以 function / const 开头，调用行不是。
   *   ⇒ 排除掉紧跟在 function/const 后面的那种匹配。
   */
  const calls = [...wbCode.matchAll(/(\w+\s*=\s*)?savePersisted\(sessionId,/g)]
    .filter((m) => !/function\s+$/.test(wbCode.slice(Math.max(0, m.index - 20), m.index)));
  must(calls.length > 0, "写的时候没传 sessionId（只有定义处匹配上了，调用点没传）");
});
t("组件从 props 解构出 sessionId", () => {
  must(/const\s*\{[^}]*sessionId[^}]*\}\s*=\s*props/.test(wbCode), "组件没拿到 sessionId");
});
t("★ 有旧值迁移（升级后不会觉得输入丢了）", () => {
  must(/key !== PERSIST_KEY/.test(wbCode), "没有从旧 key 迁移的逻辑 —— 老用户升级后会觉得提示词没了");
});

console.log("\n=== ③ 任务状态可恢复 ===\n");

t("后端有 jobs handler（列出任务）", () => {
  must(/async jobs\(\{\s*all\s*=\s*false/.test(bridgeCode), "handlers 里没有 jobs()");
});
t("后端注册了 GET /jobs 路由", () => {
  must(/prefix \+ "\/jobs"/.test(bridgeCode), "没注册 /jobs 路由");
});
t("★ /jobs 用 exact（不然会被 /job 的 prefix 抢走）", () => {
  const idx = bridgeCode.indexOf('prefix + "/jobs"');
  must(idx > 0, "找不到 /jobs 注册处");
  const before = bridgeCode.slice(Math.max(0, idx - 120), idx);
  must(/kind:\s*"exact"/.test(before), "/jobs 不是 exact —— 匹配时可能被 /job 的 prefix 拦掉");
});
t("job 结束时记录 finishedAt（/jobs 才能判断 done）", () => {
  must(/job\.finishedAt\s*\?\?=\s*Date\.now\(\)/.test(bridgeCode), "没记录 finishedAt");
});
t("失败任务被标记（failed 字段）", () => {
  must(/job\.failed\s*=\s*true/.test(bridgeCode), "没标记失败任务");
});
t("前端挂载时拉 /comfy-bridge/jobs", () => {
  must(wbCode.includes('fetch("/comfy-bridge/jobs"'), "前端没拉任务列表");
});
t("前端对未结束的任务调用 startPoll 接管", () => {
  const idx = wbCode.indexOf('fetch("/comfy-bridge/jobs"');
  const after = wbCode.slice(idx, idx + 1600);
  must(/startPoll\(newest\.jobId\)/.test(after), "没接管任务（没调 startPoll）");
});
t("★ 只接管未结束的（done 的要过滤掉）", () => {
  must(/filter\(\(x\)\s*=>\s*x && !x\.done\)/.test(wbCode), "没过滤已完成任务 —— 会恢复一条旧状态误导用户");
});

console.log("\n=== ④ 接管提示不会自己消失 ===\n");

t("有独立的 resumeNotice 状态（不共用 fillNotice）", () => {
  must(/const \[resumeNotice, setResumeNotice\]/.test(wbCode), "没有独立的 resumeNotice");
});
t("★ 接管提示没有 8 秒超时", () => {
  const idx = wbCode.indexOf("setResumeNotice(");
  must(idx > 0, "没设置 resumeNotice");
  const seg = wbCode.slice(idx, idx + 600);
  must(
    !/setTimeout\([^)]*setResumeNotice\(null\)/.test(seg),
    "接管提示被挂了定时器 —— 用户慢一点切过来就看不到了"
  );
});
t("任务结束时才收起接管提示", () => {
  must(
    /if \(isTerminal\) \{[\s\S]{0,200}setResumeNotice\(null\)/.test(wbCode),
    "任务结束没有收起 resumeNotice —— 提示会一直挂着说「正在跑」"
  );
});
t("接管提示有渲染块（且真的挂在 resumeNotice 上）", () => {
  /**
   * ★★ 2026-10-25 变异测试抓出的盲区：
   *   原来写 `/resumeNotice\s*\n?\s*\?\s*h\("div"/` —— 把渲染条件改成
   *   `null && resumeNotice ? h("div")` 后，正则仍能匹配到那串文本，
   *   而实际渲染永远不会发生。
   *
   *   判据：要求「行首是 resumeNotice（可带缩进），紧跟 ? h("div")」，
   *        中间不许有别的东西 —— 这样 null && 之类会立刻失败。
   */
  const re = /^[ \t]*resumeNotice[ \t]*\r?\n[ \t]*\?[ \t]*h\("div"/m;
  must(re.test(wbCode), "resumeNotice 没有作为条件渲染（或被 null && 之类短路掉了）");
});

console.log(`\n通过 ${pass} / ${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
