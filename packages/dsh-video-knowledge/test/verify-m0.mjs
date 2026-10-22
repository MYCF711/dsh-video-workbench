/**
 * M0 验收 —— 校验器的两条判据：
 *   ① 故意造 12 条违规参数，全部被拦下（无漏拦）
 *   ② 用 M1 已验收的 4 个真实参数跑一遍，无误拦
 *
 * 用法：node test/verify-m0.mjs
 */
import { verifyParams, formatResult, LEGAL_LENGTHS } from "../src/verify-rules.mjs";

let pass = 0;
let fail = 0;
const failures = [];

function expect(desc, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) {
      console.log(`  ✅ ${desc}`);
      pass++;
    } else {
      console.log(`  ❌ ${desc}\n     ${r}`);
      fail++;
      failures.push(desc);
    }
  } catch (err) {
    console.log(`  ❌ ${desc}\n     ${err.message}`);
    fail++;
    failures.push(desc);
  }
}

function expectBlocked(desc, params, ruleId) {
  expect(desc, () => {
    const r = verifyParams(params);
    const hit = r.blocked.find((b) => b.rule === ruleId);
    if (!hit) {
      return `规则 ${ruleId} 没被触发。实际拦下：${r.blocked.map((b) => b.rule).join(", ") || "无"}`;
    }
    return true;
  });
}

function expectClean(desc, params) {
  expect(desc, () => {
    const r = verifyParams(params);
    if (r.blocked.length) {
      return `被误拦：\n${formatResult(r)}`;
    }
    return true;
  });
}

// ══════════════════════════════════════════════════════════
console.log("═══ ① 违规用例（12 条，全部应被拦）═══\n");

expectBlocked(
  "正文含中文 → prompt-body-chinese",
  {
    modeId: "yz",
    prompt: "本镜只有苏晴一人，站在门口。The woman stands at the door.",
    durationSec: 12,
  },
  "prompt-body-chinese"
);

expectBlocked(
  "<Audio N> 后写了「说」→ audio-say-char",
  {
    modeId: "yz",
    prompt: 'The woman speaks. <Audio 1> 说："你好"',
    durationSec: 12,
  },
  "audio-say-char"
);

expectBlocked(
  "画外音缺 lips closed → voiceover-missing-lips",
  {
    modeId: "yz",
    prompt:
      'The man sits reading. <Audio 1> LIN (S1) says in an off-screen voiceover: <d>[Chinese] 这是我的信。</d>',
    durationSec: 12,
  },
  "voiceover-missing-lips"
);

expectBlocked(
  "有音色+台词但时长 5s → audio-dialogue-too-short",
  {
    modeId: "yz",
    // 正文全英文，只有 <d> 里是中文 —— 这样不会被中文规则先拦
    prompt: 'A woman speaks softly. <Audio 1>："\u4f60\u597d"',
    durationSec: 5,
  },
  "audio-dialogue-too-short"
);

expectBlocked(
  "台词太多时间不够 → dialogue-too-long-for-duration",
  {
    modeId: "yz",
    prompt:
      'A woman speaks slowly, looking at the window. ' +
      '<Audio 1>：' +
      '"\u4f60\u77e5\u9053\u5417\uff0c\u9047\u89c1\u4f60\u4e4b\u540e\u6211\u624d\u53d1\u73b0\uff0c' +
      '\u539f\u6765\u8fd9\u4e2a\u4e16\u754c\u4e0a\u8fd8\u6709\u8fd9\u6837\u6e29\u67d4\u7684\u4eba\uff0c' +
      '\u6211\u4e00\u76f4\u4ee5\u4e3a\u6211\u4e0d\u4f1a\u518d\u6709\u8fd9\u79cd\u611f\u89c9\u4e86\u3002"',
    durationSec: 10,
  },
  "dialogue-too-long-for-duration"
);

expectBlocked(
  "正文有配乐描述 → bgm-forbidden",
  {
    modeId: "yz",
    prompt:
      "The woman walks down the corridor. Soft piano music swells as she moves. " +
      "Footsteps echo. non_diegetic_music: N/A",
    durationSec: 12,
  },
  "bgm-forbidden"
);

expectBlocked(
  "overall_soundscape 写成 N/A → soundscape-is-NA",
  {
    modeId: "yz",
    prompt:
      "integrated_multimodal_description: A woman stands still.\n" +
      "overall_soundscape: N/A\nnon_diegetic_music: N/A",
    durationSec: 12,
  },
  "soundscape-is-NA"
);

expectBlocked(
  "中文尾帧锚定句 → cn-continuity-anchor",
  {
    modeId: "yz",
    prompt:
      "上一镜结尾画面（仅作第0帧连续性参考）：<Picture 1>\n" +
      "Continuity anchor: this video opens at 0.00 s on <Picture 1>.",
    durationSec: 12,
  },
  "cn-continuity-anchor"
);

expectBlocked(
  "分镜写了闪回 → no-flashback",
  {
    modeId: "yz",
    prompt: "A flashback shows the girl as a child running in the field.",
    durationSec: 12,
  },
  "no-flashback"
);

// 网格吸附是 fix 不是 block
expect("length 不在网格上 → 自动吸附（fix）", () => {
  const r = verifyParams({ modeId: "yz", prompt: "A woman stands.", durationSec: 5, length: 24 });
  const f = r.fixes.find((x) => x.rule === "length-grid");
  if (!f) return `没有产生 fix。fixes=${JSON.stringify(r.fixes)}`;
  if (f.from !== 24 || f.to !== 22) return `吸附值不对：${f.from} → ${f.to}（期望 24 → 22）`;
  return true;
});

expect("全部 22 个合法帧数都不触发 fix", () => {
  for (const n of LEGAL_LENGTHS) {
    const r = verifyParams({ modeId: "yz", prompt: "A woman stands.", durationSec: 5, length: n });
    const f = r.fixes.find((x) => x.rule === "length-grid");
    if (f) return `length=${n} 被误判需要吸附到 ${f.to}`;
  }
  return true;
});

// 生图比例写正文 → 只警告不拦（这条是 warn 级，不是 block）
expect("生图比例写正文 → 只警告不拦", () => {
  const r = verifyParams({ modeId: "krea2", prompt: "A woman, 9:16 vertical" });
  const hit = r.warnings.find((w) => w.rule === "aspect-in-prompt");
  if (!hit) return "没有产生 aspect-in-prompt 警告";
  if (r.blocked.length) return `不该拦却拦了：${r.blocked.map((b) => b.rule).join(",")}`;
  return true;
});

// ══════════════════════════════════════════════════════════
console.log("\n═══ ② 真实参数（M1 已验收的 4 个工作流）—— 不应误拦 ═══\n");

expectClean("krea2 真实参数不误拦", {
  modeId: "krea2",
  prompt:
    "a single red apple on a plain white table, studio lighting, sharp focus, photorealistic",
  aspect: "1:1",
  steps: 8,
  seed: 20261017,
});

expectClean("qwen21-edit 真实参数不误拦", {
  modeId: "qwen21-edit",
  prompt: "change the clothing to a red traditional Chinese silk dress with gold embroidery",
  steps: 25,
  seed: 20261018,
});

expectClean("qwen21 文生图参数不误拦", {
  modeId: "qwen21",
  prompt: "Retro Cartoon Graffiti EDM Party Poster, neon colors, bold outlines, energetic composition",
  aspect: "2:3",
  steps: 40,
});

expectClean("yz 无台词文戏镜不误拦", {
  modeId: "yz",
  prompt:
    "subject_definitions:\n" +
    "A young woman with long black hair, wearing a white t-shirt, standing by a window in soft daylight.\n\n" +
    "Cinematic live-action. Shot opens on her profile at medium close-up, camera slowly dollies in. " +
    "She turns her head slightly toward the lens, expression calm, eyes shifting subtly. " +
    "Background is a blurred interior with warm afternoon light. No dialogue.\n\n" +
    "overall_soundscape: quiet room tone, faint street noise through the glass, soft fabric rustle.\n" +
    "non_diegetic_music: N/A",
  aspect: "16:9",
  durationSec: 2,
  steps: 10,
});

expect("yz 合规台词镜头（≥10s + 英文 + lips closed）不误拦", () => {
  const r = verifyParams({
    modeId: "yz",
    prompt:
      "Cinematic live-action. A woman with long black hair sits at a wooden desk by the window. " +
      "Continuity anchor: this video must open at 0.00 s on exactly <Picture 1>, " +
      "the final frame of the previous shot — same framing, light and props; " +
      "no fade-in, no re-establishing shot, no reframing at the start.\n\n" +
      "At 5.0 seconds she lifts her head and speaks softly: " +
      '<Audio 1> SU QING (S1) says in a quiet, breathy voice: <d>[Chinese] 你回来了。</d> ' +
      "A short pause. Then she smiles faintly.\n\n" +
      "overall_soundscape: quiet room tone, a clock ticking, paper rustle.\n" +
      "non_diegetic_music: N/A",
    durationSec: 12,
    files: { ref_audio_0: { filename: "voice.wav" } },
    toggles: { firstFrameFromPrev: true },
  });
  if (r.blocked.length) return `被误拦：\n${formatResult(r)}`;
  return true;
});

// ══════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  M0 校验器验收全过");
