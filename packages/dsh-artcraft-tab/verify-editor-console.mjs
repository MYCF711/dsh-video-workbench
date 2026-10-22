/**
 * verify-editor-console.mjs · 剪辑台四区块实装（2026-10-22）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这个脚本锁的是【本轮 2026-10-22 实装】的全部内容，以及踩出来的 8 个坑。
 * 全部是「不报错、界面看着正常、结果不对」的类型 ——
 * 不写成断言，下次改动会原样复发。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 坑清单（每条都对照过真机，不是推测）
 *
 *  ① 宿主 require 被 esbuild 换成桩
 *     源码 `typeof require === "function" ? require : null` 判定通过，
 *     但 `require` 已是 esbuild 的 __require 桩 ⇒ 调它必抛。
 *     症状：整块渲染成「加载 ui-primitives 失败」，控制台无线索。
 *     判据：build.mjs 里有 globalThis.__DSH_PLUGIN_REQUIRE__ 搭桥；
 *           src 里不出现裸的 typeof require。
 *
 *  ② forwardRef 组件的 typeof 是 "object"
 *     MenuSurface = forwardRef(...) ⇒ typeof === "object"
 *     用 `typeof === "function"` 判据会误判「包结构变了」。
 *     判据：dsh-primitives.js 用 isComponentLike()。
 *
 *  ③ tracks 的三层形状
 *     overlay = [轨道,…]  main = 轨道(单个)  audio = [轨道,…]
 *     把 overlay 当元素数组 ⇒ elementCount 永远等于轨道条数（默认 5）
 *     ⇒ 预览区空态永不显示，用户看到一块空白。
 *     判据：所有统计都下钻 track.elements。
 *
 *  ④ --dsw-alias-bg-layer-2 在浅色下 = #fff
 *     与 bg-base / bg-layer-1 完全同色 ⇒「白底白底」，
 *     卡片与面板融为一体，881 张卡都在 DOM 里但看不见。
 *     判据：editor.css.js 不出现 bg-layer-2 的【使用】（注释可以提）。
 *
 *  ⑤ grid item 写 align-self 会让 auto 行高塌成 0
 *     实测 gridTemplateRows = "0px 0px …"，卡片互相重叠。
 *     判据：.ac-media-grid 有 grid-auto-rows: min-content，卡片无 align-self。
 *
 *  ⑥ useMemo 依赖里引用「回调里才拼出来的派生字段」= TDZ
 *     `[editorState.selectedKey, ...]` 而 selectedKey 在 onState 里才赋值
 *     ⇒ ReferenceError: Cannot access 'k' before initialization
 *     （minify 后变量名变单字母，极难认）。
 *     判据：client.js 的 selectedElement 依赖只有 [editorState]。
 *
 *  ⑦ const 定义的函数放在 if(...) return 之后 = 同款 TDZ
 *     renderGroups 定义在 if (embedded) return 之后，embedded 分支却调用它。
 *     判据：ShortcutSettings.js 的 renderGroups 行号 < if (embedded) 行号。
 *
 *  ⑧ 面板写了但没入口
 *     检查器组件写好了，但工具栏没按钮、也没监听事件 ⇒ 功能存在但打不开。
 *     判据：工具栏有「检查器」按钮 + ArtCraftTab 监听 ac:open-inspector。
 *
 *  ★ 另有一条纪律（本轮连踩两次）：
 *     editor.css.js 外层是模板字符串，CSS 注释里不能出现反引号，
 *     否则提前闭合模板 ⇒ esbuild 报 "Expected ; but found xxx"，
 *     且错误指向注释位置（看起来毫无问题）。
 *     判据：文件里反引号总数 === 2。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "src");

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

const read = (f) => {
  const p = path.join(SRC, f);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
};
/**
 * 剥掉注释再判。
 *
 * ★★ 2026-10-22 自己踩的坑：这个脚本的第一版有 3 条断言变红，
 *   全是【匹配到了注释里的示范文本】——
 *   我在注释里写「第一版写 `typeof mod.MenuSurface !== "function"`」，
 *   断言就抓到了这句；写「不要在这里再写 align-self」，断言就抓到了。
 *   ⇒ 判「代码里有没有 X」必须先把注释剥掉。
 *     这是「假红」，和假绿一样有害：会让人去改本来正确的代码。
 */
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * ★★ 2026-10-22：本仓库的源文件是 **CRLF** 行尾。
 *
 *   实测：editor.css.js 的字节是 47,42,42,13,10,32 —— 13,10 就是 \r\n。
 *   于是 `/\n\.ac-scope \.ac-btn-primary,/` 这类跨行正则会全部失配，
 *   断言变「假通过 / 假红」而看不出原因。
 *
 *   ⇒ 判代码前统一把 CRLF 归一成 LF。只影响匹配，不写回文件。
 */
const norm = (s) => s.replace(/\r\n/g, "\n");

const code = (s) => norm(stripComments(s));

const client = read("client.js");
const toolbar = read("EditorToolbar.js");
const inspector = read("Inspector.js");
const preview = read("PreviewPane.js");
const tab = read("ArtCraftTab.js");
const prim = read("dsh-primitives.js");
const sync = read("agentSync.js");
const css = read("editor.css.js");
const settings = read("ShortcutSettings.js");
const ops = read("clipboardOps.js");
const assets = read("mediaAssets.js");

/** 剥注释后的源码（判「代码里有没有」用这一组） */
const clientC = code(client);
const primC = code(prim);
const syncC = code(sync);
const cssC = code(css);
const settingsC = code(settings);
const toolbarC = code(toolbar);
const tabC = code(tab);
const assetsC = code(assets);
const inspectorC = code(inspector);
const previewC = code(preview);
const opsC = code(ops);
const lineOf = (src, re) => {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return -1;
};

/* ══ ① 宿主 require 搭桥 ══════════════════════════════════════════ */
check("① src 里没有裸的 typeof require",
  !/typeof require\s*===/.test(clientC),
  "esbuild 会把裸 require 换成 __require 桩，判定通过但调用必抛");

check("① dsh-primitives 有 resolveHostRequire 且优先全局桥",
  /export function resolveHostRequire/.test(primC) &&
  /__DSH_PLUGIN_REQUIRE__/.test(primC),
  "工厂 param 的 require 是唯一可靠来源");

const buildSrc = fs.existsSync(path.join(HERE, "build.mjs"))
  ? fs.readFileSync(path.join(HERE, "build.mjs"), "utf8") : "";
check("① build.mjs 把真 require 挂到 globalThis",
  /globalThis\.__DSH_PLUGIN_REQUIRE__\s*=\s*__requireShim/.test(buildSrc),
  "没有这行，源码拿不到真 require");

/* ══ ② forwardRef 判据 ═══════════════════════════════════════════ */
check("② 组件判定用 isComponentLike（不是 typeof === function）",
  /function isComponentLike/.test(primC) && /\$\$typeof/.test(primC),
  "MenuSurface 是 forwardRef，typeof 是 object");

check("② 没有 typeof X !== 'function' 这种对组件的误判",
  !/typeof mod\.MenuSurface\s*!==\s*"function"/.test(primC));

/* ══ ③ tracks 三层形状 ══════════════════════════════════════════ */
check("③ agentSync 有 eachElement 统一下钻",
  /function eachElement/.test(syncC),
  "overlay/audio 是轨道数组，main 是单个轨道");

check("③ agentSync 不再直接把 tracks.overlay 当元素数组",
  !/for \(const el of tracks\.overlay/.test(syncC),
  "那会把【轨道条数】当成元素数");

check("③ countElements 已导出（预览区判空态用）",
  /export function countElements/.test(syncC));

check("③ mediaAssets 的 collectMediaIds 下钻 elements",
  /const fromTrack = \(tr\) => \{\s*\n?\s*for \(const el of tr\?\.elements/.test(assetsC) ||
  /fromTrack\(tr\)/.test(assetsC),
  "旧版把 overlay 当元素数组，永远为空");

/* ══ ③b 两套 tracks 结构（本轮最隐蔽的一条）═════════════════════ */
check("③b eachElement 兼容 dsh-editor 的 clips 结构",
  /if \(Array\.isArray\(tr\.clips\)\)/.test(syncC),
  "snapshot 给的是 dsh-editor 结构：tracks=[{id,kind,name,clips}]，元素叫 clips 不叫 elements");

check("③b eachElement 兼容 ArtCraft 的 elements 结构",
  /if \(Array\.isArray\(tr\.elements\)\)/.test(syncC),
  "EditorCore 内存里元素叫 elements");

check("③b eachElement 能处理 tracks 是扁平数组",
  /if \(Array\.isArray\(tracks\)\)/.test(syncC),
  "dsh-editor 的 tracks 是数组，不是 {overlay,main,audio}");

check("③b 注释里写明两套结构不能混用",
  /dsh-editor.*timeline-state|timeline-state.*dsh-editor/s.test(sync) &&
  /clips/.test(sync),
  "这是「不报错、元素数永远 0」的那条");

/* ══ ④ bg-layer-2 使用 ══════════════════════════════════════════ */
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
check("④ editor.css 不使用 --dsw-alias-bg-layer-2",
  !/--dsw-alias-bg-layer-2/.test(cssNoComments),
  "浅色下它 = #fff，与面板同色，白底白底看不见");

check("④ 预览舞台有实际底色（不是 token 同色）",
  /\.ac-preview-stage[\s\S]{0,600}background:\s*rgba\(/.test(cssC),
  "空态不是黑块的前提");

/* ══ ⑤ grid 行高 ════════════════════════════════════════════════ */
check("⑤ 素材网格有 grid-auto-rows: min-content",
  /grid-auto-rows:\s*min-content/.test(cssC),
  "否则行高塌成 0px，卡片重叠");

const cardBlock = (cssC.match(/\.ac-media-card\s*\{[\s\S]*?\}/) || [""])[0];
check("⑤ 素材卡片没有 align-self",
  !/align-self/.test(cardBlock),
  "grid item 写 align-self 会让 auto 行高取 min-content=0");

/* ══ ⑥⑦ TDZ ════════════════════════════════════════════════════ */
check("⑥ selectedElement 的依赖只有 [editorState]",
  /const selectedElement = React\.useMemo\([\s\S]*?\}, \[editorState\]\);/.test(clientC),
  "引用回调里才拼出来的 selectedKey 会 TDZ");

check("⑥ 依赖数组里不出现 selectedKey（派生字段）",
  /**
   * ★ 判据收紧到「依赖数组」而不是全文 ——
   *   selectedKey 在 onState 里【赋值】是对的（它就是那么产生的），
   *   错的只是把它放进 useMemo 的依赖。
   *   全文判断会误伤，这也是「假红」的一种。
   */
  !/\},\s*\[[^\]]*selectedKey[^\]]*\]\)/.test(clientC),
  "selectedKey 是派生字段，不该出现在 useMemo 依赖里");

check("⑥ selectedElement 的依赖数组是 [editorState]",
  /\},\s*\[editorState\]\)/.test(clientC));

const rgLine = lineOf(settings, /^  const renderGroups = \(\) => \{/);
const embLine = lineOf(settings, /^  if \(embedded\) \{/);
check("⑦ renderGroups 定义在 if (embedded) 之前",
  rgLine > 0 && embLine > 0 && rgLine < embLine,
  `renderGroups@${rgLine} embedded@${embLine}；反了就是 TDZ`);

/* ══ ⑧ 面板必须有入口 ══════════════════════════════════════════ */
check("⑧ 工具栏有检查器开关",
  /onToggleInspector/.test(toolbarC) && /检查器/.test(toolbarC),
  "面板写了没入口 = 功能打不开");

check("⑧ ArtCraftTab 监听 ac:open-inspector",
  /addEventListener\("ac:open-inspector"/.test(tabC),
  "跨子树（另一棵 React 树）只能走自定义事件打开检查器");

/**
 * ★ 2026-10-22 更新：资产库按钮已被主人撤除（「可以取消不会要了」）。
 *   原断言要求「必须 dispatch ac:open-inspector」，现在改为：
 *   撤除后【不该】再有这个 dispatch，否则说明按钮还挂着。
 *   ⇒ 断言跟着需求改，不是删除断言（删了就没人守着了）。
 */
check("⑧ 资产库按钮已撤（不再 dispatch ac:open-inspector）",
  !/dispatchEvent\(new CustomEvent\("ac:open-inspector"/.test(clientC),
  "上一轮加的右上角按钮会挤压 DSH 原生 UI，主人已要求取消");

/* ══ 反引号纪律 ═════════════════════════════════════════════════ */
check("CSS 模板里反引号总数 === 2（开闭各一）",
  (css.match(/`/g) || []).length === 2,
  "注释里出现反引号会提前闭合模板，报错指向注释位置");

/* ══ 布局四区块 ═════════════════════════════════════════════════ */
check("布局：三段纵向（预览/工具栏/时间轴）",
  /\.ac-root[\s\S]{0,400}flex-direction:\s*column/.test(cssC));

check("布局：工具栏紧贴时间轴上方",
  /\.ac-toolbar[\s\S]{0,600}border-bottom:\s*0\.5px/.test(cssC),
  "布局文档 §三 的 0.5px 下边框规格");

check("布局：检查器宽 320 / 圆角 16px",
  /\.ac-inspector[\s\S]{0,400}width:\s*320px/.test(cssC) &&
  /\.ac-inspector[\s\S]{0,600}border-radius:\s*16px/.test(cssC));

check("布局：检查器是覆盖层（absolute，不挤压时间轴）",
  /\.ac-inspector[\s\S]{0,200}position:\s*absolute/.test(cssC));

/* ══ 工具栏 17 → 6 ═════════════════════════════════════════════ */
const primaryIds = (toolbar.match(/id:\s*"(import|split|delete|duplicate|undo|redo)"/g) || []).length;
check("工具栏常驻 6 个操作", primaryIds === 6, `实测 ${primaryIds}`);

check("工具栏没有「向左/向右分割」（布局文档 §四 已删）",
  !/splitLeft|splitRight/.test(toolbarC),
  "没有入点/出点概念，留着的语义不清");

check("「···」菜单按组标注（label + separator）",
  /type:\s*"label"/.test(toolbarC) && /type:\s*"separator"/.test(toolbarC));

check("「···」菜单项带快捷键 shape",
  /shortcut:\s*chord/.test(toolbarC) && /function shortcutShape/.test(toolbarC),
  "主人要求：同步到二级菜单提示");

/* ══ 预览区空态 ═════════════════════════════════════════════════ */
check("预览空态：有占位而不是 canvas",
  /\.ac-preview-empty/.test(cssC) && /这里还没有内容/.test(previewC),
  "主人 2026-10-21 报的「浅色主题就是大黑块」");

check("预览空态：有明确下一步（导入按钮）",
  /导入素材/.test(previewC));

/* ══ Agent 实时反馈 ═════════════════════════════════════════════ */
check("Agent：1 秒轮询 /timeline/snapshot",
  /POLL_MS\s*=\s*1000/.test(syncC) && /\/timeline\/snapshot/.test(syncC));

check("Agent：指纹判变化（不是每秒全量重渲染）",
  /export function fingerprint/.test(syncC));

check("Agent：回声消除（区分自己改的和 Agent 改的）",
  /markSelfWrite/.test(syncC) && /isSelf/.test(syncC),
  "否则用户每拖一下都弹提示");

check("Agent：消息条文案说「操作了什么」",
  /添加了/.test(syncC) && /删除了/.test(syncC) && /调整了/.test(syncC),
  "主人原话：让用户知道 Agent 操作了什么东西");

check("Agent：首次快照不弹提示",
  /isFirst/.test(syncC),
  "否则每次打开剪辑台都弹一条");

check("Agent：页面隐藏时停轮询",
  /visibilityState/.test(syncC));

/* ══ Agent 元素高亮（架构决策 §四 反馈第 1 条）══════════════════ */
check("Agent：变化元素会高亮（highlightElements）",
  /export function highlightElements/.test(syncC) && /HIGHLIGHT_MS\s*=\s*1500/.test(syncC),
  "只弹消息用户不知道是哪几个");

check("高亮靠 data-element-id 锚点（上游元素 DOM 无 data-*）",
  /data-element-id="\$\{CSS\.escape/.test(syncC) ||
  /data-element-id=/.test(syncC));

check("高亮退出时清全量（元素可能已被删）",
  /querySelectorAll\("\." \+ HIGHLIGHT_CLASS\)/.test(syncC),
  "记 DOM 引用的话元素删了就清不掉");

check("高亮尊重 prefers-reduced-motion",
  /prefers-reduced-motion/.test(syncC));

const elTsx = fs.existsSync(
  "D:/主工作区/_upstream/artcraft-demo/video-editor/src/lib/timeline/components/timeline-element.tsx"
)
  ? fs.readFileSync(
      "D:/主工作区/_upstream/artcraft-demo/video-editor/src/lib/timeline/components/timeline-element.tsx",
      "utf8")
  : "";
check("上游元素宿主确实挂了 data-element-id",
  /data-element-id=\{element\.id\}/.test(stripComments(elTsx)),
  "高亮选择器的唯一依据");

check("client 真的调了 highlightElements",
  /highlightElements\(d\.changedIds\)/.test(clientC));

/* ══ 高亮的时序（第二轮复核抓到的真缺陷）═══════════════════════ */
check("高亮推迟到 DOM 更新之后（raf 套 raf）",
  /requestAnimationFrame\(\(\) => \{\s*requestAnimationFrame\(/.test(clientC),
  "updateSceneTracks 是异步渲染，紧接着 querySelector 找不到新元素 ⇒ 高亮静默 0 次");

check("高亮返回 {hit, missing} 而不是裸数字",
  /return \{ hit, missing \}/.test(syncC),
  "返回裸数字时调用方不看 ⇒ 0 命中和全命中无法区分");

check("0 命中时留 warn（可观测）",
  /高亮未命中任何元素/.test(clientC),
  "本轮真实静默失效过，必须能一眼看见");

/* ══ Agent 数据真同步（本轮最后一个缺口）═══════════════════════ */
check("Agent：轮询拿到的新数据会灌进编辑器",
  /syncSnapshotToEditor/.test(clientC) &&
  /editor\.scenes\.updateSceneTracks\(\{\s*tracks/.test(clientC),
  "只更新计数不灌数据 ⇒ 已生成的片段变化看不到");

check("Agent：同步后重新注册媒体（否则缩略图不渲染）",
  /registerMediaAssets\(editor, ids\)/.test(clientC));

check("Agent：首次快照不重复灌（已在挂载流程做过）",
  /if \(meta\?\.first\) return;/.test(clientC));

check("Agent：用 updateSceneTracks 而不是重建 project",
  !/setActiveProject/.test(clientC),
  "重建 project 会重置选择/播放头/撤销栈");

/* ══ 已知设计边界（写下来防误判为 bug）════════════════════════ */
const proj = fs.existsSync(
  "D:/主工作区/_upstream/artcraft-demo/video-editor/src/lib/timeline/dsh-projection.ts"
)
  ? fs.readFileSync(
      "D:/主工作区/_upstream/artcraft-demo/video-editor/src/lib/timeline/dsh-projection.ts",
      "utf8")
  : "";
check("投影层有意跳过「待生成」镜头（不是 bug）",
  /hasMedia\s*=\s*srcUsable\s*\|\|\s*!!renderedName/.test(stripComments(proj)) &&
  /if\s*\(!hasMedia\)\s*return null/.test(stripComments(proj)),
  "判据：Agent 新加的镜头处于「待生成」⇒ 不进时间轴 ⇒ 消息条/高亮不触发，这符合设计");

/* ══ 字段取值器：两套结构的字段名不一样 ═════════════════════════ */
check("差异检测用取值器（elStart/elDuration/elMedia）",
  /const elStart = /.test(syncC) && /const elDuration = /.test(syncC) &&
  /const elMedia = /.test(syncC),
  "dsh-editor 的 clip 是 in/out/rendered.filename，没有 startTime/duration/mediaId");

check("fingerprint 用取值器而不是裸字段名",
  /String\(elStart\(el\)\)/.test(syncC) && /elMedia\(el\)/.test(syncC),
  "裸读 startTime/mediaId 对着 clip 全是 undefined ⇒ 指纹只剩 id");

check("describeDiff 用取值器（moved 判断）",
  /elStart\(pa\) !== elStart\(el\)/.test(syncC));

check("describeDiff 把「待生成→已生成」也算变化",
  /rendered\.push/.test(syncC) && /更新了 \$\{rendered\.length\} 个片段的画面/.test(syncC),
  "这是最需要提示的场景，漏了就等于静默");

/* ══ slot ═══════════════════════════════════════════════════════ */
check("slot · conversation.view 注册",
  /ctx\.slots\.register\(\s*\{[\s\S]{0,200}name:\s*"conversation\.view"/.test(clientC));

/**
 * ★ 2026-10-22 更新：主人要求撤掉 header.utilities 的资产库按钮。
 *   原断言是「必须注册」，现在反过来：不该再注册。
 */
check("slot · 不再注册 header.utilities（资产库按钮已撤）",
  !/name:\s*"conversation\.session\.header\.utilities"/.test(clientC),
  "list 类 slot 加一项会把 DSH 原生按钮往左挤");

check("slot · settings.section 注册",
  /name:\s*"settings\.section"/.test(clientC));

check("slot · tab 标签是「剪辑台」",
  /"view\.label":\s*"剪辑台"/.test(clientC),
  "主人要求改名");

check("slot · apply 整体包 try/catch",
  /export function apply\(ctx\)\s*\{[\s\S]{0,200}try\s*\{/.test(clientC),
  "Slot API 异常会击穿 client loader，整个前端白屏");

check("slot · list 类 slot 用 id + order 注册",
  /id:\s*VIEW_ID[\s\S]{0,120}order:\s*30/.test(clientC),
  "list 用 id/order；keyed 才用 key/priority");

/* ══ 检查器三 tab 自画 ═════════════════════════════════════════ */
check("检查器三 tab：素材/属性/字幕",
  /value:\s*"media"/.test(inspectorC) && /value:\s*"props"/.test(inspectorC) &&
  /value:\s*"caps"/.test(inspectorC));

check("检查器用 DSH 原生 SegmentedTabs",
  /U\.SegmentedTabs/.test(inspectorC),
  "主人 2026-10-22：可以复用 DSH 自身的素材");

check("属性面板空态说「怎么做才有内容」",
  /未选中片段/.test(inspectorC) && /在时间轴上点一下片段/.test(inspectorC),
  "refactoring-ui §8.4：空态是功能的一部分");

check("素材面板固定双列",
  /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(cssC),
  "主人要求固定双列");

/* ══ 快捷键 ═════════════════════════════════════════════════════ */
check("快捷键设置有 embedded 形态（复用 DSH 设置外壳）",
  /embedded\s*=\s*false/.test(settingsC) && /data-embedded/.test(settingsC));

check("快捷键：冲突拒绝且报出对方",
  /setError\(\{\s*id:\s*capturing,\s*msg:\s*r\.reason/.test(settingsC));

check("快捷键：两种形态共用同一份列表（renderGroups）",
  (settings.match(/renderGroups\(\)/g) || []).length >= 2,
  "两份实现会漂移");

/* ══ 剪辑动作走真实 manager API ════════════════════════════════ */
check("剪辑动作：元素引用形状是 {trackId, elementId}",
  /trackId:\s*r\?\.trackId,\s*elementId:\s*r\?\.elementId/.test(opsC));

check("剪辑动作：分割用播放头位置，且只切「播放头在内部」的",
  /playhead\(editor\)/.test(opsC) && /t > el\.startTime && t < el\.startTime \+ el\.duration/.test(opsC),
  "播放头不在片段内切开会得到不连续块");

check("剪辑动作：没有选中时抛可读错误（不是静默无反应）",
  /先选中要分割的片段/.test(opsC) && /先选中要删除的片段/.test(opsC),
  "「点了没反应」比报错更差");

/* ══ 恢复上次导入 ═══════════════════════════════════════════════ */
check("恢复上次导入：有本地记录 + 恢复函数",
  /LOCAL_IMPORTS_KEY/.test(assetsC) &&
  /export async function restoreLastImports/.test(assetsC),
  "主人：能不能默认上次的导入内容");

check("恢复上次导入：幂等（已存在的 mediaId 跳过）",
  /existing\.has\(String\(item\.id\)\)/.test(assetsC),
  "否则每次切 tab 都把内容复制一遍");

check("恢复上次导入：在 mount 之后调用",
  /await restoreLastImports\(editor\)/.test(clientC));

/* ══ ⑨ 2026-10-22 主人实测报的五条（第二轮）══════════════════════ */

/* ① 导入素材按钮看不见（白字透明底） */
check("导入按钮：用 background-color 长写而不是只写 background",
  /\.ac-btn-primary[\s\S]{0,300}background-color:\s*var\(--dsw-alias-state-business-primary/.test(cssC),
  "只写简写会被 .ac-scope .ac-btn 的 background-color 盖掉（级联按属性逐个比）");

check("导入按钮：用「元素+双类」提高特异性（0,2,1）",
  /**
   * ★★ 2026-10-22 第四修：真正有效的方案不是「多叠一层 .ac-scope」。
   *
   *   实测 `btn.matches('.ac-scope .ac-scope .ac-btn-primary') === false`
   *   —— 按钮只有一个 .ac-scope 祖先，叠两层根本不匹配，那条规则等于没写。
   *   真正赢的是同组里的 `.ac-scope .ac-btn-primary`（0,2,0），
   *   而它与对手 `.ac-scope .ac-btn`（0,2,0）同特异性 ⇒ 靠顺序，不可靠。
   *
   *   ⇒ 改用 `button.ac-btn.ac-btn-primary`（0,2,1）：
   *     多一个元素选择器，比对手高一级，且【真的匹配】。
   *   判据：选择器组里必须有 `button.ac-btn.ac-btn-primary,`。
   */
  /button\.ac-btn\.ac-btn-primary,(?!:hover)/.test(cssC),
  "0,3,0 的选择器匹配不到（只有一个 .ac-scope 祖先），0,2,1 才既匹配又赢");

/* ② 更多菜单被轨道挡住 */
check("更多菜单：用 portal 脱离剪辑台的层叠上下文",
  /portal:\s*true/.test(toolbarC),
  "菜单祖先 z-index:auto，时间轴在 DOM 里更后 ⇒ 整块压在菜单之上");

/* ③ 轨道高度无法拖动 */
check("高度可拖：有分隔条组件", /function VSplit/.test(code(tabC)));
check("高度可拖：分隔条用 pointer events + capture",
  /setPointerCapture/.test(tabC) && /onPointerMove/.test(tabC),
  "pointer 统一鼠标/触控，capture 保证拖出元素也不断");
check("高度可拖：拖动只改 CSS 变量（不 setState）",
  /setProperty\("--ac-preview-h"/.test(tabC),
  "每次 move 都 setState 会整树重渲染，拖动必掉帧");

/* ③b 拖动不能把时间轴挤出页面 */
check("高度可拖：根容器锁死高度（max-height + overflow hidden）",
  /\.ac-root[\s\S]{0,700}max-height:\s*100%/.test(cssC) &&
  /\.ac-root[\s\S]{0,700}overflow:\s*hidden/.test(cssC),
  "实测不锁时 root 从 789 涨到 1076，时间轴被顶出页面");

check("高度可拖：CSS 层 clamp 兜住失控的变量",
  /flex:\s*0 0 clamp\(120px, var\(--ac-preview-h/.test(cssC),
  "JS clamp 只管拖动/键盘；变量被别处改大时靠这层兜");

check("高度可拖：clamp 基准不是自身高度",
  /hostHeight\(\)/.test(tabC),
  "root 自己会被 --ac-preview-h 撑大，拿它当上界等于没限制");

/* ④ 资产库按钮撤除 */
check("资产库按钮已撤除（不再注册 header.utilities）",
  !/id:\s*"artcraft-assets"/.test(clientC),
  "会挤压 DSH 原生按钮，且 folder 图标认不出");

/* ⑤ 圆环监控同步到剪辑台 */
check("设备监控已挂进剪辑台",
  /DeviceMonitorBoundary/.test(tabC) && /h\(DeviceMonitor\)/.test(tabC),
  "它是另一个包的内部组件，需复制一份过来");

/* ⑥ 手柄屏蔽 */
check("DSH 列宽手柄屏蔽已装", /installHandleGuard/.test(clientC));
check("屏蔽层只在那 10px 上开 pointer-events",
  /pointer-events:auto/.test(code(read("dshHandleGuard.js"))) &&
  /pointer-events:none/.test(code(read("dshHandleGuard.js"))),
  "整层 auto 会挡住工作台本身");
check("恢复默认宽度（删 contentWidth 偏好）",
  /resetDshWidths/.test(clientC) && /dsh\.conversation\.contentWidth/.test(code(read("dshHandleGuard.js"))));

/* ⑦ CSS 模板反引号（本轮连犯四次，已固化成独立脚本） */
check("CSS 模板反引号检查脚本存在",
  fs.existsSync(path.join(HERE, "check-css-template.mjs")),
  "注释里一个反引号就会提前闭合模板，报错指向注释位置");

/* ══ ⑩ 2026-10-22 主人实测报的第二批（滚动条 + 滚轮缩放）═══════ */

const zoomGestures = read("timelineZoomGestures.js");
const zoomC = code(zoomGestures);
const nativeCssC = code(read("dsh-native.css.js"));

/* ① 滚动条不再是一整块灰 */
check("滚动条：track 透明（不再是实心灰长条）",
  /::-webkit-scrollbar-track\s*\{[^}]*background:\s*transparent/.test(nativeCssC),
  "主人报「鼠标不放上去有一个很丑的长方形灰色块」");

check("滚动条：thumb 有圆角",
  /::-webkit-scrollbar-thumb\s*\{[^}]*border-radius:\s*999px/.test(nativeCssC),
  "圆角只应在 thumb 上，不能给 track");

check("滚动条：thumb 用 border 内缩（视觉更细）",
  /background-clip:\s*content-box/.test(nativeCssC),
  "滚动条伪元素不能设 margin/padding，内缩只能靠透明边框");

check("滚动条：角落也透明",
  /::-webkit-scrollbar-corner\s*\{[^}]*background:\s*transparent/.test(nativeCssC));

/* ② 滚轮缩放（横向 + 纵向） */
check("滚轮缩放：有 edgeOf 按位置判方向",
  /export function edgeOf/.test(zoomC),
  "按鼠标位置而不是滚轮方向 —— 按方向会和普通滚动冲突");

check("滚轮缩放：横向条 → setZoom",
  /zone === "x"[\s\S]{0,300}setZoom/.test(zoomC));

check("滚轮缩放：纵向分支 → setTrackScale",
  /**
   * ★ 断言原本写的是 `zone === "y"`，但实现里是 `if (zone === "x") {...} else {...}` ——
   *   纵向走 else 分支，源码里没有 `zone === "y"` 这个字面量。
   *   ⇒ 判据改成「x 分支调 setZoom，else 分支调 setTrackScale」。
   *     （这是「断言锚字符串 vs 锚行为」的又一次教训）
   */
  /if \(zone === "x"\)[\s\S]{0,200}setZoom[\s\S]{0,400}else\s*\{[\s\S]{0,200}setTrackScale/.test(zoomC),
  "纵向走 else 分支，不是显式的 zone === y");

check("滚轮缩放：右下角优先横向（不同时触发）",
  /if \(nearBottom && canX\) return "x"/.test(zoomC),
  "同时缩放横纵用户会不知道发生了什么");

check("滚轮缩放：wheel 归一化（deltaMode / 120）",
  /deltaMode === 1/.test(zoomC) && /120/.test(zoomC),
  "触控板一次滑动不能被放大成几十倍缩放");

check("滚轮缩放：passive:false（否则 preventDefault 无效）",
  /passive:\s*false/.test(zoomC));

/* ③ 白屏事故的防线（最重要） */
check("滚轮缩放：DOM 未就绪时返回而不是抛",
  /if \(!el \|\| !e\) return null/.test(zoomC) &&
  /if \(!next \|\| !\(next instanceof HTMLElement\)\) return false/.test(zoomC),
  "第一版没判空就 getBoundingClientRect ⇒ 异常穿透 React 提交 ⇒ 整个 DSH 白屏");

check("滚轮缩放：内部多处 try/catch",
  (zoomC.match(/try\s*\{/g) || []).length >= 3,
  "安装失败最多是手势不生效，不该让面板崩");

check("滚轮缩放：轮询等容器就位（不假设渲染完就有）",
  /setInterval/.test(zoomC) && /tries > 50/.test(zoomC));

check("client 安装时也包 try/catch",
  /installWheelZoom\(\{/.test(tabC) && /滚轮缩放安装失败/.test(tabC));



check("MediaTime 按整数 tick 处理（120000/秒）",
  /TICKS_PER_SEC\s*=\s*120000/.test(assetsC),
  "不是 {numerator, denominator}（那是 FrameRate）");

check("AudioElement 声明 sourceType（联合类型）",
  /sourceType:\s*"upload"/.test(assetsC),
  "不声明会导致导出无音频流");

check("element.type 按扩展名判（不是 clip.kind）",
  /function mediaTypeOf/.test(assetsC));

/* ── 汇总 ── */
console.log("");
console.log("═".repeat(60));
console.log("  剪辑台四区块实装验收");
console.log("═".repeat(60));
if (fails.length === 0) {
  console.log(`  ✅ 全部通过：通过 ${pass} / ${pass}`);
  console.log("═".repeat(60));
  process.exit(0);
}
for (const f of fails) {
  console.log(`  ❌ ${f.name}`);
  if (f.detail) console.log(`     ${f.detail}`);
}
console.log("─".repeat(60));
console.log(`  通过 ${pass} / ${pass + fails.length}`);
console.log("═".repeat(60));
process.exit(1);



