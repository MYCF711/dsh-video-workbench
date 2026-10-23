/**
 * ComfyUI UI 导出格式 → API 格式转换器
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个
 *
 *   从网盘/社群拿到的 ComfyUI 工作流多半是【UI 导出格式】：
 *     { nodes: [...], links: [...], groups: [...], extra: {...} }
 *   而 POST /prompt 要求的是【API 格式】：
 *     { "36": { class_type, inputs: {...} }, ... }
 *
 *   两者结构完全不同：UI 格式里节点有 pos/size/widgets_values，
 *   连线在顶层 links 数组里用 link id 关联。
 *
 * ── 转换要处理的四类「虚拟节点」
 *   Reroute          —— 纯转接，要消掉，把上下游直接连起来
 *   SetNode/GetNode  —— 按「变量名」配对，消掉
 *   PrimitiveNode    —— 字面量来源，值要并进下游的 inputs
 *   Note/其他无输出    —— 直接丢
 *
 * ── 参数值的来源
 *   widgets_values 是数组，顺序由节点的 INPUT_TYPES 决定。
 *   ★ 我们无法在这里拿到每个节点的 INPUT_TYPES（那要 ComfyUI 在线且逐个查），
 *     所以采用【按已知节点类型的硬编码映射表 + 兜底顺序】。
 *     兜底顺序 = widgets_values 直接按 index 对应常见字段名，
 *     这是不完美但可用的近似。
 *
 *   ★ 更可靠的做法是问 ComfyUI /object_info 拿每个节点的 input 顺序。
 *     本文件提供 buildWidgetNames() 从 live /object_info 取；
 *     取不到才用硬编码表。
 */

/**
 * 从 /object_info 取一个节点的 widget 字段顺序。
 *
 * ★★ 2026-10-23 关键修正：必须用 input_order，不能用 key 顺序
 *
 *   实测 SelfLiftH3Sampler：
 *     /object_info 里 required 的 key 顺序是
 *       model, positive, negative, vae, latent_image, sampler, sigmas,
 *       seed, cfg, transition_step, lowres_scale, rho, w_min, w_max, upscaler_model
 *     但 widgets_values 的实际顺序（UI 里从上到下）是
 *       upscaler_model, upscaler_unload, highres_tiling, scale?, steps?, cfg, seed
 *     ⇒ 按 key 顺序硬对会全错：我把 upscaler_model 对成了 widgets[0] 的数组下标，
 *       把 cfg 对成了 1（实际是 6），seed 对成了 0.6（那是 scale）。
 *
 *   /object_info 里有 input_order 字段，它才是 UI 上 widget 的真实排列顺序。
 *   取不到 input_order 时才退回「按 required 的 key 顺序」。
 *
 * ★ 另一个坑：只有【widget 类型】（INT/FLOAT/STRING/BOOLEAN/下拉）才出现在
 *   widgets_values 里；连线类型（MODEL/CONDITIONING/LATENT/VAE/SAMPLER/SIGMAS/IMAGE…）
 *   不占 widgets_values 的位置。必须按类型过滤。
 */
/**
 * widget 类型判定。
 *
 * ★★ 2026-10-23 补：COMBO / 动态下拉也占 widgets_values 的位
 *
 *   实测 BlockSparseAttention.selection 的类型是 COMFY_DYNAMICCOMBO_V3，
 *   它的值 "sol-attn" 就在 widgets_values[0]。
 *   第一版只认 INT/FLOAT/STRING/BOOLEAN/COMBO，把它漏了 ⇒ 整体错位。
 *
 *   判据：类型名里带 COMBO 的都算（COMBO / COMFY_DYNAMICCOMBO_V3 / …），
 *         以及 spec[0] 直接是数组（老式下拉）。
 */
const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);

function isWidgetSpec(spec) {
  if (!Array.isArray(spec)) return false;
  const t = spec[0];
  /* 下拉：spec[0] 是数组（老式写法） */
  if (Array.isArray(t)) return true;
  if (typeof t !== "string") return false;
  if (WIDGET_TYPES.has(t)) return true;
  /* 动态下拉：COMFY_DYNAMICCOMBO_V3 之类 */
  if (/COMBO/i.test(t)) return true;
  return false;
}

/**
 * 从节点的 inputs 数组推断 widgets_values 的字段顺序。
 *
 * ★★ 2026-10-23 第三次修正：这才是唯一可靠的判据
 *
 *   UI 导出的每个节点都带 `inputs` 数组，里面的项分两类：
 *     · link !== null  → 连线输入（值来自上游节点）
 *     · link === null  → **widget 输入**（值在 widgets_values 里）
 *   而 `inputs` 数组的顺序【就是 UI 上从上到下的顺序】。
 *
 *   实测 SelfLiftH3Sampler：
 *     inputs 未连线顺序 = seed, cfg, transition_step, lowres_scale, rho,
 *                          w_min, w_max, upscaler_model, highres_tiling, upscaler_unload
 *     widgets_values    = [29732110694208, "randomize", 1, 6, 0.6, 0, 0.5, 1,
 *                          "minimax_h3_latent_upscaler_3d_fp16_V2.safetensors", false, true]
 *   ⇒ 一一对应后：seed=29732110694208, cfg="randomize", …
 *     仍然错一位，因为 seed 后面多一个 "randomize"（control_after_generate）。
 *
 *   ⇒ 规则：某个 widget 字段在 /object_info 里带 control_after_generate:true 时，
 *     widgets_values 里它后面紧跟着一个控制值，要跳过。
 *     这与 KNOWN_WIDGETS 里 KSampler 的 ["seed","control_after_generate",...] 是同一件事。
 *
 * @returns {string[]|null} 字段名序列（长度 = widgets_values 应有的长度）
 */
/**
 * 从节点的 inputs 数组 + /object_info 推断 widgets_values 的字段顺序。
 *
 * ★★ 2026-10-23 第五次修正 —— 这是最终版，前面四版都错
 *
 * ── 关键事实（实测 265 MiniMaxH3ReferenceToVideo）
 *
 *   widgets_values = ["", 1344, 768, 124, "match"]     ← 5 个
 *   inputs 里：
 *     width         link=483   ← 【有连线】但它仍占 widgets 位
 *     height        link=484   ← 同上
 *     length        link=485   ← 同上
 *     ref_video_audio_0 link=  ← 没连线，但它是连线类型，【不占】widget 位
 *     ref_image_size    link=  ← 没连线，widget 类型
 *
 *   ⇒ 只看 link===null 得到 ["ref_video_audio_0","ref_image_size"]（2 个），
 *     而 widgets_values 有 5 个 ⇒ 整体错位，ref_image_size 拿到了 1344。
 *
 *   ⇒ 正确判据：**widget 类型的字段都占位，不管它有没有连线**。
 *     连线只决定「值从哪来」（上游 or widgets_values），不决定「占不占位」。
 *     非 widget 类型（MODEL/CONDITIONING/LATENT/VAE/IMAGE…）不占位。
 *
 * ── 顺序来源
 *   node.inputs 的排列顺序就是 UI 上的顺序。但 /object_info 的 input_order
 *   才是权威。两者不一致时以 inputs 为准（因为 widgets_values 是 UI 写出来的）。
 */
function widgetNamesFromNode(node, spec) {
  const ins = Array.isArray(node?.inputs) ? node.inputs : null;
  if (!ins) return null;

  const req = spec?.input?.required ?? {};
  const opt = spec?.input?.optional ?? {};
  const lookup = (name) => {
    /* 子对象输入形如 "ref_images.ref_image_0"，取顶层名再找 */
    if (req[name] ?? opt[name]) return req[name] ?? opt[name];
    const top = name.split(".")[0];
    return req[top] ?? opt[top];
  };

  const widgets = ins.filter((x) => {
    const s = lookup(x.name);
    /* ★ 拿不到定义时保守跳过 —— 宁可少一个也别错位 */
    if (!s) return false;
    return isWidgetSpec(s);
  }).map((x) => x.name);

  if (!widgets.length) return null;

  const out = [];
  for (const name of widgets) {
    out.push(name);
    const s = lookup(name);
    const opts = Array.isArray(s) ? s[1] : null;
    /* control_after_generate：widgets_values 里紧跟一个控制值 */
    if (opts && opts.control_after_generate) out.push("control_after_generate");
  }
  return out;
}

/** 按 /object_info 取出「widget 字段名」的排列顺序（旧路径，作兜底）。 */
function widgetNamesFromObjectInfo(spec) {
  if (!spec) return null;
  const req = spec.input?.required ?? {};
  const opt = spec.input?.optional ?? {};
  const order = Array.isArray(spec.input_order)
    ? spec.input_order
    : null;

  const all = { ...req, ...opt };
  const names = order ?? Object.keys(all);
  const out = [];
  for (const name of names) {
    const s = all[name];
    if (!isWidgetSpec(s)) continue;
    if (name === "upload") { out.push(name); continue; }
    out.push(name);
  }
  return out.length ? out : null;
}

/** 已知节点的 widgets_values 字段顺序（来自 ComfyUI 常见节点）。 */
const KNOWN_WIDGETS = {
  CheckpointLoaderSimple: ["ckpt_name"],
  UNETLoader: ["unet_name", "weight_dtype"],
  CLIPLoader: ["clip_name", "type", "device"],
  VAELoader: ["vae_name"],
  LoraLoaderModelOnly: ["lora_name", "strength_model"],
  LoadImage: ["image", "upload"],
  LoadAudio: ["audio", "upload"],
  VHS_LoadVideo: ["video", "force_rate", "force_size", "custom_width", "custom_height", "frame_load_cap", "skip_first_frames", "select_every_nth"],
  KSampler: ["seed", "control_after_generate", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
  KSamplerSelect: ["sampler_name"],
  VAEDecode: [],
  VAEDecodeAudio: [],
  SaveImage: ["filename_prefix"],
  PreviewImage: [],
  ResolutionSelector: ["aspect_ratio", "megapixels", "multiple"],
  PrimitiveFloat: ["value"],
  PrimitiveInt: ["value"],
  PrimitiveString: ["value"],
  Text: ["text"],
  ModelAttentionBackend: ["backend"],
  MiniMaxH3SigmaShift: ["shift"],
  ModelPreviewOverrideKJ: ["model_name"],
};

const VIRTUAL = new Set(["Reroute", "SetNode", "GetNode", "PrimitiveNode", "Note", "MarkdownNote"]);

/**
 * 从 UI 格式转 API 格式。
 *
 * @param {object} ui   UI 导出（含 nodes / links）
 * @param {object} [opts]
 * @param {object} [opts.objectInfo]  live /object_info（可选，用来精确取字段名）
 * @returns {{prompt:object, warnings:string[]}}
 */
export function uiToApi(ui, opts = {}) {
  const warnings = [];
  const nodes = Array.isArray(ui?.nodes) ? ui.nodes : [];
  const links = Array.isArray(ui?.links) ? ui.links : [];

  /* link id → { from: nodeId, fromSlot: n } */
  const linkById = new Map();
  for (const L of links) {
    /* UI links 的形状：[id, originId, originSlot, targetId, targetSlot, type] */
    if (Array.isArray(L) && L.length >= 5) {
      linkById.set(L[0], { from: L[1], fromSlot: L[2], to: L[3], toSlot: L[4] });
    } else if (L && typeof L === "object") {
      linkById.set(L.id, { from: L.origin_id, fromSlot: L.origin_slot, to: L.target_id, toSlot: L.target_slot });
    }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));

  /* SetNode 变量名 → 来源节点；GetNode 变量名 → 消费者 */
  const setters = new Map();   // varName -> { nodeId, slot }
  for (const n of nodes) {
    if (n.type === "SetNode") {
      const name = Array.isArray(n.widgets_values) ? n.widgets_values[0] : n.title;
      /* SetNode 的输入在 inputs[0].link */
      const inLink = n.inputs?.[0]?.link;
      if (name && inLink != null) {
        const src = linkById.get(inLink);
        if (src) setters.set(String(name), { nodeId: src.from, slot: src.fromSlot });
      }
    }
  }

  /**
   * 解析一个输入槽最终指向哪个「实体节点」。
   * 沿途消掉 Reroute / GetNode / SetNode / PrimitiveNode。
   */
  const resolveSource = (nodeId, slotIndex, depth = 0) => {
    if (depth > 40) return null;
    const n = byId.get(nodeId);
    if (!n) return null;

    /* Reroute：inputs[0].link 继续往上 */
    if (n.type === "Reroute") {
      const l = n.inputs?.[0]?.link;
      if (l == null) return null;
      const src = linkById.get(l);
      return src ? resolveSource(src.from, src.fromSlot, depth + 1) : null;
    }
    /* GetNode：按变量名找 SetNode 的来源 */
    if (n.type === "GetNode") {
      const name = Array.isArray(n.widgets_values) ? n.widgets_values[0] : n.title;
      const s = setters.get(String(name));
      return s ? resolveSource(s.nodeId, s.slot, depth + 1) : null;
    }
    return { nodeId, slot: slotIndex };
  };

  /* ── 收集真实节点 ── */
  const real = nodes.filter((n) => !VIRTUAL.has(n.type));
  const out = {};

  for (const n of real) {
    const spec = opts.objectInfo?.[n.type];
    /**
     * 字段名来源优先级（2026-10-23 定稿）：
     *   ① node.inputs 里 link===null 的顺序 —— 【唯一可靠】，它就是 UI 上的排列
     *   ② /object_info 的 input_order —— 只在节点没有 inputs 数组时兜底
     *   ③ 硬编码表
     *   ④ 猜（记 warning）
     */
    const fromNode = widgetNamesFromNode(n, spec);
    const fromInfo = fromNode ? null : (spec ? widgetNamesFromObjectInfo(spec) : null);
    const known = fromNode ?? fromInfo ?? KNOWN_WIDGETS[n.type];
    const widgetNames = known;

    if (!widgetNames && Array.isArray(n.widgets_values) && n.widgets_values.length) {
      warnings.push(`节点 ${n.id}（${n.type}）没有 widget 字段名表，参数按 index 猜测`);
    }

    const inputs = {};
    /* ① widgets_values → 具名参数 */
    /**
     * ★★ 2026-10-23 补：widgets_values 不一定都是数组
     *
     *   实测 VHS_LoadVideo（节点 27）的 widgets_values 是【一个对象】：
     *     { video, force_rate, force_size, custom_width, custom_height,
     *       frame_load_cap, skip_first_frames, select_every_nth, format, ... }
     *   第一版只处理 Array.isArray，于是这个节点的参数全丢 ⇒ 提交时报
     *   「LoadVideoUpload.VALIDATE_INPUTS() missing 1 required positional argument: 'video'」。
     *
     *   ⇒ 对象形式直接按键写进 inputs（键名就是字段名，不需要对位）。
     *     顺带跳过 UI 专用的键（videopreview / choose video to upload / format 的重复项）。
     */
    if (Array.isArray(n.widgets_values) && widgetNames) {
      n.widgets_values.forEach((v, i) => {
        const name = widgetNames[i];
        /**
         * ★ control_after_generate 占位但不是真参数；
         *   upload 是 UI 按钮占位。两者都跳过。
         */
        if (!name || name === "control_after_generate" || name === "upload") return;
        inputs[name] = v;
      });
    } else if (n.widgets_values && typeof n.widgets_values === "object" && !Array.isArray(n.widgets_values)) {
      const UI_ONLY = new Set(["videopreview", "choose video to upload", "upload", "image"]);
      for (const [k, v] of Object.entries(n.widgets_values)) {
        if (UI_ONLY.has(k)) continue;
        inputs[k] = v;
      }
    }

    /* ② inputs 里的连线 → [源节点id字符串, 槽位] */
    for (const inp of n.inputs ?? []) {
      if (inp.link == null) continue;
      const src = linkById.get(inp.link);
      if (!src) continue;
      const resolved = resolveSource(src.from, src.fromSlot);
      if (!resolved) {
        warnings.push(`节点 ${n.id}（${n.type}）的输入 ${inp.name} 追不到来源`);
        continue;
      }
      inputs[inp.name ?? `in${src.fromSlot}`] = [String(resolved.nodeId), resolved.slot];
    }

    out[String(n.id)] = {
      class_type: n.type,
      inputs,
      ...(n.title ? { _meta: { title: n.title } } : {}),
    };
  }

  return { prompt: out, warnings };
}

/** 统计转换结果，便于人眼核对。 */
export function summarize(prompt) {
  const classes = {};
  for (const v of Object.values(prompt ?? {})) {
    classes[v.class_type] = (classes[v.class_type] ?? 0) + 1;
  }
  return {
    nodeCount: Object.keys(prompt ?? {}).length,
    classes,
    /** 检查有没有指向不存在节点的连线 —— 那是转换失败的典型症状 */
    dangling: (() => {
      const ids = new Set(Object.keys(prompt ?? {}));
      const bad = [];
      for (const [id, v] of Object.entries(prompt ?? {})) {
        for (const [k, val] of Object.entries(v.inputs ?? {})) {
          if (Array.isArray(val) && typeof val[0] === "string" && !ids.has(val[0])) {
            bad.push(`${id}.${k} → ${val[0]}`);
          }
        }
      }
      return bad;
    })(),
  };
}
