#!/usr/bin/env node
/**
 * D3 去敏 第二遍 —— 清理第一遍漏掉的形态。
 *
 * ★ 第一遍的教训（记下来）：
 *   我只处理了「const tok = fs.readFileSync(COOKIE_FILE, 'utf8').trim()」这一种写法，
 *   漏了另外三种：
 *     ① const tok = fs.existsSync(FILE) ? fs.readFileSync(FILE,'utf8').trim() : "";
 *     ② if (fs.existsSync(FILE)) { tok = fs.readFileSync(FILE,'utf8').trim(); }
 *     ③ try { token = fs.readFileSync(FILE,'utf8').trim(); } catch {}
 *
 *   为什么漏：我以为「读 token」只有一种写法。
 *   实际每个脚本作者写的时候略有不同，而我第一遍只按自己脑海里那一种去匹配。
 *   ⇒ 判据：做批量替换前，先 grep 出这个常量的【全部】使用点，
 *     按「每处怎么用」分类，而不是按「我以为怎么用」。
 *
 *   这次先统计再改：所有残留行都列出来，逐个形态处理。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");

const TARGETS = [
  "dsh-comfy-bridge/verify-m1-http.mjs",
  "dsh-comfy-bridge/verify-yz.mjs",
  "dsh-comfy-bridge/verify-krea2.mjs",
  "dsh-comfy-bridge/verify-qwen-edit.mjs",
  "dsh-comfy-bridge/verify-subtitle.mjs",
  "dsh-comfy-bridge/verify-quality.mjs",
  "dsh-comfy-bridge/verify-frames-chain.mjs",
  "dsh-comfy-workbench-tab/verify-artcraft-e2e.mjs",
  "dsh-comfy-workbench-tab/verify-suggest-name.mjs",
  "dsh-comfy-preset/verify-m4.mjs",
  "dsh-editor/test/e2e-audio.mjs",
  "dsh-editor/test/e2e-full.mjs",
];

console.log("");
console.log("═".repeat(70));
console.log("  D3 去敏 第二遍：清理三态/if/try 形态的残留");
console.log("═".repeat(70));
console.log("");

let changed = 0;

for (const rel of TARGETS) {
  const full = path.join(PKG_ROOT, rel);
  if (!fs.existsSync(full)) continue;
  let src = fs.readFileSync(full, "utf8");
  const before = src;

  /* 找出这个文件里被删掉的常量名（从我们插入的 banner 注释里反推） */
  const nameMatch = src.match(/原来写的是 const (\w+) = ['"][A-Za-z]:[\\/][^'"]*dsh-tok\.txt['"]/);
  if (!nameMatch) continue;
  const VAR = nameMatch[1];

  /* ── 形态①：const X = fs.existsSync(VAR) ? fs.readFileSync(VAR, 'utf8').trim() : ""; ── */
  const re1 = new RegExp(
    String.raw`const\s+(\w+)\s*=\s*fs\.existsSync\(\s*${VAR}\s*\)\s*\?\s*fs\.readFileSync\(\s*${VAR}\s*,\s*['"]utf8['"]\s*\)\s*\.trim\(\)\s*:\s*['"]['"]\s*;`,
  );
  src = src.replace(re1, (m0, target) => `const ${target} = TOKEN ?? "";`);

  /* ── 形态②：if (fs.existsSync(VAR)) { X = fs.readFileSync(VAR,...).trim(); ... } ── */
  /* 分两步：先替换条件行，再替换内部的 readFileSync 调用 */
  src = src.replace(
    new RegExp(String.raw`if\s*\(\s*fs\.existsSync\(\s*${VAR}\s*\)\s*\)\s*\{`, "g"),
    "if (TOKEN) {",
  );
  src = src.replace(
    new RegExp(
      String.raw`fs\.readFileSync\(\s*${VAR}\s*,\s*['"]utf8['"]\s*\)\s*\.trim\(\)`,
      "g",
    ),
    "TOKEN",
  );

  /* ── 形态③：try { X = fs.readFileSync(VAR,...).trim(); } catch ... ── */
  /* 已被上面的 readFileSync 通用替换覆盖 */

  /* ── 残留：任何 fs.readFileSync(VAR ...) 一律换掉 ── */
  src = src.replace(
    new RegExp(String.raw`fs\.readFileSync\(\s*${VAR}\s*,\s*['"]utf8['"]\s*\)`, "g"),
    "TOKEN",
  );
  /* 剩下的 fs.existsSync(VAR) 换成布尔判断 */
  src = src.replace(
    new RegExp(String.raw`fs\.existsSync\(\s*${VAR}\s*\)`, "g"),
    "Boolean(TOKEN)",
  );

  if (src === before) { console.log(`  · ${rel}（无残留）`); continue; }

  /* 检查是否还有 VAR 的裸引用（不能有，否则又是 ReferenceError） */
  const bare = new RegExp(String.raw`(?<![\w.$])${VAR}(?![\w$])`, "g");
  const remaining = [...src.matchAll(bare)].filter((m) => {
    /* banner 注释里提到它是有意的，允许 */
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const line = src.slice(lineStart, src.indexOf("\n", m.index));
    return !/^\s*\*/.test(line);
  });

  fs.writeFileSync(full, src, "utf8");
  console.log(`  ✅ ${rel}${remaining.length ? `  ⚠ 仍有 ${remaining.length} 处裸引用` : ""}`);
  changed++;
}

console.log("");
console.log("─".repeat(70));
console.log(`  改了 ${changed} 个`);
console.log("");
