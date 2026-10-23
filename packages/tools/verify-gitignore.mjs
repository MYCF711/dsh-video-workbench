#!/usr/bin/env node
/**
 * F1 验收 —— 检查「不该进仓库的东西确实没进」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * F1 要求：.gitignore 排除 .models/（3.9GB）、node_modules、.state、
 *          outputs、证据目录。
 *
 * ── 2026-10-23 核对时发现的真实问题
 *
 *   我第一遍用 `git check-ignore -q <路径>` 逐项判，得到 3 个「未忽略」：
 *     node_modules/  outputs/  packages/_snapshot-before.json
 *
 *   ★ 前两个是【误报】：那些目录在这个仓库里根本不存在
 *     （root 没有 node_modules，也没有 outputs/），
 *     所以 check-ignore 当然不命中。
 *     ⇒ 判据要改：不看「路径是否被忽略」，看【已跟踪文件里有没有它们】。
 *
 *   ★ 第三个是【真问题】：packages/_snapshot-before.json（288KB）
 *     被 git 跟踪了。它是 verify-no-pollution 的临时快照，
 *     每次跑验收都会重写 ⇒ 提交一次就永远是脏的，
 *     而且每次 diff 都是整个文件（279589 字符）。
 *
 *   ⇒ 修：加进 .gitignore + git rm --cached。仓库 26.2MB → 25.9MB。
 *
 * ── 本脚本的双重判据
 *   ① 【硬判据】git 已跟踪的文件里，不能有 node_modules / .models /
 *      .state / outputs / docs/evidence / bin 下的二进制 / *.mp4 等
 *      —— 这条是真正的保证，直接看 ls-files。
 *   ② 【软判据】.gitignore 里要有关键规则
 *      —— 防止以后新建同类目录被误提交。
 *
 *   ★ 只做①也能保证正确，但没有②的话，下次新建 node_modules 时
 *     会在 `git add -A` 那一刻被扫进去（那时②就救你了）。
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

const git = (args) => {
  const r = spawnSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd: REPO, encoding: "utf8", timeout: 120000,
  });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
};

console.log("");
console.log("═".repeat(70));
console.log("  F1 验收（不该进仓库的东西确实没进）");
console.log("═".repeat(70));
console.log("");

/* ── ① 硬判据：已跟踪文件里不能有这些 ── */
const tracked = git(["ls-files"]);
if (!tracked.ok) {
  /**
   * ★ 2026-10-24：非 git 环境走【跳过】而不是失败。
   *
   *   实测可移植性测试：把文件复制到新目录（没有 .git）后跑静态验收，
   *   这一项报「不是 git 仓库」—— 但那不是缺陷，是环境不适用。
   *
   *   ⇒ 跳过 + 说明。真正的 git 仓库里这条仍然会检查。
   */
  console.log("");
  console.log("  – 跳过：这儿不是 git 仓库（或 git 不可用），仓库卫生无从检查");
  console.log("     本条只在 git 工作副本里有意义。");
  console.log("");
  console.log("  通过 0 / 0（跳过）");
  console.log("");
  process.exit(0);
}
const files = tracked.out.split("\n").filter(Boolean);

const FORBIDDEN = [
  { re: /(^|\/)node_modules\//, name: "node_modules" },
  { re: /(^|\/)\.models\//, name: ".models（3.9GB 模型）" },
  { re: /(^|\/)\.state\//, name: ".state（运行时状态）" },
  { re: /(^|\/)outputs\//, name: "outputs（生成产物）" },
  { re: /(^|\/)docs\/evidence\//, name: "docs/evidence（证据目录）" },
  { re: /packages\/dsh-editor\/bin\//, name: "dsh-editor/bin（ffmpeg 83MB）" },
  { re: /\.(mp4|webm|mov|wav|mp3)$/, name: "音视频大文件" },
  { re: /_snapshot-before\.json$/, name: "验收临时快照" },
  { re: /_snapshot-after\.json$/, name: "验收临时快照" },
  { re: /(^|\/)\.frames\//, name: ".frames（抽帧临时目录）" },
  { re: /_branch-archive\//, name: "归档目录" },
];

for (const f of FORBIDDEN) {
  const hits = files.filter((x) => f.re.test(x));
  check(`已跟踪文件里没有 ${f.name}`, hits.length === 0,
    hits.length ? `命中 ${hits.length} 个：${hits.slice(0, 3).join(", ")}` : "");
}

/* ── ② 软判据：.gitignore 要有关键规则 ── */
const gi = fs.existsSync(path.join(REPO, ".gitignore"))
  ? fs.readFileSync(path.join(REPO, ".gitignore"), "utf8")
  : "";
check(".gitignore 存在", gi.length > 0);

for (const rule of [
  "node_modules/",
  ".models/",
  ".state/",
  "outputs/",
  "docs/evidence/",
  "packages/dsh-editor/bin/",
  "_snapshot-before.json",
]) {
  check(`.gitignore 含规则「${rule}」`, gi.includes(rule));
}

/* ── 体积哨兵：已跟踪总大小不该失控 ── */
let total = 0;
for (const f of files) {
  try {
    const p = path.join(REPO, f);
    if (fs.existsSync(p)) total += fs.statSync(p).size;
  } catch { /* 跳过 */ }
}
const mb = total / 1024 / 1024;
check(`已跟踪文件总体积 < 80MB`, mb < 80, `实测 ${mb.toFixed(1)}MB`);

console.log(`  已跟踪文件：${files.length} 个`);
console.log(`  总体积：${mb.toFixed(1)} MB`);
console.log("");

if (fails.length === 0) {
  console.log("  ✅ 不该进仓库的东西都没进");
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

