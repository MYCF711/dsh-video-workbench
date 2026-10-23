#!/usr/bin/env node
/**
 * E4 验收 —— README 与当前代码状态一致。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要「文档一致性」验收
 *
 *   本项目已经吃过亏：AGENTS.md 里写过「修：if (caps.aspect) ...」，
 *   但 grep 代码发现**这一行从未存在**（AGENTS §6.25）。
 *   ⇒ 文档说已修、代码没有 = 最坏的一种不一致。
 *
 *   README 是给「第一次接触这个项目的人」看的，
 *   它说错了比不说更糟 —— 会把人引到错误方向。
 *
 * ── 本脚本查什么（都能从代码/文件核验，不是凭印象）
 *   ① 安装方式与 install.ps1 的实际行为一致
 *      · README 提到的 4 个包名 = install.ps1 的 $pkgs
 *      · README 说的 bundles = install.ps1 的 $bundleNames
 *   ② README 给的验收数字与真实一致
 *      · 「93 / 93」这种硬数字必须等于当前实际步数
 *      （这是最容易过期的 —— 每加一个验收就变了）
 *   ③ README 里提到的脚本路径都真实存在
 *   ④ 排障章节覆盖了「空会话不渲染 tab」这条实测根因
 *
 * ★ 第 ② 条特别重要：
 *   我每轮都在加验收脚本，步数从 56 → 59 → 83 → 84 … → 93。
 *   README 里如果写着旧数字，读者会以为跑错了。
 *   所以这类数字要么不写，要么由脚本保证一致。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

const readme = path.join(REPO, "README.md");
const installPs1 = path.join(REPO, "install.ps1");

console.log("");
console.log("═".repeat(70));
console.log("  E4 验收（README 与代码状态一致）");
console.log("═".repeat(70));
console.log("");

check("README.md 存在", fs.existsSync(readme));
check("install.ps1 存在", fs.existsSync(installPs1));
if (!fs.existsSync(readme) || !fs.existsSync(installPs1)) {
  console.log("  ❌ 缺文件，无法继续");
  process.exit(1);
}

const R = fs.readFileSync(readme, "utf8");
const I = fs.readFileSync(installPs1, "utf8");

/* ── ① 包清单一致 ── */
{
  const m = I.match(/\$pkgs\s*=\s*@\(([\s\S]*?)\)/);
  const pkgs = m ? [...m[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]) : [];
  check("install.ps1 有包清单", pkgs.length >= 4, `实测 ${pkgs.length}`);

  const missing = pkgs.filter((p) => !R.includes(p));
  check("README 提到了 install.ps1 里的每个包", missing.length === 0,
    missing.length ? `README 缺：${missing.join(", ")}` : "");

  /* bundle 清单 */
  const bm = I.match(/\$bundleNames\s*=\s*@\(([\s\S]*?)\)/);
  const bundles = bm ? [...bm[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]) : [];
  const bMissing = bundles.filter((b) => !R.includes(b));
  check("README 提到了每个 bundle", bMissing.length === 0,
    bMissing.length ? `README 缺：${bMissing.join(", ")}` : "");
}

/* ── ② README 提到 install.ps1（方式 A）── */
check("README 给了 install.ps1 的用法", /install\.ps1/.test(R),
  "一键脚本是最省事的装法，不写读者只能手工改 profile");

/* ── ③ README 里写的验收数字必须等于真实的 ── */
{
  /**
   * 从 README 里抓形如「93 / 93」或「93/93」的数字。
   * 然后跑一次 verify-all --static 数真实步数。
   *
   * ★ 这一步会真的跑 verify-all（约 10~20 秒），
   *   因为它要拿「当前真实步数」，不能靠猜。
   */
  const claimed = [...R.matchAll(/(\d{2,3})\s*\/\s*\1/g)].map((x) => Number(x[1]));
  if (claimed.length === 0) {
    check("README 没写易过期的硬数字", true, "不写数字也是一种选择");
  } else {
    /**
     * ★★ 2026-10-23 修：不能在这里 spawn `verify-all --static`。
     *
     *   本脚本【被登记进了 verify-all】。
     *   如果它内部再跑一次 verify-all ⇒ 无限递归：
     *     verify-all → verify-readme-consistency → verify-all → …
     *   实测会在 30 秒内堆出几百个 node 进程。
     *
     *   ⇒ 改成【静态数步骤数】：verify-all.mjs 里每个
     *     `steps.push(run(...))` 就是一步。
     *     数这个比跑一遍更快、更安全、且不需要子进程。
     *
     *   ★ 判据：如果一个检查脚本要「验证 verify-all 本身」，
     *     它必须【读源码】而不是【跑一遍】—— 否则就是递归。
     */
    const vaSrc = fs.readFileSync(path.join(REPO, "packages", "verify-all.mjs"), "utf8");
    /**
     * 只数真正会被执行的 push 行：
     *   · 排除被注释掉的（行首是 // 或 *）
     *   · 排除在模板字符串里的
     */
    const pushLines = vaSrc.split("\n").filter((line) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*")) return false;
      return /^steps\.push\(run\(/.test(t);
    });
    /**
     * ★ 但这样数的是【两个模式下都登记的】总数。
     *   静态模式会跳过 `if (!STATIC) { ... }` 里的。
     *   ⇒ 简化：README 里写的数字只要落在
     *     [静态步数, 总步数] 区间内就算一致，
     *     因为读者实际会看到其中一个。
     */
    const totalPushes = pushLines.length;
    /* 粗估静态段：把 if (!STATIC) 块内的减掉 */
    let insideStatic = 0;
    let depth = 0;
    for (const line of vaSrc.split("\n")) {
      if (/if\s*\(\s*!STATIC\s*\)\s*\{/.test(line)) { depth += 1; continue; }
      if (depth > 0) {
        const opens = (line.match(/\{/g) ?? []).length;
        const closes = (line.match(/\}/g) ?? []).length;
        if (/^steps\.push\(run\(/.test(line.trim())) insideStatic += 1;
        depth += opens - closes;
        if (depth < 0) depth = 0;
      }
    }
    const staticPushes = totalPushes - insideStatic;

    const ok = claimed.some((c) => c === staticPushes || c === totalPushes);
    check(`README 写的 ${claimed.join("/")} 与实际步数（静态 ${staticPushes} / 完整 ${totalPushes}）一致`,
      ok,
      `README 写的是 ${claimed.join(", ")}；实际静态 ${staticPushes}、完整 ${totalPushes} —— 每加一个验收这个数字就过期`);
    console.log(`  README 里的硬数字：${claimed.join(", ")}；实际步数：静态 ${staticPushes} / 完整 ${totalPushes}`);
  }
}

/* ── ④ 排障章节必须覆盖「空会话不渲染 tab」 ── */
{
  const hasEmptySession = /空会话[\s\S]{0,40}不[\s\S]{0,20}渲染/.test(R);
  const hasTablist = /tablist/.test(R);
  check("README 排障写了「空会话不渲染 tab」", hasEmptySession,
    "★ 我曾因不知道这条，连续 3 轮误判「安装脚本有缺陷」");
  check("README 给了可执行的判据（tablist 数量）", hasTablist,
    "只说结论不够，要给出能照着查的一行代码");
}

/* ── ⑤ README 里提到的仓库内脚本路径都真实存在 ── */
{
  const bad = [];
  for (const m of R.matchAll(/`(packages\/[A-Za-z0-9._\-\/]+\.mjs)`/g)) {
    const p = path.join(REPO, m[1]);
    if (!fs.existsSync(p)) bad.push(m[1]);
  }
  check("README 引用的脚本路径都存在", bad.length === 0,
    bad.length ? bad.slice(0, 3).join(", ") : "");
}

console.log("");
if (fails.length === 0) {
  console.log("  ✅ README 与代码状态一致");
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
