/**
 * F9 字幕的回归验收。
 *
 * 用法：
 *   node verify-subtitle.mjs [--base http://127.0.0.1:19499]
 *
 * 覆盖：
 *   A  srtTime 格式化边界（0 / 小数 / 跨分 / 跨时 / 负数）
 *   B  toSrt 生成合法 SRT（序号连续、时间轴格式、空白句过滤）
 *   C  hasAudioStream 正确分辨有无音轨
 *   D  transcribe 真实转写（有音轨的视频 → 出文本与 SRT）
 *   E  无音轨视频 → noAudio=true（不是报错）
 *   F  burnSubtitles 烧硬字幕（产物与原件不同、时长一致）
 *   G  HTTP 路由 /subtitle/status /transcribe /burn
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  srtTime,
  toSrt,
  hasAudioStream,
  transcribe,
  burnSubtitles,
  asrStatus,
} from './src/subtitle.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const BASE = getArg('--base', 'http://127.0.0.1:19499');
const COOKIE_FILE = 'C:/Users/Administrator/dsh-tok.txt';
const FFMPEG = process.env.FFMPEG_PATH ?? 'D:\\主工作区\\DSH视频工作站\\packages\\dsh-editor\\bin\\ffmpeg.exe';
const WORK = 'D:\\主工作区\\DSH视频工作台\\.frames\\subtest';

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`); }
}

console.log('═'.repeat(58));
console.log('  F9 字幕验收');
console.log('═'.repeat(58));

// ─── A · srtTime ───────────────────────────────────────────
console.log('\n① srtTime 格式化');
t('0 → 00:00:00,000', srtTime(0) === '00:00:00,000', srtTime(0));
t('1.4 → 00:00:01,400', srtTime(1.4) === '00:00:01,400', srtTime(1.4));
t('61.5 → 00:01:01,500', srtTime(61.5) === '00:01:01,500', srtTime(61.5));
t('3661.007 → 01:01:01,007', srtTime(3661.007) === '01:01:01,007', srtTime(3661.007));
t('负数夹到 0', srtTime(-5) === '00:00:00,000', srtTime(-5));
t('非数字夹到 0', srtTime('abc') === '00:00:00,000', srtTime('abc'));

// ─── B · toSrt ─────────────────────────────────────────────
console.log('\n② toSrt');
{
  const segs = [
    { start: 0, end: 1.4, text: '好吧 那我先等着' },
    { start: 1.4, end: 3.2, text: '第二句' },
    { start: 3.2, end: 4.0, text: '   ' },     // 空白应被过滤
    { start: 4.0, end: 5.0, text: '  第四句  ' }, // 前后空白应被 trim
  ];
  const srt = toSrt(segs);
  const lines = srt.split('\n');
  t('过滤掉空白句（只剩 3 条）', (srt.match(/-->/g) ?? []).length === 3);
  t('序号从 1 开始且连续', lines[0] === '1' && /^2$/.test(lines[4] ?? ''));
  t('时间轴格式正确', /00:00:00,000 --> 00:00:01,400/.test(srt), lines[1]);
  t('文本被 trim', srt.includes('第四句') && !srt.includes('  第四句'));
  t('空数组 → 空字符串', toSrt([]) === '');
  t('null → 空字符串', toSrt(null) === '');
}

// ─── 准备 ──────────────────────────────────────────────────
fs.mkdirSync(WORK, { recursive: true });
const WITH_AUDIO = 'D:\\Comfy-Desktop\\ComfyUI-Shared\\output\\YZ_H3__00001-audio.mp4';
const NO_AUDIO = 'D:\\主工作区\\DSH视频工作站\\docs\\evidence\\roughcut-test\\video-only.mp4';

// ─── C · hasAudioStream ───────────────────────────────────
console.log('\n③ 音轨探测');
if (fs.existsSync(WITH_AUDIO)) {
  t('有音轨的视频 → true', await hasAudioStream(WITH_AUDIO));
} else {
  console.log('  ⚠ 找不到有音轨的视频，跳过');
}
if (fs.existsSync(NO_AUDIO)) {
  t('无音轨的视频 → false', (await hasAudioStream(NO_AUDIO)) === false);
} else {
  console.log('  ⚠ 找不到无音轨的视频，跳过');
}
t('不存在的文件 → false', (await hasAudioStream('D:\\nope\\__x__.mp4')) === false);

// ─── D/E · transcribe ─────────────────────────────────────
if (fs.existsSync(WITH_AUDIO)) {
  console.log('\n④ 真实转写');
  const r = await transcribe({ file: WITH_AUDIO });
  t('ok=true', r.ok === true, r.error ?? '');
  t('检测到语言', typeof r.language === 'string' && r.language.length > 0, r.language);
  t('有片段', Array.isArray(r.segments) && r.segments.length > 0, `count=${r.count}`);
  t('片段带 start/end/text', r.segments?.every((s) => 'start' in s && 'end' in s && 'text' in s));
  t('SRT 非空且格式对', /^\d+\n\d{2}:\d{2}:\d{2},\d{3} --> /.test(r.srt ?? ''));
  t('text 是片段拼接', r.text === r.segments.map((s) => s.text).join(''));
  console.log(`     识别结果：${(r.text ?? '').slice(0, 40)}`);
}

if (fs.existsSync(NO_AUDIO)) {
  console.log('\n⑤ 无音轨视频');
  const r = await transcribe({ file: NO_AUDIO });
  t('ok=false', r.ok === false);
  t('标记 noAudio=true', r.noAudio === true);
  t('错误文案是人话', /没有音轨/.test(r.error ?? ''), r.error);
}

console.log('\n⑥ 边界');
{
  const r = await transcribe({ file: 'D:\\nope\\__not_here__.mp4' });
  t('文件不存在 → ok=false', r.ok === false && /不存在/.test(r.error ?? ''), r.error);
}

// ─── F · burnSubtitles ────────────────────────────────────
if (fs.existsSync(WITH_AUDIO)) {
  console.log('\n⑦ 烧硬字幕');
  const tr = await transcribe({ file: WITH_AUDIO });
  const srtPath = path.join(WORK, 'burn-test.srt');
  fs.writeFileSync(srtPath, tr.srt, 'utf8');
  const b = await burnSubtitles({ video: WITH_AUDIO, srt: srtPath });
  t('ok=true', b.ok === true, b.error ?? '');
  if (b.ok) {
    t('产物存在', fs.existsSync(b.path), b.filename);
    const sz = fs.statSync(b.path).size;
    t('产物非空', sz > 10000, `${(sz / 1024).toFixed(0)}KB`);
    // 时长应与原件一致（±0.2s）
    const probe = (f) => {
      try {
        execFileSync(FFMPEG, ['-i', f], { windowsHide: true, stdio: 'ignore' });
      } catch { /* 正常，-i 无输出必非 0 */ }
      try {
        const out = execFileSync(FFMPEG, ['-i', f], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const m = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(String(out));
        return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
      } catch (e) {
        const m = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(String(e?.stderr ?? ''));
        return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
      }
    };
    const d1 = probe(WITH_AUDIO);
    const d2 = probe(b.path);
    t('时长与原件一致（±0.2s）', d1 != null && d2 != null && Math.abs(d1 - d2) < 0.2,
      `原=${d1?.toFixed(2)}s 新=${d2?.toFixed(2)}s`);
  }
  t('视频不存在 → 明确报错', (await burnSubtitles({ video: 'D:\\nope\\a.mp4', srt: srtPath })).ok === false);
  t('字幕不存在 → 明确报错', (await burnSubtitles({ video: WITH_AUDIO, srt: 'D:\\nope\\a.srt' })).ok === false);
}

// ─── G · HTTP ─────────────────────────────────────────────
console.log('\n⑧ HTTP 路由');
let cookie = '';
if (fs.existsSync(COOKIE_FILE)) {
  cookie = `dsh-auth-CK36o8O6fn6VWHrnbEp0bsjzKPKRmilHp-TBfPBH65k=${fs.readFileSync(COOKIE_FILE, 'utf8').trim()}`;
}
try {
  const res = await fetch(BASE + '/comfy-bridge/subtitle/status', { headers: { Cookie: cookie } });
  const j = await res.json();
  t('GET /subtitle/status 200', res.status === 200);
  t('报告 fasterWhisper 版本', typeof j.fasterWhisper === 'string', j.fasterWhisper);
} catch (err) {
  t('GET /subtitle/status 可访问', false, err.message.slice(0, 80));
}
if (fs.existsSync(WITH_AUDIO)) {
  try {
    const res = await fetch(BASE + '/comfy-bridge/subtitle/transcribe', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: WITH_AUDIO }),
    });
    const j = await res.json();
    t('POST /subtitle/transcribe 200', res.status === 200);
    t('返回 srt', typeof j.srt === 'string' && j.srt.length > 0);
  } catch (err) {
    t('POST /subtitle/transcribe 可访问', false, err.message.slice(0, 80));
  }
}

console.log('\n' + '═'.repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(' · ')}`);
  process.exit(1);
}
console.log('  F9 字幕验收全过');

// ★ 2026-10-19 加：跑完删掉本次用的临时目录。
//   原来 WORK 是固定路径（不是 mkdtemp），跑一次留一批文件。
//   实测清理前：.frames/qtest 2 个 1.79MB、.frames/subtest 1 个。
//   ⇒ 验收不该留垃圾（和 verify-bad-input 的「上传文件要删」同一条纪律）。
try {
  fs.rmSync(WORK, { recursive: true, force: true });
} catch { /* 删不掉不算失败 */ }
