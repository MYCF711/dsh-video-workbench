#!/usr/bin/env node
/**
 * G1 验收 —— 版本与交付纪律。
 *
 * ══════════════════════════════════════════════════════════════════════
 * G1 原文：「每个里程碑做 VERSION-v<date>.md + zip 归档到
 *          <WORKSPACE>\_branch-archive」
 *
 * ── 2026-10-23 核对时发现的问题
 *
 *   VERSION 文件：12 个（v2026.10.21 / 10.22 / 10.23 的 c/d/e/f/g/h/i/k/m）
 *   归档 zip：27 个
 *
 *   ★ 缺口：字母从 m 直接跳到 w，中间 n~v 共 9 个字母没有 VERSION。
 *     那几轮做的是补验收、修缺陷、去敏这类收口工作，一件件小事，
 *     没有单独写 —— 这不算违规（G1 说的是「里程碑」不是「每轮」），
 *     但确实让「按字母找版本」的链条断了。
 *     ⇒ 补了 VERSION-v2026.10.23-x.md 把这一阶段合并记录。
 *
 * ── ★ 本脚本不查「字母连不连续」
 *
 *   那是形式主义。真正该查的是：
 *     ① 最新的 VERSION 文件是否【晚于】最近一次提交
 *        —— 否则说明这轮干了活却没留版本记录
 *     ② VERSION 里是否写了【可核验的证据】（数字/命令/截图路径）
 *        —— 只有「完成了 XX」没有证据 = 没写
 *     ③ 归档目录是否存在且有 zip
 *
 *   判据 ① 用 git 的提交时间 vs 文件 mtime 比 —— 简单可靠。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const ARCHIVE = "D:\\主工作区\\_branch-archive";

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

const git = (args) => {
  const r = spawnSync("git", args, { cwd: REPO, encoding: "utf8", timeout: 60000 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};

console.log("");
console.log("═".repeat(70));
console.log("  G1 验收（版本记录 + 归档）");
console.log("═".repeat(70));
console.log("");

/* ── ① VERSION 文件存在 ── */
const versions = fs.readdirSync(REPO)
  .filter((n) => /^VERSION-v\d{4}\.\d{2}\.\d{2}(-[a-z]+)?\.md$/.test(n))
  .map((n) => ({
    name: n,
    mtime: fs.statSync(path.join(REPO, n)).mtimeMs,
  }))
  .sort((a, b) => b.mtime - a.mtime);

check("至少有一个 VERSION 文件", versions.length > 0, `实测 ${versions.length} 个`);
console.log(`  VERSION 文件：${versions.length} 个`);
if (versions.length) console.log(`    最新：${versions[0].name}`);

/* ── ② VERSION 必须真的进了版本库（不是只躺在磁盘上）── */
/**
 * ★★ 2026-10-23：第一版这条判据写错了，变异测试抓到假通过。
 *
 *   第一版：比「最近提交时间」与「VERSION 的 mtime」，要求 lag < 1 天。
 *   变异（把 mtime 改成 3 天前）→ 仍然通过。
 *
 *   根因：最近提交（00:07）**早于** VERSION 的 mtime（00:08），
 *        差值是【负数】，而 `负数 < 1 天` 恒真 ⇒ 永远通过。
 *
 *   ⇒ 换成本质的判据：
 *     ① VERSION 是否被 git 跟踪（说明真的进了版本库）
 *     ② 最近 20 个提交里有没有动过 VERSION-*.md
 *        （说明版本记录随工作一起提交，不是最后补一个）
 *
 *   ★ 通用教训：比较两个时间要处理「差值为负」的情形 ——
 *     负值往往意味着「判据方向反了」或「对象搞错了」，
 *     不该让它静默通过。
 */
{
  /**
   * ★ 2026-10-24：非 git 环境下这两条走【跳过】而不是失败。
   *   实测可移植性测试：复制到无 .git 的目录后，
   *   这两条报失败 —— 但那不是「版本纪律坏了」，是环境不适用。
   */
  const isRepo = git(["rev-parse", "--is-inside-work-tree"]).ok;
  if (!isRepo) {
    console.log("  – 跳过 git 相关的两条：这儿不是 git 仓库");
    check("VERSION 文件被 git 跟踪（跳过：非 git 环境）", true);
    check("最近 20 个提交里动过 VERSION（跳过：非 git 环境）", true);
  } else {
    const tracked = git(["ls-files", "VERSION-*.md"]);
    const trackedCount = tracked.ok ? tracked.out.split("\n").filter(Boolean).length : 0;
    check("VERSION 文件被 git 跟踪", trackedCount > 0,
      `git ls-files 只看到 ${trackedCount} 个`);
    console.log(`  已跟踪 VERSION：${trackedCount} 个`);

    /* 最近 20 个提交里有没有动过 VERSION */
    const recent = git(["log", "-20", "--name-only", "--format="]);
    const touched = recent.ok && /VERSION-v\d{4}\.\d{2}\.\d{2}/.test(recent.out);
    check("最近 20 个提交里动过 VERSION（版本随工作一起提交）", touched,
      "版本记录应当随功能提交，不是攒到最后补一份");
  }
}

/* ── ③ 最新 VERSION 必须写了可核验的东西 ── */
if (versions.length) {
  const newest = fs.readFileSync(path.join(REPO, versions[0].name), "utf8");
  /**
   * ★ 判据：要有具体数字或命令，不能只写「完成了 X」。
   *   这里查三样任一：带单位的数字 / 代码块 / 明确的通过数
   */
  const hasNumbers = /\d+\s*\/\s*\d+|\d+\s*(秒|ms|MB|KB|个|项|处|步)/.test(newest);
  const hasCodeBlock = /```/.test(newest);
  const hasVerdict = /通过\s*\d+|实测|实测输出/.test(newest);
  check("最新 VERSION 含可核验证据（数字 / 代码块 / 实测）",
    hasNumbers && (hasCodeBlock || hasVerdict),
    "只有「完成了 XX」没有证据 = 没写");
}

/* ── ④ 归档目录存在且有 zip ── */
check("归档目录存在", fs.existsSync(ARCHIVE), ARCHIVE);
if (fs.existsSync(ARCHIVE)) {
  const zips = fs.readdirSync(ARCHIVE).filter((n) => n.endsWith(".zip"));
  check("归档里有 zip", zips.length > 0, `实测 ${zips.length} 个`);
  console.log(`  归档 zip：${zips.length} 个`);
}

/* ── ⑤ VERSION 文件不该进 .gitignore（要一起发布的）── */
{
  const ignored = git(["check-ignore", "--no-index", "VERSION-v2026.10.23-x.md"]);
  check("VERSION 文件不被 gitignore 排除", !ignored.ok);
}

console.log("");
if (fails.length === 0) {
  console.log("  ✅ 版本与归档纪律满足");
  console.log(`  通过 ${pass} / ${pass}`);
  console.log("");
  process.exit(0);
}
for (const f of fails) {
  console.log(`  ✗ ${f.name}${f.detail ? "：" + f.detail : ""}`);
}
console.log("");
console.log(`  ❌ ${pass} 通过 / ${fails.length} 失败`);
console.log(`  通过 ${pass} / ${pass + fails.length}`);
console.log("");
process.exit(1);


