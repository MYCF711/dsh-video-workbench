#!/usr/bin/env node
/**
 * D4 / D5 验收 —— 包依赖可移植、四个包各自能独立加载。
 *
 * ══════════════════════════════════════════════════════════════════════
 * D4 原文：「把 3 个 link: 绝对路径依赖改成 workspace 内相对引用」
 * D5 原文：「确认合并后 test profile 能正常加载、56 步验收不退化」
 *
 * ── 2026-10-23 实测澄清（原文与实际有出入，记录在这里）
 *
 *   ① 「3 个 link: 绝对路径依赖」实际是【4 个】，而且不在仓库里 ——
 *      在 profile 的 package.json：
 *        dsh-comfy-bridge         = link:D:/主工作区/DSH视频工作台/packages/xxx
 *        dsh-comfy-workbench-tab  = link:...
 *        dsh-editor               = link:...
 *        dsh-video-knowledge      = link:...
 *
 *   ★ 这些【不可能】改成 workspace 相对引用：
 *       profile 在 D:\DeepSeek Harness\home\profiles\comfy-test
 *       仓库  在 D:\主工作区\DSH视频工作台
 *     两者不在同一个 workspace。硬改成 `link:../../../主工作区/...`
 *     只会更脆（任一边移动就断）。
 *
 *   ⇒ 它们的正确形态就是「install.ps1 按当前仓库位置生成的绝对 link」。
 *     这台机器装到哪，link 就指到哪 —— 这正是 link: 的语义。
 *
 *   ② 仓库内包之间【没有】用包名 import（实测 0 处），
 *      只有 2 处相对路径引用 dsh-video-knowledge。
 *      ⇒ 不需要 workspace 依赖解析，现有形态是对的。
 *
 * ── 本脚本查什么
 *   ① 各包 package.json 的依赖里【不得】有绝对路径（link:D:/ / file:D:/ / D:）
 *      —— 包自己不能写死机器位置，那是 profile 的事。
 *   ② 四个包的入口都能真的 import 成功
 *      —— 「文件存在」不等于「能加载」，要真 import。
 *   ③ dsh.client 声明的包必须有 lib/client.js（AGENTS §3.11）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

const PKGS = ["dsh-comfy-bridge", "dsh-comfy-workbench-tab", "dsh-editor", "dsh-video-knowledge", "dsh-comfy-preset"];

console.log("");
console.log("═".repeat(70));
console.log("  D4/D5 验收（包依赖可移植 + 四个包能独立加载）");
console.log("═".repeat(70));
console.log("");

/* ── ① 包依赖里不得有绝对路径 ── */
for (const name of PKGS) {
  const pj = path.join(PKG_ROOT, name, "package.json");
  if (!fs.existsSync(pj)) { check(`${name} 有 package.json`, false); continue; }
  let j;
  try { j = JSON.parse(fs.readFileSync(pj, "utf8")); } catch { check(`${name} package.json 合法`, false); continue; }

  const bad = [];
  for (const sec of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [k, v] of Object.entries(j[sec] ?? {})) {
      if (typeof v === "string" && /^(link|file):\s*[A-Za-z]:|^[A-Za-z]:/.test(v)) {
        bad.push(`${sec}.${k} = ${v}`);
      }
    }
  }
  check(`${name} 依赖里无绝对路径`, bad.length === 0,
    bad.length ? bad.join(" · ") : "");
}

/* ── ② 四个包能真的 import ── */
const ENTRIES = [
  { pkg: "dsh-comfy-bridge", entry: "src/index.js", label: "host 包（main = src/index.js）" },
  { pkg: "dsh-comfy-workbench-tab", entry: "lib/index.js", label: "UI 包" },
  { pkg: "dsh-editor", entry: "lib/index.js", label: "混合包" },
  { pkg: "dsh-video-knowledge", entry: "src/verify-rules.mjs", label: "纯逻辑库" },
];

for (const e of ENTRIES) {
  const p = path.join(PKG_ROOT, e.pkg, e.entry);
  check(`${e.pkg} 入口存在`, fs.existsSync(p), e.entry);
  if (!fs.existsSync(p)) continue;
  try {
    const mod = await import(pathToFileURL(p).href);
    const keys = Object.keys(mod);
    /**
     * ★ 判据：能 import 且导出非空。
     *   只查「文件存在」不够 —— 缺依赖、语法错、循环引用都会
     *   在 import 那一刻才暴露（D2 时 pathToFileURL 漏 import 就是这样）。
     */
    check(`${e.pkg} 能 import 且导出非空`, keys.length > 0, `keys=${keys.join(",")}`);
  } catch (err) {
    check(`${e.pkg} 能 import`, false, String(err?.message ?? err).slice(0, 120));
  }
}

/* ── ③ dsh.client 声明的包必须有 lib/client.js ── */
for (const name of PKGS) {
  const pj = path.join(PKG_ROOT, name, "package.json");
  if (!fs.existsSync(pj)) continue;
  let j;
  try { j = JSON.parse(fs.readFileSync(pj, "utf8")); } catch { continue; }
  if (j?.dsh?.client) {
    check(`${name} 有 lib/client.js`, fs.existsSync(path.join(PKG_ROOT, name, "lib", "client.js")),
      "声明了 dsh.client 缺产物会崩宿主（AGENTS §3.11）");
  }
}

/* ── ④ 跨包引用只用相对路径，不用包名（当前架构的约定）── */
{
  const hits = [];
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === "node_modules" || e.name === ".build" || e.name === "lib") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.m?js$/.test(e.name)) continue;
      const src = fs.readFileSync(full, "utf8");
      for (const m of src.matchAll(/from\s+["'](dsh-(?:comfy-bridge|comfy-workbench-tab|editor|video-knowledge))["'/]/g)) {
        hits.push(`${full.replace(PKG_ROOT + path.sep, "")} → ${m[1]}`);
      }
    }
  };
  for (const p of PKGS) walk(path.join(PKG_ROOT, p));
  /**
   * ★ 为什么禁止：仓库没有根 package.json / pnpm-workspace.yaml，
   *   用包名 import 需要 node_modules 解析，而本仓库不做 workspace 安装。
   *   现有 2 处跨包引用用的是 ../../dsh-video-knowledge/src/xxx 相对路径 —— 这是对的。
   */
  check("跨包引用只用相对路径（不用包名）", hits.length === 0,
    hits.length ? hits.slice(0, 3).join(" · ") : "");
}

console.log("");
if (fails.length === 0) {
  console.log("  ✅ 包依赖可移植，四个包都能独立加载");
  console.log(`  通过 ${pass} / ${pass}`);
  console.log("");
  console.log("  ★ 关于 D4 原文「3 个 link: 改 workspace 相对引用」：");
  console.log("    实测那是 profile 里的 4 个 link，与仓库不在同一 workspace，");
  console.log("    改成相对路径只会更脆。正确形态是 install.ps1 按当前位置生成。");
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
