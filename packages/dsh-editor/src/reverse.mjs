
import { verifyParams, formatResult } from "../../dsh-video-knowledge/src/verify-rules.mjs";

/**
 * 反推的三种目标写法。
 * 不同目标模型的提示词结构完全不同，不能混用。
 */
export const REVERSE_TARGETS = {
  h3: {
    id: "h3",
    label: "H3 视频",
    desc: "按 H3 的多模态描述结构写（subject_definitions / shot / soundscape）",
    // ★ H3 的提示词是一个结构化模板，不是一句话
    structure: [
      "subject_definitions",
      "integrated_multimodal_description",
      "overall_soundscape",
      "non_diegetic_music",
    ],
    requireKeyframeRefs: true,
  },
  krea2: {
    id: "krea2",
    label: "Krea2 生图",
    desc: "按 Krea2 的自然语言描述写（主体 + 场景 + 光线 + 镜头 + 质感）",
    structure: ["subject", "scene", "lighting", "camera", "texture"],
    requireKeyframeRefs: false,
  },
  qwen21: {
    id: "qwen21",
    label: "Qwen 2.1 生图",
    desc: "按 Qwen-Image 的中英双语描述习惯写",
    structure: ["subject", "scene", "style", "detail"],
    requireKeyframeRefs: false,
  },
};

/**
 * 组装「给 LLM 的反推请求」。
 * 这是本模块最核心的东西 —— 它不是一句「帮我描述这张图」，
 * 而是一份完整的、带规则约束的指令。
 * @param {object} opts
 * @param {string} opts.target       'h3' | 'krea2' | 'qwen21'
 * @param {string} [opts.imageDesc]  图片的客观描述（多模态模型给的，或用户写的）
 * @param {string} [opts.intent]     用户的创作意图（想要什么效果）
 * @param {string} [opts.existing]   已有提示词（要改的话）
 * @param {object} [opts.rules]      M0 的规则摘要（可选，Agent 自己会读）
 * @returns {{system:string, user:string, expect:string[]}}
 */
export function buildReverseRequest({ target, imageDesc = "", intent = "", existing = "", rules = null }) {
  const t = REVERSE_TARGETS[target];
  if (!t) throw new Error(`不支持的目标：${target}（可用 ${Object.keys(REVERSE_TARGETS).join("/")}）`);

  const system = [
    "你是视频/图像生成提示词工程师。",
    `你的任务：把给定的画面信息改写成【${t.label}】模型能用的提示词。`,
    `目标写法：${t.desc}`,
    "",
    "硬性要求：",
    `① 必须包含这些结构段：${t.structure.join(" / ")}`,
    t.requireKeyframeRefs
      ? "② 引用参考素材时必须用 <Subject N> / <Picture N> / <Video N> / <Audio N> 标签，不能用「第一张图」这种说法"
      : "② 不要出现 <Picture N> 这类标签，直接自然语言描述",
    "③ 不要写「一张图片」「这个画面」这类元描述，直接写画面内容",
    "④ 不要写模型参数（步数、种子、分辨率），那些是参数面板的事",
    "⑤ 输出只要提示词本身，不要解释、不要 markdown 代码块",
    "",
    "风格纪律：",
    "· 具体优于抽象：写「深蓝色海水，阳光从右上斜射」，不写「很美」",
    "· 镜头语言明确：景别、机位、运动方式写清楚",
    target === "h3" ? "· 有台词的分镜，台词要放在 multimodal_description 里，不要单独列" : "",
  ].filter(Boolean).join("\n");

  const userParts = [];
  if (imageDesc) userParts.push(`【画面信息】\n${imageDesc}`);
  if (intent) userParts.push(`【创作意图】\n${intent}`);
  if (existing) userParts.push(`【现有提示词（需要改进）】\n${existing}`);
  if (rules) userParts.push(`【生产规则摘要】\n${typeof rules === "string" ? rules : JSON.stringify(rules, null, 2)}`);
  userParts.push(`【输出要求】\n直接给出 ${t.label} 的提示词。`);

  return {
    system,
    user: userParts.join("\n\n"),
    expect: t.structure,
  };
}

export function validateReverseResult(prompt, target) {
  const problems = [];
  const warnings = [];
  const t = REVERSE_TARGETS[target];
  if (!t) throw new Error(`不支持的目标：${target}`);

  // ★ 2026-10-19：改用「有没有可见字符」判定。
  //   原来用 String(prompt ?? "").trim() —— 零宽字符 ​ 会被当成非空，
  //   然后被下面 length < 30 判成「提示词太短（1 字）」，
  //   把「根本没写」误诊成「写得太短」，方向完全错了。
  const raw = typeof prompt === "string" ? prompt : "";
  const p = raw.replace(/[\s\u200b-\u200f\u2028-\u202f\u205f\u2060-\u2064\u206a-\u206f\ufeff\u3000\u180e\u3164\u115f\u1160\uffa0\u0000-\u001f\u007f\ufff9-\ufffb]/g, "");
  if (!p) return { ok: false, problems: ["提示词为空（或只有空白/不可见字符）"], warnings: [] };
  if (p.length < 30) problems.push(`提示词太短（${p.length} 字），可能没写完整`);
  if (p.length > 8000) warnings.push(`提示词很长（${p.length} 字），可能影响模型注意力`);

  const lower = p.toLowerCase();
  const missing = t.structure.filter((seg) => !lower.includes(seg.toLowerCase()));
  if (missing.length) {
    if (target === "h3") problems.push(`缺少结构段：${missing.join(", ")}`);
    else warnings.push(`未显式包含结构段：${missing.join(", ")}（生图允许，但检查一下内容是否覆盖）`);
  }

  if (t.requireKeyframeRefs) {
    if (/第[一二三四五六七八九\d]+张(图|图片)/.test(p)) {
      problems.push("用了「第N张图」的说法，必须改成 <Picture N>");
    }
  } else {
    if(/<Picture \d+>/.test(p)) warnings.push("生图提示词里出现了 <Picture N>，可能不适用");
  }

  // 不要写参数
  if (/(步数|steps\s*[:=]\s*\d+|seed\s*[:=]\s*\d+|--ar|分辨率\s*[:=])/i.test(p)) {
    problems.push("提示词里包含了模型参数（步数/种子/分辨率），那些应该放在参数面板");
  }

  if (/^(这张|该|此)(图片|画面|图像)/.test(p)) {
    warnings.push("开头是元描述（这张图片…），建议直接写画面内容");
  }

  if (target === "h3") {
    try {
      const r = verifyParams({ prompt: p });
      if (r && r.ok === false) {
        for (const issue of r.problems ?? []) problems.push(`M0 规则：${issue}`);
      }
    } catch {
    }
  }

  return { ok: problems.length === 0, problems, warnings };
}

/**
 * ★ 把反推结果回填到节点 —— 这是「Agent 起草 + 用户修订」的关键一步。
 * 注意：回填只是【写入 prompt 字段】，不触发提交。
 * 用户看到提示词后可以再改，改完自己点运行。
 * @param {object} clip   节点/片段
 * @param {object} result { prompt, target, meta }
 * @returns {object} 新的 clip
 */
export function applyReverseResult(clip, { prompt, target, meta = {} }) {
  const v = validateReverseResult(prompt, target);
  if (!v.ok) {
    throw new Error(`反推结果不合规，未回填：\n${v.problems.join("\n")}`);
  }
  return {
    ...clip,
    shot: {
      ...(clip.shot ?? {}),
      prompt: String(prompt).trim(),
      reverseMeta: {
        at: Date.now(),
        target,
        model: meta.model ?? null,
        elapsedMs: meta.elapsedMs ?? null,
        warnings: v.warnings,
      },
    },
  };
}

/** 反推失败时的降级：把问题原样告诉用户，不静默。 */
export function describeReverseFailure(err, target) {
  const hint = target === "h3"
    ? "H3 需要结构化提示词（subject_definitions 等），可以让 Agent 读 h3-production-rules 技能后重写。"
    : `可以让 Agent 按 ${REVERSE_TARGETS[target]?.desc ?? target} 的要求重写。`;
  return `${err.message}\n\n${hint}`;
}

export function targetFromModeId(modeId) {
  if (modeId === "yz") return "h3";
  if (modeId === "krea2") return "krea2";
  if (modeId === "qwen21" || modeId === "qwen21-edit") return "qwen21";
  return "h3";
}
