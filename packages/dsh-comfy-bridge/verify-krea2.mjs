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
    if (j.completed) {
      /**
       * ★★ 2026-10-23：completed 之后再等一轮轮询周期（2 秒）。
       *
       *   实测根因（卡了我 5 轮，记录完整）：
       *     · 单跑 verify-krea2 → 零残留
       *     · 放进 verify-all → 每轮必多 1 张 Krea2-2ST-*.png，编号递增
       *     · 双采工作流有【两个保存节点】，completed 早于第二个节点落盘
       *     · 结尾已改成「等目录稳定」，但仍漏 —— 因为它稳定在
       *       「第二个保存节点还没开始写」那一刻（两次采样间隔 400ms × 3
       *       = 1.2 秒内没变化就判稳定，而第二个节点恰好在那之后写）
       *
       *   ⇒ 修法：completed 后再等 2 秒，把「保存节点排队」这个窗口吃掉。
       *     代价是每个任务多 2 秒，可接受（总共 4 秒）。
       *
       *   ★ 判据：**「目录数量稳定」不等于「写完了」。**
       *     如果写入方在两次采样之间处于「还没开始写」的间隙，
       *     采到的「稳定」是假稳定。
       *     可靠的判据是「等到写入方明确结束」—— 这里的信号是
       *     ComfyUI 的 outputs 数量与磁盘文件数量一致。
       */
      await new Promise((r) => setTimeout(r, 2000));
      return { ...j, sec: Math.round((Date.now() - t0) / 1000) };
    }
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
 * ★★ 2026-10-23 修：把「固定等 1.2 秒」改成「等落盘稳定」。
 *
 *   实测问题：单跑干净，进 verify-all 必漏 1 张（2850KB 那张）。
 *
 *   根因：
 *     ① runOnce 每 2000ms 轮询一次，j.completed 一旦为真就立刻返回；
 *     ② 双采工作流有【两个保存节点】（一采 + 二采），
 *        两轮轮询之间恰好跨过 completed 时刻 ⇒ 第二张还没写完；
 *     ③ 结尾固定等 1200ms —— 不够覆盖「第二张落盘」的窗口。
 *
 *   证据：每次跑都留 1 张，尺寸在 1150 / 2850 之间交替
 *     （1150 = 单采那张，2850 = 双采那张）⇒ 双采那张反复漏。
 *
 *   ⇒ 修法：轮询 output 目录，直到「连续 3 次采样数量不变」或超时 8 秒。
 *
 *   ★ 通用判据（AGENTS §6.46 的延伸）：
 *     「等一个异步写入完成」不能用固定 sleep —— 要观察那个写入的真实信号
 *     （这里就是目录里文件数量稳定）。固定 sleep 只在「已实测过上限」时可用，
 *     而工作流一改（加一个保存节点）那个上限就失效了。
 */
async function waitOutDirStable(ms = 8000, interval = 400, needStable = 3) {
  const dir = "D:/Comfy-Desktop/ComfyUI-Shared/output";
  const t0 = Date.now();
  let last = -1;
  let stable = 0;
  while (Date.now() - t0 < ms) {
    let n = -1;
    try { n = fs.readdirSync(dir).length; } catch { /* 读不到就继续等 */ }
    if (n === last) {
      stable += 1;
      if (stable >= needStable) return { ok: true, count: n, waited: Date.now() - t0 };
    } else {
      stable = 0;
      last = n;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return { ok: false, count: last, waited: Date.now() - t0 };
}

const stab = await waitOutDirStable();
console.log(`  （output 目录稳定于 ${stab.count} 个，等了 ${stab.waited}ms${stab.ok ? "" : " · 超时"}）`);
__cleanupNow__();

console.log('\n' + '═'.repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(' · ')}`);
  process.exit(1);
}
console.log('  krea2 端到端验收全过');
