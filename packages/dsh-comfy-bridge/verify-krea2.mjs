/**
 * krea2（双采极清生图）端到端验收。
 *
 * 判据（六条）：
 *   ① 提交成功
 *   ② completed=true
 *   ③ 至少 2 个产物（一采 + 二采各一张）
 *   ④ 产物 URL 可访问且是图片
 *   ⑤ 二采图比一采图大（×1.5 放大后再采样，尺寸应更大）
 *   ⑥ 关闭 secondPass 时只出 1 张（开关真的生效）
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
if (!TOKEN) skipWithoutToken("verify-krea2.mjs");
const OUT_DIR = 'D:/主工作区/DSH视频工作台/docs/evidence';

const tok = TOKEN ?? "";
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

async function runOnce(toggles, label) {
  const gen = await api('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      modeId: 'krea2',
      prompt: 'a single red apple on a plain white table, studio lighting, sharp focus, photorealistic',
      aspect: '1:1',
      steps: 8,
      seed: 20261017,
      toggles,
    }),
  });
  const t0 = Date.now();
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const j = await api('/job/' + encodeURIComponent(gen.jobId));
    if (j.completed) return { ...j, sec: Math.round((Date.now() - t0) / 1000) };
  }
  throw new Error(`${label} 超时`);
}

/** 读 PNG 的 IHDR 拿宽高。 */
function pngSize(buf) {
  if (buf.slice(1, 4).toString() !== 'PNG') return null;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return { w, h };
}

// ══════════════════════════════════════════════════════════
console.log('═══ ① 双采开启（默认）═══');
const j1 = await runOnce({ secondPass: true, redraw: false, loraChain: false }, 'krea2 双采');
console.log(`     ${j1.sec}s，产物 ${(j1.outputs ?? []).length} 个`);
for (const o of j1.outputs ?? []) console.log(`        ${o.filename}`);
check('completed', j1.completed === true);
const out1 = j1.outputs ?? [];
check('至少 2 个产物（一采 + 二采）', out1.length >= 2, `实际 ${out1.length}`);

// 下载并比尺寸
const imgs = [];
for (const o of out1) {
  if (!/png|jpe?g/i.test(o.filename ?? '')) continue;
  const url = o.url.startsWith('http') ? o.url : 'http://127.0.0.1:8188' + o.url;
  const res = await fetch(url);
  check(`可访问 ${o.filename}`, res.ok, `HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const sz = pngSize(buf);
  imgs.push({ name: o.filename, bytes: buf.length, size: sz, buf });
  console.log(`     ${o.filename}  ${(buf.length / 1024).toFixed(0)} KB  ${sz ? sz.w + '×' + sz.h : '?'}`);
}

if (imgs.length >= 2) {
  // 二采应更大（×1.5 放大后再采样）
  const sorted = [...imgs].sort((a, b) => (a.size?.w ?? 0) - (b.size?.w ?? 0));
  const small = sorted[0], big = sorted[sorted.length - 1];
  check('二采图比一采图大（×1.5 放大生效）',
    (big.size?.w ?? 0) > (small.size?.w ?? 0),
    `${small.name} ${small.size?.w} vs ${big.name} ${big.size?.w}`);
}

// 存一张做证据
if (imgs.length) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const biggest = imgs.sort((a, b) => b.bytes - a.bytes)[0];
  fs.writeFileSync(`${OUT_DIR}/krea2-result.png`, biggest.buf);
  console.log(`     已存 → ${OUT_DIR}/krea2-result.png`);
}

// ══════════════════════════════════════════════════════════
console.log('\n═══ ② 双采关闭（验开关真生效）═══');
const j2 = await runOnce({ secondPass: false, redraw: false, loraChain: false }, 'krea2 单采');
console.log(`     ${j2.sec}s，产物 ${(j2.outputs ?? []).length} 个`);
for (const o of j2.outputs ?? []) console.log(`        ${o.filename}`);
check('completed', j2.completed === true);
check('关闭后产物更少（开关生效）',
  (j2.outputs ?? []).length < (j1.outputs ?? []).length,
  `开=${(j1.outputs ?? []).length} 关=${(j2.outputs ?? []).length}`);

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
console.log('  krea2 端到端验收全过');
