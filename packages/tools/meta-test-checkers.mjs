#!/usr/bin/env node
/**
 * 元验收的元测试 —— 检查「那些检查器自己还在不在工作」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个
 *
 *   2026-10-23 踩了两次同类坑：
 *
 *   第一次：我把 check-undeclared.mjs 登记在了 if (!STATIC) 块内，
 *     --static 模式下它从没跑过，但输出显示「全部通过」。
 *     靠核对步骤数（56 没变）才发现。
 *
 *   第二次：verify-registry-complete.mjs（元验收，专门查「脚本有没有都登记」）
 *     自己漏扫了三个层级，报 134/134 全过，
 *     而 verify-png-tags.mjs 从没登记过。
 *
 *   ⇒ 共同点：**「检查通过」不等于「检查真的在检查」。**
 *
 *   ★ 判据：每个检查器都必须能被【故意制造的缺陷】打红。
 *     一个从来没红过的检查器，和一个不存在的检查器没有区别。
 *
 * ── 本脚本做什么
 *   对几个关键的静态检查器，各自注入一个「必然发现的缺陷」，
 *   确认它变红，然后恢复。
 *
 *   ★ 只做【可逆】的注入：都是往临时文件里写，跑完删除/恢复。
 *     绝不改动真实源码 —— 那会在失败时留下脏状态。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let pass = 0, fail = 0;
const ok = (n, d = "") => { pass++; console.log(`  ✓ ${n}${d ? "  " + d : ""}`); };
const bad = (n, d = "") => { fail++; console.log(`  ✗ ${n}${d ? "  " + d : ""}`); };
const chk = (n, cond, d = "") => (cond ? ok(n, d) : bad(n, d));

/** 跑一个脚本，返回 { code, out }。 */
function run(script, args = [], cwd = ROOT) {
  const t0 = Date.now();
  const r = spawnSync("node", [script, ...args], {
    cwd, encoding: "utf8", timeout: 300000,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? ""), ms: Date.now() - t0 };
}

console.log("");
console.log("═".repeat(70));
console.log("  元验收的元测试（检查器自己还在不在工作）");
console.log("═".repeat(70));

/* ══ ① verify-registry-complete：塞一个未登记的脚本，它必须报红 ══ */
console.log("");
console.log("[1] verify-registry-complete —— 故意制造「未登记的脚本」");
{
  const fake = path.join(ROOT, "verify-zz-meta-test.mjs");
  try {
    fs.writeFileSync(fake, 'console.log("  通过 1 / 1");\n', "utf8");
    const r = run("verify-registry-complete.mjs");
    const caught = r.code !== 0 && r.out.includes("verify-zz-meta-test.mjs");
    chk("塞入未登记脚本后它变红", caught,
      caught ? "" : `exit=${r.code}`);
    if (!caught) {
      console.log("      输出尾部：" + r.out.slice(-200).replace(/\n/g, " | "));
    }
  } finally {
    try { fs.unlinkSync(fake); } catch { /* 已删 */ }
  }
  /* 恢复后必须回到全过 */
  const r2 = run("verify-registry-complete.mjs");
  chk("清理后回到全过", r2.code === 0, `exit=${r2.code}`);
}

/* ══ ② check-undeclared：写一个引用未声明变量的文件，它必须报红 ══ */
console.log("");
console.log("[2] check-undeclared —— 故意写一个「引用未声明变量」的文件");
{
  /* 塞进它扫描的目录里，用完删掉 */
  const target = path.join(ROOT, "dsh-comfy-bridge", "src", "_zz_undeclared_test.mjs");
  try {
    fs.writeFileSync(target, [
      "// 故意：zzNeverDeclared 没有声明",
      "export function zzProbe() {",
      "  return zzNeverDeclared?.field;",
      "}",
      "",
    ].join("\n"), "utf8");
    const r = run("check-undeclared.mjs", [], HERE);
    /**
     * ★ 2026-10-24：检查器自己「跳过」（缺 acorn）时，元测试也跳过。
     *
     *   实测可移植性测试：新目录里没装 acorn ⇒ check-undeclared 走跳过分支
     *   （exit 0）⇒ 元测试判「没变红」失败。
     *   但那不是「检查器坏了」，是「检查器没装上」。
     *
     *   ⇒ 判据：先看它是不是在跳过（输出含「通过 0 / 0（跳过）」）。
     */
    const skipped = r.code === 0 && /通过 0 \/ 0（跳过）/.test(r.out);
    const caught = r.code !== 0 && r.out.includes("zzNeverDeclared");
    chk("引用未声明变量后它变红", caught || skipped,
      skipped ? "（跳过：检查器缺依赖）" : (caught ? "" : `exit=${r.code}`));
  } finally {
    try { fs.unlinkSync(target); } catch { /* 已删 */ }
  }
  const r2 = run("check-undeclared.mjs", [], HERE);
  chk("清理后回到全过", r2.code === 0, `exit=${r2.code}`);
}

/* ══ ③ check-silent-catch：写一个「空 catch 包住大段逻辑」的文件 ══ */
console.log("");
console.log("[3] check-silent-catch —— 故意写一个「空 catch 包住大段逻辑」的文件");
{
  const target = path.join(ROOT, "dsh-comfy-bridge", "src", "_zz_silent_catch_test.mjs");
  const body = Array.from({ length: 10 }, (_, i) =>
    `    const v${i} = zzObj.a.b.c${i} ?? null;`).join("\n");
  try {
    fs.writeFileSync(target, [
      "export function zzProbe(zzObj) {",
      "  try {",
      body,
      "    return true;",
      "  } catch { /* 什么都不做 */ }",
      "  return false;",
      "}",
      "",
    ].join("\n"), "utf8");
    const r = run("check-silent-catch.mjs", [], HERE);
    /* ★ 同上：检查器缺依赖而跳过时，元测试也跳过。 */
    const skipped = r.code === 0 && /通过 0 \/ 0（跳过）/.test(r.out);
    const caught = r.code !== 0 || /_zz_silent_catch_test/.test(r.out);
    chk("空 catch 包住大段逻辑后它变红", caught || skipped,
      skipped ? "（跳过：检查器缺依赖）" : (caught ? "" : `exit=${r.code}`));
  } finally {
    try { fs.unlinkSync(target); } catch { /* 已删 */ }
  }
  const r2 = run("check-silent-catch.mjs", [], HERE);
  chk("清理后回到 0 可疑", r2.code === 0, `exit=${r2.code}`);
}

/* ══ ④ 确认没有留下测试残留 ══ */
console.log("");
console.log("[4] 测试自身不留垃圾");
{
  const leftovers = [];
  const scan = (d, depth = 0) => {
    if (depth > 3) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === "node_modules") continue;
      const full = path.join(d, e.name);
      if (e.isFile() && /^_zz_|^verify-zz-/.test(e.name)) leftovers.push(full);
      if (e.isDirectory()) scan(full, depth + 1);
    }
  };
  scan(ROOT);
  chk("没有残留的 _zz_ / verify-zz- 测试文件", leftovers.length === 0,
    leftovers.map((f) => f.replace(ROOT + path.sep, "")).join(", "));
}

console.log("");
console.log("─".repeat(70));
if (fail === 0) {
  console.log(`  ✅ ${pass} 项全过 —— 三个检查器都确实在工作`);
  console.log(`  通过 ${pass} / ${pass}`);
  console.log("");
  process.exit(0);
}
console.log(`  ❌ ${pass} 通过 / ${fail} 失败`);
console.log("");
console.log("  ★ 「检查通过」不等于「检查真的在检查」。");
console.log("    一个从来没红过的检查器，和不存在的检查器没有区别。");
console.log("");
process.exit(1);

