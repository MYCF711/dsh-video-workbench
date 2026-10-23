/**
 * 登记遗漏的验收脚本 —— 先跑一遍确认能过，再往 verify-all 里加。
 *
 * ★ 背景（2026-10-23）
 *   统计发现磁盘上有 89 个 verify-*.mjs，verify-all 只登记了 60 个。
 *   未登记的 27 个（除两个元验收）实际都能跑，只是没人挂上去。
 *
 *   AGENTS §6.44a 记过这条：
 *     「未登记进总验收的脚本 = 心理安慰。
 *       实测 37 个脚本 verify-all 只跑了 30 个，
 *       漏的里面 verify-assets.mjs（45 项）一直在失败，没人知道。」
 *
 *   ⇒ 本脚本做两件事：
 *     ① 把每个未登记的脚本跑一遍，记录退出码与实际耗时
 *     ② 输出可直接粘贴进 verify-all 的登记行（只列真能过的）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** 不该登记的（元验收 / 工具 / 被别处调用的子脚本）。 */
const EXCLUDE = new Set([
  "verify-all.mjs",          // 总验收自己
  "verify-no-pollution.mjs", // 元验收：它跑 verify-all，登记会无限递归
  "verify-workflow.mjs",     // 需要传工作流路径参数
]);

/** 已登记的（从 verify-all 里抓）。 */
const verifyAll = fs.readFileSync(path.join(ROOT, "verify-all.mjs"), "utf8");
const registered = new Set();
for (const m of verifyAll.matchAll(/'([^']*verify-[a-z0-9-]+\.mjs)'/g)) {
  registered.add(path.basename(m[1]));
}

/** 收集磁盘上所有 verify-*.mjs，带上它所在的包目录。 */
const found = [];
function walk(dir, pkg, sub) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, pkg, sub ? `${sub}/${e.name}` : e.name); continue; }
    if (!/^verify-.*\.mjs$/.test(e.name)) continue;
    found.push({ name: e.name, pkg, sub, full });
  }
}
for (const pkg of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!pkg.isDirectory() || pkg.name === "tools" || pkg.name === "node_modules") continue;
  walk(path.join(ROOT, pkg.name), pkg.name, "");
}

const missing = found.filter(
  (f) => !registered.has(f.name) && !EXCLUDE.has(f.name),
);

console.log("");
console.log("═".repeat(70));
console.log("  未登记验收脚本盘点");
console.log("═".repeat(70));
console.log("");
console.log(`  磁盘上 verify-*.mjs：${found.length}`);
console.log(`  verify-all 已登记：${registered.size}`);
console.log(`  未登记（排除元验收）：${missing.length}`);
console.log("");

const results = [];
for (const m of missing) {
  const rel = m.sub ? `${m.sub}/${m.name}` : m.name;
  const t0 = Date.now();
  const r = spawnSync("node", [rel], {
    cwd: path.join(ROOT, m.pkg),
    encoding: "utf8",
    timeout: 300000,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  const ms = Date.now() - t0;
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const passMatch = out.match(/通过\s+(\d+)\s*\/\s*(\d+)/);
  const skipped = /跳过/.test(out);
  results.push({
    ...m,
    rel,
    ok: r.status === 0,
    ms,
    counts: passMatch ? `${passMatch[1]}/${passMatch[2]}` : "?",
    skipped,
  });
  const mark = r.status === 0 ? "✅" : "❌";
  console.log(`  ${mark} ${m.pkg}/${rel}  ${(ms / 1000).toFixed(1)}s  ${passMatch ? passMatch[0] : ""}${skipped ? " [跳过]" : ""}`);
  if (r.status !== 0) {
    const first = out.split("\n").filter((l) => l.trim()).slice(-3).join(" | ");
    console.log(`       ${first.slice(0, 160)}`);
  }
}

/* 输出可粘贴的登记行 */
const okOnes = results.filter((r) => r.ok);
console.log("");
console.log("─".repeat(70));
console.log(`  能过的：${okOnes.length} / ${results.length}`);
console.log("");
console.log("  可粘贴的登记行：");
console.log("");
for (const r of okOnes) {
  const label = r.name.replace(/^verify-/, "").replace(/\.mjs$/, "");
  const sub = r.sub ? `${r.sub}/${r.name}` : r.name;
  console.log(`steps.push(run('${r.pkg} · ${label}', '${r.pkg}', '${sub}'));`);
}

/* 存成文件，供下一步批量插入 */
fs.writeFileSync(
  path.join(HERE, "_missing-verify.json"),
  JSON.stringify(results, null, 2),
  "utf8",
);
console.log("");
console.log("  明细已存：packages/tools/_missing-verify.json");
console.log("");
process.exit(results.every((r) => r.ok) ? 0 : 1);
