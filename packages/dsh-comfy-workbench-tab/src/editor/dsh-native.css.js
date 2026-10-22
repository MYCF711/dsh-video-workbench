/**
 * dsh-artcraft-tab · DSH 原生对齐层（覆盖 CSS）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这份文件的作用：让 ArtCraft 的时间轴编辑器看起来像 DSH 自己的一部分。
 *
 * 它不修改 ArtCraft 的任何行为，只覆盖【样式】。
 * 由 build.mjs 追加到 ac.css 之后（保证后加载、同特异性下获胜）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 三条根因（全部 2026-10-21 浏览器实测，详见 docs/踩坑-UI收口三根因-20261021.md）
 *
 * ① 13 个语义色类在 #artcraft-tab-css 里【零定义】
 *    → 元素回落浏览器 UA 默认灰 rgb(107,107,107)
 *    → 这才是「不像原生」的最大来源，比尺寸问题严重
 *    判据：裸 <button> 的 UA 底色与这些元素完全一致
 *
 * ② 按钮同时带 size-7 + h-8 + w-8
 *    → h-8(2rem=32px) 在 CSS 里排在 size-7(1.75rem=28px) 之后，同特异性后写者赢
 *    → 实测 32px，DSH 原生 28px
 *
 * ③ --st-panel 比 --st-bg 更暗（#101014 < #121316）
 *    而 DSH 的 bg-layer-1 比 bg-base 更亮（#232324 > #151517）
 *    → 两套层级方向相反，必须按【语义】映射，不能按名字对等
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★ 尺寸基准（DSH 原生，实测）
 *
 *    页签        高 25  字号 13  字重 500  padding "0 0 9px"  圆角 0
 *    工具条图标  28×28  字号 12  圆角 8
 *    主按钮      38 高  字号 14  padding "8px 12px"  圆角 12
 *    小工具按钮  23×22  字号 11  padding "3px 5px"
 *
 *    本层采用分层策略：次要控件收到 28×28 / 13px，主按钮（导出）保持原尺寸
 *    —— 单一基准会让主按钮也变小，反而失去主次。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★ 注意：所有 var() 都带 fallback。
 *   因为 --dsw-* token 注册在 CSSOM 的 body 作用域（不在 :root），
 *   若将来 DSH 改版本丢了某个 token，fallback 保证不至于全黑。
 */

export default String.raw`
/* ═══════════════════════════════════════════════════════════════════
   ① 补齐 ArtCraft 缺失的 13 个语义色类
   —— shadcn 约定：--primary 等是 HSL 分量，必须用 hsl() 包裹
   ═══════════════════════════════════════════════════════════════════ */

.ac-scope .bg-background        { background-color: hsl(var(--background, 225 10% 8%)); }
.ac-scope .bg-primary           { background-color: hsl(var(--primary, 216 100% 59%)); }
.ac-scope .bg-secondary         { background-color: hsl(var(--secondary, 240 4% 9%)); }
.ac-scope .bg-accent            { background-color: hsl(var(--accent, 240 4% 9%)); }
.ac-scope .bg-border            { background-color: hsl(var(--border, 0 0% 100% / .15)); }

.ac-scope .bg-foreground\/5      { background-color: rgba(255, 255, 255, .045); }
.ac-scope .bg-foreground\/15     { background-color: hsl(var(--foreground, 0 0% 98%) / .15); }
.ac-scope .bg-foreground\/80     { background-color: hsl(var(--foreground, 0 0% 98%) / .80); }

.ac-scope .text-primary              { color: hsl(var(--primary, 216 100% 59%)); }
.ac-scope .text-primary-foreground   { color: hsl(var(--primary-foreground, 0 0% 98%)); }
.ac-scope .text-secondary-foreground { color: hsl(var(--secondary-foreground, 0 0% 98%)); }
.ac-scope .text-muted-foreground     { color: hsl(var(--muted-foreground, 0 0% 64%)); }
.ac-scope .text-muted-foreground\/85 { color: hsl(var(--muted-foreground, 0 0% 64%) / .85); }

.ac-scope .border-border               { border-color: hsl(var(--border, 0 0% 100% / .15)); }
.ac-scope .border-primary\/50          { border-color: hsl(var(--primary, 216 100% 59%) / .5); }
.ac-scope .border-muted\/50            { border-color: hsl(var(--muted, 240 4% 9%) / .5); }
.ac-scope .border-foreground\/10       { border-color: hsl(var(--foreground, 0 0% 98%) / .10); }
.ac-scope .border-muted-foreground\/25 { border-color: hsl(var(--muted-foreground, 0 0% 64%) / .25); }

/* ═══════════════════════════════════════════════════════════════════
   ② 尺寸：收到 DSH 原生 28×28 / 13px
   —— size-7 与 h-8/w-8 同时存在时，后者胜；用 0,3,0 特异性收回
   ═══════════════════════════════════════════════════════════════════ */

.ac-scope .size-7.h-8.w-8,
.ac-scope .h-8.w-8 { height: 1.75rem; width: 1.75rem; }

.ac-scope .h-8 { height: 1.75rem; }
.ac-scope .w-8 { width: 1.75rem; }
.ac-scope .size-8 { height: 1.75rem; width: 1.75rem; }

.ac-scope .text-sm { font-size: 0.8125rem; line-height: 1.0625rem; }

/* rounded-sm 在 ArtCraft 是 0.125rem(2px)，DSH 同级约 4px */
.ac-scope .rounded-sm { border-radius: 0.25rem; }

/* ═══════════════════════════════════════════════════════════════════
   ③ 主题：--st-* 全部从 --dsw-* 派生
   —— 按语义映射，不按名字对等（见文件头 ③）
   —— !important 必须加：ArtCraft 的 .ac-scope 规则同特异性且在后
   ═══════════════════════════════════════════════════════════════════ */

.ac-scope {
  --st-bg:        var(--dsw-alias-bg-base, #151517) !important;
  --st-panel:     var(--dsw-alias-bg-layer-1, #232324) !important;
  --st-controls:  var(--dsw-alias-bg-layer-2, #2c2c2e) !important;
  --st-modal:     var(--dsw-alias-bg-layer-1, #232324) !important;
  /* ★ sunken 是「比底色更暗一格」的语义。DSH 没有这个 token，
     所以按主题分开给：暗色下比 base 暗，浅色下比 base 略深一点。
     （见下方 ③b 的分主题覆盖） */
  --st-sunken:    var(--dsw-alias-bg-base, #151517) !important;
  --st-fg:        var(--dsw-alias-label-primary, #f9fafb) !important;
  --st-fg-rgb:    249 250 251 !important;
  --st-divider:         var(--dsw-alias-border-l1, rgba(255, 255, 255, .06)) !important;
  --st-panel-border:    var(--dsw-alias-border-l1, rgba(255, 255, 255, .06)) !important;
  --st-controls-border: var(--dsw-alias-border-l1, rgba(255, 255, 255, .06)) !important;
}

/* ═══════════════════════════════════════════════════════════════════
   ③b ★★ 补齐 shadcn 那批变量（浅色主题下必须重定义）

   —— 这是本轮最严重的一个缺陷，主人切到浅色主题时「原形毕露、很脏」。

   ★ 根因（实测，2026-10-21）：
     ArtCraft 的 CSS 里，shadcn 那 16 个变量【只定义了 1 次】，
     而且只给了暗色值：
       --background: 225 10% 8%      --foreground: 0 0% 98%
       --secondary: 240 4% 9%        --accent: 240 4% 9%
       --popover: 240 11% 7%         --muted: 240 4% 9%
       ...
     而它的 .theme-light 类【只改了 scrollbar-color 一行】，
     根本没重定义这些变量。
     ⇒ 切到浅色主题时：底色变白（--st-bg 被我派生到 #fff），
       但所有按钮/下拉/选中块仍是暗色值 rgb(22,22,24)
       ⇒ 白底上一堆黑块，就是主人说的「很脏」。

   ★ 判据（可复跑）：
     getComputedStyle(document.querySelector('.ac-scope'))
       .getPropertyValue('--secondary')  在 .theme-light 下应为浅色分量

   ★ 修法：按 shadcn 约定重写浅色值（HSL 分量，不带 hsl() 包裹），
     并把暗色的值也统一写成与 DSH 一致的（避免零点几的色差）。
     色值取自 DSH 浅色主题实测：
       底色 #fff / 文字 #0f1115 / 次要文字 #61666b / 边框 #0000000a
   ═══════════════════════════════════════════════════════════════════ */

/* —— 暗色（默认）：保持原样，与 DSH 暗色对齐 —— */
.ac-scope {
  --background: 0 0% 8%;            /* #151517 */
  --foreground: 210 20% 98%;        /* #f9fafb */
  --card: 0 0% 14%;                 /* #232324 = bg-layer-1 */
  --card-foreground: 210 20% 98%;
  --popover: 0 0% 14%;
  --popover-foreground: 210 20% 98%;
  --primary: 216 100% 59%;          /* 品牌蓝，保留 */
  --primary-foreground: 0 0% 100%;
  --secondary: 0 0% 17%;            /* #2c2c2e = bg-layer-2 */
  --secondary-foreground: 210 20% 98%;
  --muted: 0 0% 17%;
  --muted-foreground: 216 9% 71%;   /* #adb2b8 */
  --accent: 0 0% 17%;               /* shadcn 的 accent = 中性悬停底 */
  --accent-foreground: 210 20% 98%;
  --border: 0 0% 100% / 0.06;
  --input: 0 0% 100% / 0.10;
  --ring: 217 100% 73%;
  --destructive: 0 70% 50%;
  --destructive-foreground: 0 0% 100%;
}

/* —— 浅色（★ 本轮新增）：ArtCraft 从未定义过，全部补齐 ——
   色值全部取自 DSH 浅色主题实测。注意 DSH 浅色下 bg-layer-1/2/3
   都是 #fff，层级靠边框与阴影撑，所以这里 secondary/accent 用
   极淡的灰（0 0% 96%）而不是纯白，否则按钮与底完全分不出。 */
.ac-scope.theme-light {
  --background: 0 0% 100%;          /* #fff */
  --foreground: 222 26% 7%;         /* #0f1115 */
  --card: 0 0% 100%;
  --card-foreground: 222 26% 7%;
  --popover: 0 0% 100%;
  --popover-foreground: 222 26% 7%;
  --primary: 216 100% 59%;
  --primary-foreground: 0 0% 100%;
  --secondary: 210 20% 96%;         /* 极淡灰，比 #fff 可见但很轻 */
  --secondary-foreground: 222 26% 7%;
  --muted: 210 20% 96%;
  --muted-foreground: 215 12% 39%;  /* #61666b */
  --accent: 210 20% 96%;
  --accent-foreground: 222 26% 7%;
  --border: 0 0% 0% / 0.06;
  --input: 0 0% 0% / 0.10;
  --ring: 216 100% 59%;
  --destructive: 0 70% 50%;
  --destructive-foreground: 0 0% 100%;

  /* 分主题的 --st-* 修正 */
  --st-sunken: #f2f3f5 !important;         /* 浅色下「凹陷」= 略深的灰 */
  --st-fg-rgb: 15 17 21 !important;        /* 供 rgb(var(--st-fg-rgb)) 用 */
}

/* 暗色下的 sunken（补在上面默认块之后，保证特异性够） */
.ac-scope:not(.theme-light) {
  --st-sunken: #0e0e10 !important;
}

/* ═══════════════════════════════════════════════════════════════════
   ③c ★★ 滚动条也必须跟主题走

   —— 实测（2026-10-21 浅色）：时间轴底部出现一条粗黑带，
      查出来是 scrollbar-color: rgb(44,44,47) rgb(11,11,12)，
      那是 ArtCraft 写死的暗色 thumb/track。
      ArtCraft 只在自己的 .theme-light 里改了 scrollbar-color，
      但我新增的规则把 --st-* 覆盖之后，滚动条仍是暗色值。

   —— 判据（可复跑）：浅色主题下
      getComputedStyle(滚动容器).scrollbarColor 的亮度应 > 200

   —— ★ token 实测（2026-10-21，从 document.body 读）：
        --dsh-scrollbar-thumb        #e5e5e5   ✓ 存在
        --dsh-scrollbar-thumb-hover  #d4d4d4   ✓ 存在
        --dsw-alias-scrollbar-bg-l1  #e5e5e5   ✓ 存在
        --dsw-alias-scrollbar-hover-l1 #d4d4d4 ✓ 存在
        --dsw-alias-scrollbar-thumb  (缺)      ✗ 我第一版写的就是这个，错的
        --dsw-alias-scrollbar-track  (缺)      ✗ 同上
        --dsh-scrollbar-track        (缺)      ✗
      ⇒ 用真实存在的两个：--dsh-scrollbar-thumb / --dsw-alias-scrollbar-bg-l1
   ═══════════════════════════════════════════════════════════════════ */

/**
 * ★★ 2026-10-22 主人实测（第三次改滚动条）：
 *   「鼠标不放在滚动条上面的时候有一个很丑的长方形灰色块，
 *    只要鼠标放上去才有圆角滑动条」
 *
 *   根因：上一版给 track 铺了实心底色
 *     background: var(--dsw-alias-scrollbar-bg-l1)   // #e5e5e5
 *   同时 scrollbar-color 的两个值又是同一个灰
 *     rgb(229,229,229) rgb(229,229,229)
 *   ⇒ 整个 8px 宽的槽位是一块实心灰长条，滑块和槽位分不出来。
 *     圆角只加在 thumb 上，所以「没悬停时」看到的就是那条没有圆角的灰块。
 *
 *   ⇒ 改法（对齐 DSH 原生 + macOS 悬浮式滚动条）：
 *     ① track 完全透明 —— 不要底色，只留滑块
 *     ② 滑块给半透明灰 + 圆角，平时也能看见（不是完全隐藏，否则找不到）
 *     ③ hover 时才加深，而不是 hover 才出现
 *     ④ 宽度 8px，滑块用 border + background-clip 内缩 2px
 *        这样视觉上滑块只有 4px 宽，更接近 DSH 的细线风格
 *
 *   ★ 为什么用 background-clip: content-box + 透明边框：
 *     滚动条伪元素不能设 margin / padding，
 *     唯一能做「内缩」的办法就是用透明边框把 background 挤进去。
 */
.ac-scope ::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.ac-scope ::-webkit-scrollbar-track {
  /* ★ 透明：不要实心灰块 */
  background: transparent;
}

.ac-scope ::-webkit-scrollbar-thumb {
  /* ★ 半透明灰 + 圆角，平时可见 */
  background-color: var(--dsh-scrollbar-thumb, rgba(0, 0, 0, 0.22));
  border-radius: 999px;
  /* ★ 内缩 2px：视觉宽度 8 - 2*2 = 4px，更细更接近 DSH */
  border: 2px solid transparent;
  background-clip: content-box;
}

.ac-scope ::-webkit-scrollbar-thumb:hover {
  background-color: var(--dsh-scrollbar-thumb-hover, rgba(0, 0, 0, 0.38));
}

.ac-scope ::-webkit-scrollbar-thumb:active {
  background-color: var(--dsh-scrollbar-thumb-hover, rgba(0, 0, 0, 0.46));
}

/* 角落（横竖交汇处）也不要灰块 */
.ac-scope ::-webkit-scrollbar-corner {
  background: transparent;
}

/**
 * scrollbar-color 也一起改：thumb 半透明、track 透明。
 * ★ Firefox 走这条；Chrome 走上面的 ::-webkit-*。
 */
.ac-scope,
.ac-scope * {
  scrollbar-color: var(--dsh-scrollbar-thumb, rgba(0, 0, 0, 0.22)) transparent;
}

/* ═══════════════════════════════════════════════════════════════════
   ③d ★★ 轨道区纵向滚动条：必须【能看见、不跳动】

   主人：「这个高度锁死了，应该加一个纵向的滑动条」

   —— 实测（2026-10-21）：
      轨道区容器已经是 overflow-y:auto，
      但 ArtCraft 给它加了 scrollbar-thin + scrollbar-hidden（按需隐藏），
      结果是：内容刚好放下时完全看不到滚动条；
      一旦轨道变多或行高调大，滚动条突然出现，
      轨道内容宽度瞬间被挤窄约 10px ⇒ 卡片横向跳动。
      （子代理报过「拖缩放后素材片段消失」，根因之一就是这种宽度跳变）

   —— 修法：
      ① scrollbar-gutter: stable 预留槽位 —— 滚动条出现/消失时宽度不变
      ② 纵向/横向都 8px（2026-10-22 从 10px 改回来：
         10px 太粗，比 DSH 自己那条细线显眼得多；
         滑块靠 border 内缩到 4px 视觉宽度，命中区仍是 8px）
      ③ 对同时带 overflow-auto 与 scrollbar-hidden 的容器解除隐藏
   ═══════════════════════════════════════════════════════════════════ */

.ac-scope .scrollbar-thin {
  scrollbar-gutter: stable;
}

.ac-scope ::-webkit-scrollbar:vertical {
  width: 8px;
}
.ac-scope ::-webkit-scrollbar:horizontal {
  height: 8px;
}

/* 判据：容器同时带 overflow-auto 与 scrollbar-hidden 时，解除隐藏 */
.ac-scope .scrollbar-hidden.overflow-auto,
.ac-scope .scrollbar-hidden.overflow-y-auto {
  scrollbar-width: thin !important;
}
.ac-scope .scrollbar-hidden.overflow-auto::-webkit-scrollbar,
.ac-scope .scrollbar-hidden.overflow-y-auto::-webkit-scrollbar {
  display: block !important;
}

/* ═══════════════════════════════════════════════════════════════════
   ④ 大面积底色 / 面板平移到 DSH 层级
   —— ArtCraft 的 bg-background 是 hsl(225 10% 8%) ≈ #121316，比 DSH 偏暗
   ═══════════════════════════════════════════════════════════════════ */

.ac-scope .bg-background        { background-color: var(--dsw-alias-bg-base, #151517) !important; }
.ac-scope .panel                { background-color: var(--dsw-alias-bg-layer-1, #232324) !important; }
.ac-scope .panel.bg-background  { background-color: var(--dsw-alias-bg-base, #151517) !important; }

/* ═══════════════════════════════════════════════════════════════════
   ④b ★★ 补齐 bg-ui-* 系列（导出对话框的容器就是 bg-ui-controls）

   —— 这一族是 ArtCraft 自己定义的「语义类」，全部只读 --st-*：
        .bg-ui-background    → var(--st-bg)
        .bg-ui-panel         → var(--st-panel)
        .bg-ui-panel-gradient→ var(--st-panel)
        .bg-ui-controls      → var(--st-controls)
        .bg-ui-modal         → var(--st-modal)
        .bg-ui-badge         → rgba(0,0,0, var(--st-badge-alpha))
     ⇒ 我已经把 --st-* 派生到 DSH token，所以它们【理论上】会跟着走。
       但实测浅色主题下导出对话框仍是白底白框 —— 原因不是这一族没派生，
       而是 --st-controls 在浅色下等于 #fff，与底色相同，看不出面板边界。

   ★ 判据（可复跑）：浅色主题打开导出对话框，
     getComputedStyle(对话框).backgroundColor 应 ≠ body 的背景色，
     或至少有 border/shadow 能分出边界。

   ⇒ 修法：这一族不平移到纯色，而是按 DSH 的「层级 + 描边」规则给：
     大面积底 → bg-base
     面板/弹层 → bg-layer-1 + 0.5px 描边（DSH 浅色下 layer 全是 #fff，
                层级只能靠描边撑，这是它的设计选择）
   ═══════════════════════════════════════════════════════════════════ */

.ac-scope .bg-ui-background { background: var(--dsw-alias-bg-base, #151517) !important; }
.ac-scope .bg-ui-panel,
.ac-scope .bg-ui-panel-gradient {
  background: var(--dsw-alias-bg-layer-1, #232324) !important;
  background-color: var(--dsw-alias-bg-layer-1, #232324) !important;
}
.ac-scope .bg-ui-modal {
  background: var(--dsw-alias-bg-layer-1, #232324) !important;
}
.ac-scope .bg-ui-badge {
  background-color: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .08)) !important;
}

/* ★ 关键：bg-ui-controls 是【弹层容器】（导出对话框、下拉面板都用它）。
   DSH 里这类容器的做法是「bg-base 或 bg-layer-1 + 0.5px 描边 + 阴影」，
   而不是一个与底色同值的纯色 —— 否则浅色下完全看不出边界。 */
.ac-scope .bg-ui-controls {
  background: var(--dsw-alias-bg-base, #151517) !important;
  background-color: var(--dsw-alias-bg-base, #151517) !important;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, .10)) !important;
  box-shadow: var(--dsw-elevation-panel,
    0 0 0 .5px rgba(0, 0, 0, .06), 0 3px 8px 0 rgba(0, 0, 0, .04), 0 0 16px 0 rgba(0, 0, 0, .02)) !important;
}
/* 边界色也跟着走（原来读 --st-controls-border） */
.ac-scope .border-ui-controls-border {
  border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, .10)) !important;
}
.ac-scope .border-ui-panel-border {
  border-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, .06)) !important;
}
.ac-scope .border-ui-divider {
  border-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, .06)) !important;
}

/* ═══════════════════════════════════════════════════════════════════
   ⑤ 清掉 UA 默认的 outset 边框
   —— 实测时间码按钮 border = "2px outset rgb(255,255,255)"，
      截图上表现为白框，极易误认成选中态
   —— ★ 不能写 button { border: 0 }，会杀掉 7 个有意设了 border 的按钮
   ═══════════════════════════════════════════════════════════════════ */

.ac-scope button:not(.border):not(.border-border):not(.border-transparent) {
  border: 0;
}
.ac-scope button.border,
.ac-scope button.border-border,
.ac-scope button.border-transparent { border-width: 1px; border-style: solid; }
.ac-scope button.border-primary\/50 { border-width: 2px; border-style: solid; }

/* ═══════════════════════════════════════════════════════════════════
   ⑤b ★★ 补 Tailwind preflight 的 border-style 兜底（精确版）

   —— 实测（2026-10-21）标尺上 40 个刻度线全部「宽度 0px、画不出来」：
        class   = "border-muted-foreground/25 absolute top-1.5 h-1.5 border-l"
        borderLeftWidth = 0px      ← CSS 里明明写了 1px
        borderLeftStyle = none     ← 真凶
        matchesBorderL  = true     ← 说明选择器没坏

   —— 根因：Tailwind 的 preflight 里有一句
        *, ::before, ::after { border-style: solid; border-width: 0 }
      它保证 .border-l { border-left-width: 1px } 这类「只写宽度」的类能生效。
      本项目的 build-css.mjs 为了作用域隔离【关掉了 preflight】，
      于是 border-style 回到浏览器默认 none ⇒ 宽度算出来永远是 0。

   ★★ 第一版修法写的是全局兜底：
        .ac-scope *, .ac-scope ::before, .ac-scope ::after { border-style: solid; border-width: 0 }
      实测立刻出副作用：滑块 thumb 的 class 是 "border-primary/50 bg-background"，
      它【只设了边框颜色】、没设宽度，原本靠「没有 style 所以不生效」保持实心圆点；
      补了 solid 之后那条 1px 蓝边框生效，
      截图里进度条与缩放滑块的圆点变成「空心蓝圈 + 白心」。
      ⇒ 一个全局兜底会同时激活许多「只设颜色、本不想生效」的类，
        direction 不可控。

   —— 精确修法（本版采纳）：
      只给【真正需要边框的 Tailwind 工具类】补 style，不做全局兜底。
      当前用到的是 .border-l（标尺刻度）。其它方向一并给出，
      但每条都显式写明「这个类本来就是要画线的」。
      判据：新增任何一类时，先确认 ArtCraft 里有没有元素
            「只设了边框颜色、但不该有边框」的用法。
   ═══════════════════════════════════════════════════════════════════ */

.ac-scope .border-l { border-left-style: solid; }
.ac-scope .border-r { border-right-style: solid; }
.ac-scope .border-t { border-top-style: solid; }
.ac-scope .border-b { border-bottom-style: solid; }
/* .border（四边）与 .border-2 自带 width，style 也补上 */
.ac-scope .border   { border-style: solid; }
.ac-scope .border-2 { border-style: solid; }

/* ★ 显式声明了 none / dashed 的类必须仍然优先。
   上面几条与 ArtCraft 自己的定义同为 (0,2,0)，
   同特异性下【后加载者赢】—— 我这层在 #artcraft-tab-css 之后，
   所以我会把 .border-none 覆盖成 solid ⇒ 必须在这里显式还原。 */
.ac-scope .border-none   { border-style: none; }
.ac-scope .border-dashed { border-style: dashed; }
.ac-scope .border-transparent { border-color: transparent; }

/* ★ 滑块 thumb（进度条圆点 / 缩放滑块圆点）显式归零边框。
   它的 class 是 "border-primary/50 bg-background"，
   第 66 行的 .border-primary\/50 只设了 border-color、没设宽度 ——
   本该「没有 style 所以不生效」保持实心圆点。
   但它是 [role=slider] 的直接子元素，与任何 button 规则无关；
   这里显式归零是为了防止将来有人给 .border-primary\/50 补 width 时误伤它。 */
.ac-scope [role="slider"] > span { border-width: 0 !important; }

/* ★★ 2026-10-21 滑块圆点必须【实心】，不能是白底空心
   —— 实测（浅色主题截图）：进度条与缩放滑块的圆点看起来是「空心方块」。
      查出来 thumb 的 class 是 "border-primary/50 bg-background"：
        bg-background 在浅色 = #fff，
        而它浮在 #fff 的轨道上 ⇒ 视觉上就是个白点，等于看不见。
      暗色主题下这个问题更隐蔽（白点浮在深色轨道上反而显眼），
      但两边都不对：圆点应该用【主色填充】，靠颜色表达「这是可拖的点」。
   —— 判据（可复跑）：
        getComputedStyle(thumb).backgroundColor 应等于主色，不是 rgb(255,255,255)
   —— ⚠ 只作用于 [role=slider] 的直接子 span，
        不动 ArtCraft 其它用 bg-background 的地方。 */
.ac-scope [role="slider"] > span {
  background-color: var(--dsw-alias-state-business-primary, #4176e6) !important;
  box-shadow: 0 0 0 2px var(--dsw-alias-bg-base, #fff) !important;
}

/* ═══════════════════════════════════════════════════════════════════
   ⑥ 补最后一个吃 UA 默认底的元素：时间码按钮
   —— 它只有 text-primary，没有任何实体 bg-* 类 ⇒ 底色回落到 UA 的 rgb(107,107,107)
   —— 实测：清洗前 UA 灰命中数 = 1，就是这个按钮
   ★ 这条规则连续改错三次，把过程记下来（比规则本身值钱）：
     第 1 次：button.text-primary:not([class*="bg-"])  —— 不匹配。
              因为按钮带 hover:bg-muted/50，字符串含 "bg-"，被 :not 排除了。
     第 2 次：想用 button { background-color: transparent } 一刀切
              —— 会连带抹掉 bg-secondary / bg-primary / bg-background 的实底。
     第 3 次：想用 revert 还原 —— 错。revert 回退到【浏览器 UA 默认】，
              正是我们要消掉的那个灰。不是「回到上一层规则」。
     第 4 次（本版，采纳）：button 默认 transparent，
              再把这几个有实底的类用【同样的值】显式写一遍。
              实测 36 个按钮全部带显式 bg-* 类，只有时间码没有，所以覆盖名单是穷举的。
   ★ 判据：matchesMine 为 false 而 computedBg 仍是 UA 灰
           ⇒ 是选择器没命中，不是优先级问题。
   ★ 维护提醒：将来 ArtCraft 若新增别的 bg-* 类用在 button 上，
     这里要同步加进来，否则那个按钮会变透明。已在 verify 脚本里留了断言。
   ═══════════════════════════════════════════════════════════════════ */

.ac-scope button { background-color: transparent; }

/* 有实底的按钮：显式还原（值与上面第①组完全一致，改一处要同时改两处） */
.ac-scope button.bg-primary       { background-color: hsl(var(--primary, 216 100% 59%)); }
.ac-scope button.bg-secondary     { background-color: hsl(var(--secondary, 240 4% 9%)); }
.ac-scope button.bg-accent        { background-color: hsl(var(--accent, 240 4% 9%)); }
.ac-scope button.bg-background    { background-color: var(--dsw-alias-bg-base, #151517); }
.ac-scope button.bg-foreground\/5 { background-color: rgba(255, 255, 255, .045); }

/* ═══════════════════════════════════════════════════════════════════
   ⑦ ★ 浮层（点击后才出现的 UI）：下拉 / 菜单 / 弹窗 / 提示
   —— 主人 2026-10-21 明确要求：「子级菜单等各种点击后展示的 UI 也要同步」

   ★★ 为什么不能只补 bg-popover 就完事 —— 实测 DSH 自己的浮层【根本不是实心色】：
     --dsw-menu-surface-fill    = #43454a73        ← 半透明！
     --dsw-menu-backdrop-filter = blur(40px) saturate(150%)
     --dsw-elevation-prominent  = 0 0 0 .5px #ffffff29, 0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d
     --dsw-radius-lg = 16px   --dsw-radius-md = 12px

     实测 DSH 原生 [role=menu]：
       backgroundColor = rgba(0,0,0,0)   ← 果然是透明
       boxShadow       = 0.5px 白描边 + 3px/20px 双层黑影
       圆角 menu 16px / menuitem 12px，字号 13px

     ⇒ 「原生感」来自【半透明底 + 毛玻璃 + 0.5px 内描边 + 双层软阴影】，
       不是来自一个不透明的背景色。只补 bg-popover 会得到一块死板的白/黑块。

   ★★★ 这里的第一个写法是错的，记下来（重要）：
       第 1 版写 .ac-scope [role="listbox"] —— 实测【完全没生效】。
       根因：Radix 把浮层 portal 到 document.body，
             它不是 .ac-scope 的后代，祖先链是
               DIV#radix-:r1b: → DIV → BODY → HTML
             ⇒ 作用域选择器一个都命中不了。
       判据：lb.closest('.ac-scope') === null

       修法有两种，本版选 B：
         A. 给浮层加 .ac-scope 类 —— 要改 ArtCraft 的 Portal 容器，
            侵入行为层，且 Radix 的容器由它自己创建，不好插手。
         B. 把作用域选择器换成【属性标记 + 全局 role】——
            风险是可能误伤 DSH 自己的 listbox/dialog。
            为降低风险，只作用于带 data-ac-* 标记的容器，
            而标记由我们在打开时打上。

       ★ 本版最终做法（第 3 版，采纳）：
         用 body:has(.ac-scope) 作为根 —— 只有当前 DSH 页面里存在
         ArtCraft 作用域时才生效；这样 DSH 自己的下拉菜单不会被动到。
         实测 :has() 在本机 Chromium 已支持。
         ★ 注意：注释里不能写反引号 —— 本文件外层是 String.raw 模板字符串，
           反引号会把它提前闭合（本轮已踩两次，构建脚本已加护栏）。
   ═══════════════════════════════════════════════════════════════════ */

/* 补齐缺失的浮层语义色（这些在 .ac-scope 内也有效，ArtCraft 自己的浮层有时不 portal） */
.ac-scope .bg-popover              { background-color: hsl(var(--popover, 240 11% 7%)); }
.ac-scope .text-popover-foreground { color: hsl(var(--popover-foreground, 0 0% 98%)); }
.ac-scope .text-foreground\/85     { color: hsl(var(--foreground, 0 0% 98%) / .85); }
.ac-scope .border-secondary-border { border-color: hsl(var(--border, 0 0% 100% / .15)); }

/* ★ portal 到 body 的那一批也必须有 bg-popover 的定义 ——
   实测 #radix-:r1b: 这个节点自己就带 class="bg-popover text-popover-foreground"，
   但它在 .ac-scope 外面 ⇒ 上面的 .ac-scope .bg-popover 命中不了。 */
body:has(.ac-scope) .bg-popover              { background-color: hsl(var(--popover, 240 11% 7%)); }
body:has(.ac-scope) .text-popover-foreground { color: hsl(var(--popover-foreground, 0 0% 98%)); }

/* ── 浮层统一外观 ──
   作用域：ArtCraft 内部的浮层（.ac-scope 内）+ portal 到 body 的 Radix 浮层。
   ★ portal 的那一批必须靠 body 级选择器，但同时要看「页面上有 ac-scope」，
     否则会污染 DSH 自己的下拉菜单。用 :has() 表达这个前提。 */

.ac-scope [role="listbox"],
.ac-scope [role="menu"],
.ac-scope [role="dialog"],
.ac-scope [role="tooltip"],
.ac-scope [data-radix-popper-content-wrapper] > div,
body:has(.ac-scope) [data-radix-popper-content-wrapper] > div,
body:has(.ac-scope) [role="listbox"],
body:has(.ac-scope) [role="menu"] {
  background-color: var(--dsw-menu-surface-fill, #43454a73) !important;
  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%));
  box-shadow: var(--dsw-elevation-prominent,
              0 0 0 .5px #ffffff29, 0 3px 8px 0 #0000000a, 0 0 20px 0 #0000000d) !important;
  border: 0 !important;
  color: var(--dsw-alias-label-primary, #f9fafb) !important;
  border-radius: var(--dsw-radius-lg, 16px) !important;
  overflow: hidden;
}

/* 浮层里的选项：圆角 12px、字号 13px、高度跟 DSH menuitem 一致（30px）
   ★ 内边距必须给，否则文字贴着边缘 —— ArtCraft 的 option 自身 padding 是 0，
     内外全靠 Radix 的 viewport 撑，而 viewport 又是 w-full 被触发器宽度锁死。
     实测 DSH 原生 menuitem: padding 4px 8px / height 30px / 圆角 12px。 */
.ac-scope [role="option"],
.ac-scope [role="menuitem"],
.ac-scope [role="menuitemcheckbox"],
.ac-scope [role="menuitemradio"],
body:has(.ac-scope) [role="option"],
body:has(.ac-scope) [role="menuitem"] {
  border-radius: var(--dsw-radius-md, 12px) !important;
  font-size: 0.8125rem !important;
  line-height: 1.0625rem !important;
  /* ★ box-sizing + 固定高度：实测三次才对
     ① 只给 min-height:30px + padding:4px 且 content-box → 38px（多了 8px）
     ② 加 box-sizing:border-box → 35px（还多 5px，因为内容行高 17px + 上下 padding 8px
        = 25px，被 min-height 30px 抬起，但里面还有 Radix 自带的行盒余量）
     ③ 直接给 height:30px —— 与 DSH 原生 menuitem 实测值完全一致。
     判据：DSH 原生 [role=menuitem] 实测 height=30px、padding=4px 8px。 */
  box-sizing: border-box !important;
  height: 1.875rem;
  padding: 4px 8px !important;
  color: var(--dsw-alias-label-primary, #f9fafb) !important;
}

/* ★ 内边距与最小宽度：与 DSH 原生 menu 一致（padding 4px / min-width 144px）
   根因：ArtCraft 的下拉内层是 w-full min-w-(--radix-select-trigger-width)，
        宽度被触发器锁死（实测 50px），加上 option 自身 padding 为 0，
        文字被裁在边上。实测修前 lbW=50 / 修后应 ≥ 144。 */
.ac-scope [role="listbox"],
body:has(.ac-scope) [role="listbox"] {
  padding: 4px !important;
  min-width: 9rem !important;      /* 144px，DSH 原生 menu 的 min-width */
  /* ★ 高度：不要让它超出视口。
     实测（2026-10-21）：「适应」下拉 7 项 × 30px + 8px padding = 218px，
     在 774px 视口下从 y=587 展开，最后一项被裁到 797（视口外 23px）。
     DSH 原生 menu 的解法是 max-height + overflow-y:auto。 */
  max-height: var(--radix-select-content-available-height, min(60vh, 320px)) !important;
  overflow-y: auto !important;
  overscroll-behavior: contain;
}

/* ★ 选中项：不能只靠一层浅蓝底与毛玻璃底区分
   —— 实测浅色主题下，选中项 rgba(38,49,72,.10) 与容器 #f8f9fa94 的
      对比度只有约 1.1:1，两个圆角块叠在一起像「重叠覆盖」。
   —— refactoring-ui 第 12 定律：绝不只靠颜色传达信息。
   ⇒ 选中项额外加一个左侧标记条 + 字重提升，颜色只是辅助。 */
.ac-scope [role="option"][data-state="checked"],
body:has(.ac-scope) [role="option"][data-state="checked"] {
  background-color: var(--dsw-alias-interactive-bg-active, rgba(255, 255, 255, .14)) !important;
  font-weight: 600 !important;
  position: relative;
}
.ac-scope [role="option"][data-state="checked"]::before,
body:has(.ac-scope) [role="option"][data-state="checked"]::before {
  content: "";
  position: absolute;
  left: 2px;
  top: 50%;
  transform: translateY(-50%);
  width: 2px;
  height: 14px;
  border-radius: 999px;
  background: var(--dsw-alias-state-business-primary, #4176e6);
}

/* ★ 解锁 Radix 把面板宽度绑到触发器宽度的行为
   实测：内层容器带 class "h-(--radix-select-trigger-height) w-full
        min-w-(--radix-select-trigger-width)"，把面板压成触发器那么窄。
   DSH 原生菜单是按内容宽度（实测 146px，文字 2 字），不绑触发器。
   ⇒ 把 min-width 从"触发器宽度"改成"内容自然宽度即可，但有下限"。 */
body:has(.ac-scope) [data-radix-popper-content-wrapper] > div > div,
.ac-scope [data-radix-popper-content-wrapper] > div > div {
  min-width: 9rem !important;
}

/* 选项 hover / 选中：用 DSH 的交互底色
   ★ 又一次踩到「不存在的 token」（本项目第四次）：
     原写 --dsw-alias-interactive-bg-selected —— 实测【不存在】。
     实测存在的同类共 21 个，选中的正确名是 --dsw-alias-interactive-bg-active。
     ⇒ 纪律：写任何 var(--dsw-*) 前，先实测它的值是不是空。
       getComputedStyle(document.body).getPropertyValue(n) 返回 '' 就是不存在。
       ★ 且必须从 body 读 —— :root 上有大半读不到（本项目已知坑）。 */
.ac-scope [role="option"][data-highlighted],
.ac-scope [role="option"]:hover,
.ac-scope [role="menuitem"][data-highlighted],
.ac-scope [role="menuitem"]:hover,
body:has(.ac-scope) [role="option"][data-highlighted],
body:has(.ac-scope) [role="option"]:hover,
body:has(.ac-scope) [role="menuitem"][data-highlighted],
body:has(.ac-scope) [role="menuitem"]:hover {
  background-color: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .08)) !important;
}
/* ★ 选中态规则不在这里重复 —— 已在上方「浮层选项」那一节用
   data-state="checked" + ::before 标记条 + 字重实现。
   两条同特异性规则会让后者覆盖前者，改一处漏一处（本轮踩过）。 */

/* 浮层内分隔线（这一条与上面的 resizable handle 是两回事：
   浮层里的 [role=separator] 是视觉分隔；面板分隔条带 data-resize-handle） */
.ac-scope [role="separator"]:not([data-resize-handle]),
body:has(.ac-scope) [data-radix-popper-content-wrapper] [role="separator"] {
  background-color: var(--dsw-alias-border-l1, rgba(255, 255, 255, .06)) !important;
  border-color: var(--dsw-alias-border-l1, rgba(255, 255, 255, .06)) !important;
}

/* ═══════════════════════════════════════════════════════════════════
   ⑨ ★★ 面板分隔条：命中区只有 1px，等于拖不动

   —— 实测（2026-10-21）：
       三个 data-resize-handle 的尺寸分别是
         1×267（竖向）、1×267（竖向）、1625×1（横向）
       cursor 都是 auto
     ⇒ 用户要在 1px 宽的线上精确按下才能拖动。
       视觉上那条 rgba(0,0,0,.04) 的细线几乎看不见，
       鼠标移上去也没有 resize 光标。
       主人的反馈「这个高度锁死了」就是这件事 —— 不是不能拖，是拖不到。

   —— 修法（DSH 的做法也是这样：细线视觉 + 宽命中区）：
       ① 命中区扩到 7px（视觉仍是 1px 细线，用伪元素画）
       ② 给正确的 cursor
       ③ hover / 拖动时高亮，告诉用户「这里能拖」

   —— 判据（可复跑）：
        handle.getBoundingClientRect().width|height ≥ 7
        getComputedStyle(handle).cursor 是 col-resize / row-resize
   ═══════════════════════════════════════════════════════════════════ */

.ac-scope [data-resize-handle] {
  position: relative;
  background-color: transparent !important;
}
/* 纵向分隔条（左右拖）：命中区 7px 宽 */
.ac-scope [data-panel-group-direction="horizontal"] > [data-resize-handle] {
  width: 7px !important;
  margin: 0 -3px;
  cursor: col-resize;
  z-index: 10;
}
/* 横向分隔条（上下拖）：命中区 7px 高 */
.ac-scope [data-panel-group-direction="vertical"] > [data-resize-handle] {
  height: 7px !important;
  margin: -3px 0;
  cursor: row-resize;
  z-index: 10;
}

/* 视觉细线用伪元素画，不占命中区宽度 */
.ac-scope [data-panel-group-direction="horizontal"] > [data-resize-handle]::after {
  content: "";
  position: absolute;
  inset: 0 auto 0 50%;
  width: 1px;
  transform: translateX(-50%);
  background-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, .06));
  transition: background-color .12s;
}
.ac-scope [data-panel-group-direction="vertical"] > [data-resize-handle]::after {
  content: "";
  position: absolute;
  inset: 50% 0 auto 0;
  height: 1px;
  transform: translateY(-50%);
  background-color: var(--dsw-alias-border-l1, rgba(0, 0, 0, .06));
  transition: background-color .12s;
}

/* hover / 拖动时高亮 —— refactoring-ui 第 12 定律：不只靠光标，要有可见反馈 */
.ac-scope [data-resize-handle]:hover::after,
.ac-scope [data-resize-handle][data-resize-handle-state="drag"]::after {
  background-color: var(--dsw-alias-state-business-primary, #4176e6) !important;
}
.ac-scope [data-resize-handle]:hover,
.ac-scope [data-resize-handle][data-resize-handle-state="drag"] {
  background-color: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, .04)) !important;
}

/* ═══════════════════════════════════════════════════════════════════
   ⑧ ★ 圆角收进 DSH 的圆角阶（refactoring-ui 第 3 定律：每个值都来自系统）
   —— 实测两套圆角的实际取值：
        DSH 原生：4px / 8px / 12px / 999px   ← 干净的四阶
        ArtCraft：8px(34 处) / 3px(5) / 6px(4) / 4px(3) / 9999px(3)
        ⇒ 3px 与 6px 是【非系统值】，必须收掉

   —— 来源定位（实测）：
        .ac-scope button, select, textarea, input, [role=button] { border-radius: 3px }
          ← ArtCraft 的 base 层，影响所有按钮/输入框
        .ac-scope .rounded-md { border-radius: 0.375rem }  ← 6px
          ← Tailwind 的 rounded-md

   —— 为什么这是真问题而不是洁癖：
        3px 与 DSH 的 4px 差 1px，肉眼在 28px 的按钮上分辨不出「差在哪」，
        但会让人整体觉得「这个界面和别的地方不太一样」——
        这正是主人要的「无违和感」被破坏的地方。且 §1.5 明确：
        「Every value comes from a system. No hand-tuned one-offs.」
   ═══════════════════════════════════════════════════════════════════ */

/* base 层 3px → DSH 的 4px
   ★★ 2026-10-21 修正：这条规则会【打过头】
     实测：工程名输入框（<input type=text>）想用 rounded-lg(8px)，
     但这里是 input:not(...) 通配，特异性 (0,3,0) 高于 .ac-scope .rounded-lg 的 (0,2,0)
     ⇒ 输入框的圆角被强制成 4px，看起来就是「还是很粗糙」。
     ⇒ 修法：把 input 从这条规则里摘出来 ——
       它本来就不该被统一成 4px（多行输入框、搜索框、命名框各有各的圆角）。
       只保留 button / select / textarea / [role=button] 这四个真「控件」。 */
.ac-scope button,
.ac-scope select,
.ac-scope textarea,
.ac-scope [role="button"] { border-radius: 0.25rem; }

/* 单行 input 不统一圆角：让各自的 rounded-* 类说话
   （如果它没有任何 rounded 类，浏览器默认是 0，也不是 3px，视觉可接受） */

/* ═══════════════════════════════════════════════════════════════════
   ⑧b 工程名输入框（头部那个可点击改名的框）

   —— 实测（2026-10-21）：它带 h-7 / rounded-lg / max-w-[16rem] 三个类，
      但 Tailwind 的【任意值类】max-w-[16rem] 在 ArtCraft 的 build-css 里
      没被生成（内容扫描没覆盖到 editor-header.tsx 的这一处），
      所以 computed max-width 是 none ⇒ 长名字会把右侧「导出」顶出去。
   —— 判据：getComputedStyle(input).maxWidth 应为 256px，不是 none。
   —— 修法：在覆盖层里显式给出，不依赖 Tailwind 的任意值类生成。
   ═══════════════════════════════════════════════════════════════════ */

.ac-scope header input[type="text"] {
  max-width: 16rem;   /* 256px ≈ 16 个汉字 */
  min-width: 2rem;
  /* ★ 必须 !important：ArtCraft 的基础层有一条
       .ac-scope input:not([type="radio"]):not([type="range"]) { border-radius: 3px }
     特异性 (0,3,0)，而本条是 (0,2,1) ⇒ 不加 !important 会被压成 3px。
     实测：不加时 computed borderRadius = 3px，加了才变 8px。 */
  border-radius: var(--dsw-radius-sm, 8px) !important;
  text-overflow: ellipsis;
}
.ac-scope header input[type="text"]:focus {
  /* DSH 的焦点环用 box-shadow，不用 outline */
  outline: none;
  box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary, #4176e6);
}

/* rounded-md 6px → DSH 的 8px（DSH 没有 6px 这一阶） */
.ac-scope .rounded-md { border-radius: 0.5rem; }

/* rounded-xl / rounded-2xl 归到 DSH 的 12px 阶 */
.ac-scope .rounded-xl,
.ac-scope .rounded-2xl { border-radius: 0.75rem; }

/* ═══════════════════════════════════════════════════════════════════
   ⑰ ★★ portal 到 body 的浮层：给它补 ac-scope 后必须还回原背景

   —— 实测问题（子代理报告 + 我复跑确认）：
       导出对话框被挤成 231×568 的细长竖条，
       43 个带 flex/flex-col/gap-4/px-3.5/w-80 的元素 computed 全是 block。
       根因：dlg.closest(".ac-scope") === false
             ArtCraft 的全部规则都以 .ac-scope 为前缀（实测 640 处），
             Radix 的 PopoverContent portal 到 document.body 后收不到任何一条。

   —— 修法：给那个容器自己加 ac-scope 类（见 export-button.tsx）。
       这样 .ac-scope .flex { display:flex } 立刻生效。

   —— ★ 但加类会带来一个副作用必须处理：
       ac-scope 自身有 background-color: var(--st-bg)，
       它会覆盖浮层原本的 bg-ui-controls（毛玻璃感没了，变成面板底色）。

   —— 本节的职责：把「因为加 ac-scope 而被抢走的」视觉属性抢回来。
       用 ac-portal-surface 这个标记类，只影响我们主动加的浮层容器，
       不影响任何原有元素。

   —— 判据（可复跑）：
       dlg.closest('.ac-scope') === true
       dlg.getBoundingClientRect().width ≈ 320（w-80 生效）
       dlg 内部第一个 flex 元素的 computed display === 'flex'
       dlg 背景不是面板底色（仍是浮层色）
   ═══════════════════════════════════════════════════════════════════ */

/**
 * ★★ 2026-10-21 第三轮（最终）：ac-scope 加在容器【自己身上】时，
 *    必须补【组合选择器】才能救容器自己的类。
 *
 * —— 为什么后代选择器救不了它自己：
 *     ArtCraft 的规则是  .ac-scope .flex { display:flex }
 *     要求 .flex 元素是 .ac-scope 的【后代】。
 *     而 portal 出来的对话框【自己】同时带 ac-scope 和 flex 两个类，
 *     它不可能是自己的后代 ⇒ 那一条永远不匹配。
 *   实测（加 ac-scope 后）：
 *     内部 flex 元素 display=flex ✅（作为后代被救活）
 *     容器自己 display=block、宽 231px ❌（w-80 没生效）
 *
 * —— 解决：给容器自己用到的类补一条组合选择器。
 *   只补它实际用到的（flex / flex-col / w-80 / p-0 / mr-4），
 *   不批量镜像 640 条规则（那会拖慢样式计算，也难维护）。
 *   ★ 以后若给这个容器加新类，要同步在这里补一条 —— 判据见下。
 */
.ac-scope.ac-portal-surface.flex { display: flex; }
.ac-scope.ac-portal-surface.flex-col { flex-direction: column; }
.ac-scope.ac-portal-surface.w-80 { width: 20rem; }
.ac-scope.ac-portal-surface.p-0 { padding: 0; }
.ac-scope.ac-portal-surface.mr-4 { margin-right: 1rem; }

.ac-scope.ac-portal-surface {
  /* 视觉：还回浮层该有的样子（ac-scope 把背景抢成了面板底色） */
  background-color: var(--dsw-menu-surface-fill, var(--st-panel, #2c2c2e)) !important;
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%)) !important;
  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%)) !important;
  color: var(--dsw-alias-label-primary, #f9fafb) !important;
  box-shadow: var(--dsw-elevation-prominent, 0 0 0 .5px rgba(0,0,0,.2), 0 3px 8px rgba(0,0,0,.16), 0 0 20px rgba(0,0,0,.12)) !important;
  border-radius: var(--dsw-radius-lg, 16px) !important;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;
}

/**
 * ★★ 2026-10-21 修（我实测发现的对比度缺陷，子代理也报过但没定位到）
 *
 * —— 现象（截图可见）：
 *     导出对话框里「格式 / 质量 / 音频」是浅灰 rgb(174,180,188)，
 *     在 rgba(248,249,250,.58) 的浅色浮层上对比度约 2.1:1（WCAG 要求 4.5:1）；
 *     「保存位置」更糟：纯白 rgb(255,255,255)，对比度 1.0:1，完全看不见。
 *
 * —— 根因：
 *     portal 出来的对话框【不带 theme-light 类】
 *     （那个类挂在 .ac-scope 上，而对话框在 body 下），
 *     所以它用的是【暗色那一套】变量：
 *       --muted-foreground: 216 9% 71%  →  rgb(174,180,188)  ← 暗色下的「次要文字」
 *     而那套值是为深底设计的，放到浅色浮层上就变成「白底浅灰字」。
 *
 * —— 修法：给 portal 浮层单独定义一套【按当前主题解析】的文字色。
 *     主题通过 html / body 上的属性判断（DSH 的主题类在 body 上）。
 *     这里用两种写法都覆盖到，避免依赖 DSH 的主题类名拼写。
 */
.ac-scope.ac-portal-surface .text-muted-foreground,
.ac-scope.ac-portal-surface .text-muted-foreground\/85 {
  color: var(--dsw-alias-label-secondary, #61666b) !important;
}
.ac-scope.ac-portal-surface .text-muted-foreground\/70 {
  color: var(--dsw-alias-label-tertiary, #81858c) !important;
}

/* 暗色主题下 DSH 的 label-secondary 是浅灰，天然可读 —— 无需特殊处理。
   下面这条只为「万一 DSH token 取不到」时给一个保底值。 */
body:not(.theme-light):not([data-theme="light"]) .ac-scope.ac-portal-surface .text-muted-foreground {
  color: var(--dsw-alias-label-secondary, #a8adb5) !important;
}

/**
 * ★ 纯白文字在浅色浮层上完全不可见（对比度 1.05:1）。
 *   实测「保存位置」这个 SectionTitle 就是白的 rgb(255,255,255)。
 *
 *   根因同上一节：portal 出来的浮层不带 theme-light 类，
 *   所以 --foreground 用的是暗色那套（210 20% 98% ≈ 白），
 *   放到浅色浮层上就是白底白字。
 *
 *   ⇒ 凡是浮层里的前景文字，统一用 DSH 的 label-primary
 *     （浅色 #0f1115 / 暗色 #f9fafb，由主题自动解析）。
 *
 *   判据（可复跑）：浮层内所有可见文字与背景的对比度 ≥ 4.5:1。
 */
.ac-scope.ac-portal-surface .text-foreground,
.ac-scope.ac-portal-surface .text-popover-foreground,
.ac-scope.ac-portal-surface .text-card-foreground,
.ac-scope.ac-portal-surface .text-white,
.ac-scope.ac-portal-surface h1,
.ac-scope.ac-portal-surface h2,
.ac-scope.ac-portal-surface h3,
.ac-scope.ac-portal-surface strong {
  color: var(--dsw-alias-label-primary, #0f1115) !important;
}

.ac-scope.ac-portal-surface.theme-light {
  background-color: var(--dsw-menu-surface-fill, #f8f9fa) !important;
  color: var(--dsw-alias-label-primary, #0f1115) !important;
}

`;
