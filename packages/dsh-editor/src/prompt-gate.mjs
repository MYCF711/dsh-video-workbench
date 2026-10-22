/**
 * 提示词闸门 —— 强制 Agent 走校验，不许随手写提示词就提交。
 *
 * ★ 为什么要这一层（实测问题）
 *   把活派给 Agent 时观察到：它自己动手写提示词、不读生产规则 skill、
 *   提交不合规的成果，提醒之后才去用对的工具。
 *   根因不是模型不听话，是**结构上没有强制点**：
 *     · 工具描述只说「能做什么」，没说「什么时候必须做」
 *     · skill 是可选参考，不是必经关卡
 *     · 没有一层在提交前检查「你合规了吗」
 *
 * ★ 三层强制（本文件实现）
 *   ① 规则内嵌：buildPromptRequirements() 把 M0 的规则摘要直接塞进工具返回，
 *      Agent 不主动读 skill 也能看到（不依赖它自觉）
 *   ② 改提示词必须走闸门：registerPromptGuard() 拦 timeline_update_shot
 *      直接改 prompt 的调用，未过校验的一律拒绝
 *   ③ 生成前复查：timeline_generate 提交前再校验一次，不过就拒
 *
 * ★ 豁免
 *   用户手点 UI 改提示词不受限制（who === "user" 直接放行）——
 *   闸门是给 Agent 设的，不是给用户设的。
 */

import { verifyParams } from "../../dsh-video-knowledge/src/verify-rules.mjs";

/** 已经过闸门的片段：clipId → { at, promptHash, warnings } */
const passed = new Map();

/** 简易指纹（同一段文本得到同一值）。 */
function hash(s) {
  let h = 5381;
  const t = String(s ?? "");
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

/**
 * 把 M0 的规则摘要附在工具返回里。
 *
 * 只放**提交前必须过的硬规则**，不放全部 91 条 ——
 * 后者会让返回体积失控，Agent 也不会读完。
 */
// ★ 2026-10-19：统一的「有没有实际内容」判定。
//   不要用 String(x).trim() —— 它拦不住 "[object Object]"、数字 0、零宽字符。
const INVISIBLE_CHARS = /[\s\u200b-\u200d\ufeff\u3000\u180e]/g;
const hasVisibleText = (s) =>
  typeof s === "string" && s.replace(INVISIBLE_CHARS, "").length > 0;

export function buildPromptRequirements(modeId = "yz") {
  const common = [
    "【提交前必须满足】",
    "① 正文一律英文。中文只出现在台词引号内与必要的专有名词。",
    "② 有台词的分镜，时长必须 ≥ 台词字数 ÷ 4.5 字/秒，否则口型崩。",
    "③ 引用参考素材必须用 <Subject N> / <Picture N> / <Video N> / <Audio N> 标签。",
    "④ 不要写模型参数（步数/种子/分辨率），那是参数面板的事。",
    "⑤ 避免空泛词：beautiful / amazing / masterpiece —— 写具体的物体与光。",
    "⑥ 画面空间关系必须明确：谁在左、谁在右、朝向谁。否则会串脸。",
  ];
  const h3Only = [
    "⑦ H3 的提示词是结构化模板，必须含四段：subject_definitions / integrated_multimodal_description / overall_soundscape / non_diegetic_music",
    "⑧ 台词放在 integrated_multimodal_description 里，不要单独列。",
    "⑨ 分镜续接的首尾帧锚定句必须用英文写。",
  ];
  return {
    modeId,
    mustSatisfy: modeId === "yz" ? [...common, ...h3Only] : common,
    note: "这些是硬规则。违反会被 timeline_generate 拒绝。",
  };
}

/**
 * 校验提示词。不合格返回 problems。
 *
 * @param {string} prompt
 * @param {string} modeId
 * @returns {{ok:boolean, problems:string[], warnings:string[]}}
 */
export function checkPrompt(prompt, modeId = "yz") {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  const problems = [];
  const warnings = [];

  if (!text) return { ok: false, problems: ["提示词为空"], warnings: [] };
  if (text.length < 30) problems.push(`提示词太短（${text.length} 字）—— 描述不完整`);

  // 空泛词
  const vague = ["beautiful", "amazing", "masterpiece", "stunning", "gorgeous"];
  const hitVague = vague.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(text));
  if (hitVague.length) warnings.push(`空泛词：${hitVague.join(", ")} —— 换成具体的物体/光线描述`);

  // 参数不该写进提示词
  if (/(steps\s*[:=]\s*\d+|seed\s*[:=]\s*\d+|--ar\b|分辨率\s*[:=])/i.test(text)) {
    problems.push("提示词里写了模型参数（步数/种子/分辨率）—— 应放在参数面板");
  }

  // H3 专项
  if (modeId === "yz") {
    const need = ["subject_definitions", "integrated_multimodal_description", "overall_soundscape"];
    const lower = text.toLowerCase();
    const miss = need.filter((s) => !lower.includes(s));
    if (miss.length) problems.push(`H3 缺少结构段：${miss.join(", ")}`);
    if (/第[一二三四五六七八九\d]+张(图|图片)/.test(text)) {
      problems.push("用了「第N张图」，必须改成 <Picture N>");
    }
    // 台词时长自检
    const quotes = [...text.matchAll(/[""「"]([^""」"]{2,})[""」"]/g)].map((m) => m[1]);
    if (quotes.length) {
      const cjk = quotes.join("").replace(/[^\u4e00-\u9fa5]/g, "").length;
      const need2 = cjk / 4.5;
      const dur = /durationSec\s*[:=]\s*([\d.]+)/i.exec(text);
      if (dur && Number(dur[1]) < need2) {
        problems.push(`台词 ${cjk} 字需约 ${need2.toFixed(1)}s，但时长写的是 ${dur[1]}s`);
      }
    }
  }

  // 过一遍 M0 的校验器（它有 12 条规则）
  try {
    const r = verifyParams({ modeId, prompt: text, durationSec: 5 });
    for (const p of r?.problems ?? []) {
      // M0 里跟时长相关的由上面单独算，这里只收提示词本身的
      if (!/台词|网格|时长/.test(p)) problems.push(`M0：${p}`);
    }
  } catch { /* M0 要求更多参数时跳过 */ }

  return { ok: problems.length === 0, problems, warnings };
}

/** 标记某片段已过闸门。 */
export function markPassed(clipId, prompt, warnings = []) {
  passed.set(clipId, { at: Date.now(), h: hash(prompt), warnings });
}

/** 查某片段的提示词是否过过闸门。 */
export function hasPassed(clipId, prompt) {
  const r = passed.get(clipId);
  if (!r) return false;
  return r.h === hash(prompt);   // 提示词改过就失效
}

/** 清掉（片段被替换/删除时）。 */
export function forget(clipId) {
  passed.delete(clipId);
}

/**
 * 注册工具守卫 —— 拦住「绕过闸门直接改 prompt」的调用。
 *
 * ★ 只拦 who==='agent' 的路径。用户的 UI 操作走 HTTP 路由，
 *   不经过工具，自然不受这个守卫约束。
 *
 * @param {object} ctx    cordis ctx（需要 ctx.tools.guard）
 * @param {object} opts   { log }
 * @returns {Function} disposer
 */
export function registerPromptGuard(ctx, opts = {}) {
  const log = opts.log ?? console;
  if (typeof ctx?.tools?.guard !== "function") {
    log.warn?.("[prompt-gate] ctx.tools.guard 不可用，守卫未注册");
    return () => {};
  }

  const dispose = ctx.tools.guard((call) => {
    const name = call?.name ?? call?.tool;
    const args = call?.args ?? call?.arguments ?? {};

    // 拦①：Agent 直接改 prompt
    if (name === "timeline_update_shot" && typeof args.prompt === "string") {
      const clipId = args.clipId;
      if (clipId && !hasPassed(clipId, args.prompt)) {
        return {
          denied: true,
          reason:
            "改提示词必须先过闸门。请按顺序调用：\n" +
            "  ① timeline_reverse_prompt{op:'prepare', clipId} → 拿到规则与写作指令\n" +
            "  ② 按指令写好提示词\n" +
            "  ③ timeline_reverse_prompt{op:'apply', clipId, prompt} → 校验并回填\n" +
            "直接写 prompt 会被拒绝，因为历史上这样交出去的提示词不合格率很高。",
        };
      }
    }

    // 拦②：生成前复查
    if (name === "timeline_generate" && Array.isArray(args.clipIds)) {
      // 这里拿不到 store，只能查「有没有过闸门」的登记
      const bad = args.clipIds.filter((id) => !passed.has(id));
      if (bad.length) {
        return {
          denied: true,
          reason:
            `这 ${bad.length} 段还没过提示词闸门：${bad.slice(0, 3).join(", ")}` +
            (bad.length > 3 ? " 等" : "") +
            "\n先调 timeline_reverse_prompt 的 prepare + apply 走完流程。",
        };
      }
    }

    return undefined;   // 放行
  });

  log.info?.("[prompt-gate] 守卫已注册（拦 update_shot 直改 prompt / generate 未过闸门）");
  return () => { try { dispose?.(); } catch { /* ignore */ } };
}
