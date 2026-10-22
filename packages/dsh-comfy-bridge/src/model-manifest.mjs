/**
 * 模型需求清单（2026-10-23）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要
 *
 *   新机器装好 ComfyUI 后，工作流跑不起来最常见的原因是缺模型。
 *   而缺模型时 ComfyUI 只报「找不到 xxx.safetensors」——
 *   用户不知道去哪下、放在哪个子目录。
 *
 *   ⇒ 从工作流 JSON 里把所有模型文件名反推出来，
 *     逐个检查它在 ComfyUI 的 models/ 下是否存在，
 *     缺失的给出「应该放哪」的提示。
 *
 * ── 怎么反推
 *   遍历工作流 JSON 的每个节点 inputs，认出「值看起来像模型文件」的那些：
 *     · 以 .safetensors / .ckpt / .pt / .pth / .bin / .gguf / .onnx 结尾
 *     · 或者出现在已知的模型字段名上（ckpt_name / lora_name / model_name …）
 *
 *   ★ 为什么两种判据都要：
 *     只看扩展名会漏掉不带扩展名的（少数自定义节点）；
 *     只看字段名会漏掉新节点的字段（工作流是运行时输入，节点会变）。
 *     两者取并集，宁可多列。
 *
 * ── 怎么判断「已找到」
 *   用 ComfyUI 自己的 API：GET /object_info
 *   里面每个加载器节点都有 *_name 的合法值列表。
 *   ⇒ 直接问 ComfyUI「你认得这个文件名吗」，比猜路径可靠得多。
 *     （猜路径要处理 extra_model_paths.yaml 的多目录，必错。）
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** 模型文件扩展名。 */
const MODEL_EXT = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|sft)$/i;

/**
 * 已知的「这个字段的值是模型文件名」的字段名。
 * ★ 只作辅助判据，主判据是扩展名。
 */
const MODEL_FIELDS = new Set([
  "ckpt_name", "lora_name", "model_name", "vae_name",
  "control_net_name", "clip_name", "unet_name", "upscale_model",
  "style_model_name", "gligen_name", "hypernetwork_name",
  "filename",   // 某些自定义节点用这个（要配合扩展名判据）
]);

/** 从工作流 JSON 递归收集模型文件名。 */
export function collectModelRefs(obj, out = new Set(), fieldName = "") {
  if (obj == null) return out;

  if (typeof obj === "string") {
    const s = obj.trim();
    if (!s) return out;
    /* 主判据：扩展名；辅助判据：字段名 + 有扩展名感 */
    if (MODEL_EXT.test(s) || (MODEL_FIELDS.has(fieldName) && /\.[a-z0-9]{2,6}$/i.test(s))) {
      /**
       * ★ 排除明显的非模型文件：
       *   · ComfyUI 的临时预览图（rgthree.compare._temp_*.png）
       *   · URL / base64
       */
      if (/^https?:/i.test(s) || /^data:/i.test(s)) return out;
      if (/\.(png|jpe?g|webp|gif|mp4|webm|mov|wav|mp3|m4a|flac|srt)$/i.test(s)) return out;
      out.add(s);
    }
    return out;
  }

  if (Array.isArray(obj)) {
    for (const v of obj) collectModelRefs(v, out, fieldName);
    return out;
  }

  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) collectModelRefs(v, out, k);
    return out;
  }

  return out;
}

/** 读一个目录下所有 .json 工作流，收集模型引用。 */
export function collectFromDir(dir) {
  const refs = new Map();   // filename -> Set<workflowName>
  if (!existsSync(dir)) return refs;

  let names = [];
  try { names = readdirSync(dir); } catch { return refs; }

  for (const n of names) {
    /* 只读工作流本体，不读 .bind.json（那是我们的绑定数据） */
    if (!/\.json$/i.test(n) || /\.bind\.json$/i.test(n)) continue;
    const p = path.join(dir, n);
    let j;
    try { j = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    const set = new Set();
    collectModelRefs(j, set);
    for (const f of set) {
      if (!refs.has(f)) refs.set(f, new Set());
      refs.get(f).add(n);
    }
  }
  return refs;
}

/**
 * 问 ComfyUI「你认得哪些模型文件名」。
 *
 * ★ 用 /object_info 而不是扫描磁盘：
 *   extra_model_paths.yaml 可以让模型散落在多个目录，
 *   自己扫必然不全。而 /object_info 是 ComfyUI 自己列出的合法值，
 *   与它实际能加载的完全一致。
 *
 * @returns {Promise<Set<string>|null>} null 表示 ComfyUI 不可用（无法判断，不误报缺失）
 */
export async function fetchKnownModels(base, timeoutMs = 6000) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(`${String(base).replace(/\/+$/, "")}/object_info`, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const info = await res.json();

    const known = new Set();
    for (const node of Object.values(info ?? {})) {
      const input = node?.input;
      if (!input) continue;
      for (const group of [input.required, input.optional]) {
        if (!group) continue;
        for (const spec of Object.values(group)) {
          /* 形如 [ [ "a.safetensors", "b.safetensors" ], {} ] */
          const list = Array.isArray(spec) ? spec[0] : null;
          if (Array.isArray(list)) {
            for (const v of list) if (typeof v === "string") known.add(v);
          }
        }
      }
    }
    return known;
  } catch {
    return null;
  }
}

/** 按扩展名给「应该放哪个 models 子目录」的提示。 */
function subdirHint(filename) {
  const low = filename.toLowerCase();
  if (/lora/i.test(low)) return "models/loras";
  if (/vae/i.test(low)) return "models/vae";
  if (/controlnet|control_net/i.test(low)) return "models/controlnet";
  if (/upscale|esrgan|swinir/i.test(low)) return "models/upscale_models";
  if (/clip_vision|clipvision/i.test(low)) return "models/clip_vision";
  if (/text_encoder|t5|clip_l|umt5/i.test(low)) return "models/text_encoders 或 models/clip";
  if (/unet|diffusion_model/i.test(low)) return "models/diffusion_models 或 models/unet";
  if (/\.(gguf)$/i.test(low)) return "models/diffusion_models（GGUF）";
  if (/\.(ckpt)$/i.test(low)) return "models/checkpoints";
  return "models/checkpoints 或对应子目录（看工作流里是哪个加载器）";
}

/**
 * 生成清单。
 *
 * @param {object} opts
 * @param {string} opts.workflowsDir
 * @param {string} [opts.base]        ComfyUI 地址（用来 fetchKnownModels）
 * @returns {Promise<{items:Array, unknown:boolean}>}
 *   unknown = true 表示 ComfyUI 不可用，无法判断存在性（此时 found 全为 null，不误报）
 */
export async function buildModelManifest({ workflowsDir, base }) {
  const refs = collectFromDir(workflowsDir);
  const known = base ? await fetchKnownModels(base) : null;

  const items = [];
  for (const [name, usedBy] of refs) {
    const found = known ? known.has(name) : null;
    items.push({
      name,
      found,
      /**
       * ★ found 为 null 时说明「判断不了」，不是「缺失」。
       *   前端必须区分这两种，否则会把「ComfyUI 没开」误报成「缺模型」。
       */
      unknown: found === null,
      note: `用于：${[...usedBy].join("、")}${found === false ? ` · 应放到 ${subdirHint(name)}` : ""}`,
      sizeText: null,
    });
  }

  /* 缺失的排前面 —— 用户最需要先看到的 */
  items.sort((a, b) => {
    if (a.found === b.found) return a.name.localeCompare(b.name);
    if (a.found === false) return -1;
    if (b.found === false) return 1;
    return 0;
  });

  return { items, unknown: known === null, total: items.length };
}
