/**
 * 参数闭环检查 —— 界面上的每个参数控件，是否真的把值传给了后端。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这一套
 *
 *   2026-10-19 的阻断级缺陷（AGENTS §6.25）：
 *   「画幅 / 尺寸 / 张数 / 放大模型 / 时长」五个控件在界面上都能点、
 *   能显示、能持久化，但 onGenerate 里的 params 从来没带这些字段。
 *   ⇒ 主人调了两天参数，一个都没生效。
 *
 *   这类缺陷极难靠肉眼发现：
 *     · 界面显示对的（state 更新了，看起来「改了」）
 *     · 生成能成功（用默认值也能出图）
 *     · 输出尺寸看着正常（工作流默认值也合理）
 *   ⇒ 唯一可靠的检查是【静态比对两个清单】：
 *        A. UI 里渲染了哪些参数控件（Select / NumberField / ToggleSwitch）
 *        B. params 对象里赋值了哪些字段
 *     差集就是「摆设控件」。
 *
 * ══════════════════════════════════════════════════════════════════════
 *
 * 检查项：
 *   ① 每个 UI 参数控件都在 params 里有对应赋值
 *   ② params 里每个字段都被后端 buildPrompt 认（不是白传）
 *   ③ 每个 params 字段都先问 caps（不给不支持的工作流发多余字段）
 *
 * 用法：
 *   node tools/check-param-closure.mjs
 *   退出码 0 = 闭环，1 = 有断点
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WB_SRC = path.resolve(HERE, "..", "..", "dsh-comfy-workbench-tab", "src", "WorkbenchView.js");
const BRIDGE_SRC = path.resolve(HERE, "..", "src", "workflows.mjs");

let pass = 0;
let fail = 0;
const problems = [];

function ok(name, detail = "") {
  pass++;
  console.log(`  ✅ ${name}${detail ? "  " + detail : ""}`);
}
function bad(name, detail = "") {
  fail++;
  problems.push(`${name}${detail ? "：" + detail : ""}`);
  console.log(`  ❌ ${name}${detail ? "  " + detail : ""}`);
}

console.log("═".repeat(62));
console.log("  参数闭环检查（UI 控件 ⇄ params ⇄ 后端）");
console.log("═".repeat(62));

if (!fs.existsSync(WB_SRC)) {
  console.log(`  ★ 找不到前端源码：${WB_SRC}`);
  process.exit(1);
}
if (!fs.existsSync(BRIDGE_SRC)) {
  console.log(`  ★ 找不到后端源码：${BRIDGE_SRC}`);
  process.exit(1);
}

const wb = fs.readFileSync(WB_SRC, "utf8");
const bridge = fs.readFileSync(BRIDGE_SRC, "utf8");

// ─── A. UI 参数控件清单 ──────────────────────────────────────────
// 从 h(Select, { label: t("field.xxx") ... }) / h(NumberField, ...) / h(ToggleSwitch, ...)
// 抽出 label 的 i18n key，再去映射表里换成真字段名。
// 这里不做 i18n 解引用，直接按出现顺序列 key —— 人肉对照也更清楚。
function collectUiControls(src) {
  const out = [];
  const re = /h\((Select|NumberField|ToggleSwitch),\s*\{([\s\S]{0,400}?)\}\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const kind = m[1];
    const body = m[2];
    const lm = /label:\s*(?:t\("([^"]+)"\)|"([^"]+)"|([A-Za-z_$][\w$]*))/.exec(body);
    if (!lm) continue;
    // ★ 只收 i18n key 或字符串字面量。不收裸标识符 ——
    //   那多半是表达式（如 currentMode），不是控件名，收进来会误报。
    const label = lm[1] ?? lm[2];
    if (!label) continue;
    out.push({ kind, label, at: m.index });
  }
  return out;
}

// ─── B. params 赋值字段清单 ──────────────────────────────────────
function collectParamFields(src) {
  const fields = new Map(); // name → { line, hasCapsGuard }
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // params.xxx = ...  或  const params = { a, b, c }
    const m1 = /\bparams\.([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (m1) {
      fields.set(m1[1], {
        line: i + 1,
        hasCapsGuard: /caps\./.test(line),
      });
      continue;
    }
    const m2 = /const params = \{([^}]*)\}/.exec(line);
    if (m2) {
      for (const raw of m2[1].split(",")) {
        const name = raw.split(":")[0].trim();
        if (name) fields.set(name, { line: i + 1, hasCapsGuard: false });
      }
    }
  }
  return fields;
}

// ─── C. 后端认可的字段白名单 ─────────────────────────────────────
// workflows.mjs 顶部有个字符串数组列了字段名，加上代码里实际读的 params.xxx
function collectBackendFields(srcList) {
  const set = new Set();
  for (const src of srcList) {
    const re = /params\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(src)) !== null) set.add(m[1]);
  }
  return set;
}

const ui = collectUiControls(wb);
const params = collectParamFields(wb);
// ★ 2026-10-19 修（第一版只扫 workflows.mjs，误报 refLabels/refWarnings 白传）：
//   后端读 params 的地方不止 workflows.mjs ——
//   index.js:154 就读了 params.refLabels（注入 subject_definitions 到 prompt 头）。
//   ⇒ 必须扫整个 src 目录。
// ★★ 2026-10-19 第二次修正：index.js 不在 src/ 里，在包根目录。
//   第一次只扫 src/，所以 refLabels 还是被判「后端从不读」——
//   而 index.js:154 明明在读。漏了包根的入口文件。
// ★★ 2026-10-19 第三次修正（连错两次）：
//   第一次只扫 src/*.mjs  → 漏了 src/index.js（是 .js 不是 .mjs）
//   第二次去包根找 index.js → 那里没有，它在 src/ 里
//   ⇒ 正确做法：扫 src/ 下【所有】.js 与 .mjs。
//   教训：过滤后缀时不要假设「源码都是 .mjs」—— 混用很常见。
const PKG = path.resolve(HERE, "..");
const SRC_DIR = path.join(PKG, "src");
const backendFiles = [
  ...fs.readdirSync(SRC_DIR)
    .filter((n) => /\.(m?js)$/.test(n))
    .map((n) => path.join(SRC_DIR, n)),
  path.join(PKG, "index.js"),   // 兼容「入口在包根」的写法
].filter((p) => fs.existsSync(p));
const backendSources = backendFiles.map((p) => fs.readFileSync(p, "utf8"));
const backend = collectBackendFields([...backendSources, bridge]);

console.log(`\n── UI 参数控件 ${ui.length} 个 ──`);
for (const c of ui) console.log(`  ${c.kind.padEnd(14)} ${c.label}`);

console.log(`\n── params 字段 ${params.size} 个 ──`);
for (const [name, meta] of params) {
  console.log(`  ${name.padEnd(18)} 行 ${String(meta.line).padStart(4)}  ${meta.hasCapsGuard ? "有 caps 守卫" : ""}`);
}

// ─── ① 控件 → params 的映射表（人工维护，字段名不等于 label）─────
// ★ 这张表是「契约」：加控件就要在这里加一行，否则检查就会报出来。
const UI_TO_PARAM = {
  "field.mode": "modeId",          // generate(modeId, params)
  "field.aspect": "aspect",
  "field.megapixels": "megapixels",
  "field.seedvrModel": "seedvrModel",
  "field.batch": "batch",
  "field.duration": "durationSec",
  "field.steps": "steps",
  "field.steps1": "steps",
  "field.steps2": "steps2",
  "seed": "seed",
};

console.log("\n── ① 每个 UI 控件都有 params 归宿 ──");
for (const c of ui) {
  const target = UI_TO_PARAM[c.label];
  if (!target) {
    bad(`控件「${c.label}」没有映射`, "在 UI_TO_PARAM 里补一行，再确认它真的传给了后端");
    continue;
  }
  if (target === "modeId") {
    ok(`控件「${c.label}」→ generate(modeId, ...)`);
    continue;
  }
  if (!params.has(target)) {
    bad(`控件「${c.label}」→ params.${target} 但 params 里没有这个字段`, "摆设控件");
    continue;
  }
  ok(`控件「${c.label}」→ params.${target}`);
}

// ─── ② params 字段都被后端认 ────────────────────────────────────
console.log("\n── ② params 里每个字段后端都认 ──");
for (const name of params.keys()) {
  if (backend.has(name)) ok(`params.${name} 后端会读`);
  else bad(`params.${name} 后端从不读`, "白传，检查字段名是否拼错");
}

// ─── ③ 每项都有 caps 守卫（初值里那三个除外）────────────────────
console.log("\n── ③ 可选参数先问 caps ──");
// ★ seed 不需要 caps 声明：后端直接读 params.seed，所有工作流都接受。
//   caps 是「这个工作流的界面要不要显示这个控件」，而 seed 的控件是常驻的。
const ALWAYS_OK = new Set(["prompt", "steps", "toggles", "files", "refLabels", "refWarnings", "seed"]);
for (const [name, meta] of params) {
  if (ALWAYS_OK.has(name)) continue;
  if (meta.hasCapsGuard) ok(`params.${name} 有 caps 守卫`);
  else bad(`params.${name} 没问 caps`, "给不支持该参数的工作流会发多余字段");
}

console.log("\n" + "═".repeat(62));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log("  问题：");
  for (const p of problems) console.log(`    · ${p}`);
  process.exit(1);
}
console.log("  参数闭环检查全过");
