/**
 * F10 衔接质检的回归验收。
 *
 * 用法：
 *   node verify-quality.mjs [--base http://127.0.0.1:19499]
 *
 * 覆盖：
 *   ① 阈值常量确实是 0.65（实测标定的那个）
 *   ② 同源切开的两段 → 判为「接得上」（不误报）
 *   ③ 无关视频之间 → 判为「接不上」（不漏报）
 *   ④ 单段 / 空数组 → 不报错
 *   ⑤ 路径不存在 → 优雅跳过（checked 减一）
 *   ⑥ 自定义阈值生效
 *   ⑦ 返回结构齐全（summary / seams / defects / rerunSuggestion）
 *   ⑧ HTTP 路由 /comfy-bridge/audit 可用
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  SSIM_THRESHOLD,
  auditCuts,
  ssimBetween,
  scanDefects,
} from './src/quality.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const BASE = getArg('--base', 'http://127.0.0.1:19499');
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
if (!TOKEN) skipWithoutToken("verify-quality.mjs");

let pass = 0;
let fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`); }
}

const FFMPEG =
  process.env.FFMPEG_PATH ??
  'D:\\主工作区\\DSH视频工作站\\packages\\dsh-editor\\bin\\ffmpeg.exe';
const WORK = 'D:\\主工作区\\DSH视频工作台\\.frames\\qtest';
const OUT = 'D:\\Comfy-Desktop\\ComfyUI-Shared\\output';

console.log('═'.repeat(58));
console.log('  F10 衔接质检验收');
console.log('═'.repeat(58));

// ─── ① 阈值 ────────────────────────────────────────────────
console.log('\n① 阈值常量');
t('SSIM_THRESHOLD === 0.65（实测标定值）', SSIM_THRESHOLD === 0.65, String(SSIM_THRESHOLD));

// ─── 准备测试素材 ──────────────────────────────────────────
fs.mkdirSync(WORK, { recursive: true });
const vids = fs.existsSync(OUT)
  ? fs.readdirSync(OUT).filter((f) => /^YZ_H3__\d+-audio\.mp4$/.test(f)).slice(0, 3)
  : [];

if (!vids.length) {
  console.log('\n  ⚠ 找不到测试视频，②~⑦ 跳过（不是失败）');
} else {
  // 造「同源切开的两段」：把第一个视频切成两半
  const src = path.join(OUT, vids[0]);
  const p1 = path.join(WORK, 'p1.mp4');
  const p2 = path.join(WORK, 'p2.mp4');
  try {
    if (!fs.existsSync(p1)) {
      execFileSync(FFMPEG, ['-y', '-i', src, '-t', '0.8', '-c', 'copy', p1], { windowsHide: true, stdio: 'ignore' });
    }
    if (!fs.existsSync(p2)) {
      execFileSync(FFMPEG, ['-y', '-ss', '0.8', '-i', src, '-c', 'copy', p2], { windowsHide: true, stdio: 'ignore' });
    }
  } catch { /* 切分失败就在下面跳过 */ }
  const haveSplit = fs.existsSync(p1) && fs.existsSync(p2);

  // ─── ② 同源切开：不该误报 ───────────────────────────────
  console.log('\n② 同源切开的两段（理想衔接，不该误报）');
  if (haveSplit) {
    const r = await auditCuts([
      { id: 'p1', name: '前半', rendered: { path: p1 } },
      { id: 'p2', name: '后半', rendered: { path: p2 } },
    ]);
    t('只有 1 处接缝', r.seams.length === 1, String(r.seams.length));
    t('判为接得上', r.seams[0]?.ok === true, `ssim=${r.seams[0]?.ssim?.toFixed(4)}`);
    t('summary 说全通过', /全部通过/.test(r.summary), r.summary);
    t('没有重跑建议', r.rerunSuggestion.length === 0, JSON.stringify(r.rerunSuggestion));
  } else {
    console.log('  ⚠ 切分失败，跳过');
  }

  // ─── ③ 无关视频：不该漏报 ───────────────────────────────
  console.log('\n③ 无关视频之间（接不上，不该漏报）');
  {
    const clips = vids.map((v, i) => ({ id: 'c' + i, name: v, rendered: { path: path.join(OUT, v) } }));
    const r = await auditCuts(clips);
    t('接缝数 = 段数-1', r.seams.length === clips.length - 1, String(r.seams.length));
    t('全部判为接不上', r.seams.every((s) => s.ok === false), r.seams.map((s) => s.ssim?.toFixed(3)).join(','));
    t('summary 报了接不上', /接缝接不上/.test(r.summary), r.summary);
    t('重跑建议 = 后 N-1 段', r.rerunSuggestion.length === clips.length - 1, JSON.stringify(r.rerunSuggestion));
  }

  // ─── ④ 边界 ─────────────────────────────────────────────
  console.log('\n④ 边界');
  {
    const a = await auditCuts([{ id: 'only', rendered: { path: path.join(OUT, vids[0]) } }]);
    t('单段 → 无需查接缝', a.seams.length === 0 && /无需查接缝/.test(a.summary), a.summary);

    const b = await auditCuts([]);
    t('空数组 → 不报错', b.ok === true && b.checked === 0, b.summary);

    const c = await auditCuts([{ id: 'x', rendered: { path: 'D:\\nope\\__not_here__.mp4' } }]);
    t('路径不存在 → 跳过不计入', c.checked === 0, `checked=${c.checked}`);
  }

  // ─── ⑤ 自定义阈值 ───────────────────────────────────────
  console.log('\n⑤ 自定义阈值');
  if (haveSplit) {
    const lo = await auditCuts([
      { id: 'p1', rendered: { path: p1 } },
      { id: 'p2', rendered: { path: p2 } },
    ], { threshold: 0.5 });
    const hi = await auditCuts([
      { id: 'p1', rendered: { path: p1 } },
      { id: 'p2', rendered: { path: p2 } },
    ], { threshold: 0.95 });
    t('阈值 0.5 → 通过', lo.seams[0]?.ok === true, `ssim=${lo.seams[0]?.ssim?.toFixed(4)}`);
    t('阈值 0.95 → 不通过', hi.seams[0]?.ok === false, `ssim=${hi.seams[0]?.ssim?.toFixed(4)}`);
    t('阈值回传到结果里', lo.threshold === 0.5 && hi.threshold === 0.95);
  }

  // ─── ⑥ 返回结构 ─────────────────────────────────────────
  console.log('\n⑥ 返回结构');
  {
    const r = await auditCuts([
      { id: 'c0', rendered: { path: path.join(OUT, vids[0]) } },
      { id: 'c1', rendered: { path: path.join(OUT, vids[1] ?? vids[0]) } },
    ]);
    for (const k of ['ok', 'threshold', 'checked', 'summary', 'seams', 'defects', 'errors', 'rerunSuggestion']) {
      t(`字段 ${k} 存在`, k in r);
    }
    const s = r.seams[0];
    for (const k of ['from', 'to', 'ssim', 'ok', 'threshold']) {
      t(`接缝字段 ${k} 存在`, s && k in s);
    }
  }

  // ─── ⑦ 子函数单独可用 ───────────────────────────────────
  console.log('\n⑦ 子函数');
  {
    const sp = await ssimBetween(
      path.join(OUT, vids[0]),
      path.join(OUT, vids[0]),
    );
    // 同一文件对同一文件 → 因首帧对齐，ssim 应为 1 或极高
    t('ssimBetween 同一文件 ≈ 1', sp.ok && sp.ssim > 0.99, `ssim=${sp.ssim?.toFixed(4)}`);

    const d = await scanDefects(path.join(OUT, vids[0]));
    t('scanDefects 有 freezes/blacks', d.ok && Array.isArray(d.freezes) && Array.isArray(d.blacks),
      `freezes=${d.freezes.length} blacks=${d.blacks.length}`);
  }
}

// ─── ⑧ HTTP 路由 ──────────────────────────────────────────
console.log('\n⑧ HTTP 路由');
{
  let cookie = '';
  if (TOKEN) {
    cookie = `dsh-auth-CK36o8O6fn6VWHrnbEp0bsjzKPKRmilHp-TBfPBH65k=${TOKEN}`;
  }
  try {
    const res = await fetch(BASE + '/comfy-bridge/audit', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips: [] }),
    });
    const j = await res.json();
    t('POST /audit 返回 200', res.status === 200);
    t('空 clips 不报错', j.ok === true, j.summary);
  } catch (err) {
    t('POST /audit 可访问', false, err.message.slice(0, 80));
  }
}

console.log('\n' + '═'.repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(' · ')}`);
  process.exit(1);
}
console.log('  F10 衔接质检验收全过');

// ★ 2026-10-19 加：跑完删掉本次用的临时目录。
//   原来 WORK 是固定路径（不是 mkdtemp），跑一次留一批文件。
//   实测清理前：.frames/qtest 2 个 1.79MB、.frames/subtest 1 个。
//   ⇒ 验收不该留垃圾（和 verify-bad-input 的「上传文件要删」同一条纪律）。
try {
  fs.rmSync(WORK, { recursive: true, force: true });
} catch { /* 删不掉不算失败 */ }
