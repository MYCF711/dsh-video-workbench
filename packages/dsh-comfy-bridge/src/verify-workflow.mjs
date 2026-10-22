#!/usr/bin/env node
/**
 * API 工作流静态验证器 —— 不提交任务，只按 /object_info 逐节点核对。
 *
 *   node src/verify-workflow.mjs workflows\wuxi.json
 *   node src/verify-workflow.mjs <文件> --json
 *
 * 它回答一个问题：**这份 API 工作流会不会被 ComfyUI 拒？如果会，拒在哪。**
 *
 * 为什么要有它（实测教训，2026-10-16）：
 *   转换器丢 widget 值、指向不存在的节点、空串写进 COMBO ——
 *   这些错误的真实报错都很靠后（提交时、甚至执行中）。静态先查一遍，
 *   能把「一次提交换一条错误」变成「一次列出全部」。
 *
 * 它检查：
 *   ① 每个节点的 class_type 在实例上存在吗
 *   ② 必填输入齐不齐（连线算齐；widget 值算齐）
 *   ③ 连线指向的 node 存在吗（悬空连线）
 *   ④ COMBO 型输入的值在允许列表里吗
 *   ⑤ INT/FLOAT 型输入的值是不是数字（空串、多选默认值等会在这里露出来）
 *   ⑥ 有没有指向已删节点的引用
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("用法：node src/verify-workflow.mjs <API工作流.json> [--json]");
  process.exit(2);
}

const base = process.env.COMFY_BASE_URL || "http://127.0.0.1:8188";
const wf = JSON.parse(await readFile(resolve(file), "utf8"));

const entries = Object.entries(wf).filter(([k, v]) =>
  !k.startsWith("_") && v && typeof v === "object" && typeof v.class_type === "string");

if (!entries.length) {
  console.error("这不是 API 格式的工作流（顶层没有 class_type 节点）。");
  console.error("若是画布格式，先转：node src/convert-to-api.mjs <文件>");
  process.exit(1);
}

/**
 * 可以为空的「必填」类型。
 *
 * 实测（2026-10-16，Qwen-Image 2.1）：`TextEncodeQwenImage21.images` 在 schema 的
 * `required` 里，类型是 `COMFY_AUTOGROW_V3` —— 它是**自动增长的列表输入**，
 * 长度为 0 完全合法（文生图就是一张参考图都不给）。
 * ComfyUI 自己的校验对此返回 0 错，是本验证器把它当普通必填了。
 *
 * ⇒ 凡 schema 说必填、但类型是这类「可空容器」的，不按缺失报错。
 */
const NULLABLE_REQUIRED_TYPES = new Set([
  "COMFY_AUTOGROW_V3",
  "COMFY_DYNAMICCOMBO_V3",
]);

const ids = new Set(entries.map(([k]) => k));
const problems = [];
const notes = [];
const add = (kind, node, detail, hint) => problems.push({ kind, node, detail, hint });

/**
 * 已知缺件：为这些「引用 → 缺哪个文件」的组合降级为提醒而非错误。
 *
 * 为什么需要（2026-10-16）：本项目的做法是【bind 在运行时摘掉无来源的节点】，
 * 所以完整版工作流（`*-full.json`，含全部节点供开关切换）里必然残留这些引用。
 * 静态验证器若把它们算成错误，就会每次都在报告里躺着一条 —— 久了没人看，
 * 真正的错误也会被忽略。降级成提醒，并写明「bind 已处理」，信息更准。
 *
 * ⚠ 只列【已确认无公开来源】的，不是「看着不对就豁免」。
 */
const KNOWN_MISSING = new Map([
  ["Krea2-功能\\Krea2-亚洲hina_krea2Turbo_lora_tqd_v4.0.safetensors",
   "HF / civitai 全站搜不到，作者私有渠道才有。bind 的 loraChain 开关在开/关两种状态下都会摘掉 node 217。"],
]);

/**
 * 点号平铺的输入名：ComfyUI 里 autogrow / 复合输入会被平铺成
 *   `values.a`、`ref_images.ref_image_0`
 * 所以「必填名为 values」时，实际提供方是 `values.*`。
 * （实测：ComfyMathExpression 的 schema 说必填 `values: COMFY_AUTOGROW_V3`，
 *   而 API 里是 `values.a` —— 早期版本在这里误报「必填缺失」。）
 */
function hasInput(inputs, name) {
  if (inputs?.[name] !== undefined) return true;
  const prefix = name + ".";
  return Object.keys(inputs ?? {}).some((k) => k.startsWith(prefix));
}

/**
 * 不该按「COMBO 可选列表」判错的输入。
 *
 * `LoadImage.image` 是 COMBO，但它的选项来自【该实例的 input/ 目录文件列表】。
 * 主人的工作流用的是 ComfyUI 内部哈希文件名（如 `1135c54a….png`）——
 * 那是他自己上传过的图，不在当前 /object_info 报出的列表里属于正常
 * （列表只列当前目录内容，且哈希名可能是引用而非现存文件）。
 * 把它算作错误会造成 4 条误报，而误报会让人忽略真问题。
 */
const COMBO_LIST_NOT_AUTHORITATIVE = new Set([
  "LoadImage.image",
  "LoadAudio.audio",
  "VHS_LoadVideo.video",
  "LoadImageMask.image",
]);

// 建连线索引，供「哪些输入靠连线满足」判断
const linkedBy = new Map();
for (const [id, node] of entries) {
  for (const [k, v] of Object.entries(node.inputs ?? {})) {
    if (Array.isArray(v)) (linkedBy.get(id) ?? linkedBy.set(id, new Set()).get(id)).add(k);
  }
}

let schemaHits = 0;
for (const [id, node] of entries) {
  // ③ 悬空连线
  for (const [k, v] of Object.entries(node.inputs ?? {})) {
    if (Array.isArray(v) && !ids.has(String(v[0]))) {
      add("悬空连线", id, `${node.class_type}.${k} → 指向不存在的 node ${v[0]}`,
        "转换时上游被 BYPASS/MUTE 会这样；在 GUI 把上游改回 mode=0 再转，或从 bind 里提供素材");
    }
  }

  let schema;
  try {
    const res = await fetch(`${base}/object_info/${encodeURIComponent(node.class_type)}`);
    if (res.ok) schema = (await res.json())[node.class_type] ?? null;
  } catch { /* 下面按「查不到」处理 */ }

  if (!schema) {
    // ① 节点不存在
    add("节点不存在", id, `${node.class_type} 在本实例上查不到`,
      "该节点未安装，或工作流来自别的 ComfyUI 环境");
    continue;
  }
  schemaHits++;

  const linked = linkedBy.get(id) ?? new Set();
  const required = schema.input?.required ?? {};

  for (const [name, spec] of Object.entries(required)) {
    const t = spec?.[0];
    const cfg = spec?.[1] ?? {};
    const val = node.inputs?.[name];
    // autogrow / dynamiccombo 这类容器型「必填」允许为空（见 NULLABLE_REQUIRED_TYPES）
    if (typeof t === "string" && NULLABLE_REQUIRED_TYPES.has(t)) continue;
    const isLinkType = typeof t === "string" &&
      /^(MODEL|CLIP|VAE|LATENT|IMAGE|CONDITIONING|SIGMAS|SAMPLER|GUIDER|NOISE|AUDIO|VIDEO|MASK|CONTROL_?NET|COMFY_)/.test(t);

    // ② 必填缺失（认点号平铺）
    if (!hasInput(node.inputs, name) && !linked.has(name)) {
      add("必填缺失", id, `${node.class_type}.${name} 没有值也没连线`,
        isLinkType ? "这条输入必须由连线提供" : `schema 说它是必填（${Array.isArray(t) ? "COMBO" : t}），转换时可能丢了`);
      continue;
    }

    if (val === undefined) continue;

    // ⑤ 数值型写进了空串/非数字
    if (t === "INT" || t === "FLOAT") {
      if (typeof val === "string" && val.trim() === "") {
        add("值类型不对", id, `${node.class_type}.${name} 是 ${t}，但值是空串`,
          "转换对位错位或画布存了空串；应给数字");
      } else if (typeof val === "string" && Number.isNaN(Number(val))) {
        add("值类型不对", id, `${node.class_type}.${name} 是 ${t}，但值 ${JSON.stringify(val)} 不是数字`);
      }
    }

    // ④ COMBO 值不在允许列表（跳过「选项非权威」的那几个）
    if (Array.isArray(t) && !COMBO_LIST_NOT_AUTHORITATIVE.has(`${node.class_type}.${name}`)) {
      const options = t;
      const vals = Array.isArray(val) ? val : [val];
      for (const one of vals) {
        if (options.length && !options.includes(one)) {
          // 已知缺件降级为提醒（见文件顶部 KNOWN_MISSING 的说明）
          if (typeof one === "string" && KNOWN_MISSING.has(one)) {
            notes.push({ node: id, detail: `${node.class_type}.${name} 引用了 ${one}`, why: KNOWN_MISSING.get(one) });
            continue;
          }
          add("值不在可选列表", id,
            `${node.class_type}.${name} = ${JSON.stringify(one)} 不在 [${options.slice(0, 6).join(", ")}${options.length > 6 ? ", …" : ""}]`,
            "常见于转换时对位错位，把别的 widget 值塞进来了");
        }
      }
      if (cfg.multiselect === true && !Array.isArray(val)) {
        add("值类型不对", id, `${node.class_type}.${name} 是多选 COMBO，但值是标量 ${JSON.stringify(val)}`);
      }
    }
  }

  // 备注：可选输入里出现的空串也值得提示（H3 的 ref_image_size 曾收到 ''）
  for (const [name, spec] of Object.entries(schema.input?.optional ?? {})) {
    const t = spec?.[0];
    const val = node.inputs?.[name];
    if (val === "" && Array.isArray(t)) {
      add("值不在可选列表", id, `${node.class_type}.${name}（选填）收到空串，但它是 COMBO`,
        "空串不在允许列表里，会报 value_not_in_list");
    }
  }
}

const result = {
  file: resolve(file),
  comfyui: base,
  nodeCount: entries.length,
  schemaChecked: schemaHits,
  problemCount: problems.length,
  problems,
  notes,
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`工作流：${result.file}`);
  console.log(`节点数：${entries.length} ｜ 查到 schema：${schemaHits} ｜ 实例：${base}\n`);
  // 提醒（已知缺件等）—— 先打印，免得被错误列表淹没
  if (notes.length) {
    for (const n of notes) {
      console.log(`⚠ node ${n.node}: ${n.detail}`);
      console.log(`   ${n.why}`);
    }
    console.log("");
  }
  if (!problems.length) {
    console.log("✓ 静态检查全通过 —— 没有节点缺失、必填缺失、悬空连线或值类型问题。");
    console.log("  （这不等于能跑成功：执行期错误只有真提交才知道。）");
  } else {
    const byKind = {};
    for (const p of problems) (byKind[p.kind] ??= []).push(p);
    for (const [kind, list] of Object.entries(byKind)) {
      console.log(`✗ ${kind}（${list.length}）`);
      for (const p of list) {
        console.log(`   node ${p.node}: ${p.detail}`);
        if (p.hint) console.log(`       → ${p.hint}`);
      }
      console.log("");
    }
    console.log(`共 ${problems.length} 个问题。`);
  }
}

process.exit(problems.length ? 1 : 0);
