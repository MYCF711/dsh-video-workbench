#!/usr/bin/env node
/**
 * 「安装能否交付一个可用实例」的自检 —— 检查 install.ps1 写的配置是否自洽。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个
 *
 *   2026-10-23 我连续 3 轮把「安装脚本」判成有缺陷 —— 因为装完的新 profile
 *   打开后看不到 视频工作台 / 剪辑台 两个 tab。
 *
 *   实际根因：**conversation.view 只在「有消息的会话」里渲染。**
 *   新建的空会话不渲染标签条。这是 DSH 的固有行为，不是插件问题。
 *   实测：同一 profile，点开有历史的会话 → tablist 2 个、4 个 tab 全在；
 *        新建空会话 → tablist 1 个（只有「空面板」）。
 *
 *   ⇒ 这条已写进 Hindsight。本脚本做的是「让检查自己会分辨」。
 *
 * ── ★ 本脚本第一版写错了 4 条断言，教训记在这里
 *
 *   我假设「每个包都要有 dsh.client + lib/client.js」，实际有四种形态：
 *
 *     ① 纯 host 包（dsh-comfy-bridge）
 *          dsh.bundle 有、dsh.client 无、main = src/index.js、无 lib/
 *          ⇒ 只提供 HTTP 路由，不参与浏览器
 *
 *     ② UI 包（dsh-comfy-workbench-tab）
 *          dsh.client 有、有 lib/index.js + lib/client.js
 *          ⇒ 浏览器要加载它
 *
 *     ③ 混合包（dsh-editor）
 *          dsh.bundle 有、dsh.client 无、但有 lib/client.js
 *          ⇒ 客户端入口由 bundle patch 引入，不靠 dsh.client
 *
 *     ④ 纯逻辑库（dsh-video-knowledge）
 *          三个字段都没有，只被相对路径 import
 *
 *   ★ 判据：不要假设「UI 包必须有 dsh.client」。
 *     看它实际怎么被加载 —— package.json 的 dsh 字段 + 有没有 lib 产物。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PKG_ROOT = path.join(REPO, "packages");

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

/* ── 读 install.ps1 的包清单 ── */
const installPs1 = path.join(REPO, "install.ps1");
check("install.ps1 存在", fs.existsSync(installPs1));
const installSrc = fs.existsSync(installPs1) ? fs.readFileSync(installPs1, "utf8") : "";

/* ★ PS 变量名是小写 $pkgs */
const pkgsMatch = installSrc.match(/\$pkgs\s*=\s*@\(([\s\S]*?)\)/);
const listed = pkgsMatch
  ? [...pkgsMatch[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1])
  : [];
check("install.ps1 列出了包清单", listed.length >= 4, `实测 ${listed.length} 个`);

/* ── 每个包：目录 + package.json ── */
const metas = new Map();
for (const name of listed) {
  const dir = path.join(PKG_ROOT, name);
  check(`${name} 目录存在`, fs.existsSync(dir));
  const pj = path.join(dir, "package.json");
  check(`${name} 有 package.json`, fs.existsSync(pj),
    "README 与 install.ps1 都把它列为依赖，没有清单 npm 装软链会失败");
  if (fs.existsSync(pj)) {
    try {
      metas.set(name, JSON.parse(fs.readFileSync(pj, "utf8")));
    } catch { /* 坏 JSON 会在下面暴露 */ }
  }
}

/* ── 形态判定 ── */
const kinds = new Map();
for (const name of listed) {
  const j = metas.get(name);
  if (!j) continue;
  const dir = path.join(PKG_ROOT, name);

  const hasClient = Boolean(j?.dsh?.client);
  const hasBundle = Boolean(j?.dsh?.bundle);
  const hasLibIndex = fs.existsSync(path.join(dir, "lib", "index.js"));
  const hasLibClient = fs.existsSync(path.join(dir, "lib", "client.js"));

  /* ★ 唯一硬约束（AGENTS §3.11）：声明了 dsh.client 就必须有 lib/client.js，
   *   否则宿主直接崩，不是「跳过这个插件」。 */
  if (hasClient) {
    check(`${name} 声明了 dsh.client 且有 lib/client.js`, hasLibClient,
      "缺产物会让整个 DSH 崩溃（AGENTS §3.11）");
  }

  /* ★ main 指向的文件必须真实存在 */
  if (j.main) {
    check(`${name} 的 main 指向的文件存在`,
      fs.existsSync(path.join(dir, j.main)),
      `main = ${j.main}`);
  }

  /* ★ lib/ 存在且 main 不在 lib/ 里时，lib/index.js 应存在 */
  const hasLibDir = fs.existsSync(path.join(dir, "lib"));
  if (hasLibDir && !(j.main && !j.main.startsWith("lib/"))) {
    check(`${name} 有 lib/index.js`, hasLibIndex, "lib/ 存在但缺 index.js");
  }

  kinds.set(name, hasClient ? "UI（dsh.client）"
    : hasBundle && hasLibClient ? "混合（bundle + lib/client.js）"
      : hasBundle ? "纯 host（bundle）"
        : "纯逻辑库");
}

/* ── README 必须写清「空会话不渲染 tab」这件事 ── */
const readme = path.join(REPO, "README.md");
if (fs.existsSync(readme)) {
  const r = fs.readFileSync(readme, "utf8");
  /**
   * ★★ 2026-10-23：第一版这个正则太松，变异测试暴露了。
   *
   *   第一版：/已有会话|有消息的会话|历史会话|空会话[\s\S]{0,20}不[\s\S]{0,10}渲染/
   *   变异测试（把关键的几句话删掉）→ 仍然通过。
   *   原因：README 别处也出现「会话」「渲染」这类词，宽松的 OR 让它们凑成了匹配。
   *
   *   ⇒ 改成要求【两个具体判据同时出现】：
   *     ① 出现「空会话」+「不渲染」这一对（容错 30 字以内）
   *     ② 出现「tablist」这个可执行判据（读者能照做）
   *   两个都要有，删掉任何一个都会变红。
   */
  const hasCoreClaim = /空会话[\s\S]{0,30}不[\s\S]{0,15}渲染/.test(r);
  const hasActionable = /tablist/.test(r);
  check("README 写了「空会话不渲染 tab」这条根因",
    hasCoreClaim,
    "★ 我因为不知道这条，连续 3 轮误判「安装脚本有缺陷」");
  check("README 给了可执行的判据（tablist 数量）",
    hasActionable,
    "只说「空会话不渲染」不够，要给出能照着查的一行代码");
}

/* ── install.ps1 的 bundles 清单必须与包清单匹配 ── */
const bundleMatch = installSrc.match(/\$bundleNames\s*=\s*@\(([\s\S]*?)\)/);
if (bundleMatch) {
  const bundles = [...bundleMatch[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
  for (const b of bundles) {
    check(`bundle "${b}" 在包清单里`, listed.includes(b), "bundles 里有、pkgs 里没有");
  }
  check("纯逻辑库不进 bundles", !bundles.includes("dsh-video-knowledge"),
    "dsh-video-knowledge 不注册任何 slot，进 bundles 会要求它有 dsh 字段");
}

/**
 * ★★★ 2026-10-25 新增：packages/ 下每个包都必须在 install.ps1 的清单里
 *
 *   【实测事故】dsh-comfy-preset 从来没被 install.ps1 装过。
 *   后果不是「少一个包」，而是：
 *     · 技能 comfy-mode-dispatch 不存在
 *     · ⇒ 对话框里的 LLM 不知道该选哪个工作流、不知道有 comfy_workbench_fill
 *     · ⇒ 主人设计的「懒人路径」整个失效
 *   而所有验收都是绿的 —— 因为没人检查「有哪些包 vs 装了哪些包」。
 *
 *   ★ 这条判据是【目录枚举】对【安装清单】的差集，
 *     不是「清单内部自洽」（那正是上面那条漏掉的方向）。
 */
const pkgDirs = fs.readdirSync(PKG_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith("dsh-"))
  .map((d) => d.name);
const notInstalled = pkgDirs.filter((n) => !listed.includes(n));
check(
  "packages/ 下每个 dsh-* 包都在 install.ps1 的清单里",
  notInstalled.length === 0,
  notInstalled.length ? `漏装：${notInstalled.join(", ")}` : ""
);

console.log("");
console.log("═".repeat(70));
console.log("  安装配置自检（install.ps1 / package.json / README 是否自洽）");
console.log("═".repeat(70));
console.log("");
for (const name of listed) {
  console.log(`  ${name.padEnd(26)} ${kinds.get(name) ?? "(无清单)"}`);
}
console.log("");

if (fails.length === 0) {
  console.log("  ✅ 安装配置自洽");
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
