/**
 * verify-dsh-native-ui.mjs · 「时间轴像 DSH 原生」的静态验收
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么要有这个脚本
 *
 * 本轮的 UI 收口靠的是「浏览器实测 + 逐条核对」。实测有证据但不可回归 ——
 * 下次改代码若碰坏其中一条，没人会知道。这个脚本把每条判据固化成断言。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★ 它检查的是【源码与产物】，不是浏览器。
 *   浏览器侧的量测（按钮实际高度、颜色实际值）另有一个脚本：
 *   verify-dsh-native-ui.live.mjs（需要 19499 在跑）。
 *
 * ★ 判据来源：docs/踩坑-UI收口三根因-20261021.md
 *   每条断言的注释都写明「为什么是这条」，不是拍脑袋写的值。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");                       // packages/
/**
 * ★★ 2026-10-23：dsh-artcraft-tab 已归档移出仓库（剪辑台早已并入本包）
 *
 *   旧路径指向已删除的包 ⇒ 3 项全红：
 *     对齐层文件 / client.js / 产物 lib/client.js
 *
 *   现在：
 *     · 对齐层在 src/editor/dsh-native.css.js
 *     · 客户端入口是 lib/client.js（本包的构建产物）
 *     · 注入逻辑在 src/editor/editorHost.js
 */
const ART = HERE;                        // 本包就是剪辑台的宿主
const EDITOR_SUB = path.join(HERE, "src", "editor");
const UPSTREAM = "D:/主工作区/_upstream/artcraft-demo/video-editor/src";

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

const read = (p) => fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;

/* ─────────────────────────────────────────────────────────────────
   一组 · 对齐层文件本身
   ───────────────────────────────────────────────────────────────── */

const nativePath = path.join(EDITOR_SUB, "dsh-native.css.js");
const native = read(nativePath);
check("对齐层文件存在", native !== null, nativePath);
if (native) {
  // ① 13 个缺失的语义色类必须全部补齐
  //    判据：这 13 个类在 #artcraft-tab-css 里零定义，元素会吃 UA 默认灰
  const requiredColorClasses = [
    "bg-background", "bg-primary", "bg-secondary", "bg-accent", "bg-border",
    "bg-foreground\\/5", "bg-foreground\\/15", "bg-foreground\\/80",
    "text-primary", "text-primary-foreground", "text-secondary-foreground",
    "text-muted-foreground", "text-muted-foreground\\/85",
    "border-border", "border-primary\\/50", "border-muted\\/50",
    "border-foreground\\/10", "border-muted-foreground\\/25",
  ];
  for (const cls of requiredColorClasses) {
    check(`补齐语义色类 .${cls}`,
      native.includes(`.ac-scope .${cls}`),
      `对齐层里找不到 .ac-scope .${cls}`);
  }

  // ② shadcn 约定：--primary 等是 HSL 分量，必须 hsl() 包裹
  //    判据：裸三元组 `216 100% 59%` 直接当 color 解析失败 → 透明/UA 默认
  check("--primary 用 hsl() 包裹（shadcn 约定）",
    /hsl\(var\(--primary/.test(native),
    "缺 hsl(var(--primary))，裸三元组会导致解析失败");
  check("--secondary 用 hsl() 包裹",
    /hsl\(var\(--secondary/.test(native));
  check("--background 用 hsl() 包裹",
    /hsl\(var\(--background/.test(native));

  // ③ 尺寸：size-7 + h-8 + w-8 同时存在时，后者胜出 32px，必须显式收回 28px
  check("收回 32px → 28px（size-7 与 h-8/w-8 冲突）",
    /\.size-7\.h-8\.w-8[^{]*\{[^}]*1\.75rem/.test(native),
    "缺 .size-7.h-8.w-8 { 1.75rem } 覆盖");
  check("字号 text-sm 收到 13px",
    /\.text-sm[^{]*\{[^}]*0\.8125rem/.test(native),
    "0.8125rem = 13px");

  // ④ --st-* 从 --dsw-* 派生（且必须 !important，因为 ArtCraft 的定义在后）
  const stMappings = [
    ["--st-bg", "dsw-alias-bg-base"],
    ["--st-panel", "dsw-alias-bg-layer-1"],
    ["--st-controls", "dsw-alias-bg-layer-2"],
    ["--st-fg", "dsw-alias-label-primary"],
    ["--st-divider", "dsw-alias-border-l1"],
    ["--st-panel-border", "dsw-alias-border-l1"],
    ["--st-controls-border", "dsw-alias-border-l1"],
  ];
  for (const [st, dsw] of stMappings) {
    // ★ 断言写法修正（2026-10-21，连续踩两次）
    //   第一次：`[^;]*!important` 遇到 rgba(...) 里的分号外内容判断不稳
    //   第二次：把 var(--dsw-...) 的前缀写成了 `var(${dsw}` ——
    //           dsw 的值是 "dsw-alias-bg-base"，少拼了开头的两个连字符
    //           ⇒ includes 永远 false，看起来像源码没改
    //   ★ 教训：断言失败时【先看它打印的"实际值"】，那行明明是对的，
    //     就说明错在断言自己的匹配字符串上，不在被测代码。
    const target = `var(--${dsw}`;
    const line = native.split(/\r?\n/).find((l) => l.includes(`${st}:`) && l.includes("!important"));
    const ok = Boolean(line) && line.includes(target) && line.includes("!important");
    check(`${st} 从 --${dsw} 派生（带 !important）`, ok,
      line ? `实际：${line.trim().slice(0, 90)}（找的是 ${target}）` : `找不到含 !important 的 ${st} 行`);
  }

  // ⑤ 每个 var() 都要带 fallback —— DSH 换版本丢 token 时不能全黑
  //    ★ 必须先剥掉注释：注释里写着 var(--dsw-*) 这种示例文本，
  //      不剥会把注释当代码，报出「缺 fallback」的假阳性（本轮实测踩到）。
  const nativeNoComments = native.replace(/\/\*[\s\S]*?\*\//g, "");
  const varCalls = nativeNoComments.match(/var\(--ds[hw]-[^)]*\)/g) ?? [];
  const noFallback = varCalls.filter((v) => !v.includes(","));
  check("所有 --dsw-*/--dsh-* 引用都带 fallback",
    noFallback.length === 0,
    `缺 fallback 的：${noFallback.slice(0, 3).join(" | ")}`);

  // ⑤b ★ token 存在性白名单（本项目已四次踩到「不存在的 token」）
  //    实测存在性记录（2026-10-21，全部从 document.body 读到非空值）：
  //      --dsw-alias-bg-base              #151517
  //      --dsw-alias-bg-layer-1           #232324
  //      --dsw-alias-bg-layer-2           #2c2c2e
  //      --dsw-alias-border-l1            #ffffff0f
  //      --dsw-alias-interactive-bg-hover #ffffff14
  //      --dsw-alias-interactive-bg-active #ffffff24
  //      --dsw-alias-label-primary        #f9fafb
  //      --dsw-elevation-prominent        （三层阴影）
  //      --dsw-menu-backdrop-filter       blur(40px) saturate(150%)
  //      --dsw-menu-surface-fill          #43454a73
  //      --dsw-radius-lg                  16px
  //      --dsw-radius-md                  12px
  //    ★ 不存在的（曾误用过，不要再写）：
  //      --dsw-alias-interactive-bg-selected   ← 本轮踩到
  //      --dsw-alias-bg-elevated / --dsw-alias-fill-l1|l2|l3
  //      --dsw-alias-button-primary-fg / --dsw-alias-label-onbrand
  //      --dsw-alias-fill-hover
  const VERIFIED_TOKENS = new Set([
    "dsw-alias-bg-base", "dsw-alias-bg-layer-1", "dsw-alias-bg-layer-2",
    "dsw-alias-border-l1", "dsw-alias-interactive-bg-hover",
    "dsw-alias-interactive-bg-active", "dsw-alias-label-primary",
    "dsw-elevation-prominent", "dsw-menu-backdrop-filter",
    "dsw-menu-surface-fill", "dsw-radius-lg", "dsw-radius-md",
    // 2026-10-21 补测（浅色主题修复时新增引用）：
    //   --dsw-alias-border-l2            #0000001a（浅色）
    //   --dsw-elevation-panel            三层阴影（比 prominent 弱一档）
    //   --dsw-alias-state-business-primary  #4176e6（浅色）；暗色是 #7aaaff
    "dsw-alias-border-l2", "dsw-elevation-panel", "dsw-alias-state-business-primary",
    // 2026-10-21 圆角三阶（实测 light/dark 都是 16/12/8）
    "dsw-radius-sm",
    // 2026-10-21 滚动条（浅色 #e5e5e5 / #d4d4d4；暗色另值）
    //   ★ 注意：--dsw-alias-scrollbar-thumb 与 --dsw-alias-scrollbar-track
    //     【不存在】，第一版写的就是这两个，被本断言拦下。
    //     真实存在的是 --dsh-scrollbar-thumb（dsh 前缀，不是 dsw）
    "dsw-alias-scrollbar-bg-l1", "dsw-alias-scrollbar-hover-l1",
    "dsh-scrollbar-thumb", "dsh-scrollbar-thumb-hover",
    // 2026-10-21 补测（修导出对话框对比度时新增引用）
    //   实测从 document.body 读到：
    //     --dsw-alias-label-secondary  #61666b
    //     --dsw-alias-label-tertiary   #81858c
    //   ★ 用途：portal 到 body 的浮层【不带 theme-light 类】，
    //     会用到暗色那套 --muted-foreground（216 9% 71% = #adb2b8），
    //     放到浅色浮层上对比度只有 2.1:1（WCAG 要求 4.5:1）。
    //     改用这两个 DSH token 后由主题自动解析。
    "dsw-alias-label-secondary", "dsw-alias-label-tertiary",
  ]);
  const KNOWN_MISSING_TOKENS = new Set([
    "dsw-alias-interactive-bg-selected", "dsw-alias-bg-elevated",
    "dsw-alias-fill-l1", "dsw-alias-fill-l2", "dsw-alias-fill-l3",
    "dsw-alias-button-primary-fg", "dsw-alias-label-onbrand",
    "dsw-alias-fill-hover",
  ]);
  const usedTokens = [...new Set(
    [...nativeNoComments.matchAll(/var\(--(ds[hw]-[a-z0-9-]+)/g)].map((m) => m[1])
  )];
  const unverified = usedTokens.filter(
    (t) => !VERIFIED_TOKENS.has(t) && !KNOWN_MISSING_TOKENS.has(t)
  );
  check("没有引用未经验证的 --dsw-* token",
    unverified.length === 0,
    `未验证的：${unverified.join(", ")}（先在浏览器里实测它的值，再加进白名单）`);
  const usedKnownMissing = usedTokens.filter((t) => KNOWN_MISSING_TOKENS.has(t));
  check("没有引用已知不存在的 --dsw-* token",
    usedKnownMissing.length === 0,
    `引用了不存在的：${usedKnownMissing.join(", ")}`);

  // ⑥ 不能粗暴写 button { border: 0 } —— 会杀掉 7 个有意设 border 的按钮
  check("清 UA 边框用 :not() 精确排除，不是全局 button",
    /button:not\(\.border\)/.test(native),
    "写了全局 button{border:0} 会误伤有 border 类的按钮");

  // ⑦ 时间码按钮补透明底（它只有 text-primary，没有任何实体 bg-*）
  //    ★ 覆盖名单必须是穷举的：button 默认 transparent，
  //      有实底的类要显式还原，否则那些按钮会变透明。
  check("button 默认透明（消掉 UA 灰）",
    /\.ac-scope button \{[^}]*transparent/.test(native),
    "缺 button 默认透明规则");
  for (const cls of ["bg-primary", "bg-secondary", "bg-accent", "bg-background"]) {
    check(`button.${cls} 有显式还原（否则会变透明）`,
      native.includes(`button.${cls}`),
      `button 默认 transparent 后，${cls} 若不还原就会变透明`);
  }

  // ⑧ 浮层（点击后出现的 UI）—— 主人 2026-10-21 明确要求
  //    实测缺陷：bg-popover 零定义 ⇒ 下拉开出来完全透明
  check("补齐 bg-popover（下拉开出来是透明的根因）",
    native.includes(".ac-scope .bg-popover"),
    "缺 bg-popover，下拉/菜单会透明");
  check("补齐 text-popover-foreground",
    native.includes(".ac-scope .text-popover-foreground"));
  check("浮层用 DSH 的毛玻璃底（不是实心色）",
    native.includes("--dsw-menu-surface-fill") && native.includes("--dsw-menu-backdrop-filter"),
    "DSH 原生浮层 = 半透明 #43454a73 + blur(40px)，实心色会显得死板");
  check("浮层用 DSH 的三层阴影",
    native.includes("--dsw-elevation-prominent"),
    "缺 0.5px 内描边 + 3px/20px 双层软阴影");
  check("浮层覆盖 listbox/menu/dialog/tooltip 四类",
    /\[role="listbox"\]/.test(native) && /\[role="menu"\]/.test(native) &&
    /\[role="dialog"\]/.test(native) && /\[role="tooltip"\]/.test(native),
    "Radix 用这四种 role，漏一类就有一种浮层没样式");
  check("浮层选项圆角用 DSH 的 radius-md",
    native.includes("--dsw-radius-md"),
    "DSH menuitem 圆角 12px");
  check("浮层选项字号对齐 13px",
    /\[role="option"\][\s\S]{0,400}0\.8125rem/.test(native),
    "DSH menuitem 字号 13px");

  // ⑨ 文件头必须记录三条根因与尺寸基准（防止后来者删掉注释又踩回去）
  check("文件头记录了三条根因",
    native.includes("三条根因") && native.includes("UA 默认灰"),
    "缺根因说明，后来者会重复推导");

  // ⑩ ★ 注释里不许出现反引号
  //    本文件外层是 String.raw 模板字符串，注释里的反引号会把它提前闭合，
  //    报错是 "Expected ; but found xxx"，指向的位置看起来毫无问题（在注释里）。
  //    本轮连踩两次（一次在 hover:bg-muted/50，一次在 body:has(...)）。
  //    判据：从 `export default String.raw\`` 之后的正文里，反引号只应有
  //          开头那一个和结尾那一个。
  const backticks = (native.match(/`/g) ?? []).length;
  check("文件里只有 2 个反引号（模板字符串的开与闭）",
    backticks === 2,
    `实测 ${backticks} 个 —— 注释里有反引号会把 String.raw 模板提前闭合，构建报 "Expected ;" `);

  // ⑪ 浮层要能覆盖 portal 到 body 的那一批
  check("浮层覆盖 portal 到 body 的情况",
    native.includes("body:has(.ac-scope)"),
    "Radix 把浮层 portal 到 body，纯 .ac-scope 作用域命中不了（本轮实测）");
  check("注释里说明了 portal 这个坑",
    native.includes("closest('.ac-scope')") || native.includes("portal 到 document.body"),
    "缺说明，后来者会重写一遍 .ac-scope [role=listbox] 然后发现没生效");
}

/* ─────────────────────────────────────────────────────────────────
   二组 · 接线（对齐层必须真的被注入）
   ───────────────────────────────────────────────────────────────── */

/**
 * ★★ 2026-10-23：合包后客户端入口拆成两个文件
 *
 *   原来 dsh-artcraft-tab 的 client.js 既是插件入口又装剪辑台组件。
 *   合包后：
 *     · 插件的 name/apply/inject 归 src/client.js
 *     · 剪辑台组件与工具留在 src/editor/editorHost.js
 *   ⇒ 注入对齐层的逻辑在 editorHost.js。
 *     优先读它；读不到才回退 client.js。
 */
const hostSrc = read(path.join(EDITOR_SUB, "editorHost.js"));
const clientSrc = hostSrc ?? read(path.join(ART, "src", "client.js"));
check("client.js 存在", clientSrc !== null);
if (clientSrc) {
  check("client.js 导入了对齐层",
    /import\s+DSH_NATIVE_CSS\s+from\s+["']\.\/dsh-native\.css\.js["']/.test(clientSrc),
    "缺 import DSH_NATIVE_CSS");
  check("有 injectDshNativeOnce 函数",
    /function\s+injectDshNativeOnce\s*\(/.test(clientSrc));
  check("injectCssOnce 调用了对齐层注入",
    /injectCssOnce[\s\S]{0,900}injectDshNativeOnce\(\)/.test(clientSrc),
    "注入顺序：基础样式后必须紧跟对齐层");
  check("对齐层用独立 id（可单独 disable 排查）",
    clientSrc.includes('"artcraft-dsh-native"'));
}

/* ─────────────────────────────────────────────────────────────────
   三组 · 产物（构建后的 lib/client.js 必须包含对齐层）
   ───────────────────────────────────────────────────────────────── */

const clientLib = read(path.join(ART, "lib", "client.js"));
check("产物 lib/client.js 存在", clientLib !== null);
if (clientLib) {
  check("产物包含对齐层 id", clientLib.includes("artcraft-dsh-native"));
  check("产物包含尺寸覆盖规则", clientLib.includes("size-7.h-8.w-8"));
  check("产物包含派生映射", clientLib.includes("dsw-alias-bg-layer-1"));
  // payload 劫持检查：导出块里必须是我们的 apply，不是 ArtCraft 的 mount
  check("产物未被 payload 劫持（无 __export(mount...)）",
    !/__export\([^)]*_exports,\s*\{\s*mount:/.test(clientLib),
    "这是 §6.39 ② 的老坑：base64 编码就是为了防它");
}

/* ─────────────────────────────────────────────────────────────────
   四组 · 上游标尺修复
   ───────────────────────────────────────────────────────────────── */

const rulerUtils = read(path.join(UPSTREAM, "lib", "timeline", "ruler-utils.ts"));
check("上游 ruler-utils.ts 存在", rulerUtils !== null, UPSTREAM);
if (rulerUtils) {
  // 判据：原 [2,3,5,10,15] 里 5/10/15 都不整除 24fps ⇒ 永不落到整秒
  check("LABEL_FRAME_INTERVALS 已换成整除 fps 的值",
    /LABEL_FRAME_INTERVALS\s*=\s*\[2,\s*3,\s*4,\s*6,\s*12\]/.test(rulerUtils),
    "期望 [2, 3, 4, 6, 12]：全部整除 24fps");
  check("标签不再输出帧号（Xf）",
    !/return `\$\{frameWithinSecond\}f`/.test(rulerUtils),
    "还在返回 ${frameWithinSecond}f");
  check("有小数秒格式化函数",
    /function formatFractionalTimestamp/.test(rulerUtils));
  check("formatRulerLabel 接受 labelIntervalSeconds",
    /labelIntervalSeconds\?/.test(rulerUtils));
}

const tickTsx = read(path.join(UPSTREAM, "lib", "timeline", "components", "timeline-tick.tsx"));
if (tickTsx) {
  check("timeline-tick 透传 labelIntervalSeconds",
    /labelIntervalSeconds/.test(tickTsx));
}

const rulerTsx = read(path.join(UPSTREAM, "lib", "timeline", "components", "timeline-ruler.tsx"));
if (rulerTsx) {
  check("timeline-ruler 把 labelIntervalSeconds 传给 Tick",
    /labelIntervalSeconds=\{labelIntervalSeconds\}/.test(rulerTsx));
  check("标尺 aria-label 已中文化",
    rulerTsx.includes('aria-label="时间轴标尺"'),
    "还有 Timeline ruler 英文");
}

/* ─────────────────────────────────────────────────────────────────
   五组 · aria-label / title 中文化
   ───────────────────────────────────────────────────────────────── */

const trackTsx = read(path.join(UPSTREAM, "lib", "timeline", "components", "timeline-track.tsx"));
if (trackTsx) {
  check("轨道选择 aria-label 中文化",
    trackTsx.includes("选择「"),
    "还有 Select ${track.name} track");
}

const timelineIndex = read(path.join(UPSTREAM, "lib", "timeline", "components", "index.tsx"));
if (timelineIndex) {
  check("时间轴容器 aria-label 中文化",
    timelineIndex.includes('aria-label="时间轴"') && !timelineIndex.includes('aria-label="Timeline"'),
    "还有 aria-label=\"Timeline\"");
}

const timecodeTsx = read(path.join(UPSTREAM, "lib", "components", "editable-timecode.tsx"));
if (timecodeTsx) {
  check("时间码 title 中文化",
    timecodeTsx.includes("点击修改时间") && !timecodeTsx.includes("Click to edit time"),
    "还有 Click to edit time");
}

/* ─────────────────────────────────────────────────────────────────
   汇总
   ───────────────────────────────────────────────────────────────── */

const total = pass + fails.length;
console.log("");
if (fails.length === 0) {
  console.log(`  ✓ dsh-native-ui  ${pass}/${total} 全过`);
  process.exit(0);
}
console.log(`  ✗ dsh-native-ui  ${pass}/${total}，失败 ${fails.length} 项：`);
for (const f of fails) {
  console.log(`      · ${f.name}${f.detail ? `\n        ${f.detail}` : ""}`);
}
process.exit(1);

