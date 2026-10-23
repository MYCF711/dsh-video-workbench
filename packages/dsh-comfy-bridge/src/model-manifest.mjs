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
/**
 * 从工作流 JSON 递归收集模型引用。
 *
 * ★★ 2026-10-23 改：连【字段名】一起收集
 *
 *   为什么要字段名：分类要靠它。
 *   实测同一个文件名在不同工作流里可能挂在不同加载器上，
 *   而字段名（lora_name / unet_name / vae_name …）就是 ComfyUI 的加载器输入名，
 *   比按文件名猜准得多 —— 第一版按名字猜把 7 个 LoRA 归进了「主模型」。
 *
 * @param {object} obj
 * @param {Map<string, Set<string>>} out  文件名 → 出现它的字段名集合
 * @param {string} fieldName
 */
export function collectModelRefs(obj, out = new Map(), fieldName = "") {
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
      if (!out.has(s)) out.set(s, new Set());
      if (fieldName) out.get(s).add(fieldName);
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
/**
 * 读一个目录下所有 .json 工作流，收集模型引用。
 *
 * @returns {Map<string, {workflows:Set<string>, fields:Set<string>}>}
 *   文件名 → 用于哪些工作流 + 挂在哪些加载器字段上
 */
export function collectFromDir(dir) {
  const refs = new Map();
  if (!existsSync(dir)) return refs;

  let names = [];
  try { names = readdirSync(dir); } catch { return refs; }

  for (const n of names) {
    /* 只读工作流本体，不读 .bind.json（那是我们的绑定数据） */
    if (!/\.json$/i.test(n) || /\.bind\.json$/i.test(n)) continue;
    const p = path.join(dir, n);
    let j;
    try { j = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    /* collectModelRefs 现在返回 Map<文件名, Set<字段名>> */
    const perFile = collectModelRefs(j, new Map());
    for (const [f, fields] of perFile) {
      if (!refs.has(f)) refs.set(f, { workflows: new Set(), fields: new Set() });
      const rec = refs.get(f);
      rec.workflows.add(n);
      for (const fl of fields) rec.fields.add(fl);
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

/**
 * 本地扫描 models 目录，收集所有模型文件名。
 *
 * ★★ 2026-10-23 新增：ComfyUI 未启动时的兜底
 *
 *   /object_info 是权威的（它知道 extra_model_paths.yaml 展开后的完整列表），
 *   但 ComfyUI 没开时拿不到 ⇒ 只能报 unknown。
 *   而用户最常问的恰恰是「我装完模型了，齐了吗」——
 *   这时 ComfyUI 可能还没启动。
 *
 *   ⇒ 用用户填的「模型放置目录」做一次本地扫描。
 *     扫到的算「已找到」，扫不到的仍标 unknown（不是「缺失」）——
 *     因为自定义目录可能不在 modelsDir 下，扫不到不代表没有。
 *
 * @returns {Set<string>|null} null = 目录不可读（无法判断）
 */
export function scanModelsDir(modelsDir, { maxDepth = 4, maxFiles = 20000 } = {}) {
  if (!modelsDir || !existsSync(modelsDir)) return null;
  const found = new Set();
  let count = 0;

  const walk = (dir, depth) => {
    if (depth > maxDepth || count >= maxFiles) return;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (count >= maxFiles) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile()) {
        count += 1;
        if (MODEL_EXT.test(e.name)) {
          /**
           * ★ 只存 basename，不存相对路径。
           *   因为工作流里引用的是 "Krea2\Krea2-xxx.safetensors"，
           *   而 /object_info 返回的也可能是带子目录的相对路径。
           *   用 basename 比对能同时匹配两种，代价是不同子目录的同名文件会混淆
           *   —— 那种情况极少，且用户自己也知道放重了。
           */
          found.add(e.name);
        }
      }
    }
  };
  walk(modelsDir, 0);
  return found;
}

/**
 * 模型作用分类（2026-10-23 主人要求）
 *
 *   主人：「然后还要根据模型作用分类吧？」「你现在弄一起，看起来也看不懂」
 *
 * ★★ 判据：用【工作流的字段名】分类，不是用文件名猜
 *
 *   实测 26 个模型的工作流字段（2026-10-23，从 workflows/*.json 提取）：
 *     lora_name         → LoRA            （7 个）
 *     unet_name         → 扩散主模型      （5 个）
 *     clip_name         → 文本编码器      （5 个）
 *     vae_name          → VAE             （4 个）
 *     tiny_vae          → VAE（小）       （1 个）
 *     upscaler_model    → 放大            （1 个）
 *     model_name        → 放大/超分       （1 个 OmniSR）
 *
 *   我第一版按文件名猜，结果 7 个 LoRA（H3_Combat_V2 等）被归进「主模型」，
 *   taeh3.safetensors 也是（它是 tiny_vae）。字段名一次就判对了。
 *
 *   ⇒ 分类优先级：
 *     ① 字段名（权威 —— 它就是 ComfyUI 那个加载器节点的实际输入名）
 *     ② 文件名关键字（字段名没传进来时的兜底）
 *     ③ 都没有 ⇒ "other" 并明确标出，不硬塞
 */
const FIELD_ROLE = {
  lora_name: "lora",
  lora_name_2: "lora",
  unet_name: "unet",
  diffusion_model: "unet",
  ckpt_name: "main",
  clip_name: "textEncoder",
  clip_name1: "textEncoder",
  clip_name2: "textEncoder",
  text_encoder: "textEncoder",
  vae_name: "vae",
  tiny_vae: "vae",
  clip_vision_name: "clipVision",
  control_net_name: "controlnet",
  upscaler_model: "upscale",
  model_name: "upscale",   /* 实测 OmniSR 用的是 model_name */
};

const ROLE_META = {
  lora:        { label: "LoRA（风格/角色/动作增强）", dir: "models/loras" },
  vae:         { label: "VAE（解码器）",              dir: "models/vae" },
  textEncoder: { label: "文本 / 视觉编码器",           dir: "models/text_encoders 或 models/clip" },
  clipVision:  { label: "CLIP Vision",               dir: "models/clip_vision" },
  controlnet:  { label: "ControlNet",                dir: "models/controlnet" },
  upscale:     { label: "放大 / 超分",                 dir: "models/upscale_models" },
  unet:        { label: "扩散主模型（UNet / DiT）",     dir: "models/diffusion_models 或 models/unet" },
  main:        { label: "主模型（checkpoint 整套）",    dir: "models/checkpoints" },
  other:       { label: "未分类（判不出来）",           dir: "看工作流里它接在哪个加载器上" },
};

/** 文件名兜底规则（字段名缺失时才用）。 */
const NAME_RULES = [
  { role: "lora",        test: (n) => /lora/i.test(n) },
  { role: "vae",         test: (n) => /(^|[_\-.\\/])vae([_\-.\/]|$)/i.test(n) || /_vae_/i.test(n) },
  { role: "textEncoder", test: (n) => /(text_?encoder|t5|umt5|clip_l|clip_g|qwen3vl|qwen3\.5|llava)/i.test(n) },
  { role: "clipVision",  test: (n) => /clip_?vision/i.test(n) },
  { role: "controlnet",  test: (n) => /control_?net/i.test(n) },
  { role: "upscale",     test: (n) => /(upscale|esrgan|swinir|omnisr|seedvr|real_?esrgan)/i.test(n) },
  { role: "unet",        test: (n) => /(unet|diffusion_?model)/i.test(n) },
  { role: "main",        test: (n) => /\.(ckpt|safetensors|gguf)$/i.test(n) },
];

/**
 * 判一个模型属于哪一类。
 *
 * @param {string} filename
 * @param {string[]} [fields]  工作流里出现它的字段名（权威依据）
 * @returns {{role:string, label:string, dir:string, byField:string|null}}
 */
export function classifyModel(filename, fields = []) {
  /* ① 字段名优先 —— 有多个字段时取第一个能认出来的 */
  for (const f of fields) {
    const role = FIELD_ROLE[f];
    if (role) {
      const meta = ROLE_META[role] ?? ROLE_META.other;
      return { role, label: meta.label, dir: meta.dir, byField: f };
    }
  }
  /* ② 文件名兜底 */
  for (const r of NAME_RULES) {
    if (r.test(String(filename))) {
      const meta = ROLE_META[r.role];
      return { role: r.role, label: meta.label, dir: meta.dir, byField: null };
    }
  }
  /* ③ 判不出来 —— 明确标出，不硬塞 */
  return { role: "other", label: ROLE_META.other.label, dir: ROLE_META.other.dir, byField: null };
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
export async function buildModelManifest({ workflowsDir, base, modelsDir = null }) {
  const refs = collectFromDir(workflowsDir);
  const known = base ? await fetchKnownModels(base) : null;
  /**
   * ★ 本地兜底（2026-10-23）：ComfyUI 给不出答案时，扫用户填的模型目录。
   *   - known 有值 ⇒ 以它为准（权威）
   *   - known 为 null 但本地扫到了 ⇒ 用本地结果判「已找到」，扫不到的标 unknown
   *     （不标「缺失」，因为自定义目录可能不在 modelsDir 下）
   */
  const localFiles = known === null ? scanModelsDir(modelsDir) : null;

  /**
   * ★ 比对时用 basename —— 工作流里的引用可能带子目录
   *   （如 "Krea2\Krea2-moodyKrea2Mix_v8_int8_convrot.safetensors"），
   *   而 known 里两种形式都可能有。用 basename 比对覆盖面最广。
   */
  const baseName = (s) => String(s).split(/[\\/]/).pop();

  const knownBase = known
    ? new Set([...known].map(baseName))
    : null;
  const localBase = localFiles
    ? new Set([...localFiles].map(baseName))
    : null;

  const items = [];
  for (const [name, rec] of refs) {
    const usedBy = rec?.workflows ?? new Set();
    const fields = [...(rec?.fields ?? new Set())];
    const bn = baseName(name);
    let found;
    let sourceOfTruth = null;
    if (knownBase) {
      found = knownBase.has(bn);
      sourceOfTruth = "comfyui";
    } else if (localBase) {
      /**
       * 本地扫描只能证明「在」，不能证明「不在」——
       * 所以只在命中时判 true，未命中保持 null（unknown）。
       */
      found = localBase.has(bn) ? true : null;
      sourceOfTruth = "local";
    } else {
      found = null;
    }

    items.push({
      name,
      found,
      /**
       * ★ found 为 null 时说明「判断不了」，不是「缺失」。
       *   前端必须区分这两种，否则会把「ComfyUI 没开」误报成「缺模型」。
       */
      unknown: found === null,
      sourceOfTruth,
      /* ★ 2026-10-23：按作用分类（优先用工作流字段名），供前端分组显示 */
      ...classifyModel(name, fields),
      workflows: [...usedBy],
      note: `用于：${[...usedBy].join("、")}${
        found === false
          ? ` · 应放到 ${subdirHint(name)}`
          : found === null && localBase
            ? ` · 本地目录里没扫到（可能放在别处），应放到 ${subdirHint(name)}`
            : ""
      }`,
      sizeText: null,
    });
  }

  /**
   * 排序（2026-10-23 改：按作用分组排在前面）
   *
   *   主人：「根据模型作用分类吧」「你现在弄一起，看起来也看不懂」
   *
   *   主排序：作用分类的顺序（lora → vae → 编码器 → 放大 → 主模型 → 未分类）
   *   次排序：同组内缺失的在前，再按名字
   */
  const ROLE_ORDER = ["lora", "vae", "textEncoder", "clipVision", "controlnet", "upscale", "unet", "main", "other"];
  const rank = (r) => {
    const i = ROLE_ORDER.indexOf(r);
    return i < 0 ? ROLE_ORDER.length : i;
  };
  items.sort((a, b) => {
    const ra = rank(a.role);
    const rb = rank(b.role);
    if (ra !== rb) return ra - rb;
    if (a.found === b.found) return a.name.localeCompare(b.name);
    if (a.found === false) return -1;
    if (b.found === false) return 1;
    return 0;
  });

  /**
   * ★ 分组汇总：前端直接渲染，不用自己算。
   *   files = 该组里的模型名（用于「这个组缺几个」的直观展示）
   */
  const groups = [];
  const byRole = new Map();
  for (const it of items) {
    if (!byRole.has(it.role)) {
      byRole.set(it.role, {
        role: it.role,
        label: it.label,
        dir: it.dir,
        items: [],
        found: 0,
        missing: 0,
        unknownCnt: 0,
      });
    }
    const g = byRole.get(it.role);
    g.items.push(it);
    if (it.found === true) g.found += 1;
    else if (it.found === false) g.missing += 1;
    else g.unknownCnt += 1;
  }
  for (const r of ROLE_ORDER) {
    if (byRole.has(r)) groups.push(byRole.get(r));
  }

  return {
    items,
    groups,
    unknown: known === null,
    total: items.length,
    /** 需要用户处理的（缺失）总数 —— 前端据此决定是否标红 */
    missingTotal: items.filter((x) => x.found === false).length,
  };
}
