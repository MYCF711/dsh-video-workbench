/**
 * M1 抽帧 + 首尾帧衔接的回归验收。
 *
 * 用法：
 *   node verify-frames-chain.mjs [--base http://127.0.0.1:19499]
 *
 * 为什么单独一个文件：
 *   verify-m1-http.mjs 会真的提交一次生成（约 1~5 分钟），
 *   而这两个能力（抽帧、衔接）不依赖 ComfyUI，几秒就能验完。
 *   混在一起会让「只想验抽帧」的人也得等生成。
 *
 * 覆盖：
 *   A  GET  /comfy-bridge/frame/status   → ffmpeg 就绪
 *   B  POST /comfy-bridge/frame          → 抽首帧，是合法 PNG
 *   C  POST /comfy-bridge/frame          → 抽尾帧，与首帧不同
 *   D  frame 的边界：非法 position / 不存在的文件
 *   E  POST /comfy-bridge/chain          → 单个，返回 media 对象
 *   F  POST /comfy-bridge/chain          → 批量，patched/skipped 正确
 *   G  chain 的边界：空数组 / 只有一镜 / 上一镜没产物
 *   H  幂等：同一源连抽两次，文件名相同、内容一致
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};

const BASE = getArg('--base', 'http://127.0.0.1:19499');
const PREFIX = '/comfy-bridge';
/**
 * ★ 2026-10-23 D3 去敏：token 从环境变量/约定位置读，不写死本机路径。
 *
 *   原来写的是 const COOKIE_FILE = 'C:/Users/<本机用户>/dsh-tok.txt';
 *   ⇒ 别人 clone 下来跑，全部失败且看不出是「路径没配」。
 *
 *   现在：DSH_TEST_TOKEN > DSH_TEST_TOKEN_FILE > $DSH_HOME/.test-token > 家目录约定
 *   拿不到就【跳过】而不是失败 —— 跳过=今天不适用，失败=功能坏了。
 */
import { TOKEN, skipWithoutToken } from "../tools/test-env.mjs";
if (!TOKEN) skipWithoutToken("verify-frames-chain.mjs");

let cookie = '';
if (TOKEN) {
  const tok = TOKEN;
  cookie = `dsh-auth-CK36o8O6fn6VWHrnbEp0bsjzKPKRmilHp-TBfPBH65k=${tok}`;
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? '  ' + detail : ''}`);
  }
}

async function api(p, init = {}) {
  const res = await fetch(BASE + PREFIX + p, {
    ...init,
    headers: { Cookie: cookie, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error('非 JSON: ' + text.slice(0, 200));
  }
  return { status: res.status, ok: res.ok, body };
}

/** 找一个真实的视频做测试源。找不到就整份跳过（不误报失败）。 */
function findTestVideo() {
  const dirs = [
    'D:\\Comfy-Desktop\\ComfyUI-Shared\\output',
    'D:\\主工作区\\DSH视频工作台\\docs\\evidence',
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const f = fs.readdirSync(d).find((n) => /\.(mp4|webm|mov)$/i.test(n));
    if (f) return path.join(d, f);
  }
  return null;
}

const VIDEO = findTestVideo();

console.log('═'.repeat(58));
console.log('  M1 抽帧 + 首尾帧衔接 回归验收');
console.log(`  base=${BASE}`);
console.log(`  测试视频=${VIDEO ?? '（找不到，相关项将跳过）'}`);
console.log('═'.repeat(58));

// ─── A · frame/status ───────────────────────────────────────
console.log('\n① ffmpeg 就绪状态');
try {
  const r = await api('/frame/status');
  check('GET /frame/status 返回 200', r.status === 200);
  check('ffmpeg 可用', r.body.ok === true, `bin=${String(r.body.bin ?? '').split('\\').pop()} v=${r.body.version}`);
  check('frameDir 已给出', typeof r.body.frameDir === 'string' && r.body.frameDir.length > 0, r.body.frameDir);
} catch (err) {
  check('GET /frame/status 可访问', false, err.message.slice(0, 80));
}

// ─── B/C/D/E/F/G/H ──────────────────────────────────────────
if (!VIDEO) {
  console.log('\n  ⚠ 找不到测试视频，B~H 全部跳过（不是失败）');
} else {
  // B · 首帧
  console.log('\n② 抽首帧');
  let first = null;
  try {
    const r = await api('/frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: VIDEO, position: 'first' }),
    });
    first = r.body;
    check('POST /frame 返回 200', r.status === 200);
    check('ok=true', r.body.ok === true, r.body.filename ?? r.body.error ?? '');
    check('文件真的落了盘', !!r.body.path && fs.existsSync(r.body.path),
      r.body.path ? `${(fs.statSync(r.body.path).size / 1024).toFixed(0)}KB` : '');
    // PNG magic
    if (r.body.path && fs.existsSync(r.body.path)) {
      const buf = fs.readFileSync(r.body.path);
      check('是合法 PNG', buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e, `${buf.length} B`);
    } else {
      check('是合法 PNG', false, '文件不在');
    }
  } catch (err) {
    check('POST /frame 可访问', false, err.message.slice(0, 80));
  }

  // C · 尾帧
  console.log('\n③ 抽尾帧');
  let last = null;
  try {
    const r = await api('/frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: VIDEO, position: 'last' }),
    });
    last = r.body;
    check('POST /frame 返回 200', r.status === 200);
    check('ok=true', r.body.ok === true, r.body.filename ?? r.body.error ?? '');
    if (first?.path && r.body.path && fs.existsSync(first.path) && fs.existsSync(r.body.path)) {
      const h1 = crypto.createHash('sha256').update(fs.readFileSync(first.path)).digest('hex');
      const h2 = crypto.createHash('sha256').update(fs.readFileSync(r.body.path)).digest('hex');
      check('首帧与尾帧不同（真的是两帧）', h1 !== h2, h1.slice(0, 8) + ' vs ' + h2.slice(0, 8));
    } else {
      check('首帧与尾帧不同（真的是两帧）', false, '文件不全，无法比较');
    }
  } catch (err) {
    check('POST /frame 可访问', false, err.message.slice(0, 80));
  }

  // H · 幂等
  console.log('\n④ 幂等：同源同位置抽两次');
  try {
    const r = await api('/frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: VIDEO, position: 'last' }),
    });
    check('第二次文件名与第一次相同', r.body.filename === last?.filename, r.body.filename ?? '');
    if (r.body.path && fs.existsSync(r.body.path)) {
      const h = crypto.createHash('sha256').update(fs.readFileSync(r.body.path)).digest('hex');
      const h0 = last?.path && fs.existsSync(last.path)
        ? crypto.createHash('sha256').update(fs.readFileSync(last.path)).digest('hex')
        : null;
      check('内容一致（覆盖是安全的）', h === h0);
    } else {
      check('内容一致（覆盖是安全的）', false, '文件不在');
    }
  } catch (err) {
    check('幂等检查可执行', false, err.message.slice(0, 80));
  }

  // D · 边界
  console.log('\n⑤ 边界（应该明确拒绝，不是静默成功）');
  try {
    const r = await api('/frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: VIDEO, position: 'bogus' }),
    });
    check('非法 position 被拒绝', r.body.ok === false, String(r.body.error ?? '').slice(0, 60));
  } catch (err) {
    check('非法 position 被拒绝', false, err.message.slice(0, 80));
  }
  try {
    const r = await api('/frame', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: 'D:\\nope\\__not_here__.mp4', position: 'first' }),
    });
    check('不存在的文件被拒绝', r.body.ok === false, String(r.body.error ?? '').slice(0, 60));
  } catch (err) {
    check('不存在的文件被拒绝', false, err.message.slice(0, 80));
  }

  // E · chain 单个
  console.log('\n⑥ chain 单个');
  try {
    const r = await api('/chain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prevVideo: VIDEO, slot: 'ref_image_0' }),
    });
    check('POST /chain 返回 200', r.status === 200);
    check('ok=true', r.body.ok === true, r.body.error ?? '');
    check('返回 media 对象', !!r.body.media?.filename && !!r.body.media?.path, r.body.media?.filename ?? '');
    check('media 文件真的在', !!r.body.media?.path && fs.existsSync(r.body.media.path));
    check('slot 正确回传', r.body.slot === 'ref_image_0');
  } catch (err) {
    check('POST /chain 可访问', false, err.message.slice(0, 80));
  }

  // F · chain 批量
  console.log('\n⑦ chain 批量（3 镜，只有第 1 镜有产物）');
  try {
    const r = await api('/chain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clips: [
          { id: 'c1', rendered: { path: VIDEO } },
          { id: 'c2' },
          { id: 'c3' },
        ],
        slot: 'ref_image_0',
      }),
    });
    check('返回 200', r.status === 200);
    check('patched=1（只接上 c2）', r.body.patched === 1, `patched=${r.body.patched} skipped=${r.body.skipped}`);
    check('skipped=1（c3 的上一镜没产物）', r.body.skipped === 1);
    check('details 有 2 条', Array.isArray(r.body.details) && r.body.details.length === 2);
    const c2 = r.body.details?.find((d) => d.clip === 'c2');
    check('c2 的来源是 c1', c2?.from === 'c1', c2?.filename ?? '');
  } catch (err) {
    check('chain 批量可访问', false, err.message.slice(0, 80));
  }

  // G · chain 边界
  console.log('\n⑧ chain 边界');
  try {
    const r = await api('/chain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips: [], slot: 'ref_image_0' }),
    });
    check('空数组不报错', r.status === 200 && r.body.ok === true, `patched=${r.body.patched}`);
  } catch (err) {
    check('空数组不报错', false, err.message.slice(0, 80));
  }
  try {
    const r = await api('/chain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips: [{ id: 'only' }], slot: 'ref_image_0' }),
    });
    check('只有一镜不报错', r.status === 200 && r.body.patched === 0);
  } catch (err) {
    check('只有一镜不报错', false, err.message.slice(0, 80));
  }
  try {
    const r = await api('/chain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prevVideo: '', slot: 'ref_image_0' }),
    });
    check('prevVideo 为空被拒绝', r.body.ok === false, String(r.body.error ?? '').slice(0, 50));
  } catch (err) {
    check('prevVideo 为空被拒绝', false, err.message.slice(0, 80));
  }
}

// ══════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(' · ')}`);
  process.exit(1);
}
console.log('  抽帧 + 衔接验收全过');
