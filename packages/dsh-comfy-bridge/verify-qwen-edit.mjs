/**
 * qwen21-edit 端到端验收 —— 经 M1 HTTP 路由真跑一次改图。
 *
 * 判据（五条，全要）：
 *   ① 提交成功，拿到 jobId
 *   ② completed=true
 *   ③ outputs.length > 0
 *   ④ 产物 URL 可访问（HTTP 200 + image/*）
 *   ⑤ 产物尺寸与输入不同（证明真的「改」了，不是原图透传）
 *
 * 准备：用 krea2 先造一张原图 → 下载 → 作 qwen21-edit 的 ref_image_0
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

const BASE = 'http://127.0.0.1:19499';
const PREFIX = '/comfy-bridge';
const COOKIE_FILE = 'C:/Users/Administrator/dsh-tok.txt';
const OUT_DIR = 'D:/主工作区/DSH视频工作台/docs/evidence';

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
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error ?? text.slice(0, 200)}`);
  return body;
}

async function waitJob(jobId, label, maxSec = 300) {
  const t0 = Date.now();
  for (let i = 0; i < maxSec / 2; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const j = await api('/job/' + encodeURIComponent(jobId));
    const sec = ((Date.now() - t0) / 1000).toFixed(0);
    if (i % 5 === 0) console.log(`     ${label} ${sec}s completed=${j.completed} status=${j.statusStr ?? 'running'}`);
    if (j.completed) return { ...j, sec: Number(sec) };
  }
  throw new Error(`${label} 超时 ${maxSec}s`);
}

async function downloadTo(url, dest) {
  const res = await fetch(url.startsWith('http') ? url : 'http://127.0.0.1:8188' + url);
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(dest.replace(/[^/\\]+$/, ''), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}

// ══════════════════════════════════════════════════════════
console.log('═══ 前置：确认 4 个模式都在 ═══');
const modes = await api('/modes');
console.log(`     ${modes.map((m) => m.id).join(', ')}`);
check('有 qwen21-edit', modes.some((m) => m.id === 'qwen21-edit'));

// ══════════════════════════════════════════════════════════
console.log('\n═══ 第 1 步：用 krea2 造一张原图 ═══');
const seed1 = await api('/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    modeId: 'krea2',
    prompt: 'a young woman standing in a sunlit room, full body, plain gray wall background, photorealistic, simple white t-shirt and blue jeans',
    aspect: '9:16',
    steps: 8,
    seed: 20261017,
  }),
});
console.log(`     jobId=${seed1.jobId}`);
const j1 = await waitJob(seed1.jobId, 'krea2');
check('krea2 completed', j1.completed === true);
check('krea2 有产物', (j1.outputs ?? []).length > 0, `实际 ${(j1.outputs ?? []).length}`);

const srcOut = (j1.outputs ?? []).find((o) => /png|jpe?g/i.test(o.filename ?? ''));
if (!srcOut) {
  check('找到图片产物', false);
  process.exit(1);
}
const srcPath = `${OUT_DIR}/qwen-edit-src.png`;
const srcBytes = await downloadTo(srcOut.url, srcPath);
console.log(`     原图 ${srcBytes} 字节 → ${srcPath}`);
check('原图已下载（> 10KB）', srcBytes > 10240, `实际 ${srcBytes}`);

// ══════════════════════════════════════════════════════════
console.log('\n═══ 第 2 步：用 qwen21-edit 改这张图 ═══');
const srcB64 = fs.readFileSync(srcPath).toString('base64');
const gen = await api('/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    modeId: 'qwen21-edit',
    prompt: 'change the clothing to a red traditional Chinese silk dress with gold embroidery',
    steps: 25,
    seed: 20261018,
    files: {
      ref_image_0: { base64: srcB64, filename: 'src.png' },
    },
  }),
});
console.log(`     jobId=${gen.jobId}  promptId=${gen.promptId}  nodes=${gen.nodes}`);
check('qwen21-edit 提交成功', typeof gen.jobId === 'string' && gen.jobId.length > 0);
check('节点数 > 10', gen.nodes > 10, `实际 ${gen.nodes}`);

const j2 = await waitJob(gen.jobId, 'qwen21-edit', 600);
check('qwen21-edit completed', j2.completed === true, `statusStr=${j2.statusStr}`);
const outs2 = j2.outputs ?? [];
console.log(`     用时 ${j2.sec}s，产物 ${outs2.length} 个：`);
for (const o of outs2) console.log(`        ${o.kind}  ${o.filename}`);
check('qwen21-edit 有产物', outs2.length > 0, '0 产物 = 「秒级成功但空」的坑');

// ══════════════════════════════════════════════════════════
console.log('\n═══ 第 3 步：验产物 ═══');
const out2 = outs2.find((o) => /png|jpe?g/i.test(o.filename ?? ''));
if (out2) {
  // ④ 产物 URL 可访问
  const url = out2.url.startsWith('http') ? out2.url : 'http://127.0.0.1:8188' + out2.url;
  const res = await fetch(url);
  check('产物 URL 可访问', res.ok, `HTTP ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  check('产物是图片', /image\//.test(ct), `content-type=${ct}`);

  // 下载对比
  const destPath = `${OUT_DIR}/qwen-edit-result.png`;
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(destPath, buf);
  console.log(`     结果 ${buf.length} 字节 → ${destPath}`);

  // ⑤ 与输入不同（字节数不同是个弱判据，但能抓「原图透传」）
  check('产物与原图不同（防原图透传）', buf.length !== srcBytes,
    `两者都是 ${srcBytes} 字节 — 疑似原图直接透传`);
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
console.log('  qwen21-edit 端到端验收全过');
