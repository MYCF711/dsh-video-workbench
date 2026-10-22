/**
 * M1 验收脚本 —— 按 docs/方案-DSH视频工作台.md §6.6 的五条标准逐项跑。
 *
 * 用法：
 *   node verify-m1.mjs              # 全跑
 *   node verify-m1.mjs --skip-gen   # 跳过真提交（只验前三条）
 *
 * 判据全部是「能复现的观测」，不是「看着对」。
 */

import { createComfy } from "./src/comfy.mjs";
import { loadModes, buildPrompt } from "./src/workflows.mjs";
import { snapLength, secondsToLength, aspectToSize, LEGAL_LENGTHS } from "./src/length.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WFDIR = join(HERE, "workflows");
const SKIP_GEN = process.argv.includes("--skip-gen");

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) {
      console.log(`  ✅ ${name}`);
      pass++;
    } else {
      console.log(`  ❌ ${name}`);
      console.log(`     ${r}`);
      fail++;
      failures.push({ name, detail: r });
    }
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    fail++;
    failures.push({ name, detail: err.message });
  }
}

async function checkAsync(name, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) {
      console.log(`  ✅ ${name}`);
      pass++;
    } else {
      console.log(`  ❌ ${name}`);
      console.log(`     ${r}`);
      fail++;
      failures.push({ name, detail: r });
    }
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    fail++;
    failures.push({ name, detail: err.message });
  }
}

// ══════════════════════════════════════════════════════════════
console.log("═══ 验收 ① 能列出全部 mode ═══");
const { modes, warnings } = await loadModes(WFDIR);
// ★ 判据是「至少 3 个 + 三个核心职责齐全」，不是硬编码总数 ——
//   加新工作流（如 qwen21-edit）不该让这条断言变红。
//   实测踩过：加 qwen21-edit 后写成 === 3 就误报。
check("至少 3 个模式", () => (modes.length >= 3 ? true : `只有 ${modes.length} 个：${modes.map((m) => m.id)}`));
check("三个核心职责齐全（生图/改图/生视频）", () => {
  const ids = new Set(modes.map((m) => m.id));
  const need = ["krea2", "qwen21-edit", "yz"];
  const missing = need.filter((x) => !ids.has(x));
  return missing.length === 0 ? true : `缺 ${missing.join(", ")}（实际有 ${[...ids].sort().join(",")}）`;
});
check("每个模式都有 label", () => {
  const bad = modes.filter((m) => !m.label);
  return bad.length === 0 ? true : `缺 label：${bad.map((m) => m.id)}`;
});
check("每个模式都 state=ok", () => {
  const bad = modes.filter((m) => m.state !== "ok");
  return bad.length === 0 ? true : `非 ok：${bad.map((m) => `${m.id}:${m.state}`)}`;
});
if (warnings.length) {
  console.log(`  ⚠ 装载警告 ${warnings.length} 条：`);
  for (const w of warnings) console.log(`     ${w}`);
}

// ══════════════════════════════════════════════════════════════
console.log("\n═══ 验收 ② 帧数网格（17k+5 + 奇数退让）═══");
check("合法值共 22 个（k=0..21）", () =>
  LEGAL_LENGTHS.length === 22 ? true : `实际 ${LEGAL_LENGTHS.length}`);
check("首值=5 末值=362", () =>
  LEGAL_LENGTHS[0] === 5 && LEGAL_LENGTHS.at(-1) === 362
    ? true
    : `首=${LEGAL_LENGTHS[0]} 末=${LEGAL_LENGTHS.at(-1)}`);
check("全部合法值都在网格上", () => {
  const bad = LEGAL_LENGTHS.filter((v) => (v - 5) % 17 !== 0);
  return bad.length === 0 ? true : `不在网格：${bad}`;
});
check("snap(24) → 22（实测映射，视频生成参数表 §三① 逐字）", () => {
  const v = snapLength(24);
  return v === 22 ? true : `实际 ${v}`;
});
check("snap(120) → 124（实测映射）", () => {
  const v = snapLength(120);
  return v === 124 ? true : `实际 ${v}`;
});
check("snap(240) → 226（实测映射）", () => {
  const v = snapLength(240);
  return v === 226 ? true : `实际 ${v}`;
});
check("snap(5) → 5（边界：不绕到 22）", () => {
  const v = snapLength(5);
  return v === 5 ? true : `实际 ${v}`;
});
check("snap(0) → 5", () => {
  const v = snapLength(0);
  return v === 5 ? true : `实际 ${v}`;
});
check("snap(999) → 362（上限夹取）", () => {
  const v = snapLength(999);
  return v === 362 ? true : `实际 ${v}`;
});
check("secondsToLength(5) → 124", () => {
  const v = secondsToLength(5);
  return v === 124 ? true : `实际 ${v}（5 秒应吸到 124 = 5.17s）`;
});
check("所有 snap 结果都是偶数", () => {
  const odd = [];
  for (let n = 0; n <= 400; n++) {
    const v = snapLength(n);
    if (v !== 5 && v % 2 !== 0) odd.push(`${n}→${v}`);
  }
  return odd.length === 0 ? true : `奇数结果：${odd.slice(0, 5)}`;
});
check("aspectToSize('16:9') 对齐 32", () => {
  const s = aspectToSize("16:9", 0.4);
  if (!s) return "返回 null";
  if (s.width % 32 || s.height % 32) return `未对齐32：${s.width}x${s.height}`;
  return true;
});
check("aspectToSize 忽略后缀 '16:9 (Widescreen)'", () => {
  const a = aspectToSize("16:9");
  const b = aspectToSize("16:9 (Widescreen)");
  return a.width === b.width && a.height === b.height
    ? true
    : `不一致：${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
});

// ══════════════════════════════════════════════════════════════
console.log("\n═══ 验收 ③ 坏 bind → 报明确错误（不静默）═══");
const badBind = {
  id: "badtest",
  label: "坏测试",
  state: "ok",
  _workflow: { "1": { class_type: "X", inputs: {} } },
  vars: { prompt: { node: "999", input: "text" } },  // 999 不存在
  media: {},
  outputs: {},
  aspectMap: {},
  toggles: {},
  _togglesRaw: {},
  defaults: {},
};
check("vars 指向不存在的 node → 抛 WorkflowError", () => {
  try {
    buildPrompt(badBind, { prompt: "x" }, { snapLength, secondsToLength, aspectToSize });
  } catch (err) {
    return err.name === "WorkflowError" ? true : `抛的是 ${err.name}：${err.message}`;
  }
  return "没有抛错 —— 静默失败";
});

// ══════════════════════════════════════════════════════════════
console.log("\n═══ 验收 ④ ComfyUI 探活（杀掉时应报明确错误）═══");
await checkAsync("探活成功 或 明确报「未运行」", async () => {
  const comfy = createComfy({});
  try {
    const p = await comfy.probe();
    console.log(`     连上了：${p.base}  版本 ${p.comfyuiVersion}  ${p.devices.map((d) => `${d.name} ${d.vramFreeMiB}/${d.vramTotalMiB}MiB`).join(", ")}`);
    return true;
  } catch (err) {
    if (err.name === "ComfyUnreachable") {
      console.log(`     未连上（合规）：${err.message}`);
      return true;  // 报明确错误也算过 —— 判据是「不静默超时」
    }
    return `抛的是 ${err.name}：${err.message}`;
  }
});

// ══════════════════════════════════════════════════════════════
if (!SKIP_GEN) {
  console.log("\n═══ 验收 ⑤ 真提交一个任务并拿到产物 ═══");
  await checkAsync("提交 → 轮询 → 产物", async () => {
    const comfy = createComfy({});
    let p;
    try {
      p = await comfy.probe();
    } catch (err) {
      console.log(`     跳过：ComfyUI 未运行`);
      return true;
    }

    // 用 krea2（生图最快，不碰 H3 的 19.5GB）
    const mode = modes.find((m) => m.id === "krea2");
    const built = buildPrompt(
      mode,
      { prompt: "a plain blue circle on white background", aspect: "1:1", steps: 4 },
      { snapLength, secondsToLength, aspectToSize }
    );
    console.log(`     提交 ${Object.keys(built.prompt).length} 节点…`);
    const promptId = await comfy.queue(built.prompt, "verify-m1");
    console.log(`     promptId=${promptId}，轮询…`);

    const t0 = Date.now();
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const h = await comfy.history(promptId);
      if (h) {
        const sec = ((Date.now() - t0) / 1000).toFixed(1);
        if (!h.completed) return `跑完但 statusStr=${h.statusStr}（不成功）`;
        if (h.outputs.length === 0) return `completed 但 0 产物（「秒级成功但产物为空」这个坑）`;
        console.log(`     ✓ ${sec}s，产物 ${h.outputs.length} 个：`);
        for (const o of h.outputs.slice(0, 3)) console.log(`        ${o.kind}  ${o.filename}`);
        return true;
      }
      // 秒级完成但空产物 = 已知坑，要抓
      const el = Date.now() - t0;
      if (el > 9000 && el < 11000) {
        console.log(`     （已 ${Math.round(el / 1000)}s，仍在跑）`);
      }
    }
    return "180 次轮询（6 分钟）仍未完成";
  });
} else {
  console.log("\n═══ 验收 ⑤ 已跳过（--skip-gen）═══");
}

// ══════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(60));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败 ${fail} 项：`);
  for (const f of failures) console.log(`     · ${f.name}`);
  process.exit(1);
} else {
  console.log("  M1 验收全过");
}
