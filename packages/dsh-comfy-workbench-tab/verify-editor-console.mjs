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
const SRC = path.join(HERE, "src", "editor");

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

/**
 * ★★ 2026-10-22 合包：剪辑台的客户端入口从 client.js 改名为 editorHost.js
 *
 *   原来 dsh-artcraft-tab 这个独立包里，client.js 既是 IIFE 入口又装组件。
 *   合包后职责拆开：
 *     · 插件的 name/apply/inject 归 dsh-comfy-workbench-tab/src/client.js
 *     · 剪辑台的客户端组件与工具留在 src/editor/editorHost.js
 *       （只导出 NS / ArtCraftBoundary / ArtCraftHost，不导出 apply）
 *   ⇒ 这里读 editorHost.js。文件名变了，但「剪辑台客户端逻辑」这个被测对象没变。
 */
const client = read("editorHost.js");
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

check("④ 预览舞台底色必须是主题感知 token（不能用纯 rgba）",
  /**
   * ★★ 2026-10-22 更新，且这一版是被变异测试逼出来的
   *
   *   第一版断言：`background: rgba(` —— 要求必须硬编码 rgba。
   *   改法后我放宽成「token 或 rgba 都行」，但**变异测试证明这是假断言**：
   *   把代码改回纯 `rgba(0,0,0,.035)`，断言仍然通过 ——
   *   而纯 rgba 正是深色下预览区消失的原因。
   *
   *   ⇒ 收紧：必须是 --dsw-alias-interactive-bg-hover。
   *     · 浅色下 = 淡灰（与面板可区分）✅
   *     · 深色下 = #ffffff14 淡白（提亮）✅
   *     · 纯 rgba(0,0,0,*) 深色下只会更黑 ❌
   *     · bg-layer-2 浅色下与面板同色看不见 ❌
   */
  /\.ac-preview-stage[\s\S]{0,700}background:\s*var\(--dsw-alias-interactive-bg-hover/.test(cssC),
  "纯 rgba 在深色下是「更黑」，bg-layer-2 在浅色下与面板同色 —— 只有 interactive-bg-hover 两档都对");

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
/**
 * ★★ 2026-10-22：原断言是「匹配 (import|split|delete|duplicate|undo|redo) 六个」。
 *   本轮把 duplicate 换成 copy（主人要求 Ctrl+C）⇒ 变红。
 *   ⇒ 判据改成「常驻集合必须正好是这六个 id」，
 *     而不是「这六个字符串在文件里出现几次」——
 *     后者只要名称一换就红，且说不出到底少了哪个。
 */
/**
 * ★ 2026-10-23：常驻位从 6 变 7 —— 加了 export。
 *   主人：「导出按钮还是没在ui直接显示，放在导入按钮右边比较好」
 *   ⇒ 这条断言跟着改，但【顺序也要断】—— 导出必须在导入右边。
 */
const PRIMARY_EXPECT = ["import", "export", "split", "delete", "copy", "undo", "redo"];
const primaryBlock = (toolbar.match(/TOOLBAR_PRIMARY\s*=\s*\[[\s\S]*?\];/) || [""])[0];
const historyBlock = (toolbar.match(/TOOLBAR_HISTORY\s*=\s*\[[\s\S]*?\];/) || [""])[0];
const primaryActual = [...(primaryBlock + historyBlock).matchAll(/id:\s*"([a-zA-Z]+)"/g)]
  .map((m) => m[1]);
check("工具栏常驻正好 6 个（内容也对）",
  primaryActual.length === PRIMARY_EXPECT.length &&
  PRIMARY_EXPECT.every((id) => primaryActual.includes(id)),
  `期望 ${PRIMARY_EXPECT.join(",")}；实测 ${primaryActual.join(",")}`);

check("常驻「复制」是 copy 不是 duplicate",
  primaryActual.includes("copy") && !primaryActual.includes("duplicate"),
  "主人要求改成 Ctrl+C");

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
/**
 * ★★ 2026-10-22 合包：slot 注册动作从 editorHost.js 移到了 editor/index.js
 *
 *   合包前 editorHost.js（当时叫 client.js）自己 apply 并注册两个 slot。
 *   合包后：
 *     · src/editor/index.js 的 mountEditorModule() 负责注册
 *     · src/client.js（workbench 包入口）的 apply 调用它
 *   ⇒ 这些断言改读 editorIndexC（同时看 mountEditorModule 的注册体）。
 *     被测行为没变：「剪辑台必须注册进 conversation.view 与 settings.section」。
 */
const editorIndexC = code(read("index.js"));

/**
 * ★★ 2026-10-22 合包：包入口是 src/client.js（在上一层），
 *   而本脚本的 read() 只读 src/editor/ 里的文件。
 *   ⇒ 单独按绝对路径读它。上面那几条「apply 里包 try/catch」测的是【包的入口】，
 *     不是剪辑台的 editorHost.js —— 两者别再混。
 */
const pkgClientPath = path.join(HERE, "src", "client.js");
const pkgClientC = code(
  fs.existsSync(pkgClientPath) ? fs.readFileSync(pkgClientPath, "utf8") : ""
);

check("slot · conversation.view 注册（id=artcraft）",
  /id:\s*"artcraft"/.test(editorIndexC) &&
  /name:\s*"conversation\.view"/.test(editorIndexC));

/**
 * ★ 2026-10-22 更新：主人要求撤掉 header.utilities 的资产库按钮。
 *   原断言是「必须注册」，现在反过来：不该再注册。
 */
check("slot · 不再注册 header.utilities（资产库按钮已撤）",
  !/name:\s*"conversation\.session\.header\.utilities"/.test(editorIndexC) &&
  !/name:\s*"conversation\.session\.header\.utilities"/.test(clientC),
  "list 类 slot 加一项会把 DSH 原生按钮往左挤");

check("slot · settings.section 注册（快捷键设置）",
  /name:\s*"settings\.section"/.test(editorIndexC) &&
  /id:\s*"artcraft-shortcuts"/.test(editorIndexC));

check("slot · tab 标签是「剪辑台」",
  /"view\.label":\s*"剪辑台"/.test(editorIndexC),
  "主人要求改名");

check("slot · 包 apply 整体包 try/catch",
  /**
   * ★ 断言第一版写 `apply(ctx) { ... 200 字内 ... try {`，
   *   但 workbench 的 apply 很长（194 行起，第一个 try 在 225 行，
   *   中间隔了字典注册与手柄屏蔽），200 字不够 ⇒ 假红。
   *   ⇒ 判据改成：`apply` 之后到该函数结束前存在 try（用更宽的窗口）。
   */
  /export function apply\(ctx\)\s*\{[\s\S]{0,3000}?try\s*\{/.test(pkgClientC),
  "Slot API 异常会击穿 client loader，整个前端白屏");

check("slot · 剪辑台注册单独 try/catch（模块隔离）",
  /try\s*\{\s*mountEditorModule\(ctx/.test(pkgClientC),
  "剪辑台挂了不该影响视频工作台 —— 这是「模块失效只丢那一块」的落地");

check("slot · list 类 slot 用 id + order 注册（order 30）",
  /id:\s*"artcraft"[\s\S]{0,160}order:\s*30/.test(editorIndexC),
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

/* ══ ⑪ 宽度实时跟随 DSH（2026-10-23）═══════════════════════════════ */
/**
 * 主人两次要求，第一次是「跟随」，第二次是「实时」：
 *   「宽度还是没修，没有跟随DSH原生的中栏宽度调节」
 *   「能做成实时动效吗？DSH对话框就是实时拉动的」
 *
 * ★ 关键：DSH 拖动时只改 CSS 变量 --dsh-composer-card-max-width，
 *   浏览器原生重绘（无 React 重渲染）⇒ 所以它实时。
 *   我们也引用同一个变量即可同帧跟随。
 *
 * ★ 必须防的退化：改回 localStorage 轮询（慢半拍，且实测不生效）。
 */
const editorHostC = code(read("editorHost.js"));

check("剪辑台宽度引用 DSH 的 CSS 变量（不是轮询计算）",
  /var\(--dsh-composer-card-max-width/.test(editorIndexC),
  "轮询 localStorage 慢半拍；实测 DSH 拖动时根本不读 localStorage");

check("剪辑台不再用 setInterval 做宽度跟随",
  /**
   * 允许 setInterval 存在，但它只能用于「等元素挂载后补一次兜底」。
   * 判据：不能出现 sync() 那种「每 500ms 重算宽度」的写法。
   */
  !/const timer = setInterval\(sync,/.test(editorIndexC),
  "每 500ms 重算宽度 = 慢半拍");

check("ac-scope 用 min(100%, var(--ac-follow-w)) 而不是固定宽",
  /width:\s*"min\(100%,\s*var\(--ac-follow-w/.test(editorHostC));

check("工作台也用同一个 CSS 变量（两个 tab 同源）",
  /**
   * ★ 2026-10-23 修：断言第一版用 tabC，但 tabC = ArtCraftTab.js（剪辑台的组件），
   *   不是工作台。工作台在上一层 src/WorkbenchView.js。
   *   ⇒ 单独按路径读它。
   */
  (() => {
    const p = path.join(HERE, "src", "WorkbenchView.js");
    if (!fs.existsSync(p)) return false;
    const c = code(fs.readFileSync(p, "utf8"));
    return /var\(--ac-follow-w/.test(c) && /var\(--dsh-composer-card-max-width/.test(c);
  })(),
  "两个 tab 必须同源，否则宽度会不一致");

/* ══ ⑫ 加载体验与间距（2026-10-23）═══════════════════════════════════ */
/**
 * 主人：（截图一片「正在载入剪辑台…」+ 卡在「加载模式...」）
 *   「我们的tab加载是不是太久了？不能先把ui加载出来然后再慢慢加载功能吗？」
 *   「然后剪辑台和对话框直接的间隔直接为0是否太拥挤？」
 */

check("加载提示不遮挡 UI（不能用 inset:0 全屏覆盖）",
  /**
   * 原来的遮罩是 position:absolute; inset:0 —— 把已经渲染好的
   * 预览/工具栏/时间轴骨架整块盖住，用户只看到一句「正在载入」。
   * 判据：不能出现 inset: 0 的加载层。
   */
  !/正在载入时间轴[\s\S]{0,400}inset:\s*0/.test(editorHostC) &&
  /正在载入时间轴/.test(editorHostC),
  "骨架先显示，加载态单独标 —— 不是整块盖住等全部就绪");

check("加载提示定位在右上角（不覆盖主体）",
  /top:\s*8,\s*right:\s*12/.test(editorHostC));

check("剪辑台底部留 16px 间距（与 DSH 对话 tab 一致）",
  /**
   * 实测 DSH 自己：最后一条消息 bottom 778 → composer card.y 794 = 16px。
   * ★ 关键：必须同时改 height 为 calc(100% - 16px)，
   *   否则 boxSizing:border-box 会把 padding 算在 100% 里面，间距为 0。
   */
  /padding:\s*"0 0 16px"/.test(editorHostC) &&
  /height:\s*"calc\(100% - 16px\)"/.test(editorHostC),
  "border-box 下 padding 在盒内，不会把盒子推离邻居");


/* ══ ⑬ 素材缩略图 / 列表重叠 / 图标 / 导出（2026-10-23）══════════════ */
/**
 * 主人报的四个：
 *   「图标重复了，然后整个剪辑台找不到导出按钮」
 *   「1.然后导入功能又失效了 2.检查器里面的预览失效 3.表格模式重叠」
 */

check("撤销/重做用不同图标（不能都写 refresh）",
  /**
   * 原来两个按钮的 icon 都是 "refresh" ⇒ 截图里是同一个弧形箭头。
   * DSH 图标集里没有 undo/redo（实测搜 /undo|redo|history/ 只命中无关的
   * IconAgentPreset*），所以画了内联 SVG。
   */
  /icon: "undo"/.test(toolbarC) && /icon: "redo"/.test(toolbarC) &&
  /function UndoIcon/.test(toolbarC) && /function RedoIcon/.test(toolbarC),
  "两个图标必须方向相反才读得出撤回/重做");

check("导出有入口（⋯ 菜单里）",
  /id: "export"/.test(toolbarC),
  "原来 ExportButton 只在 editor-header 里，而我们用 mountTimeline 没挂 header");

check("导出调用真实 API（不是假按钮）",
  /editor\.project\.export\(/.test(editorHostC),
  "AGENTS 记过「控件是摆设」—— 必须有真实的执行路径");

check("导出对空时间轴报错（不生成 0 字节文件）",
  /时间轴是空的/.test(editorHostC));

check("素材缩略图用 /comfy-assets/file 拼 URL",
  /**
   * 实测 /comfy-assets/library 返回 { id, src, rel, … }，
   * 【没有 thumbUrl 也没有 url】⇒ 原来 `it.thumbUrl || it.url || null` 恒为 null
   * ⇒ 881 张卡片 img 元素 0 个。
   *
   * ★ 2026-10-23 收紧：必须同时出现 src= 与 rel= 两个参数。
   *   第一版只测 /comfy-assets/file?src= —— 把 rel 置空时仍然通过（假绿）。
   *   而 rel 是【真实文件名】，少了它 URL 直接 404。
   */
  /\/comfy-assets\/file\?src=\$\{encodeURIComponent\(src\)\}&rel=\$\{encodeURIComponent\(rel\)\}/.test(editorHostC) &&
  /**
   * ★ 再收紧一层：必须从 it.rel / it.src 取值。
   *   只测拼接字符串不够 —— 把 `const rel = it.rel || ""` 改成 `= ""` 时，
   *   拼接那段代码还在，断言仍然通过（第二次假绿）。
   *   根因：断的是「代码形状」，而 bug 在「取值来源」。
   */
  /const src = it\.src/.test(editorHostC) && /const rel = it\.rel/.test(editorHostC),
  "library 接口不返回图片 URL，必须用 src+rel 拼代理地址");

check("视频缩略图用 video 标签（img 解不了 mp4）",
  /it\.kind === "video"[\s\S]{0,200}h\("video"/.test(inspectorC),
  "实测 mp4 套 img 时 naturalWidth 恒为 0");

check("列表模式卡片不被 flex 压缩（重叠根因）",
  /**
   * 实测：CSS 只有一条 height:44px，但 computed 是 12px ——
   * 因为 .ac-media-list 是 flex column，卡片默认 flex-shrink:1 被压缩。
   * 缩略图 30px 比卡片 12px 还高 ⇒ 溢出压住下一张。
   */
  /\.ac-media-list \.ac-media-card \{[\s\S]{0,400}flex:\s*none/.test(cssC),
  "flex 容器里写固定 height 必须同时写 flex: none");

check("列表模式卡片有 min-height 兜底",
  /\.ac-media-list \.ac-media-card \{[\s\S]{0,500}min-height:\s*44px/.test(cssC));

/* ══ ⑭ 2026-10-23 主人报的五个 / 进度与开关 ═══════════════════════ */
/**
 * ★ 进度条 / 生成停止按钮 在【工作台】里（src/WorkbenchView.js），
 *   不在 ArtCraftTab。第一版我误用了 tabC，5 条全假红。
 */
const wbViewC = code(fs.readFileSync(path.join(HERE, "src", "WorkbenchView.js"), "utf8"));

check("导出在常驻位且紧跟导入（不在 ⋯ 二级里）",
  /**
   * 主人：「导出按钮还是没在ui直接显示，放在导入按钮右边比较好，
   *        目前是在更多操作的二级里面」
   * ⇒ 必须出现在 TOOLBAR_PRIMARY 且位于 import 之后；同时不能留在 TOOLBAR_MORE。
   */
  (() => {
    const prim = code(toolbarC).match(/TOOLBAR_PRIMARY\s*=\s*\[([\s\S]*?)\];/);
    if (!prim) return false;
    const ids = [...prim[1].matchAll(/id:\s*"([a-zA-Z]+)"/g)].map(m => m[1]);
    const iImport = ids.indexOf("import");
    const iExport = ids.indexOf("export");
    return iExport > iImport && iImport >= 0;
  })(),
  "导出必须在导入右边，且是常驻位");

check("导出不再重复出现在 ⋯ 菜单",
  (() => {
    const more = code(toolbarC).match(/TOOLBAR_MORE\s*=\s*\[([\s\S]*?)\n\];/);
    if (!more) return true;   // 找不到就不断言（避免误红）
    return !/id:\s*"export"/.test(more[1]);
  })(),
  "同一功能出现在两处 = 用户以为是两个操作");

check("生成/停止是同一个按钮（不新增取消按钮）",
  /**
   * 主人：「点击生成后多出来一个取消，应该学习DSH的对话发送和暂停，
   *        在一个按钮位置做切换」
   * 判据：按钮的 onClick 是 busy ? onCancel : onGenerate。
   */
  /onClick:\s*busy\s*\?\s*onCancel\s*:\s*onGenerate/.test(wbViewC),
  "两个按钮 vs 一个按钮切换 —— 后者才是 DSH 的做法");

check("停止态用中性色（不是 primary 蓝）",
  /busy\s*\n?\s*\?\s*"var\(--dsw-alias-interactive-bg-active/.test(wbViewC),
  "蓝底会让人以为再点一下会继续生成");

check("进度用进度条而不是一行小字",
  /**
   * 主人两次说「进度没用」。第一次我只塞了 11px 小字在状态条里，
   * 混在 jobId / 产物数之间，看不出来那是进度。
   * ⇒ 改成一个 48px 的可见进度条。
   */
  /const pct = Math\.max\(0, Math\.min\(100, pg\.pct\)\)/.test(wbViewC) &&
  /width:\s*`\$\{pct\}%`/.test(wbViewC),
  "必须有真实的宽度百分比填充");

check("进度条只在有真实数据时显示（null 不显示 0%）",
  /if \(pg && Number\.isFinite\(pg\.pct\)\)/.test(wbViewC),
  "显示 0% 比不显示更糟 —— 会让人以为卡住");

check("宽度不在 :root 上声明 --ac-follow-w",
  /**
   * 实测：:root { --ac-follow-w: var(--dsh-composer-card-max-width, 100%) }
   * 会在 :root 那一层把 var() 求值成 100%（因为 :root 没有 DSH 那个变量），
   * 然后作为已解析字面量继承下去 ⇒ 后代永远拿不到真正的宽度。
   */
  !/:root\s*\{[^}]*--ac-follow-w/.test(cssC),
  "CSS 变量在声明它的元素上解析，:root 取不到 viewArea 的变量");

check("宽度有 DSH 变量作为最终回落",
  /var\(--ac-follow-w,\s*var\(--dsh-composer-card-max-width/.test(editorHostC),
  "JS 写的 --ac-follow-w 可能还没生效，必须能直接取 DSH 变量");

check("--ac-follow-w 用 MutationObserver 补设（元素重建后仍生效）",
  /**
   * 第一版用 setInterval 补一次就 clearInterval ⇒
   * 切 tab 回来组件重建，新元素没有 inline style，宽度永远卡满宽。
   * 实测：切换后 inlineFollow="(未设置)"，宽 1633 一直不恢复。
   */
  /MutationObserver/.test(editorIndexC) && /--ac-follow-w/.test(editorIndexC),
  "定时器补一次就停 = 元素重建后失效");

check("导入上传字段是 filename + base64",
  /**
   * 实测三个组合（19499）：
   *   {name, mime, data}     → 400 缺 filename
   *   {filename, mime, data} → 400 缺 base64
   *   {filename, base64}     → 200 {"ok":true,"id":"input:wb_xxx.png"}
   */
  /filename:\s*file\.name/.test(code(ops)) && /base64,\s*\n/.test(code(ops)) &&
  (() => {
    const c = code(ops);
    /**
     * ★ 只检查 upload 的 body 段。
     *   不能全局搜 name: file.name —— 下面 _insertAsset 的参数里也有一处
     *   name: file.name（那是合法的），第一版全局搜导致假红。
     */
    const body = c.match(/JSON\.stringify\(\{([\s\S]{0,300}?)data|JSON\.stringify\(\{([\s\S]{0,300}?)\bsrc|filename:/);
    const hasFilename = /filename:\s*file\.name/.test(c);
    const hasBase64 = /base64,/.test(c);
    /* 上传段里不能出现 name: file.name（那是旧写法） */
    const upSeg = c.slice(c.indexOf("/comfy-assets/upload"), c.indexOf("/comfy-assets/upload") + 700);
    return hasFilename && hasBase64 && !/\bname:\s*file\.name/.test(upSeg);
  })(),
  "服务端只认 filename + base64");

check("导入失败会显示到界面（不是只 console.warn）",
  /setActionError/.test(editorHostC) && /ac-action-error/.test(tabC),
  "静默失败比报错更糟 —— 用户不知道是没选上还是功能坏了");


check("工作台用同一个底部间距",
  (() => {
    const p = path.join(HERE, "src", "WorkbenchView.js");
    if (!fs.existsSync(p)) return false;
    return /padding:\s*"0 0 16px"/.test(code(fs.readFileSync(p, "utf8")));
  })());

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

/* ══ ⑮ 设置页 · ComfyUI 与环境（2026-10-23）═══════════════════════ */
/**
 * 主人：「需要增加一个模型配置页面，填模型放置目录，comfy ui目录，
 *        然后模型需求清单列出来让用户去下载」
 */
const comfySettingsC = code(fs.readFileSync(path.join(HERE, "src", "editor", "ComfySettings.js"), "utf8"));
const editorIndexC2 = code(fs.readFileSync(path.join(HERE, "src", "editor", "index.js"), "utf8"));

check("设置页已注册到 settings.section",
  /settings\.section/.test(editorIndexC2) && /comfy-environment/.test(editorIndexC2),
  "id=comfy-environment，order 50 排在快捷键之前");

check("设置页有三个路径输入框",
  /label: "ComfyUI 安装目录"/.test(comfySettingsC) &&
  /label: "输出目录（产物写到哪）"/.test(comfySettingsC) &&
  /label: "输入目录（上传的素材写到哪）"/.test(comfySettingsC));

check("保存失败会显示错误（不静默）",
  /catch \(e\) \{[\s\S]{0,200}保存失败/.test(comfySettingsC),
  "用户以为存上了但没存是最糟的");

check("配置存放位置会显示给用户",
  /info\.path/.test(comfySettingsC),
  "尤其是 fallbackToTmp / mayBeWrongProfile 两种情况必须说出来");

check("体检会同时查 health 与模型清单",
  /j\("\/health"\)/.test(comfySettingsC) && /j\("\/models\/required"\)/.test(comfySettingsC));

check("模型清单区分「已找到」与「判断不了」",
  /**
   * ★ ComfyUI 没开时 found 全为 null —— 不能当成「缺失」，
   *   否则会把「没开 ComfyUI」误报成「缺模型」。
   */
  /unknown/.test(comfySettingsC),

  "found===null 是判断不了，不是缺失");

/**
 * ★★ 2026-10-23：设置页必须有「模型放置目录」
 *   主人原话：「需要增加一个模型配置页面，填模型放置目录，comfy ui目录，
 *             然后模型需求清单列出来让用户去下载」
 *   前两版只做了 comfyPath/outputDir/inputDir，把模型目录漏了。
 */
check("设置页有「模型放置目录」字段",
  /label: "模型放置目录（models 根目录）"/.test(comfySettingsC) &&
  /modelsDir/.test(comfySettingsC),
  "模型是换机器时最大的门槛（H3 主模型 19.5GB），这一项不能漏");

/* ══ ⑯ 去敏：生产代码不许有本机硬编码路径（2026-10-23）═════════════ */
/**
 * 为什么需要这条
 *   D2/D3 要求「改掉所有硬编码绝对路径」。
 *   我第一轮以为改完了，复查发现生产代码里还有 8 处：
 *     asset-scan.js   DEFAULT_WS_ASSETS / DEFAULT_STATE
 *     lib/index.js    DEFAULT_WORKFLOWS_DIR / REPO_ROOT 白名单 /
 *                     TMP_ROOT / ffmpeg / python / whisper 模型
 *   ⇒ 换机器时这些都是死路径。
 *
 * ★ 判据：只扫【生产代码】（lib/ 与 src/），不扫测试脚本 ——
 *   测试脚本用本机素材是合理的（它们本来就要读真实产物）。
 *   但生产代码一旦写死路径，插件就不可移植。
 */
const PROD_DIRS = ["lib", "src"].map((d) => path.join(HERE, d));
const HARDCODED = /C:\\\\Users|C:\/Users|D:\\\\主工作区|D:\/主工作区|D:\\\\Comfy-Desktop|D:\/Comfy-Desktop/;

check("生产代码里没有硬编码的本机绝对路径",
  (() => {
    const bad = [];
    for (const dir of PROD_DIRS) {
      if (!fs.existsSync(dir)) continue;
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) { walk(full); continue; }
          if (!/\.(m?js)$/.test(e.name) || /\.bak/.test(e.name)) continue;
          /* client.js 是构建产物，源码在 src/，由上面统一覆盖 */
          if (e.name === "client.js" && d.endsWith("lib")) continue;
          /**
           * ★ 剥注释要按【整块】剥，不能只看行首。
           *
           *   而且 split 的分隔符必须是真换行 —— 第一版写成 "\\n"（字面量），
           *   整个文件被当成一行，行号永远 1，于是把注释里的历史记录
           *   也当成残留，产生 4 条假红。
           *   AGENTS §7.5 记过同款：判「代码里有没有 X」必须先把注释剥掉。
           */
          const src = fs.readFileSync(full, "utf8");
          const codeOnly = src
            .replace(/\/\*[\s\S]*?\*\//g, "")   // 块注释（含结尾行）
            .replace(/^\s*\/\/.*$/gm, "");      // 行注释
          const codeLines = codeOnly.split("\n");
          codeLines.forEach((ln, i) => {
            if (HARDCODED.test(ln)) bad.push(`${full.replace(HERE, "")}:${i + 1}`);
          });
        }
      };
      walk(dir);
    }
    if (bad.length) console.log("     硬编码残留：" + bad.slice(0, 5).join(", "));
    return bad.length === 0;
  })(),
  "换机器时这些是死路径 ⇒ 插件不可移植");

/* ══ ⑰ 一键体检五项覆盖（E3，2026-10-23）═════════════════════════ */
/**
 * 主人要求：「一键体检：ComfyUI 目录对不对、模型齐不齐、
 *            ffmpeg 在不在、端到端探活」
 *
 * ★ 之前设置页的「体检」只查 /health 和 /models/required 两项，
 *   目录有效性与 ffmpeg 完全没覆盖 —— 配错了只能靠猜。
 */
const bridgeIndexC = code(fs.readFileSync(path.join(HERE, "..", "dsh-comfy-bridge", "src", "index.js"), "utf8"));

check("后端有 /doctor 体检路由",
  /prefix \+ "\/doctor"/.test(bridgeIndexC));

check("体检五项齐全（目录/输出/输入/ffmpeg/模型/探活）",
  /**
   * ★★ 2026-10-23 收紧两次，两个坑都要记住
   *
   *   ① 第一版写 `includes(\`"${id}"\`)` —— 源码里还有别的 "ffmpeg" 字样，
   *      把那一项的 id 改掉后仍然通过（假绿）。
   *
   *   ② 第二版改成只认字面量 `add("id"` —— 但 outputDir / inputDir
   *      是【循环里用变量 id 传的】（`for (const [id,label,dir] of [...]) add(id,...)`），
   *      字面量根本不存在 ⇒ 误判成缺项（假红）。
   *
   *   ⇒ 两种形式都认：字面量 add("id", 或「数组里有 "id" 且函数体用 add(id,」。
   */
  (() => {
    const hasAdd = (id) =>
      new RegExp(`add\\("${id}"`).test(bridgeIndexC)
      || (bridgeIndexC.includes(`"${id}"`) && /add\(id,/.test(bridgeIndexC));
    return ["comfyPath", "outputDir", "inputDir", "ffmpeg", "models", "probe"].every(hasAdd);
  })(),
  "少一项就意味着某类问题用户查不出来");

check("目录可写是【真写一次】而不是只判 exists",
  /**
   * ★ 只判 exists 不够 —— 只读盘上的目录也存在，但写不进去。
   *   判据：必须出现 writeFileSync + unlinkSync。
   */
  /writeFileSync\(probe/.test(bridgeIndexC) && /unlinkSync\(probe\)/.test(bridgeIndexC),
  "exists 通过 ≠ 能写");

check("体检失败项给出修复建议（fix 字段）",
  /fix:/.test(bridgeIndexC) && /c\.ok === false && c\.fix/.test(comfySettingsC),
  "只说「有问题」不说「怎么修」等于没说");

check("设置页体检改走 /doctor",
  /j\("\/doctor"\)/.test(comfySettingsC),
  "否则目录与 ffmpeg 两项永远不会被检查");

check("体检三态（通过 / 失败 / 判断不了）",
  /c\.ok === true[\s\S]{0,300}c\.ok === false[\s\S]{0,300}#81858c/.test(comfySettingsC),
  "灰色 = 判断不了，不能当成失败");

/* ══ ⑱ 模型清单按作用分组（2026-10-23 主人要求）═══════════════════ */
/**
 * 主人：「然后还要根据模型作用分类吧？」
 *       「你现在弄一起，看起来也看不懂」
 *
 * ★ 关键：分类的依据必须是【工作流字段名】，不是文件名猜测。
 *   实测：按文件名猜会把 7 个 LoRA（H3_Combat_V2 / Motion_Repair_V2 …）
 *   和 taeh3.safetensors（其实是 tiny_vae）全归进「主模型」。
 *   而字段名 lora_name / unet_name / vae_name / clip_name 一次就判对。
 */
const mmC = code(fs.readFileSync(path.join(HERE, "..", "dsh-comfy-bridge", "src", "model-manifest.mjs"), "utf8"));

check("模型分类优先用工作流字段名",
  /FIELD_ROLE/.test(mmC) && /lora_name:\s*"lora"/.test(mmC) && /tiny_vae:\s*"vae"/.test(mmC),
  "按文件名猜会把 LoRA 归进主模型");

check("classifyModel 接受 fields 参数且【调用时真的传了】",
  /**
   * ★★ 2026-10-23 收紧：只测定义会假绿。
   *
   *   把调用点 `classifyModel(name, fields)` 改成 `classifyModel(name)` 后，
   *   定义还在，第一版断言照样通过 —— 但分类就退回按文件名猜了
   *   （7 个 LoRA 会被归进「主模型」）。
   *
   *   判据：必须同时断言【定义】和【传参的调用点】。
   */
  /export function classifyModel\(filename,\s*fields/.test(mmC)
  && /classifyModel\(name,\s*fields\)/.test(mmC),
  "定义了不传 = 白定义");

check("collectModelRefs 记录字段名",
  /out\.get\(s\)\.add\(fieldName\)/.test(mmC),
  "不记字段名就没法可靠分类");

check("后端返回 groups 分组汇总",
  /groups,/.test(mmC) && /byRole/.test(mmC) && /missingTotal/.test(mmC));

check("前端按 groups 分组渲染（含该放哪个目录）",
  /models\.groups/.test(comfySettingsC) && /g\.dir/.test(comfySettingsC),
  "只显示模型名不显示目录，用户不知道放哪");

check("分组显示每组缺几个",
  /g\.missing/.test(comfySettingsC));

/* ══ ⑲ transition_step 与步数冲突（2026-10-23，实测踩到）═══════════ */
/**
 * 实测事故：前端 STEPS=[4,6,8,10,15,20]，选 4 步提交后
 *   跑几十秒崩在节点 397：
 *     SelfLift: transition_step 6 out of range for 4 steps
 *     sigmas = [1.0, 0.973, 0.923, 0.8, 0.0]   ← 5 个 = 4 步
 *
 * 根因：ComfyUI 的 schema 只校验 transition_step 的 min/max（1~10000），
 *       **不校验它与总步数的关系** —— 那是节点内部的 ValueError，
 *       提交阶段完全看不出来。
 *
 * ⇒ 前端必须在提交前拦住，且判据要取自工作流本身（不能写死 6）。
 */
const wbC2 = code(fs.readFileSync(path.join(HERE, "src", "WorkbenchView.js"), "utf8"));

check("提交前校验 transition_step 与步数冲突",
  /transition_step/.test(wbC2) && /总步数必须大于它/.test(wbC2),
  "不拦的话跑几十秒才崩，用户以为卡住了");

check("校验判据取自工作流而不是写死数字",
  /**
   * ★ 2026-10-23 改判据。
   *
   *   第一版查前端源码里的 `wf["397"]?.inputs?.transition_step` ——
   *   但那个写法是错的（`mode` 未声明，且 /modes 不返回 _workflow），
   *   已改成由后端提供标量 currentMode.transitionStep。
   *   ⇒ 判据跟着挪到后端：必须从工作流里遍历取出，不能写死。
   */
  (() => {
    const s = code(fs.readFileSync(path.join(HERE, "..", "dsh-comfy-bridge", "src", "index.js"), "utf8"));
    return /node\?\.inputs\?\.transition_step/.test(s);
  })(),
  "写死 6 换个工作流就失效");

/* ══ ⑳ ComfyUI 启动必须留日志（2026-10-23，实测无日志查不了崩溃）══ */
const launcherC = code(fs.readFileSync(path.join(HERE, "..", "dsh-comfy-bridge", "src", "comfy-launcher.mjs"), "utf8"));

check("ComfyUI 启动把输出重定向到日志文件",
  /**
   * 实测：v2 跑到第 10 分钟进程退出，而 logs/comfyui.log 时间戳停在 10-18，
   *      本次运行任何输出都没留下 —— 完全无法判断崩溃原因。
   * 根因：sh.Run(cmd, 0, False) 的 0 表示隐藏窗口，同时也丢弃了 stdout/stderr。
   */
  /dsh-launch\.log|1>>|2>&1/.test(launcherC),
  "崩溃后连原因都看不到");

check("日志用追加而不是覆盖",
  />>/.test(launcherC),
  "覆盖的话只能看到最后一次启动");

/* ══ ㉑ 模型下载入口（E2 的「下载链接」部分，2026-10-23）═════════ */
/**
 * 主人原话：「模型需求清单列出来让用户去下载」
 * 目标原文：「生成清单 + 下载链接」。
 *
 * ★ 现实约束：工作流 JSON 里只有文件名，没有任何下载地址。
 *   实测 krea2-full.json 的节点 _meta 里只有「K采样器」这类中文标题。
 *   ⇒ 精确 URL 只能由人在 models-sources.json 里记。
 *   ⇒ 没记的给搜索入口，而不是编一个会 404 的 URL。
 */
const mmC2 = code(fs.readFileSync(path.join(HERE, "..", "dsh-comfy-bridge", "src", "model-manifest.mjs"), "utf8"));

check("后端解析模型来源（精确 URL 或搜索页）",
  /resolveSource/.test(mmC2) && /loadSources/.test(mmC2),
  "只给名字不给入口，用户不知道去哪下");

check("来源表读不到时不崩（返回空对象）",
  /**
   * ★ 判据：loadSources 必须用 try/catch 包住 JSON.parse，失败时 return {}。
   *   坏 JSON 是用户手写文件的常态 —— 不能让它把整个模型清单搞崩。
   *
   * ★★ 收紧两次（变异测试两次都发现假绿）：
   *   ① 第一版只测「文件里有 catch」+「有 return {}」——
   *      把 catch 换成 finally 时两者都还在，照样通过。
   *   ② 第二版测 /try{...JSON.parse...}catch{/ ——
   *      仍然假绿，因为【文件别处也有 try/catch】，正则匹配到别的去了。
   *
   *   ⇒ 必须先把 loadSources 的函数体【切出来】，在切片内判断。
   *     AGENTS §7.5：判「某处有没有 X」必须限定在那一处，不能全文搜。
   */
  (() => {
    const i = mmC2.indexOf("function loadSources");
    if (i < 0) return false;
    /* 取到下一个顶层 function 之前 */
    const rest = mmC2.slice(i);
    const end = rest.indexOf("\nfunction ", 10);
    const body = end > 0 ? rest.slice(0, end) : rest;
    return /try\s*\{[\s\S]{0,400}JSON\.parse[\s\S]{0,200}\}\s*catch\s*\{/.test(body)
      && /return \{\};/.test(body);
  })(),
  "catch→finally 后坏 JSON 会让整个模型清单崩");

check("没有映射时给 HuggingFace 搜索页而不是编 URL",
  /huggingface\.co\/models\?search=/.test(mmC2),
  "编一个 URL 会 404 或下错文件");

check("前端只在缺失时显示下载入口",
  /source && source\.url && found !== true/.test(comfySettingsC),
  "已经有文件的模型不需要下载入口");

check("前端区分「精确链接」与「去搜索」",
  /source\.kind === "exact"/.test(comfySettingsC));

check("仓库根有 models-sources.json 示例",
  fs.existsSync(path.join(HERE, "..", "..", "models-sources.json")),
  "没有示例的话用户不知道有这么个机制");

/* ══ ㉒ 部署自动化：ffmpeg 安装脚本（2026-10-23）═══════════════════ */
/**
 * 为什么需要这条
 *   ffmpeg 有 83.58MB，被 .gitignore 排除了（不进仓库）。
 *   而它是【运行时必需】的：剪辑台导出、字幕烧制、抽帧、音轨处理全要它。
 *   ⇒ clone 下来的人没有它，导出功能直接报「找不到 ffmpeg」。
 *
 * ★ 这条断言是我发现 README 承诺了一个不存在的脚本后补的 ——
 *   README 里写「或用 scripts/install-ffmpeg.mjs」，但那个文件当时根本没写。
 *   文档承诺了功能就必须有对应实现，否则用户按文档走会撞墙。
 */
const REPO_ROOT = path.join(HERE, "..", "..");
const ffInstaller = path.join(REPO_ROOT, "scripts", "install-ffmpeg.mjs");

check("ffmpeg 安装脚本存在", fs.existsSync(ffInstaller),
  "README 承诺了它，缺了用户按文档走会撞墙");

check("安装脚本支持 --check（只检查不下载）",
  fs.existsSync(ffInstaller)
  && /--check/.test(fs.readFileSync(ffInstaller, "utf8")),
  "装之前先能判断要不要装");

check("安装脚本会真的验证装完能不能跑",
  (() => {
    if (!fs.existsSync(ffInstaller)) return false;
    const s = fs.readFileSync(ffInstaller, "utf8");
    /**
     * ★ 只判 exists 不够 —— 下载不完整时文件也在，但跑不起来。
     *   判据：必须有跑 `-version` 看退出码的动作。
     */
    /**
     * ★ 收紧（变异测试发现假绿）：
     *   第一版只测 /-version/ —— 但注释里也有 "-version" 字样，
     *   把实际参数改成 --help 后注释还在，断言照样通过。
     *   必须匹配【调用形式】：execFileSync(file, ["-version"]
     */
    return /execFileSync\([^,]+,\s*\[\s*"-version"\s*\]/.test(s);
  })(),
  "exists 通过 ≠ 能跑");

check("安装脚本指向包内 bin 目录（与运行时回落顺序一致）",
  (() => {
    if (!fs.existsSync(ffInstaller)) return false;
    const s = fs.readFileSync(ffInstaller, "utf8");
    return /dsh-editor["\x27,\s]+["\x27]bin/.test(s) || /packages["\x27,\s]+["\x27]dsh-editor/.test(s);
  })(),
  "装到别处运行时找不到");

check("README 的 ffmpeg 说明与实际脚本一致",
  (() => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    return /scripts\/install-ffmpeg\.mjs/.test(readme) && fs.existsSync(ffInstaller);
  })(),
  "文档提到的东西必须真的存在");

/* ══ ㉓ 前端不许引用未声明的变量（2026-10-23，实测踩到）═══════════ */
/**
 * 实测事故：我给 onGenerate 加「步数太小」校验时写了 `mode?._workflow`，
 *   而本组件里工作流对象叫 `currentMode` —— `mode` 根本没声明。
 *
 *   表现：点「生成」毫无反应。不报错、不发请求、按钮不变。
 *   页面上抓到的异常是：ReferenceError: mode is not defined
 *   onGenerate 在第一个 await 之前就抛了，被外层 try/catch 吞成 setError。
 *
 * ★ 为什么难发现：可空链 `?.` 只防「值是 null/undefined」，
 *   **防不住「变量根本没声明」** —— 未声明会直接抛 ReferenceError。
 *   这类错误 IDE 能查，但写的时候很容易以为「有 ?. 就安全」。
 *
 * ★ 判据：扫 WorkbenchView 里所有 `xxx?._workflow` / `xxx.transitionStep`，
 *   左边的名字必须是组件里真实声明过的。
 */
const wbSrc = fs.readFileSync(path.join(HERE, "src", "WorkbenchView.js"), "utf8");
const wbCode = code(wbSrc);

check("步数校验用 currentMode.transitionStep（不是未声明的 mode）",
  /currentMode\?\.transitionStep/.test(wbCode),
  "第一版写成 mode?._workflow，直接 ReferenceError，点生成毫无反应");

check("不许再出现裸 mode?._workflow 引用",
  /**
   * ★ 只查 `mode?._workflow` 这种精确形式 ——
   *   组件里 applyDefaults(mode) 的形参 legitimately 叫 mode，不能误伤。
   */
  !/(?<![A-Za-z_$])mode\?\._workflow/.test(wbCode),
  "可空链防不住「变量未声明」");

check("后端 /modes 提供 transitionStep（前端不再依赖 _workflow）",
  (() => {
    const s = code(fs.readFileSync(path.join(HERE, "..", "dsh-comfy-bridge", "src", "index.js"), "utf8"));
    return /transitionStep:/.test(s) && /transition_step/.test(s);
  })(),
  "_workflow 有 15KB+，没必要每次进页面都传");

check("transitionStep 是从工作流现取而不是写死数字",
  (() => {
    const s = code(fs.readFileSync(path.join(HERE, "..", "dsh-comfy-bridge", "src", "index.js"), "utf8"));
    /* 必须是遍历 inputs.transition_step 取出来的 */
    return /node\?\.inputs\?\.transition_step/.test(s);
  })(),
  "写死 6 换个工作流就失效");

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










