#!/usr/bin/env node
/**
 * 验收不污染数据 —— 跑验收前后各取一次快照，比对差异
 *
 * 为什么有这个脚本：
 *   2026-10-21 实测事故：verify-assets.mjs 用「input/ 下第一张图」当测试对象，
 *   命中了主人命名的「韩立-定妆照」—— 改名 → 清空名字 → 结束【没有恢复】。
 *   主人的名字在 json 和 PNG 里都被清空。
 *
 *   这不是功能 bug，是【验收污染真实数据】。它比功能 bug 更隐蔽：
 *   测试「通过了」，但用户的数据被改了。
 *
 * 用法：
 *   node verify-no-pollution.mjs                 跑 verify-all，自动比对
 *   node verify-no-pollution.mjs --static        只跑静态段
 *   node verify-no-pollution.mjs --snapshot      只取快照（不跑验收）
 *
 * 退出码：
 *   0  数据无变化
 *   1  数据被改动（列出差异）
 *   2  取不到数据
 *
 * ★ 比对什么：
 *   每个资产的 id + displayName + role + folder + fav + renamed
 *   —— 这六个字段就是「用户资产状态」的全部可观察面。
 *
 * ★ 什么算「正常变化」：
 *   · 新增（output/ 里新生成的产物）
 *   · 减少（如果验收测的是自己复制的副本，不该有减少）
 *   ⇒ 只有【已有资产的字段被改】才算污染。新增/减少单独报告。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.COMFY_WB_BASE ?? "http://127.0.0.1:19499";
/**
 * ★ 2026-10-23 D3 去敏：token 从 tools/test-env.mjs 取，不写死本机路径。
 *   原来写 C:\Users\<本机用户>\dsh-tok.txt ⇒ 别人 clone 下来这个元验收永远跑不了。
 */
import { TOKEN as TEST_TOKEN } from "./tools/test-env.mjs";

const argv = process.argv.slice(2);
const snapshotOnly = argv.includes("--snapshot");
const staticOnly = argv.includes("--static");

function getToken() {
  if (process.env.DSH_TOKEN) return process.env.DSH_TOKEN.trim();
  return TEST_TOKEN ?? "";
}

/** 取资产库快照，返回 Map<id, signature> */
async function snapshot() {
  const tok = getToken();
  const headers = {};
  if (tok) headers.Cookie = `dsh-auth-CK36o8O6fn6VWHrnbEp0bsjzKPKRmilHp-TBfPBH65k=${tok}`;
  let res;
  try {
    res = await fetch(`${BASE}/comfy-assets/library?limit=3000`, {
      headers, signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { error: `请求失败：${e?.message ?? e}` };
  }
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const j = await res.json();
  const items = Array.isArray(j?.items) ? j.items : [];
  if (!items.length) return { error: "返回 0 项" };

  const map = new Map();
  for (const it of items) {
    // 签名 = 用户能感知到的全部状态
    map.set(it.id, JSON.stringify({
      displayName: it.displayName ?? null,
      role: it.role ?? null,
      folder: it.folder ?? null,
      fav: it.fav === true,
      renamed: it.renamed === true,
    }));
  }
  return { map, count: items.length };
}

/**
 * ★ 2026-10-21：同时给 output/ 和 input/ 记文件快照。
 *   跑完 verify-all 后统一清理本次新增的文件 ——
 *   不依赖每个验收脚本自己清（实测那样会漏）。
 */
const FS_ROOTS = {
  output: "D:/Comfy-Desktop/ComfyUI-Shared/output",
  input: "D:/Comfy-Desktop/ComfyUI-Shared/input",
};

function snapshotFiles() {
  const out = {};
  for (const [k, dir] of Object.entries(FS_ROOTS)) {
    try {
      out[k] = new Set(fs.readdirSync(dir, { recursive: true })
        .map((x) => String(x).replace(/\\/g, "/"))
        .filter((x) => {
          try { return fs.statSync(`${dir}/${x}`).isFile(); } catch { return false; }
        }));
    } catch { out[k] = null; }
  }
  return out;
}

/** 删掉快照之后新增的文件，返回删了几个 */
function cleanupNewFiles(snap) {
  const removed = [];
  for (const [k, dir] of Object.entries(FS_ROOTS)) {
    if (!snap[k]) continue;
    let now;
    try {
      now = fs.readdirSync(dir, { recursive: true })
        .map((x) => String(x).replace(/\\/g, "/"))
        .filter((x) => {
          try { return fs.statSync(`${dir}/${x}`).isFile(); } catch { return false; }
        });
    } catch { continue; }
    for (const n of now) {
      if (snap[k].has(n)) continue;      // 跑之前就有，不碰
      try {
        fs.unlinkSync(`${dir}/${n}`);
        removed.push(`${k}/${n}`);
      } catch { /* 占用中，跳过 */ }
    }
  }
  return removed;
}

const t0 = Date.now();
const before = await snapshot();
const filesBefore = snapshotFiles();
if (before.error) {
  console.error(`  ✗ 取快照失败：${before.error}`);
  process.exit(2);
}
console.log(`  验收前：${before.count} 项`);

const SNAP_FILE = path.join(HERE, "_snapshot-before.json");

if (snapshotOnly) {
  fs.writeFileSync(SNAP_FILE, JSON.stringify([...before.map], null, 2), "utf8");
  console.log(`  ✓ 已存快照：${SNAP_FILE}`);
  process.exit(0);
}

/**
 * ★ `--compare-only`：只拿现存快照与当前状态比对，不跑验收。
 *
 *   用途：手工制造一个改动，验证检测逻辑真的能抓到（变异测试）。
 *   实测过：改一个资产的 displayName → 正确报 ❌ 并列出前后值。
 */
if (argv.includes("--compare-only")) {
  if (!fs.existsSync(SNAP_FILE)) {
    console.error(`  ✗ 没有快照文件，先跑一次 --snapshot`);
    process.exit(2);
  }
  const snap = new Map(JSON.parse(fs.readFileSync(SNAP_FILE, "utf8")));
  let n = 0;
  for (const [id, sig] of snap) {
    if (!before.map.has(id)) { console.log(`  ⚠ 消失：${id}`); n++; continue; }
    if (before.map.get(id) !== sig) {
      n++;
      const a = JSON.parse(sig), b = JSON.parse(before.map.get(id));
      console.log(`  ❌ ${id}`);
      for (const k of Object.keys(a)) {
        if (a[k] !== b[k]) console.log(`     ${k}: ${JSON.stringify(a[k])} → ${JSON.stringify(b[k])}`);
      }
    }
  }
  console.log(n ? `  ❌ 抓到 ${n} 个污染` : "  ✅ 无污染");
  process.exit(n ? 1 : 0);
}

// ── 跑 verify-all ────────────────────────────────────────────
console.log(`  跑 verify-all.mjs${staticOnly ? " --static" : ""} …`);
const args = ["verify-all.mjs"];
if (staticOnly) args.push("--static");
const run = spawnSync("node", args, {
  cwd: HERE,
  encoding: "utf8",
  timeout: 1800000,
  env: { ...process.env, PYTHONIOENCODING: "utf-8" },
});
const verifyOk = run.status === 0;

// ── 取验收后快照 ─────────────────────────────────────────────
/**
 * ★ 统一清理：不管哪个脚本漏，出口兜住。
 *   等 2 秒让 ComfyUI 把最后的文件写完（实测 SaveImage 落盘晚于 job.completed）。
 */
await new Promise((r) => setTimeout(r, 2000));
const cleanedFiles = cleanupNewFiles(filesBefore);

const after = await snapshot();
if (after.error) {
  console.error(`  ✗ 验收后取快照失败：${after.error}`);
  process.exit(2);
}

// ── 比对 ────────────────────────────────────────────────────
const changed = [];
const removed = [];
const added = [];

for (const [id, sig] of before.map) {
  if (!after.map.has(id)) { removed.push(id); continue; }
  if (after.map.get(id) !== sig) {
    changed.push({
      id,
      前: JSON.parse(sig),
      后: JSON.parse(after.map.get(id)),
    });
  }
}
for (const id of after.map.keys()) {
  if (!before.map.has(id)) added.push(id);
}

const sec = ((Date.now() - t0) / 1000).toFixed(0);
console.log("");
console.log(`  验收${verifyOk ? "通过" : "失败"}（${sec}s）`);
console.log(`  验收后：${after.count} 项`);
if (cleanedFiles.length) {
  console.log(`  🧹 已清理本次生成的 ${cleanedFiles.length} 个文件（证据副本保留在 docs/evidence）：`);
  cleanedFiles.slice(0, 10).forEach((f) => console.log(`      ${f}`));
  if (cleanedFiles.length > 10) console.log(`      ……还有 ${cleanedFiles.length - 10} 个`);
} else {
  console.log("  🧹 没有新增文件需要清理");
}
console.log("");

let polluted = false;

if (changed.length) {
  polluted = true;
  console.log(`  ❌ 有 ${changed.length} 个已有资产的字段被改了 —— 这是污染：`);
  for (const c of changed.slice(0, 20)) {
    console.log(`      ${c.id}`);
    for (const k of Object.keys(c.前)) {
      if (c.前[k] !== c.后[k]) {
        console.log(`        ${k}: ${JSON.stringify(c.前[k])} → ${JSON.stringify(c.后[k])}`);
      }
    }
  }
  if (changed.length > 20) console.log(`      ……还有 ${changed.length - 20} 个`);
}

if (removed.length) {
  console.log(`  ⚠ 有 ${removed.length} 项消失了（可能是验收删的，也可能是别的原因）：`);
  removed.slice(0, 10).forEach((x) => console.log(`      ${x}`));
}

if (added.length) {
  console.log(`  + 新增 ${added.length} 项（正常，通常是生成产物）`);
}

console.log("");
if (polluted) {
  console.log("  ❌ 验收改动了用户数据 —— 测试必须「记录原始值 → 结束后恢复」");
  process.exit(1);
}

console.log("  ✅ 验收没有改动任何已有资产的字段");
console.log("     （新增/减少单独报告，不算污染）");
// 验收本身失败时，仍然以验收结果为准退出非 0
process.exit(verifyOk ? 0 : 1);

