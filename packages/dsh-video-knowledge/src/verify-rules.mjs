/**
 * H3 生产规则校验器 —— 提交生成前，把「已知会出错的参数」拦下来。
 *
 * 规则来源：vendor/knowledge/canvas_skills.md（67 条）+ memory.md（24 条）
 * 每条规则后面标了原文序号，可逐条追溯。
 *
 * 三个判定等级：
 *   block —— 一定出错，不许提交
 *   warn  —— 很可能出错，提示但放行
 *   fix   —— 自动修正（如网格吸附），并在返回值里说明改了什么
 *
 * 用法：
 *   import { verifyParams } from './verify-rules.mjs';
 *   const r = verifyParams({ modeId: 'yz', durationSec: 5, prompt: '...' });
 *   if (r.blocked) throw new Error(r.blocked.map(b => b.message).join('\n'));
 */

const LEGAL_LENGTHS = Array.from({ length: 22 }, (_, k) => 17 * k + 5);
const FPS = 24;

/** 中文字符数（估算语速用）。 */
function countCJK(s) {
  return (String(s).match(/[\u4e00-\u9fa5]/g) ?? []).length;
}

/**
 * 提取台词。
 *
 * ★ 实测教训（2026-10-17）：H3 的台词有【两种合法写法】，都要支持：
 *   ① 新写法（官方规范，cs=42）：<d>[Chinese] 台词</d>
 *      说话人身份写在 <d> 外面
 *   ② 旧写法（YUH 早期经验，cs=19）：<Audio N>:"台词"
 *      <Audio N> 后面不写「说」字
 *
 * 第一版只认 ①，导致 ② 的台词被当成「正文中文」误判成违规 ——
 * 这是把一条合法写法判成错误的假阳性。
 */
const DIALOGUE_PATTERNS = [
  // ① <d>[语言] 台词</d>
  /<d>\s*(?:\[[^\]]+\])?\s*([\s\S]*?)<\/d>/g,
  // ② <Audio N>:"台词" 或 <Audio N>：“台词”
  /<Audio\s*\d+>\s*[:：]?\s*[“"「]([^”"」]*)[”"」]/g,
];

function extractDialogue(text) {
  const out = [];
  for (const re of DIALOGUE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of String(text).matchAll(re)) out.push(m[1]);
  }
  return out;
}

/**
 * 去掉台词，得到「正文」。
 * 两种写法都要剥掉，否则台词里的中文会被当成正文中文。
 */
function stripDialogue(text) {
  return String(text)
    .replace(/<d>[\s\S]*?<\/d>/g, "<d/>")
    .replace(/<Audio\s*\d+>\s*[:：]?\s*[“"「][^”"」]*[”"」]/g, "<Audio said/>");
}

/**
 * @param {object} p
 * @param {string} p.modeId       模式 id（yz / krea2 / qwen21-edit / qwen21）
 * @param {string} p.prompt
 * @param {number} [p.durationSec]
 * @param {number} [p.length]
 * @param {object} [p.toggles]
 * @param {object} [p.files]      槽名 -> { filename }
 * @param {string[]} [p.refSlots] 该模式声明了哪些 media 槽
 * @returns {{blocked:Array, warnings:Array, fixes:Array, info:object}}
 */
export function verifyParams(p = {}) {
  const blocked = [];
  const warnings = [];
  const fixes = [];

  const prompt = String(p.prompt ?? "");
  const body = stripDialogue(prompt);          // 正文（去掉台词块）
  const dialogue = extractDialogue(prompt);    // 台词数组
  const isVideo = p.modeId === "yz";

  // ══════════════════════════════════════════════════════
  // 规则 1 · 提示词正文禁中文（cs=44）
  //   实测：H3 会把正文里的中文守则念出来
  // ══════════════════════════════════════════════════════
  const bodyCJK = countCJK(body);
  if (bodyCJK > 0) {
    blocked.push({
      rule: "prompt-body-chinese",
      src: "cs=44",
      message:
        `提示词正文含 ${bodyCJK} 个中文字符。<d> 台词块之外一律用英文写 —— ` +
        `实测 H3 会把中文守则念出来（用户听到分镜4 末尾念出「本镜只有苏晴一人」）。`,
      detail: body.match(/[\u4e00-\u9fa5][^\n]{0,40}/)?.[0],
    });
  }

  // ══════════════════════════════════════════════════════
  // 规则 2 · <Audio N> 后不能写「说」字（cs=19）
  // ══════════════════════════════════════════════════════
  const audioSay = prompt.match(/<Audio\s*\d+>\s*说/);
  if (audioSay) {
    blocked.push({
      rule: "audio-say-char",
      src: "cs=19",
      message:
        `发现「${audioSay[0]}」。<Audio N> 后面不要写「说」字 —— 实测会被念出来。` +
        `正确写法：<Audio 1>："台词"`,
    });
  }

  // ══════════════════════════════════════════════════════
  // 规则 3 · 画外音必须有 off-screen voiceover + lips closed（cs=32, mm=17）
  // ══════════════════════════════════════════════════════
  const hasVoiceoverKeyword = /off-screen voiceover/i.test(prompt);
  const hasLipsClosed = /lips remain completely closed|mouth stays shut|lip movement/i.test(prompt);
  if (hasVoiceoverKeyword && !hasLipsClosed) {
    blocked.push({
      rule: "voiceover-missing-lips",
      src: "cs=32",
      message:
        `用了 "off-screen voiceover" 但没有跟 "lips remain completely closed"。` +
        `实测：否则画面里的人会跟着张嘴乱念（分镜3 读信踩过）。` +
        `且这一句要塞进【每一句】的引导语里，不能只在最后统一写一次。`,
    });
  }

  // ══════════════════════════════════════════════════════
  // 规则 4 · 有音色参考 + 有台词 ⇒ 时长 ≥10s（cs=22）
  //   实测：连线音色后人物约 4.5s 才开始说话
  // ══════════════════════════════════════════════════════
  const hasAudioRef =
    Object.keys(p.files ?? {}).some((k) => /audio/i.test(k)) ||
    prompt.includes("<Audio ");
  if (isVideo && hasAudioRef && dialogue.length > 0) {
    const dur = Number(p.durationSec ?? 0);
    if (dur > 0 && dur < 10) {
      blocked.push({
        rule: "audio-dialogue-too-short",
        src: "cs=22",
        message:
          `有音色参考且有 ${dialogue.length} 句台词，但时长只有 ${dur}s。` +
          `实测人物约 4.5s 才开始说话 —— 时长 <10s 会导致台词挤不进去、对不上口型。` +
          `请改到 ≥10s（台词多给 12~15s）。`,
      });
    }
  }

  // ══════════════════════════════════════════════════════
  // 规则 5 · 台词秒数够不够（4~5 字/秒，cs=32, 35）
  // ══════════════════════════════════════════════════════
  if (isVideo && dialogue.length > 0 && Number(p.durationSec) > 0) {
    const totalCJK = dialogue.reduce((s, d) => s + countCJK(d), 0);
    // 4.5s 后才开口，单镜上限 15s
    const speakWindow = Math.min(Number(p.durationSec), 15) - 4.5;
    if (totalCJK > 0 && speakWindow > 0) {
      const needed = totalCJK / 5; // 保守按 5 字/秒
      if (needed > speakWindow) {
        blocked.push({
          rule: "dialogue-too-long-for-duration",
          src: "cs=32",
          message:
            `台词共 ${totalCJK} 字，按 5 字/秒需要约 ${needed.toFixed(1)}s，` +
            `但可用说话窗口只有 ${speakWindow.toFixed(1)}s（时长 ${p.durationSec}s − 4.5s 起口）。` +
            `贪多必吞字。请砍句或加时长（单镜上限 15s）。`,
        });
      } else if (needed > speakWindow * 0.85) {
        warnings.push({
          rule: "dialogue-tight",
          src: "cs=32",
          message: `台词${totalCJK}字需约${needed.toFixed(1)}s，窗口${speakWindow.toFixed(1)}s —— 偏紧，建议加时长或加停顿。`,
        });
      }
    }
  }

  // ══════════════════════════════════════════════════════
  // 规则 6 · BGM（cs=31, mm=15）
  //   用户明确要求不要 BGM
  // ══════════════════════════════════════════════════════
  if (isVideo) {
    const hasMusicDesc = /(piano|strings|guitar|orchestra|soundtrack|background music|BGM|配乐|弦乐|钢琴)/i.test(body);
    const declaresNA = /\bN\/A\b/i.test(prompt);
    if (hasMusicDesc) {
      blocked.push({
        rule: "bgm-forbidden",
        src: "mm=15, cs=36",
        message:
          `正文里出现了配乐描述（钢琴/弦乐/吉他等）。用户明确要求成片不要 BGM。` +
          `请删掉配乐描述，第三段 non_diegetic_music 写 N/A。`,
        detail: body.match(/(piano|strings|guitar|orchestra|soundtrack|background music)/i)?.[0],
      });
    }
    // overall_soundscape 不能是 N/A
    if (declaresNA) {
      const naCount = (prompt.match(/\bN\/A\b/gi) ?? []).length;
      if (naCount > 1) {
        warnings.push({
          rule: "multiple-N/A",
          src: "cs=31",
          message:
            `出现 ${naCount} 处 N/A。只有 non_diegetic_music 该写 N/A；` +
            `overall_soundscape 写 N/A 意味着全片静音（官方 §4.6），环境音/动作音要正常写。`,
        });
      }
      // 粗查：N/A 是不是出现在 soundscape 段
      if (/overall_soundscape\s*[:：]?\s*N\/A/i.test(prompt)) {
        blocked.push({
          rule: "soundscape-is-NA",
          src: "cs=31",
          message:
            `overall_soundscape 写成了 N/A —— 那是「全片静音」才用（官方 §4.6）。` +
            `环境音/脚步/灯管嗡响要正常写；只有 non_diegetic_music 写 N/A。`,
        });
      }
    }
  }

  // ══════════════════════════════════════════════════════
  // 规则 7 · 首尾帧锚定句必须英文（cs=43）
  //   实测：中文锚定被正则剥离，像素差 52 vs 3.4
  // ══════════════════════════════════════════════════════
  const hasCnAnchor = /(上一镜结尾画面|本镜从上一镜结尾画面)/.test(prompt);
  if (hasCnAnchor) {
    blocked.push({
      rule: "cn-continuity-anchor",
      src: "cs=43",
      message:
        `发现中文格式的尾帧锚定句（「上一镜结尾画面…」）。` +
        `实测会被 comicPipeline 的正则剥离，模型丢掉第0帧锚定自己重新构图：` +
        `中文锚定像素差 52（完全不对）vs 英文锚定差 3.4（精确锁定）。` +
        `请改用英文：` +
        `"Continuity anchor: this video must open at 0.00 s on exactly <Picture 1>, ` +
        `the final frame of the previous shot of the same scene — same framing/light/props; ` +
        `no fade-in, no re-establishing shot, no reframing at the start."`,
    });
  }

  // ══════════════════════════════════════════════════════
  // 规则 8 · 帧数网格（本机实测，M1 的 length.mjs 同源）
  // ══════════════════════════════════════════════════════
  if (isVideo && p.length != null) {
    const req = Number(p.length);
    if (!LEGAL_LENGTHS.includes(req)) {
      const k = Math.min(Math.max(Math.ceil((req - 5) / 17), 0), 21);
      let snapped = 17 * k + 5;
      if (snapped % 2 !== 0 && k > 0) snapped = 17 * (k - 1) + 5;
      fixes.push({
        rule: "length-grid",
        src: "本机实测（M1 length.mjs 同源）",
        message: `length=${req} 不在 17k+5 网格上，吸附到 ${snapped}（${(snapped / FPS).toFixed(2)}s）。`,
        from: req,
        to: snapped,
      });
    }
  }

  // ══════════════════════════════════════════════════════
  // 规则 9 · 空泛词（cs=14）
  // ══════════════════════════════════════════════════════
  if (isVideo) {
    const vague = body.match(/\b(cinematic|beautiful|stunning|amazing|gorgeous|masterpiece)\b/gi);
    if (vague && vague.length > 2) {
      warnings.push({
        rule: "vague-words",
        src: "cs=14",
        message:
          `出现 ${vague.length} 个空泛词（${[...new Set(vague.map((v) => v.toLowerCase()))].join(", ")}）。` +
          `官方规范要求具体写构图/主体/环境/动作/镜头/声音，避免 abstract 空泛词。`,
      });
    }
  }

  // ══════════════════════════════════════════════════════
  // 规则 10 · 分镜禁止闪回（mm=14）
  // ══════════════════════════════════════════════════════
  if (isVideo) {
    const flashback = body.match(/\b(flashback|memory of|years ago|childhood|幼年|闪回|回忆)\b/gi);
    if (flashback) {
      blocked.push({
        rule: "no-flashback",
        src: "mm=14",
        message:
          `出现闪回/回忆类描述（${[...new Set(flashback)].join(", ")}）。` +
          `用户明确要求：分镜禁止用回忆/闪回镜头，一律只讲当下正在发生的事。此规则适用于以后所有剧。`,
      });
    }
  }

  // ══════════════════════════════════════════════════════
  // 规则 11 · 首尾帧模式下必须有锚定句（cs=46, 47）
  // ══════════════════════════════════════════════════════
  const hasRefImage = Object.keys(p.files ?? {}).some((k) => /image/i.test(k));
  if (isVideo && hasRefImage && p.toggles?.firstFrameFromPrev && !/Continuity anchor|First frame lock/i.test(prompt)) {
    warnings.push({
      rule: "missing-continuity-anchor",
      src: "cs=46",
      message:
        `标了「从上镜尾帧续接」但提示词里没有英文锚定句。` +
        `请加 "Continuity anchor: this video must open at 0.00 s on exactly <Picture 1>, ..."`,
    });
  }

  // ══════════════════════════════════════════════════════
  // 规则 12 · 生图比例必须走参数（mm=1, mm=9）
  // ══════════════════════════════════════════════════════
  if (!isVideo && /(\d+:\d+)/.test(body) && !p.aspect) {
    warnings.push({
      rule: "aspect-in-prompt",
      src: "mm=1",
      message:
        `正文里出现了比例（${body.match(/\d+:\d+/)[0]}），但 aspect 参数没设。` +
        `比例必须在节点参数里设 —— 写进提示词无效，引擎按节点默认输出。`,
    });
  }

  // ══════════════════════════════════════════════════════
  // 汇总
  // ══════════════════════════════════════════════════════
  return {
    blocked,
    warnings,
    fixes,
    info: {
      modeId: p.modeId,
      bodyCJK,
      dialogueCount: dialogue.length,
      dialogueCJK: dialogue.reduce((s, d) => s + countCJK(d), 0),
      legal: blocked.length === 0,
    },
  };
}

/** 把校验结果格式化成可读文本。 */
export function formatResult(r) {
  const out = [];
  if (r.blocked.length) {
    out.push(`✗ 拦下 ${r.blocked.length} 条：`);
    for (const b of r.blocked) out.push(`   [${b.rule} / ${b.src}]\n     ${b.message}`);
  }
  if (r.warnings.length) {
    out.push(`⚠ 警告 ${r.warnings.length} 条：`);
    for (const w of r.warnings) out.push(`   [${w.rule} / ${w.src}] ${w.message}`);
  }
  if (r.fixes.length) {
    out.push(`✎ 自动修正 ${r.fixes.length} 条：`);
    for (const f of r.fixes) out.push(`   [${f.rule}] ${f.message}`);
  }
  if (!out.length) out.push("✓ 全部检查通过");
  return out.join("\n");
}

export { LEGAL_LENGTHS };
