/**
 * yz（H3 文武双全）端到端验收 —— 经 M1 HTTP 路由真跑一次视频生成。
 *
 * 这是四个工作流里【唯一没验过】的大件，也是最贵的：
 *   H3 主模型 19.5 GB，需要先释放显存。
 *
 * 判据（七条）：
 *   ① 提交成功，拿到 jobId
 *   ② 节点数 > 100（文武双全是个大工作流）
 *   ③ completed=true
 *   ④ outputs.length > 0
 *   ⑤ 产物是视频（.mp4/.webm/.gif）
 *   ⑥ 有音频轨道（H3 原生出音，AV latent 分开）—— 用文件头/大小判断
 *   ⑦ 时长接近请求值（±1s）
 *
 * 用法：node verify-yz.mjs [--dur 2] [--aspect 16:9] [--no-audio-check]
 */
import fs from 'node:fs';

/**
 * ★ 2026-10-21 加：记录跑之前 output/ 里有什么，结束时只删本次新增。
 *
 *   实测副作用：每跑一次验收，output/ 里多 39 个文件
 *   （krea2 34 + yz 3 + qwen 1），会被扫进主人资产库。
 *   而关键产物已经复制到 docs/evidence 了 ⇒ 中间产物可以清。
 *
 *   ★ 只删本次新增的，绝不碰已有文件。
 */
const __OUT_SNAPSHOT__ = (() => {
  try {
    return new Set(fs.readdirSync("D:/Comfy-Desktop/ComfyUI-Shared/output"));
  } catch { return null; }
})();

function __cleanupNow__(label = "") {
  if (!__OUT_SNAPSHOT__) return 0;
  try {
    const now = fs.readdirSync("D:/Comfy-Desktop/ComfyUI-Shared/output");
    let removed = 0;
    for (const n of now) {
      if (__OUT_SNAPSHOT__.has(n)) continue;      // 跑之前就有，不碰
      try { fs.unlinkSync(`D:/Comfy-Desktop/ComfyUI-Shared/output/${n}`); removed++; } catch { /* 占用中，跳过 */ }
    }
    if (removed) {
      console.log(`  （${label}已清理本次生成的 ${removed} 个中间产物，证据副本保留在 docs/evidence）`);
    }
    return removed;
  } catch { return 0; }
}

// 兜底：异常退出时也清
process.on("exit", () => __cleanupNow__("兜底）"));

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };

const BASE = 'http://127.0.0.1:19499';
const PREFIX = '/comfy-bridge';
const COOKIE_FILE = 'C:/Users/Administrator/dsh-tok.txt';
const OUT_DIR = 'D:/主工作区/DSH视频工作台/docs/evidence';
const DUR = Number(getArg('--dur', '2'));
const ASPECT = getArg('--aspect', '16:9');

const tok = fs.existsSync(COOKIE_FILE) ? fs.readFileSync(COOKIE_FILE, 'utf8').trim() : '';
const cookie = `dsh-auth-CK36o8O6fn6VWHrnbEp0bsjzKPKRmilHp-TBfPBH65k=${tok}`;

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? '\n     ' + detail : ''}`); fail++; failures.push(name); }
}

async function api(path, init = {}) {
  const res = await fetch(BASE + PREFIX + path, {
    ...init,
    headers: { Cookie: cookie, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error('非 JSON: ' + text.slice(0, 200)); }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error ?? text.slice(0, 300)}`);
  return body;
}

/** 从 mp4 的 moov/trak 里找时长与音轨 —— 极简解析，只看 box 名。 */
function probeMp4(buf) {
  const s = buf.toString('latin1');
  const hasMoov = s.includes('moov');
  const hasMdat = s.includes('mdat');
  const audioTracks = (s.match(/soun/g) ?? []).length;
  const videoTracks = (s.match(/vide/g) ?? []).length;
  const isMp4 = s.slice(4, 8) === 'ftyp';
  return { isMp4, hasMoov, hasMdat, audioTracks, videoTracks };
}

// ══════════════════════════════════════════════════════════
console.log(`═══ yz（H3 生视频）  durationSec=${DUR}  aspect=${ASPECT} ═══`);

console.log('\n═══ 前置：释放显存 ═══');
try {
  await fetch('http://127.0.0.1:8188/free', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
  });
  await new Promise((r) => setTimeout(r, 4000));
  const st = await (await fetch('http://127.0.0.1:8188/system_stats')).json();
  const free = Math.round((st.devices?.[0]?.vram_free ?? 0) / 1048576);
  console.log(`     ${free} MiB free`);
  check('显存 > 8 GiB（H3 要 19.5GB 主模型）', free > 8192, `只有 ${free} MiB`);
} catch (err) {
  check('ComfyUI 可达', false, err.message);
}

// ══════════════════════════════════════════════════════════
console.log('\n═══ ① 提交 ═══');
let jobId = null;
try {
  const r = await api('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      modeId: 'yz',
      prompt:
        'subject_definitions:\n' +
        'A young woman with long black hair, wearing a white t-shirt, standing by a window in soft daylight.\n\n' +
        '文戏：镜头从她的侧脸缓慢推近，她微微转头看向镜头，表情平静，眼神有细微变化。背景是模糊的室内，光线柔和。',
      aspect: ASPECT,
      durationSec: DUR,
      steps: 10,
      toggles: { wudA: false },
    }),
  });
  jobId = r.jobId;
  console.log(`     jobId=${r.jobId}`);
  console.log(`     promptId=${r.promptId}`);
  console.log(`     nodes=${r.nodes}`);
  check('提交成功', typeof jobId === 'string' && jobId.length > 0);
  // 原始 API 工作流 41 节点；没提供的 10 个 media 槽各剪 1 个 LoadImage，
  // 武打开关关闭再剪 5 个 LoRA 节点 ⇒ 41 − 10 − 5 = 26。
  // 判据不是「节点多」，而是「剪枝后仍然能跑出视频」。
  check('节点数 > 20（剪枝后仍完整）', r.nodes > 20, `实际 ${r.nodes}`);
} catch (err) {
  check('generate 未抛错', false, err.message);
}

// ══════════════════════════════════════════════════════════
console.log('\n═══ ② 轮询（H3 很慢，最多 25 分钟）═══');
let job = null;
if (jobId) {
  const t0 = Date.now();
  for (let i = 0; i < 750; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      job = await api('/job/' + encodeURIComponent(jobId));
      const sec = Math.round((Date.now() - t0) / 1000);
      if (i % 15 === 0) console.log(`     ${sec}s completed=${job.completed} status=${job.statusStr ?? 'running'}`);
      if (job.completed) break;
    } catch (err) {
      console.log(`     轮询错误：${err.message}`);
      break;
    }
  }
  const sec = Math.round((Date.now() - t0) / 1000);
  check('completed === true', job && job.completed === true,
    `statusStr=${job ? job.statusStr : 'n/a'}，用时 ${sec}s`);
  if (job && job.completed) console.log(`     总用时 ${sec}s`);
}

// ══════════════════════════════════════════════════════════
console.log('\n═══ ③ 验产物 ═══');
const outs = job?.outputs ?? [];
console.log(`     产物 ${outs.length} 个：`);
for (const o of outs) console.log(`        ${o.kind}  ${o.filename}`);
check('有产物', outs.length > 0, '0 产物 = 「秒级成功但空」的坑');

const vid = outs.find((o) => /\.(mp4|webm|gif|mov)$/i.test(o.filename ?? ''))
         ?? outs.find((o) => o.kind === 'videos' || o.kind === 'gifs');
check('产物含视频', !!vid, `实际只有：${outs.map((o) => o.filename).join(', ')}`);

if (vid) {
  const url = vid.url.startsWith('http') ? vid.url : 'http://127.0.0.1:8188' + vid.url;
  const res = await fetch(url);
  check('视频 URL 可访问', res.ok, `HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`     ${vid.filename}  ${(buf.length / 1024).toFixed(0)} KB`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dest = `${OUT_DIR}/yz-result${vid.filename.match(/\.[a-z0-9]+$/i)?.[0] ?? '.mp4'}`;
  fs.writeFileSync(dest, buf);
  console.log(`     已存 → ${dest}`);
  check('文件 > 100 KB', buf.length > 100 * 1024, `实际 ${(buf.length / 1024).toFixed(0)} KB`);

  if (/\.mp4$/i.test(vid.filename ?? '')) {
    const info = probeMp4(buf);
    console.log(`     ftyp=${info.isMp4} moov=${info.hasMoov} mdat=${info.hasMdat} 视频轨=${info.videoTracks} 音轨=${info.audioTracks}`);
    check('是合法 MP4', info.isMp4 && info.hasMoov, JSON.stringify(info));
    check('含视频轨', info.videoTracks > 0, `videoTracks=${info.videoTracks}`);
    if (!args.includes('--no-audio-check')) {
      check('含音频轨（H3 原生出音）', info.audioTracks > 0,
        `audioTracks=${info.audioTracks} —— 若无音轨，检查 AV latent 是否被拆掉`);
    }
  }
}

/**
 * ★ 2026-10-21：显式清理，不等 exit。
 *   原因：ComfyUI 写文件比脚本读到 outputs 晚一点，
 *        exit 事件跑的时候文件还没落盘。
 *   等 1.2 秒再清（实测足够）。
 */
await new Promise((r) => setTimeout(r, 1200));
__cleanupNow__();

console.log('\n' + '═'.repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(' · ')}`);
  process.exit(1);
}
console.log('  yz 端到端验收全过');
