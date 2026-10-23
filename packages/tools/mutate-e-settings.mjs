#!/usr/bin/env node
/**
 * verify-e-settings.mjs 的变异测试。
 *
 * ★ 上一轮做 A/B 的变异时连抓 3 个假通过，这次一开始就按那三条判据写：
 *   ① 变异插在真实代码区（不插注释）
 *   ② 检测「会不会执行」而不只是「文本在不在」
 *   ③ 读文件的断言先确认文件存在
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const BRIDGE = path.join(PKG_ROOT, "dsh-comfy-bridge", "src");
const TAB = path.join(PKG_ROOT, "dsh-comfy-workbench-tab", "src");
const VERIFIER = path.join(HERE, "verify-e-settings.mjs");

const MUTATIONS = [
  /* E1 */
  {
    /**
     * ★ 2026-10-23 第一版假通过：settings.section 在 index.js 里出现【两次】
     *   （L190 剪辑台快捷键设置、L219 ComfyUI 与环境），
     *   我只替换了第一处 ⇒ 第二处仍满足断言。
     *   ⇒ 变异必须 all: true（替换全部）。
     *
     *   ★ 顺带发现：这两处注册说明有几个 settings 页 ——
     *     断言不能只查「有没有一处」，要查「ComfyConfig 那一处」。
     */
    name: "E1 只删 ComfyUI 那处 settings.section 注册（保留快捷键那处）",
    file: path.join(TAB, "editor", "index.js"),
    from: 'id: "comfy-environment",',
    to: 'id: "gone-environment",',
    expect: "id = comfy-environment",
  },
  {
    name: "E1 去掉输出目录字段",
    file: path.join(TAB, "editor", "ComfySettings.js"),
    from: "outputDir",
    to: "outputGone",
    expect: "输出目录",
    all: true,
  },
  /* E2 */
  {
    name: "E2 去掉 FIELD_ROLE 角色映射",
    file: path.join(BRIDGE, "model-manifest.mjs"),
    from: "FIELD_ROLE = {",
    to: "FIELD_GONE = {",
    expect: "FIELD_ROLE 角色映射",
  },
  {
    name: "E2 lora_name 映射到错的角色",
    file: path.join(BRIDGE, "model-manifest.mjs"),
    from: 'lora_name: "lora"',
    to: 'lora_name: "unknown"',
    expect: "lora_name → lora",
  },
  {
    name: "E2 vae_name 映射到错的角色",
    file: path.join(BRIDGE, "model-manifest.mjs"),
    from: 'vae_name: "vae"',
    to: 'vae_name: "misc"',
    expect: "vae_name → vae",
  },
  /* E3 */
  {
    name: "E3 去掉 /doctor 路由",
    file: path.join(BRIDGE, "index.js"),
    from: '"/doctor"',
    to: '"/healthz"',
    expect: "/doctor 路由",
  },
  {
    name: "E3 去掉 ffmpeg 检查",
    file: path.join(BRIDGE, "index.js"),
    from: "ffmpeg",
    to: "ffgones",
    expect: "体检含「ffmpeg」",
    all: true,
  },
  /* 配置回退提示 */
  {
    name: "E2 桥不再标注「可能属于另一个 profile」",
    file: path.join(BRIDGE, "user-config.mjs"),
    from: "mayBeWrongProfile",
    to: "profileIsDefinitelyRight",
    expect: "配置来源如实标注",
    all: true,
  },
  {
    name: "E2 设置页不渲染这个提示",
    file: path.join(TAB, "editor", "ComfySettings.js"),
    from: "mayBeWrongProfile",
    to: "profileIsDefinitelyRight",
    expect: "设置页把「可能属于另一个 profile」显示出来",
    all: true,
  },
];

let pass = 0;
const fails = [];

for (const m of MUTATIONS) {
  if (!fs.existsSync(m.file)) {
    fails.push(`${m.name}：文件不存在 ${m.file}`);
    continue;
  }
  const orig = fs.readFileSync(m.file, "utf8");
  if (!orig.includes(m.from)) {
    fails.push(`${m.name}：找不到变异点 "${m.from.slice(0, 40)}"`);
    continue;
  }
  try {
    const mutated = m.all
      ? orig.split(m.from).join(m.to)
      : orig.replace(m.from, m.to);
    fs.writeFileSync(m.file, mutated, "utf8");

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

const final = spawnSync("node", [VERIFIER], { encoding: "utf8", timeout: 120000 });
const restored = final.status === 0;

console.log("");
console.log("═".repeat(70));
console.log("  verify-e-settings 的变异测试");
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


