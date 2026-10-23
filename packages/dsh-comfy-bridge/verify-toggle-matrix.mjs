/**
 * toggle 组合静态重放验收。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么要这一套
 *
 *   AGENTS §6.21 记的缺陷：「delete 列表漏依赖 → ComfyUI 静默丢图」。
 *   本文件把这个缺陷变成可自动检测的断言。
 *
 *   关键差别：不是读 JSON 做静态推断，而是**真的调 buildPrompt()** ——
 *   走的是运行时会跑的那条代码路径，输出就是提交给 ComfyUI 的那个 prompt。
 *   ⇒ 比 GPU 实测更强的地方：一次覆盖全部 2^n 种开关组合。
 *      GPU 实测一次只能验 1 种。
 *
 * ══════════════════════════════════════════════════════════════════════
 *
 * 检查项：
 *   ① 每个组合都能 buildPrompt 不抛错
 *   ② 输出里没有任何「悬空输入」（输入指向一个不存在的节点）
 *   ③ 期望的输出节点都在（按 toggles 推导）
 *   ④ 该被删的节点真的没了
 *
 * 用法：
 *   node verify-toggle-matrix.mjs
 *   node verify-toggle-matrix.mjs --json      # 机器可读输出
 */

import { loadModes } from "./src/workflows.mjs";
import { buildPrompt } from "./src/workflows.mjs";
import * as comfy from "./src/comfy.mjs";

const JSON_OUT = process.argv.includes("--json");

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail = "") {
  pass++;
  if (!JSON_OUT) console.log(`  ✅ ${name}${detail ? "  " + detail : ""}`);
}
function bad(name, detail = "") {
  fail++;
  failures.push(name);
  if (!JSON_OUT) console.log(`  ❌ ${name}${detail ? "  " + detail : ""}`);
}

/** 找一个稳定的随机源（buildPrompt 要它给种子）。 */
function seededRandom() {
  let s = 20261019;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** 把 toggles 对象展开成 n 位二进制组合。 */
function allCombos(names) {
  const out = [];
  const n = names.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const o = {};
    names.forEach((k, i) => { o[k] = Boolean(mask & (1 << i)); });
    out.push(o);
  }
  return out;
}

/** 期望哪些输出键在（按 toggle 语义）。 */
function expectedOutputs(toggles) {
  const want = ["image"];                    // 一采永远在
  if (toggles.secondPass) want.push("imageTwoPass");
  if (toggles.redraw) want.push("imageUsd");
  if (toggles.seedvr) want.push("imageSeedvr");
  return want.sort();
}

/** 找出 prompt 里所有「指向不存在节点」的输入。 */
function findDangling(prompt) {
  const dangling = [];
  for (const [id, node] of Object.entries(prompt)) {
    const inputs = node?.inputs;
    if (!inputs) continue;
    for (const [k, v] of Object.entries(inputs)) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && /^\d+$/.test(v[0])) {
        if (!prompt[v[0]]) dangling.push(`${id}.${k}←${v[0]}`);
      }
    }
  }
  return dangling;
}

// ─── 主流程 ──────────────────────────────────────────────────────────

if (!JSON_OUT) {
  console.log("═".repeat(62));
  console.log("  toggle 组合静态重放验收");
  console.log("═".repeat(62));
}

const { modes, skipped } = await loadModes("./workflows");
if (skipped?.length && !JSON_OUT) {
  console.log(`  （跳过 ${skipped.length} 个工作流：${skipped.map((s) => s.id ?? s).join(",")}）`);
}

let totalCombos = 0;

for (const mode of modes) {
  const toggleNames = Object.keys(mode.toggles ?? {});
  if (!toggleNames.length) continue;

  const combos = allCombos(toggleNames);
  totalCombos += combos.length;

  if (!JSON_OUT) {
    console.log(`\n── ${mode.id}  ·  ${toggleNames.length} 个开关 ⇒ ${combos.length} 种组合 ──`);
  }

  for (const toggles of combos) {
    const label =
      "[" + toggleNames.map((k) => (toggles[k] ? k : "-" + k)).join(" ") + "]";

    let prompt;
    try {
      const out = buildPrompt(mode, {
        prompt: "a test subject",
        steps: 4,
        batch: 1,
        toggles,
      }, seededRandom());
      // buildPrompt 可能返回 { prompt } 或直接是 prompt 对象
      prompt = out?.prompt ?? out;
    } catch (e) {
      bad(`${mode.id} ${label} 能构建`, `抛错：${String(e?.message ?? e).slice(0, 120)}`);
      continue;
    }

    if (!prompt || typeof prompt !== "object") {
      bad(`${mode.id} ${label} 能构建`, "返回的不是对象");
      continue;
    }

    // ① 无悬空输入
    const dangling = findDangling(prompt);
    if (dangling.length) {
      bad(`${mode.id} ${label} 无悬空输入`, `${dangling.length} 处：${dangling.slice(0, 5).join(",")}`);
    } else {
      ok(`${mode.id} ${label} 无悬空输入`, `节点 ${Object.keys(prompt).length}`);
    }

    // ② 期望的输出节点都在
    const outputs = mode.outputs ?? {};
    const gotKeys = Object.keys(outputs).filter((k) => prompt[outputs[k]]);
    const wantKeys = expectedOutputs(toggles).filter((k) => k in outputs);
    const missingKeys = wantKeys.filter((k) => !gotKeys.includes(k));
    if (missingKeys.length) {
      bad(`${mode.id} ${label} 输出齐全`, `缺 ${missingKeys.join(",")}（实际 ${gotKeys.join(",")}）`);
    } else {
      ok(`${mode.id} ${label} 输出齐全`, gotKeys.join(","));
    }

    // ②b 输出链不能被空节点打断 / 不能多出空输出节点
    /**
     * ★★ 2026-10-23 新增，针对「忽略多组孤海」那个 bug
     *
     *   实测事故：v2 工作流里有 4 个 UI 占位节点在 /object_info 里
     *   output_node: true，却没有 inputs。ComfyUI 执行时【在它们那里就终止】，
     *   保存视频的节点（364）永远不跑。
     *   现象极具误导：任务 55 毫秒就「成功」，outputs 为空。
     *
     *   ⇒ 两条判据都要：
     *     ① 从每个输出节点向上追溯，链路必须完整（节点都在、没有空节点）
     *     ② prompt 里【不许有】除声明之外的、无输入的空节点
     *        —— 第一版只写了 ①，塞回那个空节点时仍全绿（假绿），
     *           因为它不在 364 的上游，追溯不到。
     */
    {
      /* ① 上游完整 */
      for (const outId of Object.values(mode.outputs ?? {})) {
        const root = String(outId);
        if (!prompt[root]) continue;     // 缺输出已在 ② 报过
        const seen = new Set();
        const stack = [root];
        const broken = [];
        while (stack.length) {
          const id = stack.pop();
          if (seen.has(id)) continue;
          seen.add(id);
          const node = prompt[id];
          if (!node) { broken.push(`${id}(缺失)`); continue; }
          const ins = Object.values(node.inputs ?? {});
          const linked = ins.filter((v) => Array.isArray(v) && typeof v[0] === "string");
          if (linked.length === 0 && ins.length === 0) {
            broken.push(`${id}(${node.class_type} 无任何输入)`);
            continue;
          }
          for (const v of linked) stack.push(String(v[0]));
        }
        if (broken.length) {
          bad(`${mode.id} ${label} 输出链完整`, `断了 ${broken.length} 处：${broken.slice(0, 4).join(",")}`);
        } else {
          ok(`${mode.id} ${label} 输出链完整`, `从 ${root} 上溯 ${seen.size} 个节点`);
        }
      }

      /* ② 不许有多余的空节点 */
      const emptyNodes = [];
      for (const [id, node] of Object.entries(prompt)) {
        const ins = Object.values(node.inputs ?? {});
        if (ins.length === 0) emptyNodes.push(`${id}(${node.class_type})`);
      }
      if (emptyNodes.length) {
        bad(`${mode.id} ${label} 无空节点`, `多余 ${emptyNodes.length} 个：${emptyNodes.slice(0, 4).join(",")}`);
      } else {
        ok(`${mode.id} ${label} 无空节点`);
      }
    }

    // ③ 该被删的节点真的没了
    const shouldBeGone = [];
    for (const name of toggleNames) {
      if (toggles[name]) continue;              // 开着就不删
      const del = mode.toggles?.[name]?.off?.delete ?? [];
      for (const id of del) shouldBeGone.push(String(id));
    }
    // 但一个节点可能被多个 toggle 保留（on.nodes），要排除
    const keptByOn = new Set();
    for (const name of toggleNames) {
      if (!toggles[name]) continue;
      for (const id of (mode.toggles?.[name]?.on?.nodes ?? [])) keptByOn.add(String(id));
    }
    const stillThere = [...new Set(shouldBeGone)]
      .filter((id) => prompt[id] && !keptByOn.has(id));
    if (stillThere.length) {
      bad(`${mode.id} ${label} 该删的都删了`, `还在：${stillThere.join(",")}`);
    } else {
      ok(`${mode.id} ${label} 该删的都删了`);
    }
  }
}

// ─── 汇总 ────────────────────────────────────────────────────────────

if (JSON_OUT) {
  console.log(JSON.stringify({ pass, fail, failures, totalCombos }, null, 2));
} else {
  console.log("\n" + "═".repeat(62));
  console.log(`  通过 ${pass} / ${pass + fail}   （共 ${totalCombos} 种开关组合）`);
  if (fail) {
    console.log(`  失败：${failures.slice(0, 10).join(" · ")}`);
    process.exit(1);
  }
  console.log("  toggle 组合静态重放验收全过");
}
