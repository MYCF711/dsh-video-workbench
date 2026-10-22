/**
 * editor.css.js · 剪辑台外壳样式（2026-10-22）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这份只管【DSH 里没有的东西】：预览区、工具栏、检查器抽屉、素材网格、消息条。
 * ArtCraft 自己的时间轴样式仍由 _artcraft-css.js + dsh-native.css.js 管。
 *
 * ★★ 三条硬纪律（每条都有实测依据）
 *
 *   ① 颜色只走 --dsw-* token，不写死色值
 *      AGENTS §3.10：--dsw-alias-bg-layer-2 在浅色下 = #fff（与面板同色），
 *      写「1px 边框 + bg-layer-2」等于白底白底。
 *      ⇒ 需要区分层级时用 border + hover 变色，不靠底色差。
 *
 *   ② 语义色（成功/警告/危险）可以硬编码
 *      token 在不同主题下保持同一语义，硬编码 rgb(...) 是安全的；
 *      但中性色必须走 token，否则切主题就崩。
 *
 *   ③ 所有几何值要么来自布局文档的定稿值，要么是 100%
 *      —— 不许出现「凭感觉」的 padding。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★ 已验证存在的 token（本会话从 DSH 实测读出，不是猜的）
 *   --dsw-alias-bg-base / bg-layer-1 / bg-layer-2
 *   --dsw-alias-label-primary / label-secondary / label-tertiary
 *   --dsw-alias-border-l2 / l3 / l4
 *   --dsw-alias-state-business-primary
 *   --dsw-alias-interactive-bg-hover / interactive-bg-active
 *   --dsw-elevation-prominent
 *   --dsw-menu-surface-fill
 *
 * ★ 明确【不存在】的（踩过，别用）
 *   --dsw-alias-button-primary-fg    → 403 个 token 里没有
 *   --dsw-focus-ring-color           → 实测值是 transparent
 */

export default `
/* ═══════════════════════════════════════════════════════════════════
   ★★ 2026-10-23 关于 --ac-follow-w：不要在 :root 上声明它

   ── 我踩过的坑（两次都错在同一个认知上）
     第一次：:root { --ac-follow-w: var(--dsh-composer-card-max-width, 100%) }
       以为这样首帧就有值。实测这个变量在 .ac-scope 上算出来是【字面量 100%】。

     原因：CSS 自定义属性的 var() 是在【声明所在的元素】上解析的。
       :root 这一层没有 --dsh-composer-card-max-width（它定义在 viewArea 上），
       于是 :root 上就把 var(...) 求值成了 fallback「100%」，
       然后作为【已解析的字面量】继承给所有后代。
       ⇒ 后代拿到的就是 100%，再也不会去看自己身上有没有 DSH 那个变量。

   ── 正确做法
     --ac-follow-w 要么【不在任何祖先上声明】，
     要么必须在【能取到 DSH 变量的那一层】声明。
     现在两个 tab 都走内联 style：
       width: min(100%, var(--ac-follow-w, var(--dsh-composer-card-max-width, 100%)))
     --ac-follow-w 由 JS 在元素自身上写为 var(...) 引用，
     元素自身能取到 DSH 变量 ⇒ 解析正确（实测 calc(1464px + 32px)）。
   ═══════════════════════════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════════════════════════
   根容器：三段纵向布局（预览 / 工具栏 / 时间轴）
   ═══════════════════════════════════════════════════════════════════ */
/**
 * ★★ 2026-10-22 修：外层 .ac-scope 的高度链断了
 *
 *   实测（19499）的祖先链：
 *     .ac-root           h=668  cssH=668px  display:flex
 *     .ac-scope          h=668  cssH=668px  display:flex   ← 高度来自内容，不是父级
 *     [conversation.view] h=0   cssH=auto   display:contents ← ★ 高度 0
 *     Dc7zOa_viewArea    h=668  cssH=668px  display:flex
 *
 *   'display: contents' 的元素不生成盒子 ⇒ 它的 'height: 100%' 子级
 *   没有「确定高度的父级」可参照 ⇒ % 高度全部退化成 auto。
 *   ⇒ .ac-scope 的高度变成「内容撑开」，于是拖动预览时不收缩、直接变高。
 *
 *   ⇒ 修法：不让它靠 % 拿高度，改成 flex item 靠 flex 拿：
 *     但 conversation.view 是 display:contents，flex 也不会生效…
 *     所以真正可靠的是：给它一个【视口级】的高度上限。
 *
 *   用 100% 做首选（父级有高度时对），再用 100vh 减去已知的顶部占用做兜底。
 *   已知顶部占用：DSH 头部 50 + tabs 25 + 会话头 ≈ 76（实测 .ac-root 的 top 就是 76）。
 *   ⇒ max-height: calc(100vh - 76px) 是一个安全上限，
 *     被撑大时它会把高度钳住，内部再由 overflow:hidden 裁掉。
 *
 *   ★ 为什么不用 position:absolute; inset:0：
 *     那会让它脱离子流，DSH 的滚动容器算不到它的高度，
 *     实测会导致 viewArea 塌成 0。这里必须留在流内。
 */
.ac-scope {
  max-height: calc(100vh - 76px);
  min-height: 0;
  overflow: hidden;
}

.ac-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  /**
   * ★★ 2026-10-22 修：拖动预览变大时，整个根容器被撑高，时间轴被挤出页面
   *
   *   实测（19499）：把 --ac-preview-h 设成 700px 后
   *     root 高度 789 → 1076（涨了 287px，正好是 700-413 的差额）
   *     preview 712 / timeline 仍然 319 ⇒ 时间轴没有被压缩，而是被顶出去了
   *
   *   根因：这里原来写 'height: 100%'。
   *   而 % 高度要求【父级链上有确定高度】；DSH 的 conversation.view 那一层
   *   的 computed height 实测是 0（它靠 flex 撑开，不是 height），
   *   于是 'height: 100%' 解析成 auto ⇒ 容器高度 = 内容高度
   *   ⇒ 预览一变大，容器跟着长，时间轴就被推到视口外。
   *
   *   ⇒ 两道保险，缺一不可：
   *     ① min-height: 0 —— 让本节点能作为 flex item 被压缩（否则 min auto 拒绝收缩）
   *     ② overflow: hidden —— 万一还被撑开，也绝不外溢到页面
   *     ③ height 100% 保留（父级有高度时它是对的），
   *        但加了 max-height: 100% 兜住「父级是 auto」的情况
   *   ★ 这套组合是 flex 里做「内部可拖分栏」的标准做法：
   *     容器锁死，子项之间分，超出的裁掉。
   */
  height: 100%;
  max-height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #0f1115);
  font-family: inherit;
  position: relative;
  /* ★ 防止 DSH 侧栏手柄被盖住（布局重设计 §五 的 ④ 号问题） */
}

/* ═══════════════════════════════════════════════════════════════════
   ① 预览区
   ═══════════════════════════════════════════════════════════════════ */
/**
 * ★★ 2026-10-22 修：预览区高度锁死（主人报「轨道高度无法拖动，
 *   导致上面的预览高度也跟着锁死」）
 *
 *   原来写的是 flex: 0 0 auto; —— 完全不参与分配，高度由内容撑开，
 *   .ac-preview-stage 的 min-height:120px 就成了「唯一尺寸」。
 *   而时间轴是 'flex: 1 1 auto'，所以无论怎么调，预览永远是 206px。
 *
 *   ⇒ 改成 flex: 0 0 var(--ac-preview-h)：
 *     高度由一个 CSS 变量决定，拖分隔条时只改这个变量。
 *     flex-basis 用变量、且不自动伸缩 ⇒ 拖多少就是多少，不会被内容顶开。
 */
.ac-preview {
  /**
   * ★★ 2026-10-22 第三修：CSS 层再加一道硬保护
   *
   *   实测：JS 的 clamp 只管「拖动/键盘」两条路径。
   *   如果变量被别的方式改大（旧值残留、手改、将来别处写入），
   *   预览会涨到 2012px，把时间轴压到 12px —— 轨道完全看不见。
   *
   *   ⇒ 用 clamp() 在 CSS 层再钳一次，界限与 JS 侧一致：
   *       最小 120px（PREVIEW_MIN）
   *       最大 calc(100% - 220px)
   *         容器高 - 工具栏45 - 分隔条8 - 时间轴下限160 ≈ 220
   *   ★ 两道保险，任一失效另一个仍兜得住。
   */
  flex: 0 0 clamp(120px, var(--ac-preview-h, 220px), calc(100% - 220px));
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 12px 16px 0;
}

.ac-preview-stage {
  flex: 1 1 auto;
  min-height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  /**
   * ★ 空态不是黑块（主人 2026-10-21 报的问题）：
   *   这一层给的是中性底色，canvas 的透明像素透出它而不是黑。
   *
   * ★★ 2026-10-22 实测修正：不能用 --dsw-alias-bg-layer-2
   *   它的值 = #fff，与 bg-base / bg-layer-1 完全同色，
   *   视觉上等于「没有底色」，空态看起来仍是一片空白。
   *   ⇒ 用 rgba(0,0,0,.035) 做中性描底色：
   *     在浅色下是淡灰、在暗色下也是淡灰（相对面板略暗/略亮），
   *     不承载文字对比度，所以硬编码安全。
   */
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.035));
  border-radius: 12px;
  overflow: hidden;
  position: relative;
}

.ac-preview-canvas {
  width: 100%;
  height: 100%;
  /* ★ 有内容时给 canvas 浅灰底（架构决策 §二 修法 A）—— 同上，不用 bg-layer-2 */
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.035));
}

.ac-preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
}

.ac-preview-empty-icon {
  color: var(--dsw-alias-label-tertiary, #81858c);
  opacity: 0.7;
}

.ac-preview-empty-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #0f1115);
}

.ac-preview-empty-desc {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  max-width: 300px;
  line-height: 1.5;
}

.ac-preview-bar {
  flex: 0 0 auto;
  height: 40px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 2px;
}

.ac-preview-play {
  flex: none;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #0f1115);
  cursor: pointer;
}
.ac-preview-play:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, #2631480f);
}
.ac-preview-play:disabled {
  opacity: 0.35;
  cursor: default;
}

.ac-timecode {
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary, #61666b);
  min-width: 74px;
}
.ac-timecode-total {
  color: var(--dsw-alias-label-tertiary, #81858c);
  text-align: right;
}

/* ★ 细线进度条，不用滑块圆点（布局文档 §三） */
.ac-scrub {
  flex: 1 1 auto;
  height: 16px;
  appearance: none;
  background: transparent;
  cursor: pointer;
  min-width: 60px;
}
.ac-scrub::-webkit-slider-runnable-track {
  height: 2px;
  border-radius: 1px;
  background: linear-gradient(
    to right,
    var(--dsw-alias-state-business-primary, #4176e6) var(--ac-scrub-pct, 0%),
    var(--dsw-alias-border-l3, #0000001f) var(--ac-scrub-pct, 0%)
  );
}
.ac-scrub::-webkit-slider-thumb {
  appearance: none;
  width: 0;
  height: 0;
}
.ac-scrub:hover::-webkit-slider-runnable-track {
  height: 4px;
}
.ac-scrub:disabled {
  opacity: 0.4;
  cursor: default;
}
.ac-scrub::-moz-range-track {
  height: 2px;
  border-radius: 1px;
  background: var(--dsw-alias-border-l3, #0000001f);
}
.ac-scrub::-moz-range-progress {
  height: 2px;
  background: var(--dsw-alias-state-business-primary, #4176e6);
}
.ac-scrub::-moz-range-thumb {
  width: 0;
  height: 0;
  border: 0;
}

.ac-aspect-tag {
  flex: none;
}

/* ═══════════════════════════════════════════════════════════════════
   ①b 预览/时间轴 的分隔条（可拖）
   ═══════════════════════════════════════════════════════════════════ */
/**
 * ★★ 2026-10-22 新增：主人报「轨道高度依旧无法拖动」
 *
 *   上一版为了让「工具栏紧贴时间轴」，把 ArtCraft 的 ResizablePanelGroup
 *   整个替换掉了 —— 顺手把它的垂直拖拽手柄也删了
 *   （实测 '[role="separator"]' 数量 = 0）。
 *   于是预览高度由 CSS 写死，用户拖不动。
 *
 *   ⇒ 自己做一个：8px 高的命中区（视觉是 1px 细线，hover 变粗），
 *     鼠标上下拖 → 改 --ac-preview-h。
 *
 *   ★ 为什么命中区 8px 而视觉只有 1px：
 *     1px 的线鼠标几乎点不中（Fitts 定律）。DSH 自己的分隔条也是「细线 +
 *     宽命中区」。视觉上不抢眼，但好点。
 *
 *   ★ 为什么要 cursor: row-resize + touch-action: none：
 *     前者告诉用户这里能拖；后者防止触控板/触屏把手势当成滚动。
 */
.ac-vsplit {
  flex: 0 0 auto;
  height: 8px;
  margin: -4px 0;          /* 上下各压 4px，让 8px 命中区不额外占视觉高度 */
  position: relative;
  z-index: 5;              /* 高于预览与时间轴，才收得到鼠标 */
  cursor: row-resize;
  touch-action: none;
  background: transparent;
  border: 0;
  padding: 0;
  display: block;
  width: 100%;
}

/* 视觉上的那条线 */
.ac-vsplit::after {
  content: "";
  position: absolute;
  left: 12px;
  right: 12px;
  top: 50%;
  height: 1px;
  transform: translateY(-50%);
  background: var(--dsw-alias-border-l3, #0000001f);
  transition: height 120ms ease, background 120ms ease;
}

.ac-vsplit:hover::after,
.ac-vsplit:focus-visible::after,
.ac-vsplit[data-dragging="1"]::after {
  height: 2px;
  background: var(--dsw-alias-state-business-primary, #4176e6);
}

.ac-vsplit:focus-visible {
  outline: none;
}

/* 拖动中禁止选中文本（否则会一路选出大片蓝） */
.ac-root[data-resizing="1"] {
  user-select: none;
  cursor: row-resize;
}

/* ═══════════════════════════════════════════════════════════════════
   ② 工具栏（紧贴时间轴上方 —— 主人明确要求）
   ═══════════════════════════════════════════════════════════════════ */
.ac-toolbar {
  flex: 0 0 auto;
  height: 44px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 12px;
  /**
   * ★★ 2026-10-22 深色修正：工具栏底不能比画布亮一档
   *
   *   实测深色下：
   *     bg-base    #151517   ← 画布
   *     bg-layer-1 #232324   ← 原来是这个
   *   亮一档 ⇒ 工具栏在深色下变成一条明显的深灰带，把界面切成两截。
   *
   *   ⇒ 和画布同底，靠下边框分隔。工具栏是「画布的一部分」，不是浮起的卡片。
   *   ★ 判据：浅色下 layer-1 与 base 只差 #fff vs #fff（几乎同色），
   *     所以这个错误只在深色下暴露 —— 所有 bg-layer 用法都要在深色下复查。
   */
  background: var(--dsw-alias-bg-base, #fff);
  /* ★ 布局文档 §三：0.5px 下边框，不用 1px 阴影 */
  border-bottom: 0.5px solid var(--dsw-alias-border-l3, #0000001f);
  /**
   * ★★ 2026-10-22：不换行 + 不许撑破父容器。
   *   实测 375px 下工具栏自身 content 约 440px，
   *   没有 min-width: 0 时 flex 子项会把父容器顶开通（scrollWidth > clientWidth）。
   *   overflow-x 给 auto 是【兜底】：正常靠 @container 收成纯图标就不会溢出。
   */
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.ac-toolbar::-webkit-scrollbar {
  display: none;
}

.ac-tb-group {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.ac-tb-spacer {
  flex: 1 1 auto;
}

.ac-tb-sep {
  flex: none;
  width: 0.5px;
  height: 18px;
  background: var(--dsw-alias-border-l3, #0000001f);
  margin: 0 4px;
}

.ac-tb-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #0f1115);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  flex: none;
}
.ac-tb-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, #2631480f);
}
.ac-tb-btn:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active, #2631481a);
}
.ac-tb-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.ac-tb-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #4176e6);
}

.ac-tb-icon-only {
  width: 28px;
  padding: 0;
  justify-content: center;
}

/* 开关型按钮的「已开」态（如检查器） */
.ac-tb-active {
  background: var(--dsw-alias-interactive-bg-active, #2631481a);
  color: var(--dsw-alias-label-primary, #0f1115);
}
.ac-tb-active:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active, #2631481a);
}

/* 主操作（导入）：唯一实心按钮 */
.ac-tb-primary {
  background: var(--dsw-alias-state-business-primary, #4176e6);
  /* ★ 用 label-primary-foreground 而不是 button-primary-fg
     —— 后者在 DSH 的 403 个 token 里【不存在】，会静默降级成 #fff，
        而暗色下 button 底是近白 #f9fafb ⇒ 白字白底，对比度 1.00 */
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.ac-tb-primary:hover:not(:disabled) {
  filter: brightness(1.08);
}
.ac-tb-primary:disabled {
  opacity: 0.45;
}

/**
 * ★★ 2026-10-22 修：窄容器下工具栏横向溢出
 *
 *   实测（frame 强制 375px ⇒ 剪辑台 root 312px）：
 *     scrollWidth 338 > clientWidth 312，溢出的正是工具栏右侧两个图标按钮
 *     原因：6 个带文字按钮（各 62px）+ 2 个图标（各 28px）+ 间距 ≈ 440px。
 *
 *   ★ 为什么用【容器查询】而不是媒体查询：
 *     剪辑台是被嵌在 DSH 中栏里的，视口宽 1912 而容器只有 312。
 *     媒体查询看的是视口 ⇒ 永远不触发（实测 mediaQueryMatches=false）。
 *     container-type: inline-size 看的是自身宽度，这才是对的判据。
 */
.ac-root {
  container-type: inline-size;
  container-name: acroot;
}

@container acroot (max-width: 620px) {
  .ac-tb-label {
    display: none;
  }
  .ac-tb-btn {
    padding: 0 6px;
  }
  .ac-aspect-tag {
    display: none;
  }
}

@container acroot (max-width: 420px) {
  .ac-tb-sep,
  .ac-timecode-total {
    display: none;
  }
}

/* 视口级的兜底（独立打开预览页时用） */
@media (max-width: 720px) {
  .ac-tb-label {
    display: none;
  }
  .ac-tb-btn {
    padding: 0 6px;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   ③ 时间轴容器
   ═══════════════════════════════════════════════════════════════════ */
.ac-timeline-host {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0 12px 12px;
}

.ac-timeline-mount {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  overflow: hidden;
  /* ★ 容器必须 relative + hidden：
     ArtCraft 的轨道是绝对定位的，高度不够时会【向上溢出】到预览区，
     表现为「轨道头名字与轨道错位」（AGENTS 里记过）。 */
  position: relative;
}

/* ═══════════════════════════════════════════════════════════════════
   ④ 右侧检查器抽屉
   ═══════════════════════════════════════════════════════════════════ */
.ac-inspector {
  position: absolute;
  top: 8px;
  right: 8px;
  bottom: 8px;
  width: 320px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 16px;
  background: var(--dsw-menu-surface-fill, var(--dsw-alias-bg-layer-1, #fff));
  backdrop-filter: blur(40px) saturate(150%);
  -webkit-backdrop-filter: blur(40px) saturate(150%);
  box-shadow: var(--dsw-elevation-prominent, 0 8px 32px #0000002e);
  /* ★ 进场：从右滑入 160ms（布局文档 §三） */
  animation: ac-insp-enter 160ms ease-out;
}

@keyframes ac-insp-enter {
  from { opacity: 0; transform: translateX(12px); }
  to   { opacity: 1; transform: translateX(0); }
}

/* ★ 尊重用户的减弱动效偏好 */
@media (prefers-reduced-motion: reduce) {
  .ac-inspector { animation: none; }
}

.ac-insp-head {
  flex: none;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 14px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l3, #0000001f);
}

.ac-insp-title {
  font-size: 13px;
  font-weight: 500;
}

.ac-insp-tabs {
  flex: none;
  padding: 8px 12px 4px;
}

.ac-insp-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ═══════════════════════════════════════════════════════════════════
   检查器内部：三个 tab 的公共骨架
   ═══════════════════════════════════════════════════════════════════ */
.ac-pane {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.ac-pane-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 12px 8px;
}

.ac-pane-title {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #61666b);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-pane-seg {
  flex: none;
}

.ac-seg-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.ac-pane-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 12px 12px;
}

/* ═══════════════════════════════════════════════════════════════════
   空态（refactoring-ui §8.4：空态是功能的一部分）
   ═══════════════════════════════════════════════════════════════════ */
.ac-empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 16px;
  text-align: center;
}
.ac-empty-inline {
  padding: 20px 8px;
  flex: none;
}

.ac-empty-icon {
  color: var(--dsw-alias-label-tertiary, #81858c);
  opacity: 0.6;
}

.ac-empty-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #0f1115);
}

.ac-empty-desc {
  font-size: 12px;
  line-height: 1.55;
  color: var(--dsw-alias-label-tertiary, #81858c);
  max-width: 240px;
}

/* ═══════════════════════════════════════════════════════════════════
   素材网格：固定双列（主人要求），列表视图单列
   ═══════════════════════════════════════════════════════════════════ */
.ac-media-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  /**
   * ★★ 2026-10-22 修：行高全塌成 0px，卡片重叠
   *
   *   实测（881 张卡）：
   *     gridTemplateRows = "0px 0px 0px …"（441 个 0）
   *     卡片自身高 127，但 grid 行高是 0
   *     ⇒ 第 1 张 y=237，第 3 张 y=245，只差 8px（= gap）
   *     ⇒ 所有行叠在一起，视觉上一片糊
   *
   *   根因：卡片上写了 align-self: start。grid item 一旦 align-self 不是
   *   stretch，grid 的 auto 行高就不再由内容撑开（内容被视为「不参与行高」），
   *   于是行高取 min-content 的初始值 0。
   *
   *   ⇒ 修法：显式 grid-auto-rows: min-content，让行高按内容算；
   *     并去掉卡片的 align-self（改回 stretch，行高由 min-content 决定）。
   */
  grid-auto-rows: min-content;
  gap: 8px;
  padding: 0 12px 12px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
  align-content: start;
}

.ac-media-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 12px 12px;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}

.ac-media-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  border: 0.5px solid var(--dsw-alias-border-l3, #0000001f);
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  overflow: hidden;
  text-align: left;
  font-family: inherit;
  color: inherit;
  min-width: 0;
  /**
   * ★★ 2026-10-22 修：卡片高度塌成 0 / 行重叠
   *
   *   实测：881 张卡都在 DOM 里、每张 139×127，但 gridTemplateRows 全是 0px，
   *   于是第 1 张 y=237、第 3 张 y=245（只差一个 gap）⇒ 全叠在一起。
   *
   *   根因：写了 align-self: start。grid item 的 align-self 一旦不是 stretch，
   *   grid 的 auto 行高就不再由内容撑开，取 min-content 初始值 0。
   *
   *   ⇒ 改成 stretch（默认），行高交给 grid-auto-rows: min-content。
   *     ⚠ 不要在这里再写 align-self。
   */
  width: 100%;
}
.ac-media-card:hover {
  border-color: var(--dsw-alias-border-l4, #00000029);
}
.ac-media-card:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #4176e6);
}

.ac-media-list .ac-media-card {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  padding: 6px;
  height: 44px;
  /**
   * ★★ 2026-10-23 修：列表模式下卡片被压成 12px，缩略图（30px）溢出压住下一行
   *
   *   主人（截图）：「表格模式重叠」—— 图标竖着排、一张压一张。
   *
   *   实测（19499，881 张卡切到列表模式）：
   *     CSS 里只有一条规则写 height: 44px
   *     但 getComputedStyle(card).height === "12px"
   *     而 .ac-media-thumb 是 48×30（aspect-ratio 16/10）
   *   ⇒ 缩略图比卡片本身还高，直接溢出压到下一张。
   *
 *   根因：.ac-media-list 是 display:flex + flex-direction:column，
   *   卡片作为 flex item 默认 flex-shrink:1。
   *   881 张卡的总高远超容器 ⇒ 浏览器按比例压缩每一张，
   *   但 height: 44px 只是「期望值」，被 flex 压缩覆盖。
   *
   *   ⇒ flex: none（= flex: 0 0 auto）让卡片不接受压缩，
   *     同时加 min-height 兜底（防止将来别的规则再压它）。
   *
   *   ★ 判据：在 flex 容器里写固定高度，必须同时写 flex: none。
   *     「height 写了却不生效」的第一嫌疑永远是 flex-shrink。
   */
  flex: none;
  min-height: 44px;
}

.ac-media-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 10;
  /**
   * ★★ 2026-10-22 修：缩略图占位不能靠 bg-layer-2
   *
   *   实测：--dsw-alias-bg-layer-2 = #fff，与 bg-layer-1 / bg-base 完全同色。
   *   ⇒ var(--dsw-alias-bg-layer-2, #f7f8f9) 计算出来是纯白，
   *     卡片与面板融为一体 ⇒ 881 张卡片全在 DOM 里、尺寸也对，但【看不见】。
   *
   *   AGENTS §3.10 记过同一件事：「--dsw-alias-bg-layer-2 浅色下 = #fff，
   *     写 1px 边框 + bg-layer-2 等于白底白底」。
   *
   *   ⇒ 修法：不靠底色差，改用【中性灰占位 + 内描边】。
   *     grayscale 的 rgb(...) 在不同主题下都保持「比面板略暗」的相对关系，
   *     而它只用于「没有图片时的占位块」，不承载文字对比度，硬编码是安全的。
   */
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.045));
  color: var(--dsw-alias-label-tertiary, #81858c);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3, #0000001f);
  overflow: hidden;
  flex: none;
}
.ac-media-list .ac-media-thumb {
  width: 48px;
  aspect-ratio: 16 / 10;
  border-radius: 4px;
}

.ac-media-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}


/**
 * 视频缩略图（2026-10-23）
 *
 * 用 video 标签取首帧，不能用 img —— 实测 mp4 套 img 时 naturalWidth 恒为 0。
 * 尺寸/裁切规则与 img 完全一致，保证两种卡片的缩略图视觉统一。
 */
.ac-media-thumb video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  /* ★ 关掉任何交互，缩略图不该能播放 */
  pointer-events: none;
}

.ac-media-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 6px 6px;
  min-width: 0;
}
.ac-media-list .ac-media-meta {
  padding: 0;
}

.ac-media-name {
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #0f1115);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-media-sub {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #81858c);
}

/* ═══════════════════════════════════════════════════════════════════
   属性行 / 表单控件
   ═══════════════════════════════════════════════════════════════════ */
.ac-sec-title {
  font-size: 11px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary, #81858c);
  padding: 12px 2px 6px;
}

.ac-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-height: 30px;
}

.ac-row-label {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #61666b);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ac-row-value {
  min-width: 0;
  display: flex;
  align-items: center;
}

.ac-row-hint {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font-variant-numeric: tabular-nums;
}

.ac-mono {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, #0f1115);
}

/* ★ 输入框去掉 UA 的 2px inset（布局重设计 §七 ①） */
.ac-input {
  width: 100%;
  height: 28px;
  border: 0.5px solid var(--dsw-alias-border-l3, #0000001f);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #0f1115);
  font-family: inherit;
  font-size: 12px;
  padding: 0 8px;
  outline: none;
  box-shadow: none;
  appearance: none;
  min-width: 0;
}
.ac-input:hover {
  border-color: var(--dsw-alias-border-l4, #00000029);
}
.ac-input:focus {
  border-color: var(--dsw-alias-state-business-primary, #4176e6);
}
.ac-input-num {
  width: 72px;
  font-variant-numeric: tabular-nums;
}

.ac-range {
  flex: 1 1 auto;
  height: 16px;
  min-width: 0;
  appearance: none;
  background: transparent;
  cursor: pointer;
}
.ac-range::-webkit-slider-runnable-track {
  height: 2px;
  border-radius: 1px;
  background: var(--dsw-alias-border-l3, #0000001f);
}
.ac-range::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  margin-top: -5px;
  border-radius: 50%;
  background: var(--dsw-alias-state-business-primary, #4176e6);
}
.ac-range::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: 0;
  border-radius: 50%;
  background: var(--dsw-alias-state-business-primary, #4176e6);
}

.ac-textarea {
  width: 100%;
  border: 0.5px solid var(--dsw-alias-border-l3, #0000001f);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #0f1115);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.55;
  padding: 6px 8px;
  resize: vertical;
  outline: none;
  box-sizing: border-box;
  min-height: 64px;
}
.ac-textarea:focus {
  border-color: var(--dsw-alias-state-business-primary, #4176e6);
}

.ac-field-hint {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary, #81858c);
  padding: 0 2px 6px;
}

.ac-btn-row {
  display: flex;
  gap: 8px;
  padding: 8px 0;
  flex-wrap: wrap;
}

.ac-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4, #00000029);
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #0f1115);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.ac-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, #2631480f);
}
.ac-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.ac-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #4176e6);
}

/**
 * ★★ 2026-10-22 第二次修：主操作按钮仍然白字透明底
 *
 *   第一版我把选择器提到 .ac-scope .ac-btn-primary（0,2,0），
 *   以为赢了 ArtCraft 的 .ac-scope button（0,1,1）。
 *
 *   实测（19499）仍没生效 —— 用「列出所有命中规则」的办法查出真相：
 *     命中的 4 条里，最后两条是
 *       .ac-scope .ac-btn      { background: transparent }   ← 0,2,0
 *       .ac-scope button       { background: transparent }   ← 0,1,1
 *     而 .ac-scope .ac-btn-primary 也是 0,2,0，
 *     但它【声明在 .ac-scope .ac-btn 之前】⇒ 同特异性下后来者赢 ⇒ 被覆盖。
 *
 *   ⇒ 修法：提到 0,3,0（多一层 .ac-scope），让它无论顺序如何都赢。
 *     ★ 这是「同特异性后加载者胜」的正解：不挪位置（位置会被人改乱），
 *       而是把特异性拉开一档，让顺序不再重要。
 */
/**
 * ★★ 2026-10-22 第三次修：主操作按钮仍白字透明底
 *
 *   前两次修都没生效，实测查出两个连环原因：
 *
 *   ① 特异性：对手 .ac-scope button 是 0,1,1，比 .ac-btn-primary 的 0,1,0 高
 *      ⇒ 提到 .ac-scope .ac-scope .ac-btn-primary（0,3,0）
 *   ② 声明本身被丢掉：注释里不能出现「星号+斜杠」这四个字符的组合，
 *      那会提前结束注释块，后面的 CSS 声明全部被当成非法内容丢弃。
 *      这条规则的 background-color 读出来是 null（只剩 background）。
 *      ⇒ 注释一律移到规则【外面】，声明块里只留声明。
 *
 *   判据（可复跑）：getComputedStyle(btn).backgroundColor 必须是 rgb(65,118,230)，
 *   且 cssRules 里那条规则的 getPropertyValue("background-color") 非空。
 */
.ac-scope button.ac-btn.ac-btn-primary,
button.ac-btn.ac-btn-primary,
.ac-btn-primary {
  border: 0;
  background-color: var(--dsw-alias-state-business-primary, #4176e6);
  background: var(--dsw-alias-state-business-primary, #4176e6);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}

/**
 * hover 态。同理：注释在外，声名下只有声明。
 */
.ac-scope button.ac-btn.ac-btn-primary:hover:not(:disabled),
button.ac-btn.ac-btn-primary:hover:not(:disabled),
.ac-btn-primary:hover:not(:disabled) {
  filter: brightness(1.08);
  background-color: var(--dsw-alias-state-business-primary, #4176e6);
  background: var(--dsw-alias-state-business-primary, #4176e6);
}

/**
 * ★ 同理：普通 .ac-btn 的边框也被 '.ac-scope button' 的 border 影响，
 *   统一提到 0,2,0。
 */
.ac-scope .ac-btn {
  border: 0.5px solid var(--dsw-alias-border-l4, #00000029);
  background: transparent;
  color: var(--dsw-alias-label-primary, #0f1115);
}
.ac-scope .ac-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, #2631480f);
}

/* 主操作按钮唯一实心 */
.ac-scope .ac-tb-primary,
.ac-tb-primary {
  background: var(--dsw-alias-state-business-primary, #4176e6);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.ac-scope .ac-tb-primary:hover:not(:disabled),
.ac-tb-primary:hover:not(:disabled) {
  filter: brightness(1.08);
  background: var(--dsw-alias-state-business-primary, #4176e6);
}

/* ═══════════════════════════════════════════════════════════════════
   字幕列表
   ═══════════════════════════════════════════════════════════════════ */
.ac-cap-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 8px;
  border-top: 0.5px solid var(--dsw-alias-border-l3, #0000001f);
  margin-top: 4px;
}

.ac-cap-row {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  gap: 6px;
  align-items: center;
}

.ac-cap-time {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary, #81858c);
}

/* ═══════════════════════════════════════════════════════════════════
   Agent 消息条（右上角）
   ═══════════════════════════════════════════════════════════════════ */
.ac-agent-toast {
  position: absolute;
  top: 10px;
  right: 340px;              /* 让开检查器宽度 320 + 留白 */
  z-index: 60;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 320px;
  padding: 6px 10px;
  border-radius: 10px;
  background: var(--dsw-menu-surface-fill, var(--dsw-alias-bg-layer-1, #fff));
  backdrop-filter: blur(40px) saturate(150%);
  -webkit-backdrop-filter: blur(40px) saturate(150%);
  box-shadow: var(--dsw-elevation-prominent, 0 8px 32px #0000002e);
  border: 0.5px solid var(--dsw-alias-border-l3, #0000001f);
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #0f1115);
  pointer-events: none;
  animation: ac-toast-enter 160ms ease-out;
}

/* 检查器收起时不需要让位 */
.ac-root:not(:has(.ac-inspector)) .ac-agent-toast {
  right: 12px;
}

@keyframes ac-toast-enter {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

.ac-agent-toast-icon {
  flex: none;
  color: var(--dsw-alias-state-business-primary, #4176e6);
}

.ac-agent-toast-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ═══════════════════════════════════════════════════════════════════
   会话右上角的资产库按钮（conversation.session.header.utilities）
   ═══════════════════════════════════════════════════════════════════ */
.ac-hdr-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #61666b);
  cursor: pointer;
  flex: none;
}
.ac-hdr-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, #2631480f);
  color: var(--dsw-alias-label-primary, #0f1115);
}
.ac-hdr-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary, #4176e6);
}

/* ═══════════════════════════════════════════════════════════════════
   窄窗口（375）：检查器铺满，工具栏压缩
   ═══════════════════════════════════════════════════════════════════ */
@media (max-width: 480px) {
  .ac-inspector {
    left: 8px;
    width: auto;
  }
  .ac-agent-toast {
    right: 12px;
    left: 12px;
    max-width: none;
  }
  .ac-preview {
    padding: 8px 8px 0;
  }
  .ac-timeline-host {
    padding: 0 8px 8px;
  }
  .ac-row {
    grid-template-columns: 52px minmax(0, 1fr) auto;
  }
}
`;

