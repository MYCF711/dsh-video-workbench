/**
 * verify-no-english-src.mjs · 全量漏翻扫描（源码，不看 DOM）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么之前漏了
 *
 * 我先前只查了 4 个属性：aria-label / title / placeholder / alt，
 * 外加 label= 与 tooltip=。结果主人一连指出三批漏网：
 *   · Split right（tooltip=，后来补上）
 *   · Blur / Colors / Pattern craft / Syntax UI（直接写在 JSX 里）
 *   · 素材形状名 Square / Circle / Triangle（数据源里的 name 字段）
 *
 * ⇒ 教训：**不要靠「猜哪些属性会有文案」**。用户可见文案可能出现在
 *   ① 属性：aria-label / title / placeholder / alt / label / tooltip / description
 *   ② JSX 文本节点：<SectionTitle>Blur</SectionTitle>
 *   ③ 数据源：{ id:"colors", title:"Colors" }、name:"Square"
 *   ④ 常量表：TABS = [{ label: "Assets" }]
 *   这四类必须一起扫，漏一类就漏一批。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这个脚本做什么
 *
 * 扫上游 src 下所有 .ts/.tsx，按上面四类提取「疑似用户可见文案」，
 * 过滤掉代码标识符（import/className/type/id/style 值等），
 * 输出仍需翻译的清单。
 *
 * ★ 它不做自动修复，只负责「不漏」。改文案要人（或我）逐个判断语义。
 *
 * 用法：
 *   node verify-no-english-src.mjs            列出所有候选
 *   node verify-no-english-src.mjs --strict   有候选就退出码 1（进 CI 用）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = "D:/主工作区/_upstream/artcraft-demo/video-editor/src";

/**
 * ★ 2026-10-21 修：这个脚本缺了 findings 的定义 —— 它一直跑不起来。
 *
 *   报错：ReferenceError: findings is not defined
 *         at pushIfEnglish (verify-no-english-src.mjs:185)
 *
 *   为什么一直没发现：它【从未登记进 verify-all.mjs】。
 *   这正是 AGENTS §6.44a 记过的那条 ——
 *     「未登记进总验收的脚本 = 心理安慰」，漏的里面可能一直在失败。
 *
 *   ⇒ 补定义，并登记进 verify-all。
 */
const findings = [];

/* ── 白名单：翻译后会更糟的英文 ───────────────────────────────── */
const WHITELIST_WORDS = new Set([
  // 品牌与格式
  "ComfyUI", "DSH", "DeepSeek", "Harness", "ArtCraft", "OpenCut",
  "MP4", "WebM", "MOV", "MKV", "AVI", "PNG", "JPEG", "JPG", "GIF", "WebP", "SVG",
  "H.264", "H264", "VP9", "HEVC", "AV1", "AAC", "MP3", "WAV", "OPUS",
  "Chrome", "Safari", "Edge", "Firefox",
  // 单位
  "fps", "FPS", "px", "KB", "MB", "GB", "ms", "Hz",
  // 本项目有意保留的品牌名（画幅预设 / 渐变风格名）
  "Square", "Plus",
  // 代码里当文案用的技术标识（已在别处中文化，这里放过）
  "Timeline",
]);

/* 允许的整体模式 */
const WHITELIST_PATTERNS = [
  /^\d{2}:\d{2}(:\d{2}(:\d{2})?)?$/,
  /^\d+:\d+$/,
  /^\d+(\.\d+)?%$/,
  /^\d+(\.\d+)?\s*(fps|ms|px|KB|MB|GB)$/i,
  /^\.[a-z0-9]{2,4}$/i,
  /^[\d\s.×x/-]+$/,
  /^[×x]$/,
  /**
   * ★ 2026-10-21 补：多行 "throw new Error(...)" 的【续行】。
   *
   *   实测最后一处是 EditorProvider.tsx:46 的第二行：
   *     throw new Error(
   *       "useEditorAdapters must be used inside <EditorProvider>. " +
   *       "Mount your <VideoEditor> below an <EditorProvider>.",   ← 命中这里
   *     );
   *   第一行有 `Error(`，但第二行只剩一段字符串，我的「同行为 Error( 就跳过」
   *   那条规则够不着它。
   *
   *   ⇒ 用「这是纯字符串续行」的特征来判：
   *     整行只由 + 连接的字符串字面量构成（没有 JSX 标签、没有属性赋值）。
   *     真正的 UI 文案几乎不会长这样 —— 它总在某个标签或属性里。
   */
  /^\s*"[^"]{0,120}"\s*\+\s*$/,
  /^\s*"[^"]{0,120}",?\s*$/,
];

const isWhitelisted = (s) => {
  if (WHITELIST_WORDS.has(s)) return true;
  return WHITELIST_PATTERNS.some((re) => re.test(s));
};

/* ── 判定：这是不是「用户可见文案」而不是代码标识符 ──────────── */

/* 这些属性是用户可见的 */
const VISIBLE_ATTRS = [
  "aria-label", "title", "placeholder", "alt", "label", "tooltip",
  "description", "heading", "caption", "emptyText", "buttonText",
];

/* 这些属性值是代码标识符，不算 */
const CODE_ATTRS = new Set([
  "className", "id", "key", "type", "name", "role", "as", "variant",
  "size", "color", "style", "href", "src", "data-testid", "htmlFor",
  "value", "accept", "fill", "stroke", "d", "viewBox", "xmlns",
  "displayName", "shapeKey", "definitionId", "effectType", "sourceType",
  "projectId", "assetId", "trackId", "elementId", "mediaId", "sceneId",
  "provider", "providerId", "graphicsId", "paramKey", "presetId",
  "callback", "onClick", "onChange", "onValueChange", "onSave", "onDelete",
  "orientation", "align", "side", "position", "font", "fontFamily",
  "target", "action", "method", "encoding", "format", "mime", "ext",
]);

/* 出现在这些上下文里的字符串一定是代码，不是文案 */
const CODE_LINE_HINTS = [
  /^\s*import\b/, /^\s*export\s+(type|interface)\b/,
  /from\s+["'][^"']+["']/,
  /console\.(log|warn|error|debug|info)/,
  /throw new Error/,
  /\.displayName\s*=/,
  /typeof\s+/,
  /^\/\//, /^\s*\*/,
];

/* ── 误报排除（本轮实测的 4 类） ─────────────────────────────
   第一版扫出 114 处，其中大半是误报，必须排除，否则真问题被淹没：

   ① SVG 图标组件里的 <title>English</title>
      那是图标的可访问名称，不是界面文案；而且 icons/ui.tsx 里有
      几十个，全报出来会盖住真问题。
      判据：文件路径含 /icons/，或该行前后是 <svg / <path

   ② 代码标识符被当成 jsx-text
      如 "key.time"、"Promise"、"IDBRequest"、"below an"、"range.from && value"
      成因：我的 >...< 正则在 TS 表达式里也能匹配。
      判据：报出的内容含 . 、&& 、=> 、( ) 、[ ] 等非文案字符

   ③ 数据表的键值被误当文案
      如 { type: "button" }、{ id: "colors" }
      判据：已经是 CODE_ATTRS 里的键就不看（已实现），
            另加：值全是小写且无空格（像标识符）

   ④ className 里的 Tailwind 片段
      如 "p-0"
    */
const isLikelyCodeFragment = (s) => {
  if (/[.()[\]{}<>=&|;]/.test(s)) return true;       // 含代码符号
  if (/^[a-z][a-z0-9-]*$/.test(s) && s.length < 12) return true;  // 纯小写短标识
  if (/^[A-Z][a-zA-Z]*$/.test(s) && s.length < 8) return true;    // 单个驼峰词，多半是类型名
  if (/^\d/.test(s)) return true;                    // 数字开头

  /**
   * ★ 2026-10-21 补两条（修 findings 未定义后才跑起来，暴露出 4 个误报）
   *
   * ① TS 继承/实现关键字开头 —— 一定是类型声明不是文案
   *      "extends BoxSelectionSnapshot"
   *      "extends BaseNode"
   *    实测这两条来自 `interface X extends Y {`，被 ②JSX 文本的正则误抓。
   *
   * ② 单个「库里类型名」形态 —— 全大写开头 + 无空格 + 长度 > 8
   *      "IDBRequest"
   *    实测来自 `run: (store) => IDBRequest<T> | void`，
   *    提取时 `<>` 被剥掉，剩下裸类型名。
   *    ★ 不能简单扩大「驼峰词」那条的阈值（会把 Spotlight 这类真文案也吞掉），
   *      所以按「像库名」的特征来判：
   *      含 IDB / HTML / SVG / URL / API 这类全大写缩写。
   */
  if (/^(extends|implements|interface|type|declare)\b/.test(s)) return true;
  if (!/\s/.test(s) && /^[A-Z][A-Za-z]*(IDB|HTML|SVG|URL|API|DOM|CSS|JSON|HTTP|File|Request|Response|Event|Element|Node|Store|Mode|State|Ref|Props|Snapshot|Transaction)[A-Za-z]*$/.test(s)) return true;

  return false;
};

function scanFile(file) {
  const isIconFile = /[\\/]icons[\\/]/.test(file);
  const src = fs.readFileSync(file, "utf8");
  // 去注释（保留行号）
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const lines = noBlock.split(/\r?\n/);

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    // 跳过明显的代码行（但同一行可能既有代码又有 JSX 属性，所以只看显著特征）
    const isCodeLine = CODE_LINE_HINTS.some((re) => re.test(line));

    /* ① 可见属性：attr="英文" 或 attr={'英文'} */
    for (const attr of VISIBLE_ATTRS) {
      const re1 = new RegExp(`${attr}="([^"]*)"`, "g");
      for (const m of line.matchAll(re1)) pushIfEnglish(m[1], attr, line, lineNo, file, isIconFile);
      const re2 = new RegExp(`${attr}=\\{'([^']*)'\\}`, "g");
      for (const m of line.matchAll(re2)) pushIfEnglish(m[1], attr, line, lineNo, file, isIconFile);
      const re3 = new RegExp(`${attr}=\\{\`([^\`]*)\`\\}`, "g");
      for (const m of line.matchAll(re3)) pushIfEnglish(m[1], attr, line, lineNo, file, isIconFile);
    }

    /* ② JSX 文本节点：>英文< —— 只在非代码行做，且排除 icon 文件 */
    if (!isCodeLine && !isIconFile) {
      for (const m of line.matchAll(/>\s*([A-Za-z][A-Za-z0-9 '&.,!?-]{2,40})\s*</g)) {
        pushIfEnglish(m[1], "jsx-text", line, lineNo, file, isIconFile);
      }
    }

    /* ③ 数据源里的 title/label/heading/text 字段 */
    for (const m of line.matchAll(/\b(title|label|heading|text|emptyText|buttonText):\s*"([^"]{2,40})"/g)) {
      pushIfEnglish(m[2], `data:${m[1]}`, line, lineNo, file, isIconFile);
    }
  });
}

function pushIfEnglish(raw, kind, line, lineNo, file, isIconFile) {
  const val = String(raw).trim();
  if (!val) return;
  // 必须含字母
  if (!/[A-Za-z]/.test(val)) return;
  // 整串白名单
  if (isWhitelisted(val)) return;
  // 代码片段
  if (isLikelyCodeFragment(val)) return;
  // 逐词检查：全部词都白名单就放过
  const words = val.match(/[A-Za-z][A-Za-z.']*/g) ?? [];
  const bad = words.filter((w) => !isWhitelisted(w));
  if (bad.length === 0) return;
  // 至少要有 2 个字母的词，单个字母不算
  if (bad.every((w) => w.length < 2)) return;

  /**
   * ★ 2026-10-21 补：开发者报错信息不算漏翻。
   *
   *   实测最后一处"漏翻"是 EditorProvider.tsx:46
   *     throw new Error(
   *       "useEditorAdapters must be used inside <EditorProvider>. " +
   *       "Mount your <VideoEditor> below an <EditorProvider>.",
   *     );
   *   这是【编程错误】的提示 —— 只有当开发者用错了 API 才会抛，
   *   终端用户永远看不到。翻译它没有意义（反而会降低可搜索性）。
   *
   *   判据：原始行里有 `Error(` 或 `console.`。
   *   ★ 这与「用户可见文案」的界线很清楚：
   *     用户看得见 ⇒ 要翻；只有开发者看得见 ⇒ 不翻。
   */
  if (/\b(?:new\s+)?(?:Error|TypeError|RangeError)\s*\(/.test(line)) return;
  if (/\bconsole\.(?:warn|error|log|info|debug)\s*\(/.test(line)) return;

  /**
   * ★ 续行也算（同一条 throw 被拆成多行字符串时，续行里没有 Error(）。
   *   实测 EditorProvider.tsx:46 就是这种情况：
   *     throw new Error(
   *       "A... . " +
   *       "Mount ... below an <EditorProvider>.",   ← 提取出 "below an"
   *     );
   *   判据：整行只由 + 连接的字符串字面量构成（没有 JSX 标签、没有属性赋值）。
   *   真正的 UI 文案几乎不会长这样 —— 它总在某个标签或属性里。
   */
  if (/^\s*"[^"]{0,200}"\s*(?:\+\s*)?,?\s*$/.test(line)) return;

  findings.push({
    file: file.replace(UPSTREAM, "").replace(/^[\\/]/, ""),
    line: lineNo,
    kind,
    src: val.slice(0, 50),
    bad: bad.slice(0, 5).join(", "),
    raw: line.trim().slice(0, 90),
  });
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (/^(__tests__|node_modules|\.git)$/.test(e.name)) continue;
      walk(p);
    } else if (/\.(tsx|ts)$/.test(e.name)) {
      if (/\.bak/.test(e.name)) continue;
      scanFile(p);
    }
  }
}

if (!fs.existsSync(UPSTREAM)) {
  console.error(`  ✗ 找不到上游源码：${UPSTREAM}`);
  process.exit(2);
}

walk(UPSTREAM);

/* ── 汇总 ─────────────────────────────────────────────────────── */

// 按「文案 + 文件」去重
const uniq = new Map();
for (const f of findings) {
  const k = `${f.file}|${f.kind}|${f.src}`;
  if (!uniq.has(k)) uniq.set(k, f);
}
const list = [...uniq.values()];

const byFile = new Map();
for (const f of list) {
  const arr = byFile.get(f.file) ?? [];
  arr.push(f);
  byFile.set(f.file, arr);
}

console.log("");
if (list.length === 0) {
  console.log("  ✓ 漏翻扫描（源码）：0 处非白名单英文");
  process.exit(0);
}

console.log(`  ⚠ 漏翻扫描（源码）：${list.length} 处待确认（${byFile.size} 个文件）\n`);
for (const [file, arr] of [...byFile.entries()].sort()) {
  console.log(`  ${file}`);
  for (const f of arr.slice(0, 10)) {
    console.log(`    L${f.line}  [${f.kind}]  "${f.src}"   未白名单：${f.bad}`);
  }
  if (arr.length > 10) console.log(`    …还有 ${arr.length - 10} 处`);
  console.log("");
}

console.log("  ── 白名单（翻译后更糟，保留原文）──");
console.log("    " + [...WHITELIST_WORDS].join(" · "));
console.log("");

const strict = process.argv.includes("--strict");
process.exit(strict ? 1 : 0);
