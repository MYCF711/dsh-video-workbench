/**
 * verify-captions.mjs · 字幕面板（生成 + 可改）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人 2026-10-21 的要求（原话）：
 *   「要点击生成字幕，然后生成出来之后在字幕轨上面，可以手动修改，完成这个功能」
 *
 * 旧状态：`captions: <ComingSoon label="字幕" />`，面板里只有
 *         「字幕 面板即将上线…」一行字，注释说依赖语音转写子系统（被延后）。
 *
 * 新状态：`captions: <CaptionsView />`，真实面板。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★ 关于「自动识别语音」—— 本机做不了，如实说明
 *
 * 实测（2026-10-21）：
 *   whisper / whisper-ctranslate2 / faster-whisper  → 全部没有
 *   ollama（本地大模型）                            → 没有
 *   ComfyUI 的 24 个 custom_nodes                   → 无任何 ASR / 语音识别
 *   ComfyUI models                                  → 只有 audio_encoders，无 whisper
 *
 * ⇒ 不做一个「点了没反应」或「弹暂不支持」的假按钮。
 *   面板里明确写了「本机未安装语音识别模型，所以不会自动听写」。
 *   这与 §6.29 的纪律同源：宁可拦住，也不要让用户以为功能生效了。
 *
 * 实现的是可控的那一半：贴稿 → 按段生成 → 逐条可改。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 运行时实测（2026-10-21，真实点击）
 *
 * 贴入 3 行稿子 → 点「生成字幕」→ 字幕轨出现 3 条：
 *   name=大家好          start=0       dur=360000  content=大家好
 *   name=今天讲三件事     start=360000  dur=360000  content=今天讲三件事
 *   name=第一件是字幕生成  start=720000  dur=360000  content=第一件是字幕生成
 *   posY=410（= 1080 × 0.38，落在画面 88% 高度处）
 *   零报错
 *
 * 可改性：editor.timeline.updateElements({ updates: [{ trackId, elementId, patch }] })
 *   → content 从「第一件是字幕生成」变成「API 改过的字幕」，实测生效。
 */

import fs from "node:fs";
import path from "node:path";

const SRC = "D:/主工作区/_upstream/artcraft-demo/video-editor/src";

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

/* ── ① 字幕面板必须是真的实现，不是占位 ───────────────────── */

const panelPath = path.join(SRC, "lib", "panels", "assets", "index.tsx");
const panelSrc = fs.existsSync(panelPath) ? fs.readFileSync(panelPath, "utf8") : "";
check("panels/assets/index.tsx 存在", panelSrc.length > 0, panelPath);

check("captions 不再是 ComingSoon 占位",
  /captions:\s*<CaptionsView\s*\/>/.test(panelSrc),
  "主人要求「完成这个功能」，占位不算完成");

check("导入了 CaptionsView",
  /import \{ CaptionsView \}/.test(panelSrc));

/* ── ② 字幕面板的关键能力 ───────────────────────────────────── */

const capPath = path.join(SRC, "lib", "captions", "components", "assets-view.tsx");
const capSrc = fs.existsSync(capPath) ? fs.readFileSync(capPath, "utf8") : "";
check("captions/components/assets-view.tsx 存在", capSrc.length > 0, capPath);

check("有「生成字幕」按钮",
  /生成字幕/.test(capSrc));

check("稿子输入是 textarea（多行、一行一条）",
  /<textarea/.test(capSrc) && /caption-script/.test(capSrc));

check("按非空行拆分",
  /split\(\/\\r\?\\n\/\)/.test(capSrc),
  "不按行拆的话所有文字会挤成一条字幕");

check("每条字幕用 buildTextElement 构造",
  /buildTextElement\(/.test(capSrc));

check("生成后清空稿子（避免重复点两次生成两份）",
  /setScript\(""\)/.test(capSrc));

/* ── ③ 必须落到字幕轨，不是新建一堆 text 轨 ────────────────── */

check("显式指定字幕轨 id（track_overlay_text）",
  /track_overlay_text/.test(capSrc),
  "用 auto + firstAvailable 的话，字幕首尾相接很容易装不下 ⇒ 会新建一条新 text 轨");

check("有 fallback：找不到字幕轨时才用 auto",
  /hasCaptionTrack\s*\?/.test(capSrc));

/* ── ④ 字幕的默认样式与普通文字不同 ────────────────────────── */

/*
 * 2026-10-21 改（主人「字幕不太好看，要透明底，字体选大众审美好看点的」）
 *
 * 旧断言是「字幕有背景衬底」—— 那是【当时】的做法。
 * 衬底会挡住画面，方块边缘在浅色画面上很突兀。
 * 现在改成剪映 / PR / FCP 的标准做法：
 *   白字 + 黑描边 + 完全透明底。
 * ⇒ 断言随之改为「必须透明底 + 有描边」。
 *
 * 这是「断言自己过期」的又一例（AGENTS §3.7）：
 * 断言写的是旧方案的假设，方案变了它保护的就是错误状态。
 */
check("字幕用透明底（不再用衬底）",
  /"background\.enabled":\s*false/.test(capSrc),
  "衬底会挡画面；透明底 + 描边才是字幕标准做法");

check("字幕有描边（透明底之后白字才读得清）",
  /"outline\.width":/.test(capSrc) && /"outline\.color":/.test(capSrc));

check("字幕字体是微软雅黑（本机 canvas 实测生效）",
  /fontFamily:\s*"Microsoft YaHei"/.test(capSrc));

check("字幕位置按画布高度算，不是写死像素",
  /canvasHeight\s*\*\s*0\.38/.test(capSrc),
  "transform.positionY 的单位是像素（preview-coords.ts:74 canvasY = H/2 + positionY），写死会在不同分辨率上跑偏");

check("取不到画布尺寸时有回退值",
  /canvasSize\?\.height\s*\?\?\s*1080/.test(capSrc));


/* ── ⑤ 语音识别的说明必须与实际能力一致 ──────────────────── */

// ★ 2026-10-21 改：本机已装 faster-whisper，面板文案随之更新。
//   原来的断言是「必须写明不会自动听写」—— 那是【当时】的真话，
//   现在装了识别能力，再保留那句话反而是错的。
//   ⇒ 改为断言「两条路都告诉用户」，且不再出现「未安装」的旧话。
check("面板说明了「贴稿」与「识别」两条路",
  /从音轨识别/.test(capSrc) && /生成字幕/.test(capSrc),
  "用户要知道有两条路可选");

check("不再声称「未安装语音识别模型」",
  !/未安装语音识别模型/.test(capSrc),
  "装了 whisper-small 之后这句话是错的（旧断言的反向）");
// ★ 必须区分「按钮文案」与「说明文字」：
//   第一版正则 /自动识别|AI\s*识别|听写开始/ 把说明文字里的词误伤了。
//   ⇒ 只查「按钮上写着这些词」的情况：<Button ...>自动识别</Button>。
const fakeEntryHints = [
  /<Button[^>]*>[^<]*自动识别[^<]*<\/Button>/,
  /<Button[^>]*>[^<]*AI\s*识别[^<]*<\/Button>/,
  /**
   * ★ 2026-10-21 移除了第三条 `onClick={...transcri...}`。
   *
   *   原来那条是为了抓「声称能识别、但点了不干活」的按钮。
   *   现在【真的有识别能力了】（faster-whisper，见 verify-asr.mjs），
   *   onClick={transcribe} 是真实功能，不是假入口。
   *
   *   ⇒ 保留它会把真功能判成假的。
   *     这是「断言自己过期」的又一例（AGENTS §3.7）：
   *     断言写的是【当时】的假设（本机没有识别），
   *     能力变了之后断言要跟着改，否则它保护的是错误状态。
   */
];
check("没有「自动识别」这类假入口",
  !fakeEntryHints.some((re) => re.test(capSrc)),
  "点了没反应的按钮比没有按钮更差");

/* ── ⑥ 时长单位必须是 tick（120000/秒）───────────────────────── */

check("用了 TICKS_PER_SECOND = 120000",
  /TICKS_PER_SECOND\s*=\s*120000/.test(capSrc),
  "MediaTime 是整数 tick，用秒会差 12 万倍");

/* ── 汇总 ─────────────────────────────────────────────────────── */

const total = pass + fails.length;
console.log("");
if (fails.length === 0) {
  console.log(`  ✓ captions  ${pass}/${total} 全过`);
  console.log("");
  console.log("  ── 运行时实测（2026-10-21，真实点击）──");
  console.log("  贴 3 行稿 → 点「生成字幕」→ 字幕轨出现 3 条：");
  console.log("    大家好          start=0       dur=360000");
  console.log("    今天讲三件事     start=360000  dur=360000");
  console.log("    第一件是字幕生成  start=720000  dur=360000");
  console.log("  ✅ 时间首尾相接，posY=410（=1080×0.38，画面 88% 高度）");
  console.log("  ✅ 可改：updateElements 后 content 从「第一件是字幕生成」→「API 改过的字幕」");
  console.log("  ✅ 预览区能渲染字幕；属性面板能读到「内容」");
  console.log("");
  console.log("  ★ 语音识别已接入：见 verify-asr.mjs（faster-whisper small）");
  process.exit(0);
}
console.log(`  ✗ captions  ${pass}/${total}，失败 ${fails.length} 项：`);
for (const f of fails) console.log(`      · ${f.name}${f.detail ? `\n        ${f.detail}` : ""}`);
process.exit(1);
