/**
 * LoRA 多选织链验收。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么要这一套（2026-10-19）
 *
 *   主人要求：「krea2 里面的 lora 是不是应该弄一个下拉栏，
 *             里面放所有可用 lora，可以多选开启」
 *
 *   实现方式是在 buildPrompt() 的【末尾】动态织一条 LoraLoaderModelOnly 链，
 *   而不是用工作流里写死的 217/218 节点（那两个是作者的 Turbo + 亚洲人像，
 *   其中 217 的文件本机没有）。
 *
 *   ⇒ 动态织链的风险很高：接错位置会把整个模型链断开，
 *     而 ComfyUI 对断链的表现是【静默跳过下游节点】——
 *     status 仍是 success，只是没有图。
 *   ⇒ 所以必须有一份验收，把「链接对了」变成可自动检测的断言。
 *
 * ══════════════════════════════════════════════════════════════════════
 *
 * 检查项：
 *   ① 不传 loras 时行为与改动前完全一致（零侵入）
 *   ② 挂 N 个 LoRA 时真的产生 N 个 LoraLoaderModelOnly 节点
 *   ③ 它们串成链（第 2 个的 model 指向第 1 个，以此类推）
 *   ④ 链尾被 KSampler 消费（否则等于没挂）
 *   ⑤ 全表无断链
 *   ⑥ 边界输入不崩（[]、null、undefined、空 name、纯字符串数组）
 *   ⑦ 与已有的 loraChain 开关共存时不打架
 *
 * 用法：
 *   node verify-lora-chain.mjs
 *   node verify-lora-chain.mjs --json
 */

import { loadModes, buildPrompt } from "./src/workflows.mjs";

const JSON_OUT = process.argv.includes("--json");

let pass = 0;
let fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; if (!JSON_OUT) console.log(`  ✅ ${name}`); }
  else {
    fail++; failures.push(name);
    if (!JSON_OUT) console.log(`  ❌ ${name}${extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 160) : ""}`);
  }
}

const { modes } = await loadModes("./workflows");
const mode = modes.find((m) => m.id === "krea2");
if (!mode) {
  console.error("找不到 krea2 工作流");
  process.exit(1);
}

const R = { seed: () => 12345, rand: () => 99 };
const loraCt = (prompt) => Object.values(prompt).filter((n) => n.class_type === "LoraLoaderModelOnly");
const baseParams = () => ({
  prompt: "a red apple", steps: 8, steps2: 5,
  aspect: "1:1", megapixels: 1, batch: 1,
  toggles: { secondPass: true, redraw: false, loraChain: false, seedvr: false },
});

if (!JSON_OUT) {
  console.log("═".repeat(64));
  console.log("  LoRA 多选织链验收");
  console.log("═".repeat(64));
}

// ─── ① 零侵入 ────────────────────────────────────────────────
if (!JSON_OUT) console.log("\n① 不传 loras 时零侵入");
{
  const r = buildPrompt(mode, baseParams(), R);
  t("节点表非空", Object.keys(r.prompt).length > 0);
  t("没有 LoraLoaderModelOnly", loraCt(r.prompt).length === 0, loraCt(r.prompt).length);
  // 与「显式传空数组」必须完全一致
  const r2 = buildPrompt(mode, { ...baseParams(), loras: [] }, R);
  t("传 [] 与不传结果一致",
    JSON.stringify(Object.keys(r.prompt).sort()) === JSON.stringify(Object.keys(r2.prompt).sort()));
}

// ─── ② 数量正确 ──────────────────────────────────────────────
if (!JSON_OUT) console.log("\n② 挂 N 个就产生 N 个节点");
for (const n of [1, 2, 3, 5]) {
  const loras = Array.from({ length: n }, (_, i) => ({ name: `L${i}.safetensors`, strength: 1 }));
  const r = buildPrompt(mode, { ...baseParams(), loras }, R);
  t(`挂 ${n} 个 → ${n} 个 LoraLoaderModelOnly`, loraCt(r.prompt).length === n, loraCt(r.prompt).length);
}

// ─── ③ 串成链 ────────────────────────────────────────────────
if (!JSON_OUT) console.log("\n③ 串成链（每个的 model 指向前一个）");
{
  const loras = [
    { name: "A.safetensors", strength: 1 },
    { name: "B.safetensors", strength: 0.8 },
    { name: "C.safetensors", strength: 0.5 },
  ];
  const r = buildPrompt(mode, { ...baseParams(), loras }, R);
  const entries = Object.entries(r.prompt).filter(([, n]) => n.class_type === "LoraLoaderModelOnly");
  // 按 model 指向排序，还原链顺序
  const chain = [];
  let cur = entries.find(([, n]) => !entries.some(([id]) => id === String(n.inputs.model?.[0])));
  // 从「model 不指向任何 lora」的那个开始（链头，指向 UNETLoader）
  for (const [id, n] of entries) {
    const src = String(n.inputs.model?.[0] ?? "");
    if (!entries.some(([eid]) => eid === src)) { cur = [id, n]; break; }
  }
  let guard = 0;
  while (cur && guard++ < 10) {
    chain.push(cur);
    const wantNext = String(cur[0]);
    const next = entries.find(([, n]) => String(n.inputs.model?.[0]) === wantNext);
    cur = next;
  }
  t("链长度 = 3", chain.length === 3, chain.length);
  t("链头指向 UNETLoader(214)", String(chain[0]?.[1]?.inputs?.model?.[0]) === "214",
    chain[0]?.[1]?.inputs?.model);
  t("链顺序 = A→B→C",
    chain.map(([, n]) => n.inputs.lora_name).join(",") === "A.safetensors,B.safetensors,C.safetensors",
    chain.map(([, n]) => n.inputs.lora_name));
  t("强度被正确写入",
    chain[1]?.[1]?.inputs?.strength_model === 0.8 && chain[2]?.[1]?.inputs?.strength_model === 0.5,
    chain.map(([, n]) => n.inputs.strength_model));
}

// ─── ④ 链尾被 KSampler 消费 ──────────────────────────────────
if (!JSON_OUT) console.log("\n④ 链尾接进模型消费者");
{
  const r = buildPrompt(mode, {
    ...baseParams(),
    loras: [{ name: "X.safetensors", strength: 1 }],
  }, R);
  const entries = Object.entries(r.prompt).filter(([, n]) => n.class_type === "LoraLoaderModelOnly");
  const tailId = entries[0]?.[0];
  // 找所有把 model 指向 tailId 的节点
  const consumers = Object.entries(r.prompt).filter(([, n]) =>
    Object.entries(n.inputs ?? {}).some(([k, v]) => k === "model" && String(v?.[0]) === tailId)
  );
  t("链尾至少被 1 个节点消费", consumers.length >= 1, consumers.map(([id]) => id));
  t("其中一个必须是 KSampler", consumers.some(([, n]) => n.class_type === "KSampler"),
    consumers.map(([, n]) => n.class_type));
}

// ─── ⑤ 全表无断链 ────────────────────────────────────────────
if (!JSON_OUT) console.log("\n⑤ 全表无断链");
{
  for (const n of [1, 3]) {
    const loras = Array.from({ length: n }, (_, i) => ({ name: `L${i}.safetensors`, strength: 1 }));
    const r = buildPrompt(mode, { ...baseParams(), loras }, R);
    let broken = [];
    for (const [id, node] of Object.entries(r.prompt)) {
      for (const [k, v] of Object.entries(node.inputs ?? {})) {
        if (Array.isArray(v) && v.length === 2) {
          const src = String(v[0]);
          if (!r.prompt[src]) broken.push(`${id}.${k}→${src}`);
        }
      }
    }
    t(`挂 ${n} 个时无断链`, broken.length === 0, broken.slice(0, 5));
  }
}

// ─── ⑥ 边界输入 ──────────────────────────────────────────────
if (!JSON_OUT) console.log("\n⑥ 边界输入不崩");
{
  const cases = [
    ["loras=null", null],
    ["loras=undefined", undefined],
    ["loras=[]", []],
    ["loras 含空 name", [{ name: "" }]],
    ["loras 纯字符串数组", ["X.safetensors"]],
    ["loras 含 null 项", [null]],
    ["strength 非数字", [{ name: "Y.safetensors", strength: "abc" }]],
  ];
  for (const [label, val] of cases) {
    let ok = true, nodeCt = 0;
    try {
      const r = buildPrompt(mode, { ...baseParams(), loras: val }, R);
      nodeCt = Object.keys(r.prompt).length;
    } catch (e) { ok = false; }
    t(`${label} 不抛错`, ok);
    if (ok) t(`${label} 产出合法节点表`, nodeCt > 0, nodeCt);
  }
}

// ─── ⑦ 与 loraChain 开关共存 ────────────────────────────────
if (!JSON_OUT) console.log("\n⑦ 与 loraChain 开关共存");
{
  // loraChain 开关打开时，工作流自带 218 节点（作者的 Turbo LoRA）
  const r = buildPrompt(mode, {
    ...baseParams(),
    toggles: { ...baseParams().toggles, loraChain: true },
    loras: [{ name: "Mine.safetensors", strength: 1 }],
  }, R);
  const entries = Object.entries(r.prompt).filter(([, n]) => n.class_type === "LoraLoaderModelOnly");
  t("总数为 2（自带的 218 + 用户选的 1 个）", entries.length === 2, entries.map(([id]) => id));
  // 用户的应该挂在链尾
  const mine = entries.find(([, n]) => n.inputs.lora_name === "Mine.safetensors");
  t("用户选的在自己的 LoRA 在表里", !!mine);
  if (mine) {
    t("它指向作者的 218（续接而不是覆盖）", String(mine[1].inputs.model?.[0]) === "218",
      mine[1].inputs.model);
  }
  // 仍然无断链
  let broken = 0;
  for (const [id, node] of Object.entries(r.prompt)) {
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (Array.isArray(v) && v.length === 2 && !r.prompt[String(v[0])]) broken++;
    }
  }
  t("共存时无断链", broken === 0, broken);
}

// ─── 汇总 ────────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(JSON.stringify({ pass, fail, failures }, null, 2));
} else {
  console.log("\n" + "═".repeat(64));
  console.log(`  通过 ${pass} / ${pass + fail}`);
}
if (fail) {
  if (!JSON_OUT) console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
if (!JSON_OUT) console.log("  LoRA 多选织链验收全过");
