#!/usr/bin/env node
/**
 * D3 去敏验收 —— 代码里不能出现本机专属的绝对路径。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个
 *
 *   2026-10-23 做 D3（去敏）时发现：12 个验收脚本里硬编码了
 *
 *     const COOKIE_FILE = '<HOME>/dsh-tok.txt';
 *
 *   ⇒ 别人 clone 下来跑验收，全部失败，而且报错只说「读不到 token」，
 *     看不出是「路径没配」。这直接违背「可移植」这个目标。
 *
 * ── ★ 修复过程走了两遍，教训记在这里
 *
 *   第一遍：我只处理了「const tok = fs.readFileSync(FILE,'utf8').trim()」一种写法，
 *          结果 11 个文件仍然崩（ReferenceError: COOKIE_FILE is not defined）。
 *   漏掉的三种形态：
 *     ① const tok = fs.existsSync(FILE) ? fs.readFileSync(FILE,'utf8').trim() : "";
 *     ② if (fs.existsSync(FILE)) { tok = fs.readFileSync(FILE,'utf8').trim(); }
 *     ③ try { token = fs.readFileSync(FILE,'utf8').trim(); } catch {}
 *
 *   ⇒ 判据：做批量替换前，先 grep 出这个常量的【全部】使用点，
 *     按「每处怎么用」分类，而不是按「我以为怎么用」。
 *
 * ── 本脚本检查什么
 *   ① 代码文件（.mjs / .js / .ps1 / .json）里不能有 C:/Users/<某用户>/ 这类绝对路径
 *   ② 不能有 dsh-tok.txt 这种本机文件名
 *   ③ 文档（.md）允许提及（那是历史记录），但要给出统计
 *
 * ★ 为什么不检查 docs/*.md：
 *   踩坑记录里提到「主人机器的 token 在 <HOME>/dsh-tok.txt」
 *   是有价值的历史信息，删掉反而丢失证据。
 *   代码不能依赖它，但文档可以记录它。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

/**
 * 本机专属路径的特征。
 *
 * ★ 2026-10-23 扩了两类（D2 去敏时发现的）：
 *   ① <WORKSPACE>/... —— 本仓库自己的绝对路径。
 *      别人 clone 到别的盘，整个验收体系一条都跑不起来。
 *   ② file:///D:/... —— 上面那种的三斜杠 URL 形式。
 *      ★ 我第一版只处理了 ①，漏了 ②，因为替换规则是按
 *        `const X = "D:/..."` 这一种写法写的。
 */
const PATTERNS = [
  { re: /C:[\\/]Users[\\/](?!<|x|\{|\$)[A-Za-z][A-Za-z0-9._-]*[\\/]/, name: "硬编码用户目录" },
  { re: /dsh-tok\.txt/, name: "本机 token 文件名" },
  { re: /restart-test2?\.ps1/, name: "本机重启脚本" },
  { re: /D:[\\/]主工作区[\\/]DSH视频工作台/, name: "本仓库的绝对路径" },
  { re: /file:\/\/\/[A-Za-z]:[\\/]/, name: "file:/// 形式的绝对路径" },
];

/**
 * 允许的例外（仓库外部的参考源）。
 *
 * ★ <UPSTREAM>/artcraft-demo 是【上游参考源】，不在本仓库里。
 *   引用它的脚本改成「找不到就跳过」是另一件事（adapter 层），
 *   这些路径本身保留是有意为之 —— 它们是「本机把上游放在哪」的约定。
 *   ⇒ 单独列出来，而不是笼统允许所有 D:/ 路径。
 */
const UPSTREAM_RE = /D:[\\/]主工作区[\\/]_upstream/;

/** 要扫的代码扩展名（文档不在此列） */
const CODE_EXT = /\.(mjs|js|cjs|ps1|json|yml|yaml)$/;

/** 允许的例外（有正当理由的本机路径）。 */
/**
 * 允许的例外（有正当理由的提及）。
 *
 * ★ 判据：区分「依赖这条路径才能工作」和「文字里提到这个文件名」。
 *   前者必须修；后者删掉反而丢失信息（这些是解释为什么要有这个检查的注释）。
 */
const ALLOW = [
  /* test-env.mjs 自己的说明文字 */
  /tools[\\/]test-env\.mjs$/,
  /* 这个去敏检查器本身要写明它在查什么 */
  /tools[\\/]verify-no-local-paths\.mjs$/,
  /* check-dead-paths 里判断「dsh-tok.txt 是文件名不是包名」的那行逻辑说明 */
  /tools[\\/]check-dead-paths\.mjs$/,
  /* 临时探针备份目录（不在 git 里，是调试期的快照） */
  /\.probe-backup[\\/]/,
  /* 一次性修复脚本，它的标题就要说明它修什么 */
  /tools[\\/]fix-hardcoded-token(-2)?\.mjs$/,
];

let files = 0;
const hits = [];

function walk(dir, depth = 0) {
  if (depth > 4) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "_branch-archive") continue;
    if (e.name === ".models" || e.name === ".frames" || e.name === ".state") continue;
    if (e.name === "_verify6" || e.name === ".tmp-scripts") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, depth + 1); continue; }
    if (!CODE_EXT.test(e.name)) continue;
    if (ALLOW.some((r) => r.test(full))) continue;

    files += 1;
    let src;
    try { src = fs.readFileSync(full, "utf8"); } catch { continue; }

    const lines = src.split("\n");
    for (const p of PATTERNS) {
      lines.forEach((line, i) => {
        /* 跳过注释行 —— 注释里记录历史是允许的 */
        const t = line.trim();
        if (/^(\*|\/\/|#)/.test(t)) return;
        if (!p.re.test(line)) return;
        hits.push({
          file: full.replace(REPO + path.sep, ""),
          line: i + 1,
          kind: p.name,
          text: t.slice(0, 90),
        });
      });
    }
  }
}

console.log("");
console.log("═".repeat(70));
console.log("  D3 去敏验收（代码里不得有本机专属绝对路径）");
console.log("═".repeat(70));
console.log("");

walk(REPO);

console.log(`  扫了 ${files} 个代码文件`);
console.log("");

if (hits.length === 0) {
  console.log("  ✅ 没有本机专属路径");
  console.log(`  通过 ${files} / ${files}`);
  console.log("");
  console.log("  ★ 判据：代码不能依赖本机路径，文档可以记录本机路径（那是证据）。");
  console.log("");
  process.exit(0);
}

for (const h of hits) {
  console.log(`  ✗ ${h.file}:${h.line}  ${h.kind}`);
  console.log(`      ${h.text}`);
}
console.log("");
console.log(`  ❌ ${hits.length} 处本机路径`);
console.log("");
console.log("  ★ 这批路径会让「别人 clone 下来跑验收」全部失败，");
console.log("    而且报错只说「读不到 token」，看不出是路径没配。");
console.log("  ⇒ 用 tools/test-env.mjs 的 TOKEN / authCookie()，");
console.log("    它从 DSH_TEST_TOKEN > DSH_TEST_TOKEN_FILE > $DSH_HOME/.test-token 依次取。");
console.log(`  通过 ${files - hits.length} / ${files}`);
console.log("");
process.exit(1);



