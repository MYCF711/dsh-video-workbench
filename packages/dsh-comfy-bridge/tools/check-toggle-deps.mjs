/**
 * toggle 依赖反查 —— 找「off.delete 删了某节点，但别处还有节点从它取输入」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个脚本
 *
 *   ComfyUI 的行为：某节点的输入指向一个【已被删除】的节点时，
 *   它不会报错，而是**静默跳过**这个节点和它的全部下游。
 *
 *   结果：status 仍是 success，不弹任何错误，只是少了几张图。
 *   实测（2026-10-18）：
 *     组合「二采关 + 高清重绘开」
 *       修好前  输出 = [202]        只有一采
 *       修好后  输出 = [202, 186]   一采 + 高清重绘
 *     两次都是 success。差别只在图存不存在。
 *
 *   这个模式在本项目出现过三次：
 *     ① loraChain 删 217/218，漏了 199.model
 *     ② secondPass 删 221..223，漏了 199.image
 *     ③ 系统性扫描时又找出 195/900/190 三处
 *   ⇒ 所以做成脚本，每次动 toggle 都跑。
 * ══════════════════════════════════════════════════════════════════════
 *
 * 用法：
 *   node tools\check-toggle-deps.mjs                     # 默认查 krea2
 *   node tools\check-toggle-deps.mjs krea2 qwen21-edit   # 查多个
 *   node tools\check-toggle-deps.mjs --verbose           # 打印全部依赖表
 *
 * 退出码：有未覆盖的依赖 → 1，否则 0。
 *
 * ★ 已知假阳性（脚本只能筛候选，必须人工再核一遍归属）：
 *   · 「自比自」：被删节点自己也依赖被删节点（如 176 ← 172，172 也在 delete 里）
 *     ⇒ 两者一起删，不算断链。
 *   ⇒ 脚本报出来的每条，都要问一句「这个节点在别的 toggle 里会不会也被删」。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF_DIR = path.resolve(HERE, "..", "workflows");

const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const modes = args.filter((a) => !a.startsWith("--"));
if (!modes.length) modes.push("krea2");

/** 读取 {mode}-full.json，返回 nodeId → [{from, via}] */
function buildDepTable(workflow) {
  const table = new Map();
  for (const [id, node] of Object.entries(workflow)) {
    const inputs = node?.inputs;
    if (!inputs || typeof inputs !== "object") continue;
    const list = [];
    for (const [via, val] of Object.entries(inputs)) {
      // 连线输入的形状是 [源节点id字符串, 输出索引数字]
      if (Array.isArray(val) && val.length === 2 && typeof val[0] === "string" && /^\d+$/.test(val[0])) {
        list.push({ from: val[0], via });
      }
    }
    if (list.length) table.set(String(id), list);
  }
  return table;
}

let totalIssues = 0;

for (const mode of modes) {
  const fullPath = path.join(WF_DIR, `${mode}-full.json`);
  const bindPath = path.join(WF_DIR, `${mode}.bind.json`);

  if (!fs.existsSync(fullPath)) {
    console.log(`\n[${mode}] 跳过：找不到 ${path.basename(fullPath)}`);
    continue;
  }
  if (!fs.existsSync(bindPath)) {
    console.log(`\n[${mode}] 跳过：找不到 ${path.basename(bindPath)}`);
    continue;
  }

  const workflow = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  const bind = JSON.parse(fs.readFileSync(bindPath, "utf8"));
  const deps = buildDepTable(workflow);

  console.log(`\n${"=".repeat(62)}`);
  console.log(`  ${mode}  ·  节点 ${Object.keys(workflow).length} 个，有连线的 ${deps.size} 个`);
  console.log("=".repeat(62));

  const toggles = bind.toggles ?? {};
  if (!Object.keys(toggles).length) {
    console.log("  （这个工作流没有 toggle）");
    continue;
  }

  // ★ always.delete 里的节点【永远】被删，不属于任何 toggle 的作用域。
  //   ★★ 2026-10-19 实测教训：第一版脚本没考虑这个，报了 2 条假阳性
  //      （176.image_a ← 187 / 176.image_b ← 172）。
  //      实际 176、172、175 都在 always.delete 里 —— 它们本来就不该存在，
  //      所以 seedvr 开关与它们无关。判断范围必须有这一层。
  const alwaysDel = new Set(bind.always?.delete ?? []);
  if (alwaysDel.size) {
    console.log(`\\n  （always.delete 永远删：${[...alwaysDel].join(",")}，不参与 toggle 判断）`);
  }

  for (const [name, spec] of Object.entries(toggles)) {
    const del = spec?.off?.delete ?? [];
    const rewire = spec?.off?.rewire ?? {};
    const rewiredIds = Object.keys(rewire);

    if (!del.length) {
      console.log(`\n  [${name}] 没有 off.delete，跳过`);
      continue;
    }

    console.log(`\n  [${name}] off.delete = ${del.join(",")}`);
    if (rewiredIds.length) console.log(`              rewire 已覆盖 = ${rewiredIds.join(",")}`);

    const issues = [];
    for (const [nodeId, edges] of deps) {
      if (del.includes(nodeId)) continue;        // 自己也删了，不算幸存节点
      if (alwaysDel.has(nodeId)) continue;       // ★ always.delete 的，永不存活
      for (const e of edges) {
        if (!del.includes(e.from)) continue;     // 来源没被删，没事
        if (alwaysDel.has(e.from)) continue;     // ★ 来源本来就被永久删了
        issues.push({
          node: nodeId,
          via: e.via,
          from: e.from,
          covered: rewiredIds.includes(nodeId),
          cls: workflow[nodeId]?.class_type ?? "?",
        });
      }
    }

    if (!issues.length) {
      console.log("      ✓ 没有幸存节点依赖被删项");
      continue;
    }

    for (const x of issues) {
      const mark = x.covered ? "✓ 已 rewire" : "★ 未覆盖";
      console.log(`      ${mark}  ${x.node}.${x.via} ← ${x.from}   (${x.cls})`);
      if (!x.covered) totalIssues += 1;
    }
  }

  if (VERBOSE) {
    console.log(`\n  ── 全部依赖表 ──`);
    for (const [id, edges] of [...deps.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(`    ${id}: ${edges.map((e) => `${e.via}←${e.from}`).join(", ")}`);
    }
  }
  // ── 附加检查：rewire 目标本身是否合法 ──────────────────────────
  //   ★ 只检查「有没有 rewire」不够。还得确认 rewire 到的地方靠得住：
  //     a) 目标节点存在
  //     b) 目标节点不会被任何 toggle / always 删掉
  //     c) 目标输入名在被改节点上真实存在
  //   2026-10-19 实测：208(VAEDecode←203 一采) 满足以上三条，用它接是安全的。

  const allDeleted = new Set(alwaysDel);
  for (const t of Object.values(toggles)) {
    for (const id of (t?.off?.delete ?? [])) allDeleted.add(String(id));
  }

  for (const [name, spec] of Object.entries(toggles)) {
    const rw = spec?.off?.rewire;
    if (!rw) continue;
    const problems = [];
    for (const [nodeId, inputs] of Object.entries(rw)) {
      const target = workflow[nodeId];
      if (!target) {
        problems.push(`rewire 里写的节点 ${nodeId} 在工作流里不存在`);
        continue;
      }
      for (const [inputName, src] of Object.entries(inputs ?? {})) {
        if (!target.inputs || !(inputName in target.inputs)) {
          problems.push(`节点 ${nodeId} 没有输入 "${inputName}"`);
        }
        const srcId = Array.isArray(src) ? String(src[0]) : null;
        if (!srcId) {
          problems.push(`${nodeId}.${inputName} 的来源格式不对（应是 ["节点id", 输出索引]）`);
          continue;
        }
        if (!workflow[srcId]) {
          problems.push(`${nodeId}.${inputName} 指向的 ${srcId} 不存在`);
        } else if (allDeleted.has(srcId)) {
          problems.push(
            `${nodeId}.${inputName} 指向 ${srcId}，但 ${srcId} 在某个 delete 列表里` +
            `（单开关没问题，跨开关组合时可能仍会断）`
          );
        }
      }
    }
    if (problems.length) {
      console.log(`\n  [${name}] rewire 合法性有问题：`);
      for (const p of problems) console.log(`      ★ ${p}`);
      totalIssues += problems.length;
    } else {
      console.log(`\n  [${name}] ✓ rewire 目标全部合法（节点存在 / 输入名对 / 不被删）`);
    }
  }
}


console.log(`\n${"=".repeat(62)}`);
if (totalIssues) {
  console.log(`  ★ ${totalIssues} 处未覆盖`);
  console.log("");
  console.log("  注意：以下情况是【假阳性】，人工确认后可忽略 ——");
  console.log("    · 该节点在【别的 toggle】的 off.delete 里（两者一起被删，不算断链）");
  console.log("    · 来源节点永不被删（如 LoadImage 的 187、VAEDecode 的一采 208）");
  console.log("");
  console.log("  修法：在对应 toggle 的 off.rewire 里加");
  console.log('    "节点id": { "输入名": ["替代来源id", 0] }');
  process.exit(1);
}
console.log("  ✓ 全部 toggle 的依赖都已覆盖");