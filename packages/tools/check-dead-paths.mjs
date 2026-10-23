#!/usr/bin/env node
/**
 * 检查「源码里引用的文件路径是否真实存在」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个
 *
 *   2026-10-23 移出废弃包 dsh-artcraft-tab 后，立刻暴露 2 个隐藏依赖：
 *     · verify-regression.mjs 读 dsh-artcraft-tab/build-payload.mjs
 *     · verify-dsh-native-ui.mjs 的 ART 指向已删除的包
 *   这些路径在包还在时「看起来没问题」，包一移走就全红。
 *
 *   ⇒ 死引用是【延迟引爆】的缺陷：平时不报错，等到被引用的东西动一下才炸。
 *     必须持续扫描，而不是等出事才找。
 *
 * ── 判据
 *   扫描范围：packages/ 下所有 .mjs/.js 的【生产代码 + 验收脚本】
 *
 *   识别这几种形态：
 *     ① path.join(HERE, "..", "xxx.mjs")   —— 相对本文件
 *     ② "D:/..." / "C:/..." 绝对路径
 *     ③ import ... from "./xxx.mjs"        —— 相对导入
 *
 *   ★ 只报告「路径里含 packages 下的包名，但那个文件/目录不存在」的情况 ——
 *     这是真正会炸的死引用。
 *     不检查运行时才产生的路径（outputs/、临时文件、用户素材）。
 *
 *   用法：
 *     node tools/check-dead-paths.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");

/* 只扫这些包（artcraft 已移出） */
const SCAN_PKGS = [
  "dsh-comfy-workbench-tab",
  "dsh-comfy-bridge",
  "dsh-editor",
  "dsh-video-knowledge",
  "dsh-comfy-preset",
];

/** packages/ 下现存的包名集合（用于判断「引用的是不是已删除的包」）。 */
const EXISTING = new Set(
  fs.readdirSync(PKG_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "node_modules")
    .map((e) => e.name),
);

/**
 * 剥注释（保留行数，便于报行号）。
 *
 * ★ 2026-10-23：第一版没剥注释，把注释里的历史说明全报成死路径 ——
 *   例如 verify-upload-protocol 的注释写着「第一版写成 path.join(HERE, "dsh-artcraft-tab", ...)」，
 *   那是记录踩坑的历史，不是活代码。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^([ \t]*)\/\/.*$/gm, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

/**
 * 把模板字符串的内容替换成等长空白（保留行数）。
 *
 * ★ 2026-10-23：dsh-editor/build.mjs 往 lib/index.js 里 writeFileSync
 *   一个模板字符串，内容是 `export ... from "../src/index-host.mjs"`。
 *   那个 ../src 是相对 lib/ 的，相对 build.mjs 解析就成了错误的路径。
 *   ⇒ 模板字符串里的路径不能按本文件的相对位置判断，必须排除。
 */
function stripTemplates(src) {
  /**
   * ★ 用逐字符扫描而不是正则 ——
   *   正则版 `/`(?:\\[\s\S]|[^`\\])*`/` 在长文件上会爆栈
   *   （实测 RangeError: Maximum call stack size exceeded）。
   */
  let out = "";
  let i = 0;
  let inTpl = false;
  while (i < src.length) {
    const c = src[i];
    if (!inTpl) {
      if (c === "`") { inTpl = true; out += " "; i++; continue; }
      out += c; i++; continue;
    }
    if (c === "\\") { out += "  "; i += 2; continue; }
    if (c === "`") { inTpl = false; out += " "; i++; continue; }
    out += (c === "\n" ? "\n" : " ");
    i++;
  }
  return out;
}

/** 包名判定：必须是真的包名形态（dsh- + 小写字母/连字符，且不是文件名）。 */
function isPkgName(s) {
  if (!/^dsh-[a-z][a-z0-9-]*$/.test(s)) return false;
  /* dsh-tok.txt 这类是文件名，不是包 */
  if (/\./.test(s)) return false;
  return true;
}

let files = 0;
const problems = [];

/** 相对本文件解析一段 path.join 链里的字符串常量。 */
function resolveJoinChain(str) {
  const parts = [];
  for (const m of str.matchAll(/["']([^"']+)["']/g)) parts.push(m[1]);
  return parts;
}

function walk(dir, pkg) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name === "node_modules" || e.name === ".bak") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, pkg); continue; }
    if (!/\.m?js$/.test(e.name)) continue;

    files += 1;
    const srcRaw = fs.readFileSync(full, "utf8");
    /**
     * ★ 扫【剥注释后】的代码。
     *   另外：模板字符串里的路径不能按本文件的相对位置解析
     *   （build.mjs 往 lib/index.js 写内容，那里面 ../src 是相对 lib 的）。
     *   ⇒ 只检查普通字符串里的绝对路径与 path.join 链。
     */
    const src = stripTemplates(stripComments(srcRaw));
    const rel = full.replace(PKG_ROOT + path.sep, "");

    /* ① 硬编码绝对路径（D:/ 或 C:/）—— 只报指向 packages 的 */
    for (const m of src.matchAll(/["'`]((?:[A-Za-z]:[\\/])[^"'`\n]{4,200})["'`]/g)) {
      const p = m[1];
      /* 本机敏感路径单独由另一个检查负责；这里只看是否指向 packages 里已不存在的包 */
      const seg = p.split(/[\\/]/).find((s) => s.startsWith("dsh-"));
      if (!seg) continue;
      if (!isPkgName(seg)) continue;
      if (!EXISTING.has(seg) && !/^dsh-(providers|client|host|base|web|agent)/.test(seg)) {
        const line = src.slice(0, m.index).split("\n").length;
        problems.push({ rel, line, kind: "绝对路径指向不存在的包", detail: p });
      }
    }

    /* ② path.join(...) 链里提到已删除的包名 */
    for (const m of src.matchAll(/path\.(?:join|resolve)\(([^)]{0,300})\)/g)) {
      const parts = resolveJoinChain(m[1]);
      for (const seg of parts) {
        if (!isPkgName(seg)) continue;
        if (EXISTING.has(seg)) continue;
        if (/^dsh-(providers|client|host|base|web|agent)/.test(seg)) continue;
        const line = src.slice(0, m.index).split("\n").length;
        problems.push({
          rel, line, kind: "path.join 拼了不存在的包",
          detail: `${seg}（path.join 的实参里）`,
        });
      }
    }

    /* ③ 相对导入指向不存在的文件 */
    /* ★ 只查真正的 import/export 语句（行首或分号后），不查模板字符串里的内容 */
    for (const m of src.matchAll(/(?:^|[;\n])\s*(?:import|export)\b[^;]{0,400}?from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
      const spec = m[1];
      const target = path.resolve(path.dirname(full), spec);
      const cands = [target, `${target}.mjs`, `${target}.js`, path.join(target, "index.mjs"), path.join(target, "index.js")];
      if (cands.some((c) => fs.existsSync(c))) continue;
      const line = src.slice(0, m.index).split("\n").length;
      problems.push({ rel, line, kind: "相对导入的文件不存在", detail: spec });
    }

    /**
     * ④ 裸包名导入指向本仓库里已不存在的包
     *
     * ★ 2026-10-23 补：前三条只查相对/绝对路径，漏了 `import x from "dsh-xxx"`。
     *   变异测试发现：塞 `import x from "dsh-nonexistent-pkg"` 时它不报。
     *
     *   判据：说明符以 dsh- 开头（本仓库的包命名），
     *         且那个包不在 packages/ 下、也不是 DSH 自带的 @deepseek-ai 系列。
     */
    for (const m of src.matchAll(/(?:^|[;\n])\s*(?:import|export)\b[^;]{0,400}?from\s+["']([^"'./][^"']*)["']/g)) {
      const spec = m[1];
      const head = spec.split("/")[0];
      if (!isPkgName(head)) continue;
      if (EXISTING.has(head)) continue;
      /* DSH 自带的包不算 */
      if (/^dsh-(providers|client|host|base|web|agent)/.test(head)) continue;
      /* node: 内置不算（已被 [^"'./] 排除，这里保险） */
      if (spec.startsWith("node:")) continue;
      const line = src.slice(0, m.index).split("\n").length;
      problems.push({ rel, line, kind: "导入了不存在的本仓库包", detail: spec });
    }
  }
}

console.log("");
console.log("═".repeat(70));
console.log("  死路径检查（引用了不存在的文件 / 已删除的包）");
console.log("═".repeat(70));
console.log("");

for (const pkg of SCAN_PKGS) {
  const d = path.join(PKG_ROOT, pkg);
  if (!fs.existsSync(d)) continue;
  walk(d, pkg);
}

console.log("");
console.log("─".repeat(70));
console.log(`  扫了 ${files} 个文件`);
console.log("");

if (problems.length === 0) {
  console.log("  ✅ 没有死路径引用");
  console.log(`  通过 ${files} / ${files}`);
  console.log("");
  process.exit(0);
}

/* 按文件分组输出，便于一次改完 */
const byFile = new Map();
for (const p of problems) {
  if (!byFile.has(p.rel)) byFile.set(p.rel, []);
  byFile.get(p.rel).push(p);
}
for (const [rel, list] of byFile) {
  console.log(`  ✗ ${rel}`);
  for (const p of list) {
    console.log(`      L${p.line}  ${p.kind}：${p.detail.slice(0, 120)}`);
  }
}

console.log("");
console.log(`  ❌ ${problems.length} 处死路径，涉及 ${byFile.size} 个文件`);
console.log("");
console.log("  ★ 死引用是【延迟引爆】的缺陷：平时不报错，");
console.log("    等到被引用的东西动一下才炸（上一轮移出 artcraft 包就是这样）。");
console.log(`  通过 ${files - byFile.size} / ${files}`);
console.log("");
process.exit(1);


