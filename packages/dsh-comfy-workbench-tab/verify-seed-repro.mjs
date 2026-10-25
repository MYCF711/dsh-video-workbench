/**
 * 校验：种子的可见性与可复现
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这是「懒人能不能微调」的核心，不是锦上添花。
 *
 * 【实测问题一】用户留空种子（默认行为）时，后端【完全不碰种子节点】：
 *     if (params.seed != null && mode.vars.seed) { setInput(...) }
 *   ⇒ 沿用工作流里的原始固定值。已知 bind 里就是写死的数
 *   ⇒ 用户以为「留空 = 每次随机」，实际每次跑同一个种子，
 *     连出十张几乎一样的图，还以为模型坏了。
 *
 * 【实测问题二】即使出了好图，用户也不知道这次用了什么种子：
 *   · 想「同一张换个发色再试」做不到（没有种子）
 *   · 想出相似风格的第二张也做不到
 *   ⇒ 生成 100 张里有一张满意的，就只能靠运气再抽。
 *
 * 【实测问题三】骰子按钮填一个具体数字进框，语义是反的：
 *   用户点「随机种子」想要的是「换一张」，而它把种子锁死成某个固定值。
 *
 * 修法：
 *   后端 —— 留空时生成一个 INT32 随机种子，写进节点，随返回值带出（seed）
 *   前端 —— 提交成功后回填进输入框（只在他原本留空时）
 *   骰子 —— 改成清空（空 = 这次随机）
 *
 * 判据：**凡是「用户留空」的参数，系统替他选的值必须可见**，
 *       否则他既不能复现也不能微调。
 * ══════════════════════════════════════════════════════════════════════
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const WF = path.join(REPO, "packages", "dsh-comfy-bridge", "src", "workflows.mjs");
const IDX = path.join(REPO, "packages", "dsh-comfy-bridge", "src", "index.js");
const WB = path.join(HERE, "src", "WorkbenchView.js");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};
const must = (c, m) => { if (!c) throw new Error(m); };
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const wf = strip(fs.readFileSync(WF, "utf8"));
const idx = strip(fs.readFileSync(IDX, "utf8"));
const wb = strip(fs.readFileSync(WB, "utf8"));

console.log("\n=== ① 后端：留空时自己定一个，并回报 ===\n");

t("留空时生成随机种子（不是沿用工作流固定值）", () => {
  must(
    /Math\.random\(\)\s*\*\s*2147483647/.test(wf),
    "没有生成随机种子 —— 留空时会沿用工作流里的固定值，出图几乎一样"
  );
});

t("★ 随机种子被写进节点（不是生成了却不用）", () => {
  const i = wf.indexOf("let usedSeed = null;");
  must(i > 0, "没有 usedSeed");
  const seg = wf.slice(i, i + 900);
  must(/setInput\(mode\.vars\.seed\.node/.test(seg), "usedSeed 没有写进种子节点");
});

t("种子上限是 INT32（ComfyUI 的 seed 是 int）", () => {
  /**
   * ★★ 2026-10-25 变异/假红记录：
   *   原来写 `!/Number\.MAX_SAFE_INTEGER/.test(wf)` —— 而那个常量在
   *   本文件里另有两处【正当】用途（排序时 order 缺失的兜底）。
   *   ⇒ 断言会永远假红，跟种子毫无关系。
   *
   *   判据：断言要盯「种子那一行」，不是「整个文件里有没有某个词」。
   */
  const i = wf.indexOf("let usedSeed = null;");
  must(i > 0, "找不到 usedSeed");
  const seg = wf.slice(i, i + 900);
  must(/2147483647/.test(seg), "种子没有按 INT32 上限生成 —— 超出会被 ComfyUI schema 拒");
  must(
    !/Math\.random\(\)\s*\*\s*Number\.MAX_SAFE_INTEGER/.test(seg),
    "种子用了 MAX_SAFE_INTEGER —— 那是 INT64 范围，ComfyUI 收不了"
  );
});

t("buildPrompt 返回值带 seed", () => {
  must(/seed:\s*usedSeed/.test(wf), "buildPrompt 没把实际种子传出去");
});

t("generate 响应带 seed（前端不用再查一次）", () => {
  const i = idx.indexOf("const built = buildPrompt(");
  must(i > 0, "找不到 buildPrompt 调用");
  const seg = idx.slice(i, i + 2200);
  must(/seed:\s*built\.seed/.test(seg), "generate 的返回值没有 seed");
});

t("job 记录里也存 seed（历史可查）", () => {
  const i = idx.indexOf("jobs.set(jobId, {");
  must(i > 0, "找不到 jobs.set");
  const seg = idx.slice(i, i + 1200);
  must(/seed:\s*built\.seed/.test(seg), "job 记录没存 seed");
});

console.log("\n=== ② 前端：回填但不覆盖用户手填的值 ===\n");

t("提交成功后回填种子", () => {
  must(/setSeed\(String\(r\.seed\)\)/.test(wb), "没有回填种子 —— 用户不知道这次用了什么");
});

t("★ 只在原本留空时回填（手填了就不改）", () => {
  const i = wb.indexOf("setSeed(String(r.seed))");
  must(i > 0, "找不到回填处");
  const seg = wb.slice(Math.max(0, i - 700), i);
  /**
   * ★★ 2026-10-25 变异测试抓出的盲区：
   *   原来写 `/seedIsBlank/.test(seg) || /seed === ""/.test(seg)` ——
   *   只要出现过这个标识符就算过。把 seedIsBlank 改成恒 true
   *   （于是每次都覆盖用户手填的种子）后，断言照绿。
   *
   *   判据：不能只检查「有没有判空变量」，要检查
   *        **这个变量本身真的区分了「空」和「非空」**。
   *   ⇒ 要求它的定义里同时出现「空串判定」和至少一个空值族
   *      （null / undefined），不能是常量。
   */
  const def = seg.match(/const\s+seedIsBlank\s*=\s*([^;]+);/);
  must(def, "没有 seedIsBlank 的定义 —— 无法确认它真的判空");
  const expr = def[1];
  must(/===\s*""/.test(expr), `seedIsBlank 没有判空串（现在是 ${expr}）`);
  must(/null/.test(expr) || /undefined/.test(expr),
    `seedIsBlank 没有覆盖 null/undefined（现在是 ${expr}）`);
  must(!/=\s*(true|false)\s*$/.test(expr.trim()),
    "seedIsBlank 是常量 —— 等于每次都会覆盖用户手填的值");

  must(
    !/String\(seed[^)]*\)\.trim\(\)/.test(seg),
    "用了 String().trim() 判空（AGENTS §6.32 禁止的写法）"
  );
});

console.log("\n=== ③ 骰子按钮：清空（换一张），不是填死一个数 ===\n");

t("★ 骰子的 onClick 是 setSeed 空串", () => {
  must(
    /onClick:\s*\(\)\s*=>\s*setSeed\(""\)/.test(wb),
    "骰子还是填一个具体数字 —— 语义反了（用户要的是「换一张」）"
  );
});

t("骰子的 title 说清它是「换一张」", () => {
  const i = wb.indexOf('"aria-label": t("field.seedRandom")');
  must(i > 0, "找不到骰子按钮");
  const seg = wb.slice(i, i + 400);
  must(/换一张|清空/.test(seg), "title 没有说明它是换一张 —— 用户会以为能抽一个具体值");
});

t("输入框 placeholder 与「留空=随机」一致", () => {
  /* placeholder 来自 field.seedHint，这里只要求它是「留空随机」族语义 */
  const locale = fs.readFileSync(path.join(HERE, "src", "locale.js"), "utf8");
  const m = locale.match(/"field\.seedHint":\s*"([^"]+)"/);
  must(m, "找不到 field.seedHint");
  must(/留空|随机/.test(m[1]), `placeholder「${m[1]}」没说清留空是什么行为`);
});

console.log(`\n通过 ${pass} / ${pass + fail}\n`);
if (fail) console.log("★ 用户拿不到种子 = 出到好图也不能复现/微调。\n");
process.exit(fail === 0 ? 0 : 1);
