/**
 * 全部模块与工作流的总验收 —— 一个脚本跑完，给一张总账。
 *
 *   node verify-all.mjs           跑全部（含真生成，约 5~8 分钟）
 *   node verify-all.mjs --static  只跑离线检查（不碰 ComfyUI）
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// ★ 2026-10-18 修：两个项目在不同根目录。
//   M1（dsh-comfy-bridge）在「DSH视频工作台」，M7（dsh-editor）在「DSH视频工作站」。
//   原来 HERE 只有一个值，导致 dsh-editor 的套件全报「脚本不存在」。
const HERE = 'D:/主工作区/DSH视频工作台/packages';
const HERE2 = 'D:/主工作区/DSH视频工作站/packages';

/** 按包名解析到正确的根：dsh-editor 及其 test/ 在工作站，其余在工作台。 */
function rootOf(dir) {
  const p1 = HERE + "/" + dir;
  const p2 = HERE2 + "/" + dir;
  return fs.existsSync(p2) && !fs.existsSync(p1) ? HERE2 : HERE;
}
const STATIC = process.argv.includes('--static');
const steps = [];

/**
 * ══ 跑之前的 output 快照（供出口统一清理用）══════════════════════════
 *
 * ★ 2026-10-23：实测「单独跑各脚本零残留，放进 verify-all 就漏 1 张」，
 *   试了 6 个假设都不成立，采纳 §6.46 的「出口统一清」。
 *   这里拍基线，文件末尾按差集删。
 *
 * ★ 只拍 output —— input 已由 verify-bad-input 自己清干净（实测 115 → 115）。
 */
const OUT_BASELINE = (() => {
  try {
    return new Set(fs.readdirSync('D:/Comfy-Desktop/ComfyUI-Shared/output'));
  } catch {
    return null;   // 读不到就不清（不能因为读不到就把整个目录当新增）
  }
})();


// ★ 2026-10-19 加：跑之前先看 ComfyUI 队列是不是空闲。
//
//   实测踩到：我前面发了 5 个 32MB 生成任务占满队列，
//   紧接着跑总验收 → 「M1 HTTP 端到端」15/16 失败（超时 309 秒）。
//   单独复跑 18/18 —— 那个「失败」是我自己造的假象。
//
//   ⇒ 队列忙的时候，验收结果不可信。与其让人怀疑代码，不如先说清楚。
async function checkQueue() {
  if (STATIC) return;   // 静态模式不碰 ComfyUI
  try {
    const res = await fetch('http://127.0.0.1:8188/queue', { signal: AbortSignal.timeout(5000) });
    const j = await res.json();
    const running = (j.queue_running ?? []).length;
    const pending = (j.queue_pending ?? []).length;
    if (running || pending) {
      console.log('');
      console.log('  ⚠ ComfyUI 队列不是空的：running=' + running + ' pending=' + pending);
      console.log('    跑真生成的那几项可能超时（这不是代码的问题）。');
      console.log('    建议：等队列清空再跑，或加 --static 只跑离线检查。');
      console.log('');
    }
  } catch {
    // 桥没起来或 ComfyUI 没起 —— 后面的步骤自己会报错，这里不重复
  }
}
await checkQueue();

function run(label, dir, script, extraArgs = [], timeout = 1800000) {
  const ROOT = rootOf(dir);
  const p = `${ROOT}/${dir}/${script}`;
  if (!fs.existsSync(p)) return { label, ok: false, note: '脚本不存在' };
  const t0 = Date.now();
  const r = spawnSync('node', [script, ...extraArgs], {
    cwd: `${ROOT}/${dir}`,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const sec = ((Date.now() - t0) / 1000).toFixed(0);
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  /**
   * ★★★ 2026-10-21 修：`通过 N / M` 的两种口径互相冲突
   *
   *   多数脚本输出「通过 20 / 20」（总分）
   *   verify-canvas 输出「通过 20 / 0 失败 / 0 跳过」（分母是失败数）
   *   ⇒ 同一个正则抓到 "20 / 0"，显示成 0/20，看着像全红
   *
   *   ⇒ 判据：分母为 0 且通过数 > 0 ⇒ 那是「失败数」口径，总数应是「通过数」
   */
  /**
   * ★ 2026-10-21 修：两种输出格式都要认
   *   A) 「通过 15 / 15」            ← 多数脚本（通过在前）
   *   B) 「结果：20 通过 / 0 失败 / 0 跳过」  ← verify-canvas（数字在前）
   */
  const mB = out.match(/(\d+) 通过 \/ (\d+) 失败/);
  const mA = out.match(/通过 (\d+) \/ (\d+)/);
  const m = mB
    ? [null, mB[1], String(Number(mB[1]) + Number(mB[2]))]
    : mA;
  let sum = '?';
  if (m) {
    const p = Number(m[1]);
    const q = Number(m[2]);
    if (q < p) {
      // 分母小于通过数 ⇒ 分母是失败数，总数 = 通过数
      sum = `${p}/${p + q}`;
    } else {
      sum = `${p}/${q}`;
    }
  }
  const allPass = r.status === 0;
  return { label, ok: allPass, sum, sec, note: allPass ? '' : sum };
}

console.log('═'.repeat(64));
console.log('  DSH 视频工作台 · 总验收');
console.log('═'.repeat(64));
console.log(`  实例 http://127.0.0.1:19499/comfy-bridge`);
console.log(`  模式 ${STATIC ? '（静态模式，不碰 ComfyUI）' : '全部'}`);
console.log('');

// ── M1 离线 ──
steps.push(run('M1 离线（bind 层 / 帧网格 / 坏 bind 报错）', 'dsh-comfy-bridge', 'verify-m1.mjs', ['--skip-gen']));

// ── M1 HTTP ──
steps.push(run('M1 HTTP 端到端（health/modes/lengths/generate/job）', 'dsh-comfy-bridge', 'verify-m1-http.mjs'));

// ── M1 抽帧 + 衔接（2026-10-18 新增，不依赖 ComfyUI）──
steps.push(run('M1 抽帧 + 首尾帧衔接（ffmpeg / chain 边界）', 'dsh-comfy-bridge', 'verify-frames-chain.mjs'));

// ── M1 衔接质检 F10（2026-10-18 新增，纯 ffmpeg）──
steps.push(run('M1 衔接质检（SSIM 接缝 / 卡帧 / 黑场 / 重跑建议）', 'dsh-comfy-bridge', 'verify-quality.mjs'));

// ── M2 H3 标签（纯函数，离线）──
steps.push(run('M2 H3 参考标签（用途映射 / Subject-Picture 规则 / 警告）', 'dsh-comfy-workbench-tab', 'verify-h3-labels.mjs'));
steps.push(run('M2 H3 警告触发（每条都要能出、也要能不误出）', '.', 'verify-h3-warnings.mjs'));
steps.push(run('M2 资产库（改名/别名/收藏/回收站/角色标签 45 项）', 'dsh-comfy-workbench-tab', 'verify-assets.mjs'));
steps.push(run('M2 LLM 起名 + 规则降级（LLM 不可用也给草稿）', 'dsh-comfy-workbench-tab', 'verify-suggest-name.mjs'));
steps.push(run('M2 画布（卡片合并 / 视野 / lightbox）', 'dsh-comfy-workbench-tab', 'verify-canvas.mjs'));
steps.push(run('Toggle 依赖反查（改 delete 前必跑）', 'dsh-comfy-bridge', 'tools/check-toggle-deps.mjs'));

// ── 跨模块契约（2026-10-20 新增）──
//   h3-labels.js 把 4 个平铺 role 重构为 4 标签 + 19 细分之后，
//   【另一个项目】dsh-editor/src/characters.mjs 仍在生产旧 id "appearance"
//   （实测扫出 3 处）。这条断言防的就是
//   「两个模块各自改对了，但契约变了没人通知对方」。
steps.push(run('跨模块 · H3 用途 id 一致性（工作台 ⇄ 工作站）', 'dsh-comfy-workbench-tab', 'verify-role-contract.mjs'));

// ── 角色卡桥（2026-10-20 新增）──
//   两个项目各有一套资产库，扫的是同一个 ComfyUI output 目录。
//   角色卡的标签（role:character / char:<名字>）只存在工作站那份，
//   工作台的 @ 搜索看不到 ⇒「@韩立」搜不到。
//   这条验收保证：桥能读、能按 basename 对齐、能让角色名参与搜索、失败时降级不阻断。
steps.push(run('跨模块 · 角色卡桥（工作站 tags → 工作台 @ 搜索）', 'dsh-comfy-workbench-tab', 'verify-character-bridge.mjs'));

// ── @ 引用逻辑（2026-10-20 新增）──
//   主人的两条要求「输入 @ 弹出可选窗口」与「Tab 直接引用」
//   原来内联在 AssetLibrary.js（import React，node 跑不了）⇒ 只能人肉点。
//   本轮抽成 src/at-mentions.js 纯函数，这条验收就测它：
//   22 种分隔符触发、不该触发的不触发、Tab/Enter 决策表、替换规则。
steps.push(run('M2 @ 引用逻辑（触发正则 / Tab 直接引用 / 替换）', 'dsh-comfy-workbench-tab', 'verify-at-mentions.mjs'));

// ── ArtCraft 接入（2026-10-20 新增）──
//   主人定的架构原则：「工作流是作为一个可替换的模块接入我们的插件的，
//   你的所有东西都应该让工作流对号入座」、「先做后端，再匹配前端 ui」。
//   ① 后端契约：我们的资产 → ArtCraft 的 MediaPickerSelection / ResolvedMedia
//   ② 端到端：url 真能取到媒体字节（验魔数，不只看 HTTP 200）
steps.push(run('ArtCraft 适配层（资产 → MediaHandle / ResolvedMedia）', 'dsh-comfy-workbench-tab', 'verify-artcraft-adapter.mjs'));
steps.push(run('ArtCraft 接入端到端（字节头 / Range / mime）', 'dsh-comfy-workbench-tab', 'verify-artcraft-e2e.mjs'));
//   ③ 工程投影：我们的 timeline ⇄ ArtCraft TProject。
//     ★ 关键断言：shot / handoff / rendered 这三个 ArtCraft 模型里不存在的字段，
//       转过去再转回来必须一个字节都没变。
steps.push(run('工程投影（timeline ⇄ TProject，shot/handoff 不丢）', 'dsh-comfy-workbench-tab', 'verify-timeline-projection.mjs'));
//   ④ projectStorage：ArtCraft 存工程 → 我们的 timeline-state。
//     ★ 最关键：saveProject 拿到的是 ArtCraft 改完的 TProject，
//       直接覆盖会丢掉 shot/handoff/rendered，且不报错。必须走投影合并。
steps.push(run('projectStorage（存工程不丢 shot/handoff）', 'dsh-comfy-workbench-tab', 'verify-artcraft-storage.mjs'));
//   ⑤ assetGallery 的界面（pickMode）：资产选择器
//     ★ 不传 pickMode 时 LibraryPanel 行为必须与之前完全一致（回归保护）
steps.push(run('资产选择器 pickMode（不传时行为不变）', 'dsh-comfy-workbench-tab', 'verify-pick-mode.mjs'));
//   ⑦b 真实槽位：用桥返回的真实 media 定义跑分配
//     ★ 与上面互补：上面用手写 fixture 验逻辑，这份验「逻辑跑在真数据上」。
//       手写 fixture 永远是「我以为的数据形状」。
//       核心断言：6 个图片槽占满后不许越界塞进视频/音频槽。
steps.push(run('真实槽位分配（跨 kind 不越界）', 'dsh-comfy-workbench-tab', 'verify-slot-real.mjs'));
//   ⑥ ArtCraft 裁切写回
//     ★ 核心断言：只提交 trim 与顺序，不夹带 shot / handoff / rendered。
//       直接覆盖 timeline-state 会让每一镜的「生成配方」消失且不报错。
steps.push(run('ArtCraft 裁切写回（只改 trim 不碰 shot）', 'dsh-comfy-workbench-tab', 'verify-save-trim.mjs'));
//   ⑦ 回归护栏：锁住这一轮端到端实测挖出的 8 个静默失效点。
//     ★ 它们全部「不报错、界面看着正常、结果不对」，
//       不写进验收的话下次改动会原样复发。
//     ① MediaTime 是整数 tick（不是 {numerator,denominator}）
//     ② tracks 是 { overlay, main(单个), audio } —— main 单数、audio 复数
//     ③ element.type 按扩展名判，不是 clip.kind
//     ④ duration = trimEnd - trimStart，不是 out-in
//     ⑤ startTime 累加用实际时长（双 clip 才暴露的空隙 bug）
//     ⑥ AudioElement 必须声明 sourceType（否则导出无音频流）
//     ⑦ mediaId 必须能修正成资产表真实 id（音频 id 是 editor: 不是 output:）
//     ⑧ payload 必须 base64（否则 esbuild 导出被劫持、插件静默不激活）
steps.push(run('ArtCraft 回归护栏（8 个静默失效点）', 'dsh-comfy-workbench-tab', 'verify-regression.mjs'));

// ── UI 收口（2026-10-21 新增，主人要求「风格和 dsh 统一到原生就有这个功能一样」）──
//
// ⑨ DSH 原生对齐层
//    ★ 这三条是本轮最值钱的发现，全部「不报错、看着正常、就是不像原生」：
//      ① 13 个语义色类在 ArtCraft 的 CSS 里【零定义】
//         ⇒ 元素回落浏览器 UA 默认灰 rgb(107,107,107)
//         判据：造一个裸 <button> 对比底色，一样就是 UA
//      ② 按钮同时带 size-7 + h-8 + w-8，h-8(2rem=32px) 排后面胜出（期望 28px）
//      ③ --st-panel 比 --st-bg 更暗，而 DSH 的 layer-1 比 base 更亮
//         ⇒ 两套层级方向相反，必须按语义映射不能按名字对等
//    ★ 还有一条纪律写进了断言：注释里不许出现反引号。
//      本文件外层是 String.raw 模板字符串，注释里的反引号会提前闭合它，
//      构建报 "Expected ; but found xxx" 且指向注释位置（看起来毫无问题）。
//      本轮连踩两次。
steps.push(run('DSH 原生对齐层（语义色 / 尺寸 / 派生 / 浮层 / 圆角 / token 存在性）', 'dsh-comfy-workbench-tab', 'verify-dsh-native-ui.mjs'));

// ⑩ 默认轨道布局
//    ★ 主人 2026-10-21：「下方的轨道应该默认有两条视频两条音频，一条文本（字幕）」
//    ★ 路径坑：本机有两份 artcraft 源码 —— _upstream\artcraft-src（参考源，构建不读）
//      与 _upstream\artcraft-demo\video-editor\src（构建真正读这份）。
//      第一次改在 artcraft-src 上，构建毫无变化，一度以为「改了没生效」。
steps.push(run('默认轨道（2 视频 + 2 音频 + 1 字幕 = 5 条）', 'dsh-comfy-workbench-tab', 'verify-default-tracks.mjs'));

// ⑫ 上传协议（2026-10-21）
//    ★ 主人报「这两个还是导入不了本地的视频」。
//      根因是【协议不匹配】，两端各自都正确：
//        适配器发 multipart/form-data（FormData）
//        服务端只接受 JSON：body = JSON.parse(...) → 否则 400「请求体不是合法 JSON」
//      实测：multipart → 400；JSON+base64 → 200 {"ok":true,"id":"input:wb_xxx.png"}
//    ★ 响应还是【扁平结构】（id 在顶层，没有嵌套 item），
//      第一版按 j.item.id 取会报「没返回资产 id」。
//    ★ 同一错误在 dsh-comfy-workbench-tab/src/artcraft-wire.mjs 里也有一份
//      （那个文件没被构建进产物，属死代码，已同步修但当前不生效）。
steps.push(run('上传协议（JSON+base64，不是 FormData）', 'dsh-comfy-workbench-tab', 'verify-upload-protocol.mjs'));

// ⑬ 轨道 UI 顺序（2026-10-21）
//    ★ 主人规格：「视频2 视频1 音频1 音频2，字幕」（字幕在最下）
//    ★ 这项改动横跨 20 处 [...overlay, main, ...audio]：
//        · 14 处属 UI（渲染行序 / 拖放落点 / 点击命中 / 吸附 / 整体移动）→ 改用 getDisplayTracks
//        · 6 处属渲染或无关（混音 / 画布命中 / 时长 / 元素查找）→ 保留原样并加标注
//    ★ 漏一处的后果：渲染用新顺序、命中用旧顺序 ⇒ 点击位置与视觉错位，
//      且【不报错、不崩】，只能靠人眼看出来（AGENTS §6.43 的典型场景）。
steps.push(run('轨道 UI 顺序（视频2→视频1→音频1→音频2→字幕）', 'dsh-comfy-workbench-tab', 'verify-track-order.mjs'));

// ⑭ 导入行为（2026-10-21）
//    ★ 主人规格：「视频1和音频1是一个视频导入进去后默认的放置位置，
//      导进去就把音频自动分离到音频1，第二个视频默认接在视频1轨道中的已有视频后面，
//      如果手动拖，就可以拖到视频2，音频同理」
//    ★ 三个已知风险点（都已写成断言）：
//      ① 落点不能再用播放头，要接在已有内容后面
//      ② 音轨分离只对「带音轨的视频」做（无声视频不产生空片段）
//      ③ ★ 放置顺序必须与 UI 显示顺序解耦 ——
//          UI 改成「视频2 在前」之后，若放置也用它，素材会先落视频2，
//          与主人规格相反。这条是本轮自己引入又修掉的问题。
//    ⚠ 落轨与分离的【运行时】验证待补：本机 ComfyUI 关闭 → 素材面板为空，
//      走不到「点+加素材」那一步。上传协议已单独运行时验证（200 + 真实 id）。
steps.push(run('导入行为（接在后面 / 音轨分离 / 视频1 优先）', 'dsh-comfy-workbench-tab', 'verify-import-behavior.mjs'));

// ⑮ @ 卡片预览（2026-10-21，主人报了两次）
//    ★ 第一次「对话框中的@卡片还是没有预览」：
//       blob 的 MIME 是空字符串 → <img> 静默失败（naturalWidth=0，不报错）
//    ★ 第二次「这个卡片的框不是跟随文字了…实在做不了就放一个按钮吧」：
//       ① <select> 的原生 option 文本参与宽度计算 ⇒ chip 从 60px 撑到 239px
//       ② 缩略图 left:-18px 落在 chip 外 ⇒ 压住前一个词
//    ★ 反向断言抓出了【第二条构造路径】（刷新后恢复时 new Blob([buf]) 没传 type）——
//      正是 AGENTS §6.43「只修一处 = 没修」。
steps.push(run('@ 卡片预览（MIME / 宽度 / 悬停大图）', 'dsh-comfy-workbench-tab', 'verify-chip-preview.mjs'));

// ⑯ SVG <title> 中文化（2026-10-21）
//    ★ 主人要求「英文 aria-label/title 全中文化」，我前后扫了三轮：
//      ① JSX 的 aria-label= / title= 属性 → 全中文
//      ② tooltip= / label= / 直接 JSX 文本 → 补了 8 + 18 处
//      ③ ★ 本轮：按钮的 accessible name 仍然有一个 "Ripple"，
//         根因是图标组件里的 <title>Ripple</title> ——
//         svg 标了 aria-hidden，但 <title> 仍参与 accessible name 计算。
//    ★ 判据：时间轴 42 个按钮里 aria-label/title 为纯英文的应为 0（修前 1 个）。
//    ★ 品牌名白名单不译：Vercel / Marble / Data Buddy。
steps.push(run('SVG <title> 中文化（含品牌名白名单）', 'dsh-comfy-workbench-tab', 'verify-svg-titles.mjs'));

// ⑰ 导出对话框（2026-10-21，修了四轮）
//    ★ 子代理实测报「导出对话框宽 231px、高 568px，挤成一条细长竖条」，
//      我复跑确认。四轮的原因各不相同，全部记在脚本头部：
//      ① 加 ac-scope 到容器自己 → 内部救活，容器自己仍是 block
//      ② 外面包 div → Radix 自己 portal，包裹层是空的
//      ③ 补【组合选择器】.ac-scope.ac-portal-surface.flex → 布局全对
//      ④ 对比度：「保存位置」纯白 1.05:1（portal 浮层不带 theme-light，
//         用的是暗色 --foreground / --muted-foreground）
//      ⑤ 顺手：折叠分区看不到当前值（SectionHeader 没传 trailing）
steps.push(run('导出对话框（布局 / 对比度 / 折叠时显示当前值）', 'dsh-comfy-workbench-tab', 'verify-export-dialog.mjs'));

// ⑱ 空工程下的禁用态（2026-10-21，子代理第 12 条）
//    ★ 子代理：「空工程下依次点工具栏 15 个图标，11 个点了完全没反应」
//    ★ 我复跑：7 个片段操作里 5 个可点但什么都不发生
//      （分割/向左/向右/复制/删除），提取音频与定格帧本来就 disabled。
//    ★ 「点了没反应」比「报错」更差 —— 报错至少说明系统听到了。
//      空态下这些操作逻辑上做不了，必须提前用视觉状态告诉用户。
//    ★ 反向断言：不许写成永久 disabled={true}，否则选中片段后也用不了。
steps.push(run('空工程禁用态（5 个片段操作 + 定格帧）', 'dsh-comfy-workbench-tab', 'verify-disabled-states.mjs'));

// ⑲ 导入端到端（2026-10-21）
//    ★ 本轮用真实 887KB mp4 完整跑通了导入链路，发现两个缺陷：
//      ① 音频轨叫 "Audio track"（DEFAULT_TRACK_NAMES 是英文）
//      ② ★★ 导入后「视频 2」「字幕」两条空轨凭空消失
//         根因：core/index.ts 的 prune reactor 每次都删「元素为空的轨道」，
//         而主人要的默认五条轨道里，视频2/音频2/字幕 天然是空的
//         ⇒ 第一次插入元素就被当垃圾清掉。
//         这是【设计冲突】（ArtCraft 认为空轨没用 vs 主人要五条默认轨），
//         不是 bug ⇒ 加 PINNED_TRACK_IDS 白名单解决。
//    ★ 实测修复后：视频2(0)/字幕(0)/视频1(1视频)/音频1(1音频)/音频2(0)，五条全在。
steps.push(run('导入端到端（落视频1 + 分离音频1 + 空轨保留）', 'dsh-comfy-workbench-tab', 'verify-import-e2e.mjs'));

// ⑳ 资产卡「更多操作」浮层（2026-10-21，本轮修的两个真缺陷）
//    ★ 缺陷 1：多个浮层可同时开着
//       实测连续点两张卡 → 出现 2 个 z-index:99999 浮层，
//       第二个跑到 y=1461（视口高 914，完全看不见），第一个不消失。
//       根因：onDown 里 `closest("[data-wb-card-more]")` 本意是「点浮层内部不关」，
//             但所有卡的按钮都带这个属性 ⇒ 点另一张卡也不关自己。
//       修：全局单例 id + 自定义事件（wb:card-more-open）。
//    ★ 缺陷 2：浮层可能跑到视口外
//       根因：`if (above >= GAP) return above;` 在 anchor.top 很大时直接返回视口外的值，
//             最后那条 clamp 兜不住。
//       修：先算想要的位置，最后统一钳进 [GAP, innerHeight - effH - GAP]。
//    ★ 实测修复后：连续点 3 张卡，每次浮层数=1 且 allInViewport=true。
steps.push(run('资产卡浮层单例 + 视口钳制', 'dsh-comfy-workbench-tab', 'verify-popover-singleton.mjs'));

// ㉑ 1280 / 375 两档宽度（2026-10-21，refactoring-ui 强制要求）
//    ★ 试过四种改宽度的方法，只有「给 DSH 外壳设固定 width」真的改变布局：
//      ① window.resizeTo            → 浏览器拦截
//      ② CDP setDeviceMetricsOverride → 被页面 resize 逻辑重置
//      ③ .BynINW_frame 设固定 width  → ✅ 真布局
//      ④ documentElement.style.zoom → 只缩放渲染，布局宽度不变
//    ★ 实测：1280 宽 section 969px（零挤压）；375 宽 section 288px（靠横向滚动）
steps.push(run('1280/375 两档宽度布局', 'dsh-comfy-workbench-tab', 'verify-responsive.mjs'));

// ㉖ 剪辑台四区块实装（2026-10-22，主人「复用 DSH 自身素材」+「三个 tab 全部自己重写」）
//    ★ 这一轮把「时间轴」tab 改名为「剪辑台」并重做成 DSH 原生风格：
//        布局 = 预览 / 工具栏（紧贴时间轴上方）/ 时间轴 / 右侧检查器抽屉
//        工具栏 17 → 6（导入/分割/删除/复制/撤销/重做），其余进「···」并标快捷键
//        检查器三 tab（素材/属性/字幕）自画，控件全用 DSH 原生 primitives
//    ★★ 58 项断言锁的是本轮踩出来的 8 个「不报错、看着正常、结果不对」：
//      ① 宿主 require 被 esbuild 换成桩（typeof require 判定通过但调用必抛）
//      ② forwardRef 组件的 typeof 是 "object"，用 typeof==="function" 判会误判
//      ③ tracks 三层形状：overlay=[轨道] main=轨道 audio=[轨道]
//         —— 把 overlay 当元素数组 ⇒ elementCount 永远等于轨道数 ⇒ 预览空态永不显示
//      ④ --dsw-alias-bg-layer-2 浅色下 = #fff（与面板同色）⇒ 881 张卡在 DOM 里但看不见
//      ⑤ grid item 写 align-self ⇒ auto 行高塌成 0px，卡片重叠
//      ⑥ useMemo 依赖里放「回调里才赋值的派生字段」⇒ TDZ（minify 后只剩 'k'）
//      ⑦ const 函数定义在 if(...) return 之后 ⇒ 同款 TDZ
//      ⑧ 面板写了但没入口（检查器）⇒ 功能存在但打不开
//    ★ 另锁一条纪律：editor.css.js 外层是模板字符串，CSS 注释里不能有反引号。
//    ★ 已做变异测试：4/4 条改坏代码都能让验收变红（不是假通过）。
steps.push(run('剪辑台四区块实装（布局/工具栏6项/检查器/slot/恢复导入）', 'dsh-comfy-workbench-tab', 'verify-editor-console.mjs'));

// ㉘ CSS 模板反引号检查（2026-10-22）
//    ★★ 同一个错误一天犯四次：editor.css.js 外层是模板字符串，
//       CSS 注释里塞一个反引号就会提前闭合模板，esbuild 报
//       「Expected ; but found xxx」且错误指向注释位置（看起来毫无问题）。
//    ⇒ 固化成脚本，构建前跑，比人对注释有记性可靠。
//    已做变异测试（往注释里注入一个反引号）→ 正确报红并指出行号。
steps.push(run('CSS 模板反引号检查（注释里不许有反引号字符）', 'dsh-comfy-workbench-tab', 'check-css-template.mjs'));

// ㉙ 剪贴板 C/V/X + 滚动条滚轮缩放（2026-10-22）
//    ★ 主人：「复制粘贴为什么不是大众习惯的 c 和 v？」「d 没必要保留吧？」
//      原来只有 duplicate（Mod+D）= 原地复制，不经过剪贴板，
//      也没有「粘贴到别处」—— 那是功能缺口，不只是键位不合习惯。
//    ★ 同时覆盖滚动条缩放的容错与「不误抢」（ArtCraft 自己也在 timelineRef
//      上挂了 capture 监听，会抢走所有滚轮）。
//    已做变异测试：改回 Mod+D / 快照带原 id / 删右下角判定 / 去掉 immediate，
//    全部正确变红。
steps.push(run('剪贴板 C/V/X + 滚动条滚轮缩放', 'dsh-comfy-workbench-tab', 'verify-clipboard.mjs'));

// ㉚ 实时进度（WebSocket 进度总线 + 队列位次，2026-10-22）
//    ★ 主人：「是不是需要有一个任务队列，或者任务状态？实时显示进度之类的？」
//    ★ 为什么必须走 WS：/queue 只给位次、/history 只在结束时才有数据，
//      中间的「第 15/30 步」ComfyUI 只在 WebSocket 上推。
//      协议实证：ComfyUI/main.py:461  progress = {value, max, prompt_id, node}
//    ★ 用 Node v24 内建 WebSocket —— bridge 包保持零依赖。
//    已做变异测试：去 100% 上限 / 去除零保护 / 去过期判定 / 去 pid 判空 /
//    前端不判 pct / 后端不返回 progress，6 项全部正确变红。
steps.push(run('实时进度（WS 总线 / 除零 / 过期 / 前后端契约）', 'dsh-comfy-workbench-tab', 'verify-progress.mjs'));

// ㉗ 快捷键系统（2026-10-21 写好，2026-10-22 补登记）
//    ★★ 这个脚本此前【从未登记进总验收】—— 正是 AGENTS §6.44a 那条
//       「未登记进总验收的脚本 = 心理安慰」。今天才发现它一直没被跑过。
//    ★ 它测的是纯逻辑：归一化 / 冲突检测 / 持久化（只存差异）/ 跨平台 Mod / 输入框内不触发
steps.push(run('快捷键系统（归一化/冲突/持久化/跨平台）', 'dsh-comfy-workbench-tab', 'verify-shortcuts.mjs'));

// ㉒ 字幕面板（2026-10-21，主人要求「点击生成 + 生成后可手动修改」）
//    ★ 旧状态：captions 是 <ComingSoon label="字幕" />，只有一行「即将上线…」。
//    ★ 新状态：<CaptionsView />，贴稿 → 按段生成 → 每段一条字幕落在字幕轨 → 逐条可改。
//    ★ 实测：贴 3 行 → 生成 3 条，start=0/360000/720000，dur 各 360000，
//            posY=410（=1080×0.38，画面 88% 高度处）。零报错。
//    ★ 关于「自动识别语音」：本机 whisper / ollama / ComfyUI ASR 全无，
//      面板里明确告知「不会自动听写」，不做假入口（§6.29 同源纪律）。
steps.push(run('字幕面板（生成 + 可改 + 不造假入口）', 'dsh-comfy-workbench-tab', 'verify-captions.mjs'));

// ㉓ 漏翻全量扫描（2026-10-21）
//    ★★ 这个脚本此前【从未登记】，而且自身是坏的（findings 未定义，一跑就崩）。
//       这正是 AGENTS §6.44a 记过的坑：「未登记进总验收的脚本 = 心理安慰」。
//    ★ 修好 `findings` 后它立刻报出 15 处候选：
//        13 处是真漏翻（Pattern craft / Syntax UI / Add to timeline /
//                       Recently used / Show bookmark notes / Spotlight /
//                       Rotation ×4 / Stroke Align / Stroke width / Stroke color）
//        2 处是误报（extends BaseNode、IDBRequest<T>）
//        1 处是开发者报错信息（throw new Error 的续行）
//      ⇒ 13 处已翻译，误报与开发者提示已加过滤规则。
//    ★ 结论：我之前自报的「英文清零」是错的 —— 当时这个脚本根本跑不起来。
//    ★ 现在 0 处，--strict 退出码 0。
steps.push(run('漏翻全量扫描（源码 0 处英文）', 'dsh-comfy-workbench-tab', 'verify-no-english-src.mjs'));

// ㉔ 音频转文字（2026-10-21，主人「装就行了」）
//    ★ 装了什么：faster-whisper 1.2.1 + ctranslate2 4.8.3 + opencc
//      （pip 只有腾讯云镜像可达；hf-hub 下载要关 SSL 校验，本机 CA 链不全）
//      模型 Systran/faster-whisper-small 463.7MB → .models/whisper
//    ★ 准确率（TTS 已知文本闭环，编辑距离）：16 字 100% / 40 字 100%
//    ★ 端到端实测：上传 2.3 秒带音频视频 → 点「从音轨识别」
//      → 字幕轨出现 content="你就是吗" start=0 dur=240000，预览区渲染出字幕
//    ★ 两个坑：
//      ① 临时 wav 写 %TEMP% 被沙箱拦（ffmpeg Permission denied）→ 改落 .frames/
//      ② 资产只有 {id,name}，用 name 当路径会 404（磁盘上是 wb_xxx.mp4）
//         → 必须从 id 剥前缀
steps.push(run('音频转文字（从音轨生成字幕）', 'dsh-comfy-workbench-tab', 'verify-asr.mjs'));

// ㉕ whisper 模型选型（2026-10-21 晚，主人开代理后实测下载 + 对比）
//    ★ 下载：单连接极不稳（0.06~2.63 MB/s 跳，同文件这次 200 下次 502）。
//      改【8 线程 Range 分块】后稳定 10.7 MB/s —— 快约 180 倍。
//      1457MB 135 秒下完（medium），1543MB 95 秒下完（turbo，含续传）。
//    ★ 坑：huggingface_hub 默认走 XetHub CAS，hf-mirror 没代理那域 ⇒ 401。
//      传统 LFS 直链是通的 ⇒ 直链 + 分块下。
//    ★ 坑：faster_whisper 的短名表里没有 "large-v3-turbo"，传短名会联网查表
//      ⇒ 必须传本地目录路径。
//    ★ 困难样本实测（干净样本三个模型都 100%，测不出差距）：
//        small  87.8% / 4.88s
//        medium 91.8% / 12.33s   ← 选它
//        turbo  91.6% / 13.44s   （体积大 86MB、慢 9%、快语速反而输）
//    ⇒ turbo 虽然标称 large 档，这个 ct2 版本实测略输 medium。
steps.push(run('whisper 模型选型（medium > turbo > small）', 'dsh-comfy-workbench-tab', 'verify-asr-models.mjs'));

// ⑪ 不许留调试探针
//    ★ 本项目已四次留下「临时诊断探针」并忘删：
//      __AT_DEBUG__ / __CHIP_DEBUG__ / __LAST_GROUP_BIND__ / __ARTCRAFT_RESOLVE__ / __ARTCRAFT_FATAL__
//      害处三条：每次渲染写全局、把用户数据复制到 window、后人以为它有用不敢删
//    ★ 脚本分三类：合规（DSH 要求）/ 例外（功能与冒烟必需，写明理由）/ 违规（诊断遗留）
//    ★ 只扫 src/，不扫 lib/ —— 产物是压缩镜像，扫它全是噪声（本轮实测报 18 处误报）
steps.push(run('无调试探针残留（诊断遗留必须清掉）', '.', 'verify-no-debug-probes.mjs'));
//   ⑧ 验收自检：这些断言真的能变红吗？
//     ★ 上一轮发现 verify-artcraft-storage.mjs 读的是 tracks.video
//       （那个键根本不存在），却一直显示通过 —— 因为它从没真正读到 element。
//       「假通过」比没有验收更危险：它让人以为已经覆盖了。
//     本套做变异测试的极简版：把被测行为改坏，验收必须变红。
//     若变坏后仍通过 ⇒ 报「假通过」。
steps.push(run('验收自检（断言真能变红吗）', '.', 'verify-can-catch.mjs'));

// ── M1 字幕 F9（2026-10-18 新增，本机 faster-whisper）──
steps.push(run('M1 字幕（SRT 格式 / 音轨探测 / 转写 / 烧入）', 'dsh-comfy-bridge', 'verify-subtitle.mjs', [], 300000));

// ── M1 toggle 组合静态重放（2026-10-19 新增，0 秒，不占 GPU）──
//   覆盖全部 2^n 种开关组合，检查「悬空输入 / 输出齐全 / 该删的删了」。
//   这是 AGENTS §6.21 那个「静默丢图」缺陷的自动挡。
steps.push(run('M1 toggle 组合静态重放（18 种组合 / 悬空输入 / 输出齐全）', 'dsh-comfy-bridge', 'verify-toggle-matrix.mjs'));

// ── M1 LoRA 多选织链（2026-10-19 新增，0 秒，不占 GPU）──
//   主人要求「krea2 的 lora 下拉栏可多选」，实现方式是 buildPrompt 末尾动态
//   插 LoraLoaderModelOnly 链。动态插节点风险高：接错位置会把模型链断开，
//   而 ComfyUI 对断链的表现是【静默跳过下游】—— status 仍是 success，只是没图。
//   ⇒ 单独一份验收覆盖：链顺序 / 链尾接进 KSampler / 无断链 / 与 loraChain 开关共存。
//   ★ 它当场抓到过一个真缺陷：loraChain 开着时用户的 LoRA 从 214 分叉，
//     把作者的 218 绕过去了（并联而非串联）。
steps.push(run('M1 LoRA 多选织链（链顺序 / 链尾接进 KSampler / 无断链 / 与开关共存）', 'dsh-comfy-bridge', 'verify-lora-chain.mjs'));

// ── M1 参数闭环（2026-10-19 新增，0 秒）──
//   「界面控件能点但值没传给后端」这类缺陷的自动挡。
//   检查：每个 UI 控件都有 params 归宿 / 每个 params 后端都读 / 可选参数先问 caps。
steps.push(run('M1 参数闭环（UI 控件 ⇄ params ⇄ 后端，防「控件是摆设」）', 'dsh-comfy-bridge', 'tools/check-param-closure.mjs'));

// ── M1 异常输入（2026-10-19 新增）──
//   17 项：空提示词 / 数值越界 / 未知模式 / 素材校验 / 正常输入防误拒。
//   实测命中率 30%（5/17 项曾是真缺陷）。
//   ★ 第 ⑤ 组「正常输入仍能通过」是防校验过头 —— 只测「坏的被拒」不够。
steps.push(run('M1 异常输入（空提示词 / 越界 / 坏素材 / 正常输入不被误拒）', 'dsh-comfy-bridge', 'verify-bad-input.mjs'));

// ── 文本判定（2026-10-19 新增）──
//   24 项：text-guard 判定正确性（19 项）+ 全项目扫描是否有 String(x).trim() 回潮（1 项）
//   ★ 这个判定在本项目写过 6 遍，全部是假防护 —— 抽成一个函数 + 常驻扫描。
steps.push(run('文本判定（零宽/BOM/全角/对象/0 都算空，防 String().trim() 回潮）', '.', 'verify-text-guard.mjs'));

// ── M7 人机交接 F6（纯函数，离线）──
steps.push(run('M7 人机交接（字段锁 / 冲突检测 / 解锁）', 'dsh-editor', 'test/verify-handoff.mjs'));

// ── M7 角色卡 F1（纯函数，离线）──
steps.push(run('M7 角色卡（标签解析 / 分组 / 槽位注入）', 'dsh-editor', 'test/verify-characters.mjs'));

// ── M7 段间转场 F8（纯函数，离线）──
steps.push(run('M7 段间转场（xfade 链 / 音频同步裁短 / 退化）', 'dsh-editor', 'test/verify-transition.mjs'));

// ── M7 重启数据存活（2026-10-18 抓到的真缺陷，普通单测抓不到）──
steps.push(run('M7 重启数据存活（进程 A 写盘 / 进程 B 恢复 / 换 cwd / 坏存档）', 'dsh-editor', 'test/verify-persist-restart.mjs'));

// ── M4 ──
steps.push(run('M4 preset（yml / cordis / skill / 与 M1 一致）', 'dsh-comfy-preset', 'verify-m4.mjs'));
steps.push(run('增量回归（加 batch/steps2 后既有能力没坏）', 'dsh-comfy-bridge', 'test/verify-batch.mjs'));


/* ══ 补齐遗漏的验收脚本（2026-10-23）════════════════════════════════
 *
 * 背景：统计发现磁盘上有 99 个 verify-*.mjs，verify-all 只登记了 60 个。
 * 未登记的 24 个（排除元验收）实际都能跑，合计约 480 项断言 ——
 * 也就是说过去这些断言一次都没在总验收里跑过。
 *
 * AGENTS §6.44a 记过这条：
 *   「未登记进总验收的脚本 = 心理安慰。」
 *
 * ★ 补登记前先逐个跑过一遍（tools/audit-missing-verify.mjs），
 *   确认 24/24 都能过才挂上去 —— 不能把不跑的当通过。
 */
steps.push(run('dsh-editor · agent-progress', 'dsh-editor', 'test/verify-agent-progress.mjs'));
steps.push(run('dsh-editor · asset-root', 'dsh-editor', 'test/verify-asset-root.mjs'));
steps.push(run('dsh-editor · audio-split', 'dsh-editor', 'test/verify-audio-split.mjs'));
steps.push(run('dsh-editor · commands', 'dsh-editor', 'test/verify-commands.mjs'));
steps.push(run('dsh-editor · crop', 'dsh-editor', 'test/verify-crop.mjs'));
steps.push(run('dsh-editor · handoff-tools', 'dsh-editor', 'test/verify-handoff-tools.mjs'));
steps.push(run('dsh-editor · host-entry', 'dsh-editor', 'test/verify-host-entry.mjs'));
steps.push(run('dsh-editor · host-store', 'dsh-editor', 'test/verify-host-store.mjs'));
steps.push(run('dsh-editor · m5-assets', 'dsh-editor', 'test/verify-m5-assets.mjs'));
steps.push(run('dsh-editor · m6-reverse', 'dsh-editor', 'test/verify-m6-reverse.mjs'));
steps.push(run('dsh-editor · m6-tools', 'dsh-editor', 'test/verify-m6-tools.mjs'));
steps.push(run('dsh-editor · m7-bundle', 'dsh-editor', 'test/verify-m7-bundle.mjs'));
steps.push(run('dsh-editor · m7-render', 'dsh-editor', 'test/verify-m7-render.mjs'));
steps.push(run('dsh-editor · m7-shot', 'dsh-editor', 'test/verify-m7-shot.mjs'));
steps.push(run('dsh-editor · m7-timeline', 'dsh-editor', 'test/verify-m7-timeline.mjs'));
steps.push(run('dsh-editor · m7-trim', 'dsh-editor', 'test/verify-m7-trim.mjs'));
steps.push(run('dsh-editor · m8-audio-edit', 'dsh-editor', 'test/verify-m8-audio-edit.mjs'));
steps.push(run('dsh-editor · m9-preview', 'dsh-editor', 'test/verify-m9-preview.mjs'));
steps.push(run('dsh-editor · persist-host', 'dsh-editor', 'test/verify-persist-host.mjs'));
steps.push(run('dsh-editor · prompt-gate', 'dsh-editor', 'test/verify-prompt-gate.mjs'));
steps.push(run('dsh-editor · sse', 'dsh-editor', 'test/verify-sse.mjs'));
steps.push(run('dsh-editor · tools-def', 'dsh-editor', 'test/verify-tools-def.mjs'));
steps.push(run('dsh-video-knowledge · rules', 'dsh-video-knowledge', 'src/verify-rules.mjs'));
steps.push(run('dsh-video-knowledge · m0', 'dsh-video-knowledge', 'test/verify-m0.mjs'));

/**
 * ── 资产库基线（2026-10-21 新增）────────��───────────────────────────
 *
 * 为什么有这一项：
 *   我曾三次报「资产库数字对得上」，三次用的口径都不同
 *   （-File / -Recurse / API 返回），三次都「对上了」，
 *   实际是和三个不同的东西比。主人问「差 3 项在哪」，我算不出来。
 *
 * 判据：「数字对得上」必须能补全成
 *   「用 <口径 X> 数出来的 A，与用 <同一口径 X> 数出来的 B 相等」。
 *
 * ⇒ 固定口径（/comfy-assets/library 的 items，按 id 排序），
 *   存成基线文件（docs/基线-资产库-20261021.json），每次比差集。
 */
if (!STATIC) {
  steps.push(run('资产库基线（与 docs/基线 比差集）', '.', 'verify-asset-baseline.mjs', [], 120000));
  steps.push(run('payload 字段一致性（三个构造点是否都带业务字段）', '.', 'verify-payload-parity.mjs'));
  steps.push(run('漏翻检测器自检（验证它真能抓到英文）', '.', 'verify-no-english.mjs', ['--self-test']));
}

/* ══ 以下都是纯静态检查（不碰 ComfyUI），两个模式都跑 ══ */
/**
 * ★★ 2026-10-23 新增：ui-to-api 转换器验收
 *
 *   UI 格式 → API 格式的转换是「接新工作流」的唯一入口，
 *   而它的错误全是静默的（参数悄悄错位，报错在很远处）。
 *   本项目为此错了五次才对位。
 *
 *   ★ 纯逻辑测试，不碰 ComfyUI ⇒ 放静态段。
 */
steps.push(run('UI→API 转换器（widgets 对位 5 条判据）', 'tools', 'verify-ui-to-api.mjs', [], 120000));

/**
 * ★★ 2026-10-23 新增：未声明变量检查
 *
 *   实测事故：onGenerate 里写了 mode?._workflow，而组件里叫 currentMode。
 *   症状是「点生成毫无反应」—— 不报错、不发请求、按钮不变。
 *
 *   ★ 可空链 ?. 只能防「值是 null/undefined」，
 *     防不住「变量根本没声明」。这类错误 node --check 抓不到。
 *
 *   用 acorn 做词法作用域分析。装法见 tools/check-undeclared.mjs 顶部注释
 *   （npm 在中文路径下要加 --prefix，否则 EPERM mkdir D:\\）。
 */
steps.push(run('未声明变量检查（ReferenceError 的静态形态）', 'tools', 'check-undeclared.mjs', [], 180000));

/**
 * ★★ 2026-10-23 新增：静默 catch 检查
 *
 *   起因：dsh-comfy-bridge/src/index.js 那个裸 path.join 的 bug，
 *   之所以一直没暴露，是因为它被空 catch 吞掉了。
 *
 *   ★ 但空 catch 不是罪 ——
 *     抽查发现绝大多数是有意的容错（轮询端点失败不影响编辑、
 *     清理临时文件删不掉就算了）。
 *   ⇒ 判据不能是「空 catch 就报」，那会 28 处全红、全部误报。
 *      改成「try 体 >=8 行 且 含 >=6 处多层属性访问」才算可疑。
 */
steps.push(run('静默 catch 检查（会吞掉编程错误的地方）', 'tools', 'check-silent-catch.mjs', [], 180000));

/**
 * ★★ 2026-10-23 新增：死路径检查
 *
 *   起因：移出废弃包 dsh-artcraft-tab 后，立刻暴露 2 个隐藏依赖 ——
 *   有些验收脚本硬编码了指向它的路径，包在时「看起来没问题」，
 *   包一移走就全红。
 *
 *   ⇒ 死引用是【延迟引爆】的缺陷。必须持续扫描，不能等出事才找。
 *
 *   查四种形态：
 *     ① 绝对路径（D:/... C:/...）里提到已不存在的包
 *     ② path.join(...) 的实参里拼了已不存在的包
 *     ③ 相对导入指向不存在的文件
 *     ④ 裸包名导入指向已不存在的包
 *
 *   ★ 扫的是【剥注释 + 剥模板字符串】后的代码 ——
 *     注释里的历史说明、模板字符串里的路径（相对基准不同）都不算。
 */
steps.push(run('死路径检查（引用了不存在的文件 / 已删除的包）', 'tools', 'check-dead-paths.mjs', [], 180000));

/**
 * ★★ 2026-10-23 新增：安装配置自检
 *
 *   起因：我连续 3 轮把「安装脚本」判成有缺陷 —— 装完的新 profile
 *   看不到 视频工作台 / 剪辑台 两个 tab。实际根因是：
 *   **conversation.view 只在「有消息的会话」里渲染，空会话不渲染标签条。**
 *   这是 DSH 固有行为，安装完全没问题。
 *
 *   实测判据：同一 profile
 *     · 新建空会话 → [role="tablist"] 数量 = 1（只有「空面板」）
 *     · 点开历史会话 → 数量 = 2，四个 tab 全在，两个功能都正常
 *
 *   本脚本检查安装配置是否自洽（不需要起实例）：
 *     ① install.ps1 列出的包都在 packages/ 下且有 package.json
 *     ② 声明了 dsh.client 的包必须有 lib/client.js（AGENTS §3.11）
 *     ③ 每个包的 main 指向的文件真实存在
 *     ④ README 必须写清「空会话不渲染 tab」这条根因 + 可执行判据
 *     ⑤ 纯逻辑库不进 bundles
 *
 *   ★ 第一版有 4 条断言写错了：我假设「每个包都要有 dsh.client」。
 *     实际有四种形态（纯 host / UI / 混合 / 纯库），见脚本头部注释。
 */
steps.push(run('安装配置自检（install.ps1 / package.json / README）', 'tools', 'verify-install-config.mjs', [], 180000));

/**
 * ★★ 2026-10-23 新增：A5 导入失败提示 + B1/B3/B4 状态点开关
 *
 *   起因：C2 要求「新增验收：进度条渲染、生成/停止切换、宽度首帧、
 *   导出按钮位置、导入字段」。我逐条查覆盖情况：
 *
 *     进度条      5 处 ✅
 *     生成/停止   1 处 ✅
 *     首帧        17 处 ✅
 *     导出按钮    3 处 ✅
 *     导入字段    0 处 ❌
 *     状态点      0 处 ❌
 *
 *   ⇒ 后两项从来没被断言过。它们都已实现（读代码确认了），
 *     但「实现存在」和「有断言盯着」是两件事 —— 后者才防回退。
 *
 *   检查：
 *     A5  .ac-action-error 红色错误条 + role=alert + 可关闭 + 有值才渲染
 *     B1  关闭态点 → /comfy-bridge/ensure；已连接点 → /comfy-bridge/stop
 *     B3  绿点点击 = 关闭（主人要求长时间不用能关掉省设备损耗）
 *     B4  「启动中…/关闭中…」+ busy 禁用 + 失败原因回显
 *     B2  启动参数六件套齐全
 */
steps.push(run('A5 导入失败提示 · B1/B3/B4 状态点开关', 'tools', 'verify-ab-features.mjs', [], 180000));

/**
 * ★★ 2026-10-23 新增：D3 去敏验收
 *
 *   起因：做 D3 时发现 12 个验收脚本硬编码了
 *     const COOKIE_FILE = 'C:/Users/<本机用户>/dsh-tok.txt';
 *   ⇒ 别人 clone 下来跑验收全部失败，报错只说「读不到 token」，
 *     看不出是「路径没配」。这直接违背「可移植」这个目标。
 *
 *   ★ 修复走了两遍，教训（记下来）：
 *     第一遍只处理了「直接 readFileSync」一种写法，
 *     漏了 existsSync 三元、if 分支、try 块三种形态 ⇒ 11 个文件仍崩。
 *     ⇒ 做批量替换前先 grep 出这个常量的【全部】使用点，
 *       按「每处怎么用」分类，而不是按「我以为怎么用」。
 *
 *   本检查：代码文件里不得有 C:/Users/<某用户>/ 与 dsh-tok.txt。
 *   ★ 文档（docs/*.md）允许提及 —— 那是证据，删掉反而丢信息。
 */
steps.push(run('D3 去敏（代码里不得有本机专属路径）', 'tools', 'verify-no-local-paths.mjs', [], 240000));

/**
 * ★★ 2026-10-23 新增：E 段验收（设置页 / 模型清单 / 一键体检）
 *
 *   E 段一直没做过真机验证。本轮实测（19499 + ComfyUI 在线）：
 *
 *   设置侧栏有「ComfyUI 与环境」，点进去：
 *     4 个路径输入（比要求的 3 个多一个「输入目录」）
 *     有「体检」按钮
 *
 *   点体检 → 「1 项有问题」，逐项：
 *     ComfyUI 安装目录 / 输出目录可写 / 输入目录可写 / ffmpeg /
 *     模型 共 26 项 25 就位 缺 1 / 端到端 HTTP 200 · 576ms · ComfyUI 0.40.0
 *     ComfyUI 状态 已连接 · 版本 0.40.0 · 延迟 6ms · 4 个工作流
 *
 *   模型清单按【角色】分组（主人要求过）：
 *     LoRA 8 个 缺 1 · VAE 6 个 · 文本/视觉编码器 5 个 …
 *     每条标注 [字段名] 用于：<工作流>.json · 应放到 models/xxx
 *     缺失项带「→ 下载链接」
 *
 *   ★ 一个值得记的设计点：
 *     comfy-test profile 没有自己的配置时，回退到 desktop 的，
 *     页面如实标注「可能属于另一个 profile」而不是静默用错。
 */
steps.push(run('E 段（设置页 / 模型清单 / 一键体检）', 'tools', 'verify-e-settings.mjs', [], 180000));

/**
 * ★★ 2026-10-23 新增：F1 验收（不该进仓库的东西确实没进）
 *
 *   核对时发现的真实问题：packages/_snapshot-before.json（288KB）
 *   被 git 跟踪了 —— 它是 verify-no-pollution 的临时快照，
 *   每次跑验收都重写 ⇒ 提交一次就永远是脏的，
 *   而且每次 diff 都是整个文件（279589 字符）。
 *   加 .gitignore + git rm --cached 后，仓库 26.2MB → 25.9MB。
 *
 *   ★ 判据的教训：
 *     第一遍我用 git check-ignore 判，得到 3 个「未忽略」，
 *     其中 node_modules/ 和 outputs/ 是误报 ——
 *     那些目录在这仓库里根本不存在，当然不命中。
 *     ⇒ 判据改成看【已跟踪文件里有没有它们】（硬判据），
 *       再加 .gitignore 规则检查（软判据，防下次新建时被 add -A 扫进去）。
 */
steps.push(run('F1（不该进仓库的东西确实没进）', 'tools', 'verify-gitignore.mjs', [], 180000));

/**
 * ★★ 2026-10-23 新增：元验收的元测试
 *
 *   踩过两次同类坑：
 *   ① check-undeclared 登记在 if (!STATIC) 块内，--static 下从没跑过，
 *      但显示「全部通过」（靠核对步骤数才发现）。
 *   ② verify-registry-complete 自己漏扫三个层级，报 134/134 全过，
 *      而 verify-png-tags.mjs 从没登记。
 *
 *   ⇒ 共同点：「检查通过」不等于「检查真的在检查」。
 *     一个从来没红过的检查器，和不存在的检查器没有区别。
 *
 *   本脚本对三个检查器各注入一个「必然发现的缺陷」，确认它们变红，
 *   然后清理。★ 只做可逆注入（写临时文件再删）。
 */
steps.push(run('元测试（三个检查器是否真的在工作）', 'tools', 'meta-test-checkers.mjs', [], 600000));

/**
 * ★★ 2026-10-23 补：verify-png-tags.mjs 一直在 packages/ 根目录，
 *   从没登记进 verify-all —— 而 verify-registry-complete 早该报出来，
 *   但它自己也漏扫了根目录（只扫 PACKAGES 子目录的第一层）。
 *   两处都修好后这条才暴露。13 项断言。
 */
steps.push(run('PNG 标签（写本体不改像素 / 中文 / 幂等）', '.', 'verify-png-tags.mjs', [], 120000));
/**
 * ★★ 2026-10-23 新增：未声明变量检查
 *
 *   实测事故：onGenerate 里写了 mode?._workflow，而组件里叫 currentMode。
 *   症状是「点生成毫无反应」—— 不报错、不发请求、按钮不变。
 *
 *   ★ 可空链 ?. 只能防「值是 null/undefined」，
 *     防不住「变量根本没声明」。这类错误 node --check 抓不到。
 *
 *   用 acorn 做词法作用域分析。装法见 tools/check-undeclared.mjs 顶部注释
 *   （npm 在中文路径下要加 --prefix，否则 EPERM mkdir D:\\）。
 */
/* ★ 未声明变量检查 与 静默 catch 检查 已移到上面的静态段（两个模式都跑）*/

// ── 工作流 1：krea2 ──
if (!STATIC) {
  steps.push(run('krea2 生图（真跑）', 'dsh-comfy-bridge', 'verify-krea2.mjs', [], 600000));
  steps.push(run('qwen21-edit 改图（真跑，含提示词增强器）', 'dsh-comfy-bridge', 'verify-qwen-edit.mjs', [], 1200000));
  steps.push(run('yz 生视频（真跑，含音轨）', 'dsh-comfy-bridge', 'verify-yz.mjs', ['--dur', '2'], 1800000));
}

console.log('─'.repeat(64));
let okAll = true;
for (const s of steps) {
  const mark = s.ok ? '✅' : '❌';
  console.log(`  ${mark} ${s.label.padEnd(52)} ${String(s.sum ?? '').padStart(7)}  ${s.sec ?? ''}s`);
  if (!s.ok) okAll = false;
}
console.log('─'.repeat(64));

/**
 * ══ 出口统一清理 output/（2026-10-23）════════════════════════════════
 *
 * ★ 为什么要在这里做，而不是继续修各个脚本：
 *
 *   实测：单独跑 verify-krea2 → 零残留；
 *        放进 verify-all 里跑 → 每轮必多 1 张 Krea2-2ST-*.png（编号递增）。
 *
 *   我试过 6 个假设，全部不成立：
 *     ❌ 落盘延迟（completed 时文件已在磁盘，实测确认）
 *     ❌ 并发（verify-all 用 spawnSync，是串行的）
 *     ❌ verify-bad-input 不清理（补了 output 清理，仍然漏）
 *     ❌ 固定 sleep 太短（改成等目录稳定，仍然漏）
 *     ❌ completed 后保存节点排队（补等 2 秒，仍然漏）
 *     ❌ 多脚本同名覆盖（核对过，是各自独立的文件）
 *
 *   ⇒ 采纳 AGENTS §6.46 的第三条路：**在出口统一清，不管谁漏都兜住。**
 *     这是当时验证过的做法（「实测：跑前 output 760/input 129 → 跑后 760/129」）。
 *
 * ★ 纪律：
 *   · 只删「跑之前不存在的」——绝不碰已有文件
 *   · 删之前等落盘稳定（连续 3 次采样数量不变，最多 8 秒）
 *   · 失败不阻断退出码（清理失败不该让验收变红）
 *   · 打印删了什么，便于事后核对
 *
 * ★ 为什么不放进各个脚本：
 *   各脚本自己清 = 各自可能漏（这次的实际情况）。
 *   统一在出口清，等于「最后一道闸」，谁漏都被挡住。
 */
const OUT_DIRS = [
  'D:/Comfy-Desktop/ComfyUI-Shared/output',
];

/** 跑之前拍的快照（在 steps 执行前就拍）—— 见文件开头的 OUT_BASELINE */
for (const dir of OUT_DIRS) {
  try {
    if (!OUT_BASELINE) continue;
    // 等落盘稳定
    let last = -1;
    let stable = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const n = fs.readdirSync(dir).length;
      if (n === last) {
        if (++stable >= 3) break;
      } else {
        stable = 0;
        last = n;
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    const now = fs.readdirSync(dir);
    const made = now.filter((n) => !OUT_BASELINE.has(n));
    let gone = 0;
    for (const n of made) {
      try { fs.unlinkSync(`${dir}/${n}`); gone += 1; } catch { /* 占用中，跳过 */ }
    }
    if (made.length) {
      console.log(`  清理 output：${gone}/${made.length} 个本次生成的产物`);
      for (const n of made) console.log(`      - ${n}`);
    }
  } catch { /* 目录读不到就跳过 */ }
}

console.log(`  ${okAll ? '全部通过' : '有失败项'}`);
console.log('═'.repeat(64));
process.exit(okAll ? 0 : 1);



