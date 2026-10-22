/**
 * M1 HTTP 路由端到端验收 —— 走真实网络，不 import 内部函数。
 *
 * 用法：
 *   node verify-m1-http.mjs [--mode krea2] [--base http://127.0.0.1:19499]
 *
 * 五项：
 *   ① GET  /comfy-bridge/health    → ok=true
 *   ② GET  /comfy-bridge/modes     → 3 个模式，字段齐
 *   ③ GET  /comfy-bridge/lengths   → 22 个合法帧数
 *   ④ POST /comfy-bridge/generate  → 拿到 jobId
 *   ⑤ GET  /comfy-bridge/job/:id   → 轮询到 completed 且有产物
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};

const BASE = getArg('--base', 'http://127.0.0.1:19499');
const MODE = getArg('--mode', 'krea2');
const PREFIX = '/comfy-bridge';
const COOKIE_FILE = 'C:/Users/Administrator/dsh-tok.txt';

// DSH 的认证 cookie
let cookie = '';
if (fs.existsSync(COOKIE_FILE)) {
  const tok = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  cookie = `dsh-auth-CK36o8O6fn6VWHrnbEp0bsjzKPKRmilHp-TBfPBH65k=${tok}`;
}

let pass = 0, fail = 0;
const failures = [];

async function api(path, init = {}) {
  const res = await fetch(BASE + PREFIX + path, {
    ...init,
    headers: { Cookie: cookie, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error('非 JSON: ' + text.slice(0, 200)); }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error ?? text.slice(0, 150)}`);
  return body;
}

function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? '\n     ' + detail : ''}`); fail++; failures.push(name); }
}

// ══════════════════════════════════════════════════════════
console.log(`═══ 目标 ${BASE}${PREFIX} ═══\n`);

/**
 * ★★ 2026-10-21 补：先探 ComfyUI 是否在线。
 *
 * —— 为什么需要：
 *   本脚本的 ① ~ ③ 是【路由 / 元数据】检查，不碰 ComfyUI；
 *   ④ ⑤ 是【真提交 + 轮询】，必须有 ComfyUI 在线。
 *
 *   之前的写法不区分这两类，所以 ComfyUI 一关（主人明确指示关的），
 *   ④⑤ 必然失败，报「generate 可达 ❌ / 有 jobId 可轮询 ❌」——
 *   看起来像 M1 坏了，实际是【环境不具备】。
 *
 *   「环境不具备」和「功能坏了」必须分开报，否则每次跑验收都要人工判断
 *   哪些红是真的。这条纪律与 verify-bad-input 的符号检查同源
 *   （那里也是把校验逻辑和网络可达性耦合，一起修的）。
 *
 * —— 判据：GET /health 的 ok 反映 ComfyUI 可达性；
 *          再用 8188 直连兜一次（有些配置下 health 不探 ComfyUI）。
 */
let comfyOnline = false;
try {
  const h = await api('/health');
  comfyOnline = h?.ok === true;
} catch { /* 下面直连再试 */ }
if (!comfyOnline) {
  try {
    const r = await fetch('http://127.0.0.1:8188/system_stats', {
      signal: AbortSignal.timeout(2000),
    });
    comfyOnline = r.ok;
  } catch { /* 确认离线 */ }
}
if (!comfyOnline) {
  console.log('  ⚠ ComfyUI 离线（127.0.0.1:8188 不可达）');
  console.log('    ④⑤ 需要真实提交，本次【跳过】—— 这不是失败，是环境不具备。');
  console.log('    要跑完整验收请先启动 ComfyUI。\n');
}

console.log('═══ ① health ═══');
let health;
try {
  health = await api('/health');
  console.log(`     ok=${health.ok}  comfyui=${health.comfyuiVersion}  modes=${health.modes}`);
  check('health.ok === true', health.ok === true, `实际 ${health.ok}`);
  check('报告 ComfyUI 版本', typeof health.comfyuiVersion === 'string', JSON.stringify(health.comfyuiVersion));
  check('报告 ≥3 个模式', health.modes >= 3, `实际 ${health.modes}`);
} catch (err) {
  check('health 可达', false, err.message);
}

console.log('\n═══ ② modes ═══');
let modes = [];
try {
  modes = await api('/modes');
  check('≥3 个模式', modes.length >= 3, `实际 ${modes.length}`);
  // ★ 不硬编码总数 —— 加工作流不该让断言变红。判据是三个核心职责齐全。
  const idSet = new Set(modes.map((m) => m.id));
  const need = ['krea2', 'qwen21-edit', 'yz'];
  const missing = need.filter((x) => !idSet.has(x));
  check('三个核心职责齐全（krea2/qwen21-edit/yz）', missing.length === 0,
    `缺 ${missing.join(',')}（实际有 ${[...idSet].sort().join(',')}）`);
  const lacking = modes.filter((m) => !m.label || !m.defaults);
  check('每个模式有 label 与 defaults', lacking.length === 0, `缺: ${lacking.map((m) => m.id)}`);
  const yz = modes.find((m) => m.id === 'yz');
  // yz.bind.json 声明了 10 个 media 槽：
  //   ref_image_0..5 (6) + ref_video_0 (1) + ref_audio_0..2 (3) = 10
  check('yz 有 10 个素材槽', yz && Object.keys(yz.media ?? {}).length === 10,
    `实际 ${yz ? Object.keys(yz.media ?? {}).length : 'n/a'}`);
  check('yz 有武打开关', yz && yz.toggles && yz.toggles.wudA !== undefined);
  const krea2 = modes.find((m) => m.id === 'krea2');
  // ★ 不写死总数（AGENTS.md §3.7）—— 加开关注册不该让断言变红。
  //   判据改成「≥核心项数 且关键几项齐全」。
  {
    const ks = krea2 ? Object.keys(krea2.toggles ?? {}) : [];
    const must = ["secondPass", "redraw", "loraChain"];
    const miss = must.filter((k) => !ks.includes(k));
    check(`krea2 有 ${must.length} 个核心开关且不少于此`,
      ks.length >= must.length && miss.length === 0,
      `实际 ${ks.length} 个 [${ks.join(",")}]${miss.length ? " 缺 " + miss.join(",") : ""}`);
  }
  console.log('\n     模式摘要：');
  for (const m of modes) {
    console.log(`       ${m.id.padEnd(8)} ${String(m.label).padEnd(12)} order=${m.order ?? '-'} primary=${m.primary ?? false} media=${Object.keys(m.media ?? {}).length} toggles=${Object.keys(m.toggles ?? {}).length}`);
  }
} catch (err) {
  check('modes 可达', false, err.message);
}

console.log('\n═══ ③ lengths ═══');
try {
  const L = await api('/lengths');
  check('合法帧数 22 个', L.legal && L.legal.length === 22, `实际 ${L.legal ? L.legal.length : 'n/a'}`);
  check('首=5 末=362', L.legal[0] === 5 && L.legal.at(-1) === 362, `${L.legal[0]}..${L.legal.at(-1)}`);
  check('fps=24', L.fps === 24, `实际 ${L.fps}`);
} catch (err) {
  check('lengths 可达', false, err.message);
}

// ══════════════════════════════════════════════════════════
console.log(`\n═══ ④ 真提交（mode=${MODE}）═══`);
let jobId = null;
try {
  const r = await api('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      modeId: MODE,
      prompt: 'a plain solid blue circle centered on pure white background, minimal, flat',
      aspect: '1:1',
      steps: 4,
      toggles: {},
    }),
  });
  jobId = r.jobId;
  console.log(`     jobId=${r.jobId}`);
  console.log(`     promptId=${r.promptId}`);
  console.log(`     nodes=${r.nodes}`);
  check('返回 jobId', typeof jobId === 'string' && jobId.length > 0);
  check('返回 promptId', typeof r.promptId === 'string' && r.promptId.length > 0);
  check('节点数 > 5', r.nodes > 5, `实际 ${r.nodes}`);
} catch (err) {
  check('generate 可达', false, err.message);
}

console.log('\n═══ ⑤ 轮询产出 ═══');
if (jobId) {
  const t0 = Date.now();
  let done = false;
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const j = await api('/job/' + encodeURIComponent(jobId));
      const sec = ((Date.now() - t0) / 1000).toFixed(0);
      if (i % 5 === 0) console.log(`     ${sec}s  completed=${j.completed}  status=${j.statusStr ?? 'running'}`);
      if (j.completed) {
        done = true;
        const outs = j.outputs ?? [];
        console.log(`\n     用时 ${sec}s，产物 ${outs.length} 个：`);
        for (const o of outs.slice(0, 3)) console.log(`        ${o.kind}  ${o.filename}`);
        check('completed === true', true);
        check('产物数 > 0', outs.length > 0, `实际 ${outs.length}（「completed 但 0 产物」是已知坑）`);
        check('产物带 URL', outs.length > 0 && !!outs[0].url, JSON.stringify(outs[0] ?? {}).slice(0, 120));
        break;
      }
    } catch (err) {
      console.log(`     轮询错误：${err.message}`);
      break;
    }
  }
  if (!done) check('5 分钟内完成', false, '超时');
} else {
  check('有 jobId 可轮询', false);
}

// ══════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(' · ')}`);
  process.exit(1);
}
console.log('  M1 HTTP 端到端验收全过');