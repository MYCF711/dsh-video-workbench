#!/usr/bin/env node
/**
 * 把验收脚本里硬编码的本机路径改成可移植的写法（D3 去敏）。
 *
 * ★ 变更前（8 个脚本都一样）：
 *     const COOKIE_FILE = 'C:/Users/Administrator/dsh-tok.txt';
 *     const tok = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
 *
 * ★ 变更后：
 *     import { TOKEN, skipWithoutToken } from "../../tools/test-env.mjs";
 *     if (!TOKEN) skipWithoutToken("verify-xxx.mjs");
 *
 * 判据（都是脚本顶部几行）：
 *   1. 出现 C:/Users/<某用户>/dsh-tok.txt 这类本机路径
 *   2. 后面有 readFileSync(该常量)
 *
 * 本脚本只改「读 token」这一处，不动其它逻辑。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(PKG_ROOT, "..");

const TARGETS = [
  "dsh-comfy-bridge/verify-m1-http.mjs",
  "dsh-comfy-bridge/verify-yz.mjs",
  "dsh-comfy-bridge/verify-krea2.mjs",
  "dsh-comfy-bridge/verify-qwen-edit.mjs",
  "dsh-comfy-bridge/verify-subtitle.mjs",
  "dsh-comfy-bridge/verify-quality.mjs",
  "dsh-comfy-bridge/verify-frames-chain.mjs",
  "dsh-comfy-workbench-tab/verify-artcraft-e2e.mjs",
  "dsh-comfy-workbench-tab/verify-slot-real.mjs",
  "dsh-comfy-workbench-tab/verify-suggest-name.mjs",
  "dsh-comfy-preset/verify-m4.mjs",
  "dsh-editor/test/e2e-audio.mjs",
  "dsh-editor/test/e2e-full.mjs",
];

console.log("");
console.log("═".repeat(70));
console.log("  D3 去敏：把硬编码的 dsh-tok.txt 改成可移植读取");
console.log("═".repeat(70));
console.log("");

let changed = 0;
let skipped = 0;

for (const rel of TARGETS) {
  const full = path.join(PKG_ROOT, rel);
  if (!fs.existsSync(full)) { console.log(`  · ${rel}（不存在）`); skipped++; continue; }

  let src = fs.readFileSync(full, "utf8");
  const before = src;

  /* ① 找到那个常量定义行 */
  const m = src.match(/const\s+(\w+)\s*=\s*['"][A-Za-z]:[\\/][^'"]*dsh-tok\.txt['"]\s*;?/);
  if (!m) { console.log(`  · ${rel}（没有硬编码 token 路径）`); skipped++; continue; }

  const varName = m[1];

  /* ② 找到读它的那一行，看有没有 trim */
  const readRe = new RegExp(
    String.raw`(?:const|let)\s+(\w+)\s*=\s*fs\.readFileSync\(\s*${varName}\s*,\s*["']utf8["']\s*\)\s*\.trim\(\)\s*;?`,
  );
  const rm = src.match(readRe);
  const tokVar = rm ? rm[1] : null;

  /* ③ 计算到 tools/test-env.mjs 的相对路径 */
  const fromDir = path.dirname(full);
  let relToTools = path.relative(fromDir, path.join(HERE, "test-env.mjs")).replace(/\\/g, "/");
  if (!relToTools.startsWith(".")) relToTools = "./" + relToTools;

  /* ④ 替换常量定义 → import + 跳过守卫 */
  const banner = [
    `/**
 * ★ 2026-10-23 D3 去敏：token 从环境变量/约定位置读，不写死本机路径。
 *
 *   原来写的是 const ${varName} = 'C:/Users/<本机用户>/dsh-tok.txt';
 *   ⇒ 别人 clone 下来跑，全部失败且看不出是「路径没配」。
 *
 *   现在：DSH_TEST_TOKEN > DSH_TEST_TOKEN_FILE > $DSH_HOME/.test-token > 家目录约定
 *   拿不到就【跳过】而不是失败 —— 跳过=今天不适用，失败=功能坏了。
 */
import { TOKEN, skipWithoutToken } from "${relToTools}";
if (!TOKEN) skipWithoutToken("${path.basename(full)}");`,
  ].join("\n");

  src = src.replace(m[0], banner);

  /* ⑤ 把读文件那一行换成直接用 TOKEN */
  if (rm) {
    src = src.replace(rm[0], `const ${tokVar} = TOKEN;`);
  }

  if (src === before) { console.log(`  · ${rel}（替换未生效）`); skipped++; continue; }

  fs.writeFileSync(full, src, "utf8");
  console.log(`  ✅ ${rel}  (${varName} → TOKEN${tokVar && tokVar !== varName ? `, ${tokVar} 保留` : ""})`);
  changed++;
}

console.log("");
console.log("─".repeat(70));
console.log(`  改了 ${changed} 个，跳过 ${skipped} 个`);
console.log("");
