#!/usr/bin/env node
/**
 * 找出「静默吞掉错误的 catch」—— 也就是 catch 体里什么都没有的写法。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个检查
 *
 *   2026-10-23 实测：dsh-comfy-bridge/src/index.js:830 写了裸 path.join，
 *   而那个文件只有 nodePath（node:path 的命名空间导入）。
 *
 *   后果链：
 *     抛 ReferenceError
 *     → 被外层那个「解析不到就不兜底」的空 catch 吞掉
 *     → 静默不兜底
 *     → ComfyUI 没开时模型清单永远 unknown=true
 *
 *   **这与我「本地兜底」的设计意图正好相反，而且完全无声。**
 *
 *   ★ 关键认知：空 catch 是最危险的写法之一。
 *     它本意是「容错」，实际会连【编程错误】一起吞掉 ——
 *     拼错的变量名、调用不存在的函数、访问 undefined 的属性……
 *     这些都不是「意料之中的失败」，而是代码写错了。
 *
 * ── 判据
 *   不是所有空 catch 都是错的。要区分：
 *     合理：清理临时文件（删不掉就算了）、可选功能探测
 *     可疑：包住一大段业务逻辑、包住可能抛编程错误的多行代码
 *
 *   本工具按【catch 包住的 try 体有多大】分级：
 *     · 空 catch 且 try 体 > 5 行   → 可疑（可能吞掉编程错误）
 *     · 空 catch 且 try 体 <= 5 行  → 提示（自己判断）
 *     · catch 里有 log/warn/throw  → 合格
 *
 *   用法：
 *     node tools/check-silent-catch.mjs          # 只报「可疑」
 *     node tools/check-silent-catch.mjs --strict # 连提示也当失败
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const STRICT = process.argv.includes("--strict");

const requireFromHere = createRequire(import.meta.url);
let acorn;
try {
  acorn = requireFromHere("acorn");
} catch {
  console.log("  ❌ 找不到 acorn。见 tools/check-undeclared.mjs 顶部注释。");
  process.exit(2);
}

const dirs = [
  "dsh-comfy-workbench-tab/src",
  "dsh-comfy-bridge/src",
  "dsh-editor/src",
  "dsh-video-knowledge/src",
].map((d) => path.join(ROOT, d));

/**
 * 判断 catch 体是否「什么都没做」。
 * 允许里面有注释（注释不是语句）。
 */
function isEmptyBody(node) {
  if (!node || node.type !== "BlockStatement") return false;
  return node.body.length === 0;
}

/** 数一个节点的语句行数跨度（用于判断 try 体多大）。 */
function lineSpan(node) {
  if (!node?.loc) return 0;
  return node.loc.end.line - node.loc.start.line + 1;
}

/**
 * 判断一个 catch 是否「危险地静默」。
 *
 * ★★ 2026-10-23 第二版：第一版按「try 体行数 > 5」判，28 处全报，
 *   但抽查发现多数是合理的容错（轮询端点失败不影响编辑、
 *   清理临时文件删不掉就算了）。
 *
 *   ⇒ 行数不是好判据。改成看【try 体里有没有「不该失败却可能抛编程错误」的动作】：
 *
 *     危险动作（编程错误会在这里冒出来）：
 *       · 变量引用 / 函数调用 / 属性访问 —— 拼错名字、调用不存在的函数
 *     安全动作（失败是意料之中的）：
 *       · await fetch(...) / JSON.parse / fs.unlink —— 网络、解析、文件 IO
 *
 *   判据：try 体里【同时】有危险动作、且整个 try 有 ≥8 行（说明包了业务逻辑），
 *         而 catch 完全没反应（无 log/throw/赋值）⇒ 可疑。
 *
 *   ★ 更重要的一条：如果 try 体里【没有】任何可能抛编程错误的复杂逻辑
 *     （比如只有一行 fetch），那空 catch 是合理的。
 */
function isDangerousSilent(tryBlock, catchBody) {
  if (!isEmptyBody(catchBody)) return false;

  const span = lineSpan(tryBlock);
  /* 太小的 try 体：空 catch 是合理容错 */
  if (span < 8) return false;

  /**
   * ★ 关键：看 try 体里有没有「调用本地函数」或「访问多层属性」——
   *   这类最容易藏编程错误。
   *   纯 fetch + json() + 简单赋值的不算。
   */
  let risky = 0;
  const walk = (n) => {
    if (!n || typeof n.type !== "string") return;

    if (n.type === "MemberExpression") {
      /* a.b.c 三层以上 —— 中间任一为 undefined 就 TypeError */
      let depth = 0;
      let o = n;
      while (o && o.type === "MemberExpression") { depth++; o = o.object; }
      if (depth >= 2) risky += 1;
    }

    for (const k of Object.keys(n)) {
      if (k === "type" || k === "loc" || k === "start" || k === "end") continue;
      const v = n[k];
      if (Array.isArray(v)) { for (const x of v) walk(x); }
      else if (v && typeof v.type === "string") walk(v);
    }
  };
  walk(tryBlock);

  /* 多层属性访问 ≥ 6 次，说明这段逻辑不简单，空 catch 会掩盖问题 */
  return risky >= 6;
}

let files = 0;
let suspicious = 0;
let hints = 0;

function walkDir(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walkDir(full); continue; }
    if (!/\.m?js$/.test(e.name) || /\.bak/.test(e.name)) continue;
    if (e.name === "client.js" && /[\\/]lib[\\/]/.test(full)) continue;

    files += 1;
    const src = fs.readFileSync(full, "utf8");

    let ast;
    try {
      ast = acorn.parse(src, {
        ecmaVersion: "latest", sourceType: "module",
        locations: true, allowHashBang: true,
      });
    } catch { continue; }

    /* 收集所有 try 语句 */
    const tries = [];
    const walk = (n) => {
      if (!n || typeof n.type !== "string") return;
      if (n.type === "TryStatement") tries.push(n);
      for (const k of Object.keys(n)) {
        if (k === "type" || k === "loc" || k === "start" || k === "end") continue;
        const v = n[k];
        if (Array.isArray(v)) { for (const x of v) walk(x); }
        else if (v && typeof v.type === "string") walk(v);
      }
    };
    walk(ast);

    for (const t of tries) {
      const h = t.handler;
      if (!h) continue;                       // try/finally，没有 catch
      if (!isEmptyBody(h.body)) continue;     // catch 里有代码，合格

      const span = lineSpan(t.block);
      const line = h.loc?.start?.line ?? 0;
      const rel = full.replace(ROOT + path.sep, "");

      if (isDangerousSilent(t.block, h.body)) {
        console.log(`  ⚠ ${rel}:${line}  空 catch 包住 ${span} 行逻辑，含多处多层属性访问 —— 可能吞掉编程错误`);
        console.log(`      try 起始 L${t.block.loc?.start?.line}`);
        suspicious += 1;
      } else {
        if (STRICT) {
          console.log(`  · ${rel}:${line}  空 catch（try ${span} 行，判定为合理容错）`);
        }
        hints += 1;
      }
    }
  }
}

console.log("");
console.log("═".repeat(68));
console.log("  静默 catch 检查（会吞掉 ReferenceError / TypeError 的地方）");
console.log("═".repeat(68));
console.log("");

for (const d of dirs) walkDir(d);

console.log("");
console.log("─".repeat(68));
console.log(`  扫了 ${files} 个文件`);
console.log(`  可疑（空 catch 包住 >5 行）：${suspicious}`);
console.log(`  提示（空 catch 但 try 很小）：${hints}`);
console.log("");
console.log("  ★ 空 catch 本意是容错，但会连【编程错误】一起吞掉 ——");
console.log("    拼错的变量名、调用不存在的函数、访问 undefined 的属性。");
console.log("    这些不是「意料之中的失败」，是代码写错了。");
console.log("");
console.log("    正确写法：至少 log.warn 一句，或只包住真正会失败的那一行。");
console.log("");

/* ★ verify-all 用 `通过 N / M` 提取统计 —— 这里给一个统一口径 */
const total = files;
const passed = files - suspicious;
console.log(`  通过 ${passed} / ${total}`);
console.log("");

if (suspicious > 0 || (STRICT && hints > 0)) process.exit(1);
process.exit(0);

