/**
 * verify-registry-complete.mjs · 验收脚本登记完整性
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个「元验收」
 *
 * AGENTS §6.44a 记录过：
 *   「未登记进总验收的脚本 = 心理安慰。实测 37 个脚本，verify-all 只跑了 30 个。
 *     漏的里面 verify-assets.mjs（45 项）一直在【失败】，没人知道。」
 *
 * 2026-10-21 我又踩了同一个坑：
 *   verify-no-english-src.mjs 从未登记，而且自身有 bug
 *   （ReferenceError: findings is not defined，一跑就崩）。
 *   于是我之前几轮反复写的「英文清零」是错的 —— 那个专门扫漏翻的脚本
 *   从来没跑成功过。修好它立刻报出 13 处真漏翻。
 *
 * ⇒ 知道 ≠ 执行。这条必须做成自动检查，否则下次会话又会忘。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 它检查什么
 *
 *   ① 每个包目录下所有 verify-*.mjs / check-*.mjs 脚本，
 *      都出现在 verify-all.mjs 里
 *   ② verify-all.mjs 里引用的脚本，文件都真实存在（防止改名后留下死引用）
 *
 * ★ 这不检查脚本内容对不对 —— 那是每个脚本自己的事。
 *   它只保证「没有任何一个脚本被遗忘在角落」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么它自己不能进 verify-all
 *
 * 它是「元验收」—— 检查的是「其他验收有没有被登记」。
 * 如果把自己也登记进去，就变成「检查自己有没有被检查」，无意义且容易递归。
 * ⇒ 独立跑：node verify-registry-complete.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

/**
 * 元验收 / 需要参数的工具 —— 它们本来就不该进 verify-all。
 *
 * ★ 2026-10-23：不加白名单的话，这个脚本会把「自己没登记」也报成缺陷。
 *   判据：能被 verify-all 无参数直接跑的才算验收脚本；
 *   跑它会导致递归或需要外部参数的，是工具。
 */
const META_SCRIPTS = new Set([
  "verify-all.mjs",              // 总验收自己
  "verify-no-pollution.mjs",     // 元验收：它跑 verify-all，登记会无限递归
  "verify-registry-complete.mjs",// 本文件
  "verify-workflow.mjs",         // 需要传工作流路径参数
]);

/**
 * 要检查的包目录（相对 packages/）。
 *
 * ★★ 2026-10-23 修：原来是硬编码 5 个包名，漏了 tools / dsh-editor /
 *   dsh-video-knowledge —— 于是新加的 tools/check-undeclared.mjs、
 *   tools/check-silent-catch.mjs、tools/verify-ui-to-api.mjs 全被报成
 *   「死引用」，而它们其实存在。
 *
 *   ⇒ 改成【自动发现】packages 下所有含 verify 或 check 脚本的子目录。
 *     硬编码列表必然随项目增长而过期（AGENTS §3.7 同款）。
 */
const PACKAGES = (() => {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(HERE, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (!e.isDirectory() || e.name === "node_modules") continue;
    /* 只收「目录里有 verify-/check- 脚本」的 —— 避开纯数据目录 */
    let has = false;
    const probe = (d, depth = 0) => {
      if (has || depth > 2) return;
      let list;
      try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const f of list) {
        if (f.isDirectory()) { if (f.name !== "node_modules") probe(path.join(d, f.name), depth + 1); }
        else if (/^(verify|check)-[a-z0-9-]+\.mjs$/.test(f.name)) { has = true; return; }
      }
    };
    probe(path.join(HERE, e.name));
    if (has) out.push(e.name);
  }
  return out;
})();

/** 脚本名模式 */
const SCRIPT_RE = /^(verify|check)-[a-z0-9-]+\.mjs$/;

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

/* ── 读 verify-all.mjs，提取所有被引用的脚本名 ─────────────────── */

const allPath = path.join(HERE, "verify-all.mjs");
if (!fs.existsSync(allPath)) {
  console.error(`  ✗ 找不到 ${allPath}`);
  process.exit(2);
}
const allSrc = fs.readFileSync(allPath, "utf8");

/** `run('标题', '包名', '脚本名.mjs')` 里的第三个参数 */
const referenced = new Set();
for (const m of allSrc.matchAll(/run\(\s*(['"`])[^'"`]*\1\s*,\s*(['"`])([^'"`]+)\2\s*,\s*(['"`])([^'"`]+)\4/g)) {
  referenced.add(m[5]);
  /* ★ 同时存 basename：后面按「包/文件名」与「文件名」两种形式匹配 */
  referenced.add(String(m[5]).split("/").pop());
}
/* 兜底：任何 'xxx.mjs' 形态的引用都算（防止 run() 写法变化后漏抓） */
for (const m of allSrc.matchAll(/['"`]((?:verify|check)-[a-z0-9-]+\.mjs)['"`]/g)) {
  referenced.add(m[1]);
}

check("verify-all.mjs 里至少引用了 10 个脚本",
  referenced.size >= 10,
  `实测只提取到 ${referenced.size} 个 —— 可能是提取规则失效了`);

/* ── ① 每个脚本都必须被登记 ───────────────────────────────────── */

const allScripts = [];
/**
 * ★★ 2026-10-23 修：原来只扫 PACKAGES 子目录 —— 漏了 packages 根目录
 *
 *   实测：verify-png-tags.mjs 就放在 packages/ 根目录，
 *   从没登记进 verify-all，而这个元验收报「134/134 全过」。
 *
 *   ⇒ 元验收自己漏扫目录，等于它的保证不成立。
 *     根目录也要扫。
 */
const scanDir = (dir, pkg) => {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (!SCRIPT_RE.test(name)) continue;
    if (name === SELF) continue;
    if (META_SCRIPTS.has(name)) continue;
    allScripts.push({ pkg, name });
  }
};

/* ① packages/ 根目录本身的脚本 */
scanDir(HERE, "(根)");

/* ② 各包目录（含 test/ tools/ src/ 子目录） */
for (const pkg of PACKAGES) {
  const base = path.join(HERE, pkg);
  if (!fs.existsSync(base)) continue;
  scanDir(base, pkg);
  /* 子目录也要扫：test/ tools/ src/ 里也有验收脚本 */
  for (const sub of fs.readdirSync(base, { withFileTypes: true })) {
    if (!sub.isDirectory() || sub.name === "node_modules") continue;
    scanDir(path.join(base, sub.name), `${pkg}/${sub.name}`);
  }
}

check("找到了所有包的验收脚本（至少 20 个）",
  allScripts.length >= 20,
  `实测 ${allScripts.length} 个`);

for (const { pkg, name } of allScripts) {
  check(`${pkg}/${name} 已登记进 verify-all`, referenced.has(name) || referenced.has(`${pkg}/${name}`),
    "未登记 = 永远不会被跑到 = 心理安慰（AGENTS §6.44a）");
}

/* ── ② 反向：引用的脚本必须真实存在 ───────────────────────────── */

/**
 * ★ 注意：verify-all.mjs 里还引用了【别的项目】的脚本
 *   （如 'dsh-editor' 包的 test/verify-transition.mjs），
 *   它们不在本目录树里。那不算死引用 —— 是跨项目调用。
 *
 * ⇒ 判据：只对【本目录树内】的包做存在性检查；
 *   引用里带子目录（如 test/xxx）或包名不在 PACKAGES 里的，跳过。
 */
/**
 * ★★ 2026-10-23 修：这里只查 PACKAGES 子目录的【第一层】，
 *   于是 dsh-editor/test/verify-*.mjs 这类二级路径全被报成「死引用」。
 *
 *   ⇒ 改成递归查：只要 packages/ 树下任何位置有同名文件就算存在。
 *     判据是「这个名字的脚本真的存在」，不是「在某个特定层级」。
 */
const findScript = (dir, name, depth = 0) => {
  if (depth > 3) return false;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of ents) {
    if (e.name === "node_modules") continue;
    if (e.isFile() && e.name === name) return true;
  }
  for (const e of ents) {
    if (e.name === "node_modules") continue;
    if (e.isDirectory() && findScript(path.join(dir, e.name), name, depth + 1)) return true;
  }
  return false;
};

const LOCAL_REF = /^[a-z0-9-]+\.mjs$/;
for (const name of referenced) {
  /* 带路径的引用（test/xxx.mjs）已经在 ① 里按包/子目录核过，这里只看纯文件名 */
  const base = String(name).split("/").pop();
  if (!LOCAL_REF.test(base)) continue;
  const found = findScript(HERE, base);
  check(`verify-all 引用的 ${base} 真实存在`, found,
    "改名或删除后留下死引用，会让总验收静默跳过这一步");
}

/* ── 汇总 ─────────────────────────────────────────────────────── */

const total = pass + fails.length;
console.log("");
if (fails.length === 0) {
  console.log(`  ✓ registry-complete  ${pass}/${total} 全过`);
  console.log("");
  console.log(`  ${allScripts.length} 个脚本全部已登记，${referenced.size} 个引用全部指向真实文件。`);
  console.log("  ★ 这是元验收，不进 verify-all（否则变成检查自己有没有被检查）。");
  process.exit(0);
}
console.log(`  ✗ registry-complete  ${pass}/${total}，失败 ${fails.length} 项：`);
for (const f of fails) console.log(`      · ${f.name}${f.detail ? `\n        ${f.detail}` : ""}`);
process.exit(1);
