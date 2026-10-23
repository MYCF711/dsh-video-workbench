#!/usr/bin/env node
/**
 * 对 verify-ab-features.mjs 做变异测试 —— 每条断言都必须能变红。
 *
 * ★ 为什么单独写：这个脚本检查的是「UI 里有没有某个实现」，
 *   最容易写出「永远为真」的断言（比如正则匹配到注释）。
 *   实测过一次假通过（README 的 tablist 断言），必须每条都验。
 *
 * 做法：逐个变异 → 跑 verify-ab-features → 期望变红 → 恢复。
 * 全程用 try/finally，任何一步失败都会恢复原文件。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const TAB = path.join(PKG_ROOT, "dsh-comfy-workbench-tab", "src");
const VERIFIER = path.join(HERE, "verify-ab-features.mjs");

const ART = path.join(TAB, "editor", "ArtCraftTab.js");
const CLIENT = path.join(TAB, "client.js");
const LAUNCHER = path.join(PKG_ROOT, "dsh-comfy-bridge", "src", "comfy-launcher.mjs");

/** 每个变异：文件 + 原文 → 替换成什么 + 期望报出的断言关键词 */
const MUTATIONS = [
  /* ── A5 ── */
  {
    name: "A5 去掉错误条 class",
    file: ART,
    from: "ac-action-error",
    to: "ac-gone-away",
    expect: "ac-action-error",
  },
  {
    name: "A5 去掉 role=alert",
    file: ART,
    from: 'role: "alert"',
    to: 'role: "status"',
    expect: "role=alert",
  },
  {
    name: "A5 去掉关闭回调",
    file: ART,
    from: "onDismissError",
    to: "onNothingHere",
    expect: "错误条可关闭",
  },
  /* ── B1 / B3 ── */
  {
    name: "B1 启动地址打错",
    file: CLIENT,
    from: '"/comfy-bridge/ensure"',
    to: '"/comfy-bridge/start"',
    expect: "/comfy-bridge/ensure",
  },
  {
    name: "B1/B3 关闭地址打错",
    file: CLIENT,
    from: '"/comfy-bridge/stop"',
    to: '"/comfy-bridge/kill"',
    expect: "/comfy-bridge/stop",
  },
  /* ── B4 ── */
  {
    name: "B4 去掉「启动中…」",
    file: CLIENT,
    from: "启动中…",
    to: "",
    expect: "启动中",
  },
  {
    name: "B4 去掉「关闭中…」",
    file: CLIENT,
    from: "关闭中…",
    to: "",
    expect: "关闭中",
  },
  {
    name: "B4 去掉 busy 时禁用",
    file: CLIENT,
    from: "disabled: busy,",
    to: "",
    expect: "busy 时按钮 disabled",
  },
  /* ── A5 / B1 剩余几条 ── */
  {
    name: "A5 去掉 actionError 条件渲染",
    file: ART,
    from: "callbacks?.actionError",
    to: "null",
    expect: "actionError 是渲染条件的一部分",
  },
  {
    name: "B1 两个动作不再由同一处 state.s 判定",
    file: CLIENT,
    from: 'state.s === "ok" ? "/comfy-bridge/stop" : "/comfy-bridge/ensure"',
    to: '"/comfy-bridge/ensure"',
    expect: "两个动作由同一处 state.s 判定",
  },
  /* ── B2：启动参数完整性（6 条） ── */
  {
    name: "B2 去掉 --listen",
    file: LAUNCHER,
    from: '"--listen", "127.0.0.1",',
    to: '',
    expect: "--listen",
  },
  {
    name: "B2 去掉 --port",
    file: LAUNCHER,
    from: '"--port", String(port),',
    to: '',
    expect: "--port",
  },
  {
    name: "B2 去掉 --disable-auto-launch",
    file: LAUNCHER,
    from: '"--disable-auto-launch",',
    to: '',
    expect: "--disable-auto-launch",
  },
  {
    name: "B2 去掉 --extra-model-paths-config",
    file: LAUNCHER,
    from: '"--extra-model-paths-config", p.extraYaml',
    to: '"--models", p.extraYaml',
    expect: "--extra-model-paths-config",
  },
  {
    name: "B2 去掉 --output-directory",
    file: LAUNCHER,
    from: '"--output-directory", p.outputDir',
    to: '"--out", p.outputDir',
    expect: "--output-directory",
  },
  {
    name: "B2 去掉 --input-directory",
    file: LAUNCHER,
    from: '"--input-directory", p.inputDir',
    to: '"--in", p.inputDir',
    expect: "--input-directory",
  },
];

let pass = 0;
const fails = [];

for (const m of MUTATIONS) {
  if (!fs.existsSync(m.file)) {
    fails.push(`${m.name}：文件不存在`);
    continue;
  }
  const orig = fs.readFileSync(m.file, "utf8");
  if (!orig.includes(m.from)) {
    /* 变异点不存在 —— 这个变异本身失效了，必须报出来 */
    fails.push(`${m.name}：找不到变异点 "${m.from.slice(0, 40)}"`);
    continue;
  }
  try {
    fs.writeFileSync(m.file, orig.replace(m.from, m.to), "utf8");
    const r = spawnSync("node", [VERIFIER], { encoding: "utf8", timeout: 120000 });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    const caught = r.status !== 0 && out.includes(m.expect);
    if (caught) {
      pass++;
      console.log(`  ✓ ${m.name}  → 变红`);
    } else {
      fails.push(`${m.name}：期望报「${m.expect}」，实际 ${r.status === 0 ? "全过（假通过）" : "报了别的"}`);
      console.log(`  ✗ ${m.name}  → ${r.status === 0 ? "假通过" : "报错不对"}`);
    }
  } finally {
    fs.writeFileSync(m.file, orig, "utf8");
  }
}

/* 恢复后必须回到全过 */
const final = spawnSync("node", [VERIFIER], { encoding: "utf8", timeout: 120000 });
const restored = final.status === 0;

console.log("");
console.log("═".repeat(70));
console.log("  verify-ab-features 的变异测试");
console.log("═".repeat(70));
console.log("");
console.log(`  变异数：${MUTATIONS.length}`);
console.log(`  能打红：${pass}`);
console.log(`  恢复后全过：${restored ? "是" : "否 ❌"}`);
console.log("");

if (fails.length === 0 && restored) {
  console.log(`  ✅ ${pass}/${MUTATIONS.length} 全部能打红，且恢复后回到全过`);
  console.log(`  通过 ${pass} / ${pass}`);
  console.log("");
  process.exit(0);
}
for (const f of fails) console.log(`  ✗ ${f}`);
console.log(`  通过 ${pass} / ${MUTATIONS.length}`);
console.log("");
process.exit(1);


