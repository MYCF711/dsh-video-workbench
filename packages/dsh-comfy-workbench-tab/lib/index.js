/**
 * Host loader entry for dsh-comfy-workbench-tab.
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么 host 侧不再「无行为」
 *
 * 主人原话：「图片不能打开，不能保存」。
 *
 * 实测根因（2026-10-18，node fetch 直测 8188，非浏览器）：
 *   GET  http://127.0.0.1:8188/api/view?...                    → 200
 *   GET  同上 + Origin: http://127.0.0.1:19499                 → 403
 *   OPTIONS 同上（preflight）                                   → 403
 *   GET  同上 + Origin: http://127.0.0.1:8188（同源）           → 200
 *
 *   ⇒ ComfyUI 的 aiohttp 对【带 Origin 的跨源请求】一律 403。
 *   ⇒ <img src> 是 no-cors 模式（不带 Origin，也读不到响应）→ 图能看。
 *   ⇒ <a download href="http://127.0.0.1:8188/..."> 跨源时 download 属性
 *      被浏览器直接忽略，点了只会把工作台导航走 —— 这不是「保存」。
 *   ⇒ 必须由【同源】吐出这些字节。
 *
 * 归谁做：M2 自己的 host 侧。理由：
 *   · 硬约束「不改 dsh-comfy-bridge」—— 该包完全不知道这个路由存在；
 *   · 路由归 M2，画布资产也归 M2，一个房间管一块。
 * 端点：GET /comfy-assets/view?filename=&subfolder=&type=[&download=1]
 *   download=1 → 加 Content-Disposition: attachment，浏览器直接落盘。
 *   不带 → 内联（便于将来 <img> 同源化，避开跨源限制）。
 * ══════════════════════════════════════════════════════════════════════
 */

export const name = "dsh-comfy-workbench-tab-host";

/**
 * ★ 写的是【服务名】不是包名（AGENTS.md §3.1）。
 *   不声明就直接访问 ctx.webServer 会抛
 *   `cannot get property "webServer" without inject`。
 */
export const inject = ["webServer", "llm", "tools"];

/**
 * 全局资产库的 host 侧（2026-10-18）。
 * 一个文件一个房间：扫描/合并/状态全在 asset-scan.js，
 * 这里只做路由与参数校验。它挂了不影响 /comfy-assets/view 那条老路。
 */
import {
  createStateStore, scanMediaRoot, mergeLibrary, statsOf, filterItems,
  comfyRoots, moveToTrash, kindOf, loadCharacterTags, setCharacterTag,
} from "./asset-scan.js";

const ROUTE = "/comfy-assets";
const ALLOWED_TYPES = new Set(["output", "temp", "input"]);

/**
 * 路径工具。用一个顶部 import 拿 node:path，
 * 免得每个 handler 里再 await import（那会让判断函数变 async，
 * 而白名单判定必须是同步的、一眼看得懂）。
 */
import nodePath from "node:path";
/* ★ 2026-10-23：URL → 本地路径必须用它（.pathname 不解码中文路径）。 */
import { fileURLToPath } from "node:url";
const path_resolve = (...segs) => nodePath.resolve(...segs);
const path_sep = () => nodePath.sep;

/**
 * 工作流目录的默认落点。
 *
 * ★★ 2026-10-23 去敏：不再写死 "<WORKSPACE>/.../dsh-comfy-bridge/workflows"
 *
 *   原来写死绝对路径 ⇒ 包换位置就找不到工作流（modes 为空、生成全失败）。
 *
 *   现在从本模块位置推：<packages 目录>/dsh-comfy-bridge/workflows
 *   与 M1 的 WORKFLOWS_DIR 指向同一个地方，只是从 M2 过来要跨一个包目录。
 *
 *   ★ 必须用 fileURLToPath —— .pathname 不做 percent-decoding，
 *     包路径含中文时会变成 %E4%B8%BB... 找不到目录（dsh-editor 已踩过）。
 */
const DEFAULT_WORKFLOWS_DIR = (() => {
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const pkg = nodePath.resolve(here, "..");
  const packagesDir = nodePath.resolve(pkg, "..");
  return nodePath.join(packagesDir, "dsh-comfy-bridge", "workflows");
})();

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

/**
 * 只放行「ComfyUI 自己产出的文件」这一种取值。
 * 拒绝 .. 与绝对路径 —— 代理不能变成任意文件读取。
 */
function safeSeg(s) {
  const v = String(s ?? "");
  if (v.includes("..")) return null;
  if (/^[\\/]/.test(v)) return null;
  if (/[\x00-\x1f]/.test(v)) return null;
  return v;
}

/**
 * 用 LLM 给资产起一个中文名。
 *
 * 探针实测的调用链（native 函数读不到签名，靠试错确认）：
 *   llm.prepareCall({ provider, model }) → { config, stream, ... }
 *   call.stream(...)                      → 真正调模型
 *
 * ★ 为什么起名这种小事也值得单独一条路由：
 *   主人原话「命名可以让 llm 来起一个默认名，用户做最后把关确认」。
 *   规则起名（suggestName）只能把 wb_ref_image_0_xxx 变成 "ref image 0"，
 *   而起个「藤蔓木门逆光」这种名字必须看图 —— 那是模型的活。
 */
async function suggestNameByLLM({ llm, args }) {
  if (!llm || typeof llm.stream !== "function") {
    return { ok: false, error: "本机没有可用的 LLM 服务" };
  }

  const provider = String(args?.provider ?? "deepseek-official");
  const model = String(args?.model ?? "deepseek-flash");
  const filename = String(args?.filename ?? "").trim();
  const kind = String(args?.kind ?? "image");
  const hint = String(args?.hint ?? "").trim();

  if (!filename) return { ok: false, error: "缺 filename" };

  const kindZh = { image: "图片", video: "视频", audio: "音频", text: "文本" }[kind] ?? "素材";
  const sys = "你是视频素材命名助手。只输出一个中文名字，不超过 12 个字，不要引号、不要标点、不要解释。";
  const user = [
    `这是一段${kindZh}素材，原始文件名是「${filename}」。`,
    hint ? `补充信息：${hint}` : "",
    "请起一个能让人一眼看出内容的中文名字。",
  ].filter(Boolean).join("\n");

  try {
    /**
     * ★★★ 2026-10-21 定稿：llm.stream 是正确入口
     *
     *   踩过的三个坑（都记下来，免得以后重复）：
     *     ① prepareCall() 无参        → reading 'provider'
     *     ② prepareCall({provider})   → invalid exact model metadata
     *     ③ call.stream(任何参数)     → "config changed before adapter dispatch"
     *        —— 8 种形状（prompt/input/text/content/messages/system+prompt/数组）全报这个错
     *        ⇒ 说明 call.stream 是【低层】函数，config 已固定，不能再传消息
     *
     *   ✅ 正确：llm.stream({ provider, model, messages })
     *      高层接口，一次搞定，不需要 prepareCall。
     */
    /**
     * ★ 格式必须是 Anthropic Messages：content 是【块数组】，不是字符串。
     *   实测报错：content.some is not a function ← 传字符串时
     */
    const stream = await llm.stream({
      provider,
      model,
      messages: [
        { role: "user", content: [{ type: "text", text: sys + "\n\n" + user }] },
      ],
    });

    let text = "";

    let n = 0;
    for await (const chunk of stream) {
      n++;
      const t =
        typeof chunk === "string" ? chunk
        : chunk?.delta?.text ?? chunk?.text ?? chunk?.delta?.content
        ?? chunk?.content ?? chunk?.message?.content ?? "";
      if (t) text += t;
      /**
       * ★★★ 2026-10-21 修：流里的失败被「finish」chunk 吞掉，看不见
       *
       *   实测（用失效的 API key 调）：
       *     {"type":"finish","reason":{"kind":"error","failure":{
       *        "message":"Authentication Fails, Your api key: ****G1hB is invalid",
       *        "code":"AUTH","status":401}}}
       *
       *   原来的代码只取 text ⇒ 看到的是「模型返回空文本」，
       *   把「认证失败」误报成「模型没说话」。
       *   ⇒ 必须把 finish.reason.failure 里的原始错误抛出来。
       */
      if (chunk?.type === "finish" && chunk?.reason?.kind === "error") {
        const f = chunk.reason.failure ?? {};
        throw new Error(
          `LLM 调用失败：${f.message ?? "未知错误"}` +
          (f.code ? `（code=${f.code}${f.status ? `, status=${f.status}` : ""}）` : "")
        );
      }
      if (chunk?.finishReason || chunk?.done || chunk?.type === "finish") break;
    }

    // 清理：去引号、去句号、去换行、截 12 字
    let name = String(text).replace(/["'「」『』。，,.]/g, "").replace(/\s+/g, "").trim();
    if (name.length > 12) name = name.slice(0, 12);
    if (!name) return { ok: false, error: "模型返回空文本（流结束了但没有任何文本）" };

    return { ok: true, name, provider, model };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * LLM 判断资产归属哪个项目文件夹。
 *
 * 返回固定几类候选（避免模型乱造名字）：
 *   · 已存在的文件夹名（existingFolders）
 *   · 「未归类」= 不归任何项目
 *
 * ★ 让模型【从候选里选】，而不是自由生成 ——
 *   自由生成会造出「项目A」「项目 A」「A项目」这种近义名，
 *   主人的要求是「两个不相关的项目不要混在一起」，
 *   近义名反而让同类散开。
 */
async function suggestFolderByLLM({ llm, args }) {
  const filename = String(args?.filename ?? "").trim();
  const kind = String(args?.kind ?? "image");
  const hint = String(args?.hint ?? "").trim();
  const existing = Array.isArray(args?.existingFolders)
    ? args.existingFolders.filter((x) => typeof x === "string" && x.trim()).slice(0, 30)
    : [];

  if (!filename) return { ok: false, error: "缺 filename" };

  // 没有已有文件夹 ⇒ 只能用规则（让模型凭空造项目名没有意义）
  if (!existing.length) {
    return {
      ok: false,
      error: "还没有任何项目文件夹，先建一个再判断归属",
      needCreate: true,
    };
  }

  if (!llm || typeof llm.stream !== "function") {
    return { ok: false, error: "本机没有可用的 LLM 服务" };
  }

  const provider = String(args?.provider ?? "deepseek-official");
  const model = String(args?.model ?? "deepseek-flash");
  const kindZh = { image: "图片", video: "视频", audio: "音频", text: "文本" }[kind] ?? "素材";

  const sys = [
    "你是素材归档助手。根据素材文件名推断它属于哪个项目。",
    "只能从给定的候选里选一个，原样输出候选文字。",
    "如果完全看不出归属，输出「未归类」。",
    "不要解释，不要引号，不要标点。",
  ].join("");

  const user = [
    `素材：${kindZh}「${filename}」`,
    hint ? `补充：${hint}` : "",
    `候选项目：${existing.join(" / ")} / 未归类`,
    "输出你选的那一个。",
  ].filter(Boolean).join("\n");

  try {
    const stream = await llm.stream({
      provider,
      model,
      messages: [
        { role: "user", content: [{ type: "text", text: sys + "\n\n" + user }] },
      ],
    });

    let text = "";
    for await (const chunk of stream) {
      const t =
        typeof chunk === "string" ? chunk
        : chunk?.delta?.text ?? chunk?.text ?? chunk?.delta?.content
        ?? chunk?.content ?? chunk?.message?.content ?? "";
      if (t) text += t;
      // ★ 和 suggestNameByLLM 一样：finish 里的错误必须抛出来
      if (chunk?.type === "finish" && chunk?.reason?.kind === "error") {
        const fl = chunk.reason.failure ?? {};
        throw new Error(
          `LLM 调用失败：${fl.message ?? "未知错误"}` +
          (fl.code ? `（code=${fl.code}${fl.status ? `, status=${fl.status}` : ""}）` : "")
        );
      }
      if (chunk?.finishReason || chunk?.done || chunk?.type === "finish") break;
    }

    const clean = String(text).replace(/["'「」『』。，,.\s]/g, "").trim();

    // 只接受候选里的，或「未归类」
    if (clean === "未归类") {
      return { ok: true, folder: null, source: "llm", reason: "模型判断不属任何现有项目" };
    }
    const hit = existing.find((x) => x.replace(/\s/g, "") === clean);
    if (hit) {
      return { ok: true, folder: hit, source: "llm", reason: "模型从候选中选中" };
    }
    // 模型输出了候选之外的词 —— 不采信，交给规则
    return {
      ok: false,
      error: `模型输出了候选之外的内容：「${clean.slice(0, 20)}」`,
      modelSaid: clean.slice(0, 40),
    };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** 规则判断归属 —— 按文件名与文件夹名的最长公共子串打分。 */
function suggestFolderRule(filename, existing) {
  const base = String(filename ?? "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[_\-]+/g, " ")
    .toLowerCase();
  if (!existing.length) return { ok: false, error: "还没有任何项目文件夹" };

  let best = null;
  let bestScore = 0;
  for (const folder of existing) {
    const key = folder.replace(/\s/g, "").toLowerCase();
    if (!key) continue;
    // 文件名里包含文件夹名（或反过来）⇒ 强信号
    let score = 0;
    if (base.replace(/\s/g, "").includes(key)) score = key.length * 3;
    else {
      // 逐字符公共前缀/子串计分（保守，避免误判）
      for (let i = 0; i < key.length; i++) {
        const sub = key.slice(i, i + 2);
        if (sub.length === 2 && base.includes(sub)) score += 1;
      }
    }
    if (score > bestScore) { bestScore = score; best = folder; }
  }

  // 分数太低 ⇒ 不硬猜
  if (!best || bestScore < 2) {
    return { ok: true, folder: null, source: "rule", reason: "文件名看不出归属" };
  }
  return { ok: true, folder: best, source: "rule", reason: `文件名与「${best}」有重合` };
}

/**
 * 规则起名 —— LLM 不可用时的降级草稿。
 *
 * ★ 只做「把文件名变成人话」这一件事，不假装智能。
 *   Krea2-2ST-20261018_00249_.png → 「Krea2 2ST 249」
 *   wb_ref_image_0_src_abc.png     → 「图片 0」
 */
function suggestNameRule(filename, kind) {
  const raw = String(filename ?? "");
  // 去扩展名、去尾部随机后缀（_abc123 / __abc123）
  let s = raw.replace(/\.[a-z0-9]+$/i, "").replace(/[_]{2}[a-z0-9]{5,}$/i, "").replace(/_[a-z0-9]{5,}$/i, "");
  // 去日期（20261018 / 2026-10-18）
  s = s.replace(/20\d{6}/g, "").replace(/20\d{2}-\d{2}-\d{2}/g, "");
  // 下划线、连字符 → 空格
  s = s.replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
  // 压掉连续数字编号（00249 → 249）
  s = s.replace(/\b0+(\d+)\b/g, "$1");
  if (!s) {
    const kindZh = { image: "图片", video: "视频", audio: "音频", text: "文本" }[kind] ?? "素材";
    s = kindZh;
  }
  /**
   * ★ 2026-10-21 修：原来直接 slice(0,12)，把尾部编号砍掉了。
   *   实测：「Krea2-2ST-20261018_00249_.png」→ "Krea2 2ST 24"（249 变 24）
   *         「Qwen_image_2.1_00029.png」→ "Qwen image 2"（2.1 被吃）
   *   ⇒ 按【词】截断，不切断最后一个词；且上限提到 20 字
   *      （主人原话只说「用户做最后把关确认」，没要求短）。
   */
  if (s.length <= 20) return s;
  const words = s.split(" ");
  let out = "";
  for (const w of words) {
    if ((out + " " + w).trim().length > 20) break;
    out = (out + " " + w).trim();
  }
  return out || s.slice(0, 20);
}

/**
 * 从资产 id 求它在磁盘上的真实绝对路径。
 *
 * id 的格式（实测）：
 *   output:Krea2-USD-20261018_00008_.png      → <output>/Krea2-USD-...png
 *   input:wb_测试图_fkb292.png                 → <input>/wb_测试图_fkb292.png
 *   input:h3station/20261016-172913/x.png      → <input>/h3station/.../x.png（含子目录）
 *   editor:xxx                                 → 不是我们扫的目录，返回 null
 *
 * ★ 必须做路径越界检查 —— id 里的 rel 是外部数据，不能直接拼。
 */
function absPathOfId(id) {
  const s = String(id ?? "");
  const i = s.indexOf(":");
  if (i < 0) return null;
  const src = s.slice(0, i);
  const rel = s.slice(i + 1);
  if (src !== "output" && src !== "input") return null;
  if (!rel || rel.includes("..")) return null;
  const roots = comfyRoots();
  const root = roots[src];
  if (!root) return null;
  const abs = path_resolve(root, rel);
  // 越界检查：解析后必须仍在 root 之内
  if (!path_resolve(abs).startsWith(path_resolve(root))) return null;
  return abs;
}

/**
 * 把工作台标签写进图片本体。失败不影响主流程（json 已经写成功了）。
 *
 * ★ 只对 PNG 做 —— 其它格式（jpg/webp/mp4）没有对应的安全方案：
 *   · JPG 的 EXIF 要整段重编码，风险高
 *   · MP4 加 -metadata 会挤掉 ComfyUI 的 prompt 字段（实测）
 *   ⇒ 那些仍以 json 为准，如实记在返回值里。
 *
 * 返回 { written: bool, reason?: string }
 */
async function writeTagsToImage(id, tags) {
  const abs = absPathOfId(id);
  if (!abs) return { written: false, reason: "不是可定位的文件" };
  if (!/\.png$/i.test(abs)) return { written: false, reason: "非 PNG（仅 PNG 支持写本体）" };
  try {
    const fsmod = await import("node:fs");
    if (!fsmod.existsSync(abs)) return { written: false, reason: "文件不存在" };
    const mod = await import("./png-tags.mjs");
    mod.writeTextTags(abs, tags);
    return { written: true };
  } catch (e) {
    return { written: false, reason: String(e?.message ?? e) };
  }
}

/**
 * 从图片本体里清掉指定的标签 key（不动别的）。
 *
 * ★ 为什么需要单独一个函数：
 *   writeTagsToImage 是「覆盖式写」——传什么就有什么。
 *   但「清掉别名、保留 role」这个场景，如果直接把 role 传进去重写，
 *   万一 role 读出来是空（比如 json 里也没有），就会把 PNG 里的 role 也抹掉。
 *   ⇒ 明确地「只删这个 key」，比「重写一遍」安全。
 */
async function clearTagsInImage(id, keys) {
  const abs = absPathOfId(id);
  if (!abs) return { written: false, reason: "不是可定位的文件" };
  if (!/\.png$/i.test(abs)) return { written: false, reason: "非 PNG" };
  try {
    const fsmod = await import("node:fs");
    if (!fsmod.existsSync(abs)) return { written: false, reason: "文件不存在" };
    const mod = await import("./png-tags.mjs");
    const cur = mod.readTextTagsSync(abs) ?? {};
    /**
     * ★ 2026-10-21 修：不能只靠「传 keep」来删 ——
     *   writeTextTags 的 dropKeys 只来自传进去的 key，
     *   keep 里没有 alias ⇒ alias 不会被删。
     *   ⇒ 显式把 keys 传给 dropAlso。
     */
    const keep = {};
    for (const [k, v] of Object.entries(cur)) {
      if (keys.includes(k)) continue;
      if (k.startsWith("workbench_")) keep[k] = v;   // 只重写工作台自己的 key
    }
    mod.writeTextTags(abs, keep, keys);
    return { written: true };
  } catch (e) {
    return { written: false, reason: String(e?.message ?? e) };
  }
}

export async function apply(ctx, config = {}) {

  const log = ctx?.logger ?? console;
  const prefix = config.routePrefix ?? ROUTE;
  const base = config.comfyBase ?? process.env.COMFY_BASE_URL ?? "http://127.0.0.1:8188";

  /**
   * ══════════════════════════════════════════════════════════════════
   * ★★★ 2026-10-25 · 让对话框里的 LLM 能把提示词「写进工作台」
   *
   *   【主人原话】
   *     「懒人一般走这里输入需求，然后让云端 llm 根据模型匹配的 skill
   *       反推提示词，然后输入到上方的提示词框，生成。」
   *
   *   【实测断点】工作台的 setPrompt() 只有两个调用点：
   *     WorkbenchView.js:1373  从 sessionStorage 恢复
   *     WorkbenchView.js:1408  切工作流时写默认值
   *   ⇒ 没有任何外部入口。dsh-editor 的 15 个 timeline_* 工具全在时间轴上，
   *     够不到工作台的提示词框。
   *   ⇒ LLM 反推出来的提示词只能打在对话里让人手动复制粘贴。
   *
   *   【做法】给一个队列 + 两个端点：
   *     POST /comfy-assets/workbench-fill   LLM 侧（工具）写一条指令进队列
   *     GET  /comfy-assets/workbench-pending 工作台侧轮询取走（取走即清）
   *   ★ 为什么用「取走即清」而不是 SSE：
   *     这是低频事件（一次对话一两次），SSE 要长连接 + 重连 + 多标签页去重，
   *     为这点频率不值。轮询 1 秒一次，成本可忽略。
   *   ★ 为什么不做成「自动点生成」：
   *     主人 2026-10-25 明确选「填完不自动生成」——
   *     生成一次 23s~178s，跑错太贵，要留一个用眼睛扫一遍的检查点。
   * ══════════════════════════════════════════════════════════════════
   */
  const fillQueue = [];
  const FILL_TTL_MS = 5 * 60 * 1000;   // 5 分钟没被取走就作废（会话切走了）

  const dropStaleFills = () => {
    const now = Date.now();
    for (let i = fillQueue.length - 1; i >= 0; i--) {
      if (now - fillQueue[i].at > FILL_TTL_MS) fillQueue.splice(i, 1);
    }
  };


  /**
   * ══════════════════════════════════════════════════════════════════
   * ★★★ 2026-10-25 · 按需下发 ArtCraft 产物（首屏从 11.5MB 降到 ~1MB）
   *
   *   【问题】实测首屏 performance.getEntriesByType('resource')：
   *     client.js 传输 5096 KB / 解码 14559 KB
   *     其中 10.43 MB 是 ArtCraft 的 base64 payload
   *   ⇒ 而它只在【打开剪辑台那一刻】用得上。
   *     不打开剪辑台的人，每次刷新都要白下 10MB、再 atob 一遍（再吃 ~7MB 内存）。
   *
   *   【做法】把 payload / css 从打包产物里拆出来，改成这条路由按需取。
   *     前端 editorHost.js 的 ARTCRAFT_SRC 变成""（占位），
   *     真正要用时 fetch 这里拿文本。
   *
   *   【为什么不用 lib/ 静态文件】DSH 的 /plugins/?? 只服务 client.js 入口，
   *     不暴露包内任意文件（实测 /plugins/<包名>/lib/index.js → 404）。
   *     所以只能由 host 侧自己吐。
   *
   *   【安全】只允许固定的两个文件名，不接受路径。
   * ══════════════════════════════════════════════════════════════════
   */
  const ART_ASSET_DIR = nodePath.resolve(
    nodePath.dirname(fileURLToPath(import.meta.url)), "..", "src", "editor"
  );
  const ART_ASSETS = {
    "payload.js": "artcraft-payload.b64.txt",
    "css.js": "artcraft-css.b64.txt",
  };

  /**
   * 内容指纹（给 ETag 用）。
   * ★ 不用 crypto：10MB 的 sha256 每次都要算，而这里只是想让
   *   「内容变了」能反映出来，长度 + 头尾采样 + 简单累加足够。
   *   碰撞概率对「同一个文件改了一点」这种场景可以忽略。
   */
  const hashOf = (s) => {
    let h = 2166136261;
    const step = Math.max(1, Math.floor(s.length / 4096));
    for (let i = 0; i < s.length; i += step) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16);
  };

  ctx.effect(() => {
    return ctx.webServer.register({
      kind: "exact",
      path: ROUTE + "/artcraft-asset",
      handler: async (req, res) => {
        if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
        const u = new URL(req.url ?? "/", "http://x");
        const which = String(u.searchParams.get("name") ?? "");
        const file = ART_ASSETS[which];
        if (!file) {
          return json(res, 400, { error: `name 只允许 ${Object.keys(ART_ASSETS).join(" / ")}` });
        }
        const abs = nodePath.join(ART_ASSET_DIR, file);
        let text;
        try {
          /* ★ 本文件其它地方都是作用域内 await import("node:fs")，
             这里同理 —— 不在模块顶层多引一份。 */
          const fsp = await import("node:fs/promises");
          text = await fsp.readFile(abs, "utf8");
        } catch {
          /* 没准备过产物 —— 这是正常的降级态，不是错误 */
          return json(res, 404, {
            error: "ART_MISSING",
            hint: "剪辑台需要 ArtCraft 产物。在仓库根目录执行：\n" +
                  "pwsh -NoProfile -File ./scripts/fetch-artcraft.ps1",
          });
        }
        const b64 = text.trim();
        if (!b64) {
          return json(res, 404, { error: "ART_MISSING", hint: "产物文件是空的，请重新生成" });
        }
        const etag = `"${Buffer.byteLength(b64).toString(16)}-${hashOf(b64)}"`;
        /* ★ 内容没变回 304 —— 省掉 10MB 重传，但状态仍是现查的 */
        if (req.headers?.["if-none-match"] === etag) {
          res.writeHead(304, {
            "ETag": etag,
            "Cache-Control": "private, no-cache",
          });
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": Buffer.byteLength(b64),
          /**
           * ★★ 2026-10-25 实测踩到：原来写 max-age=300，结果——
           *   把产物文件删掉后，5 分钟内打开剪辑台【仍然正常渲染】，
           *   因为浏览器直接吃了缓存。使用者会以为「产物还在」，
           *   直到某次缓存过期才突然看到降级提示 —— 时序诡异、无法解释。
           *
           *   ⇒ 改成立刻过期 + ETag 协商：
           *     · 每次都向宿主确认一次（请求很小，304 只有几百字节）
           *     · 内容没变 ⇒ 304，不重传 10MB
           *     · 内容变了/被删 ⇒ 真值立刻反映出来
           *   代价是每次开剪辑台多一次 304 往返，换来「状态永远是真的」。
           */
          "Cache-Control": "private, no-cache",
          "ETag": `"${Buffer.byteLength(b64).toString(16)}-${hashOf(b64)}"`,
          "X-Content-Type-Options": "nosniff",
        });
        res.end(b64);
      },
    });
  }, "comfy-workbench-tab: artcraft asset (lazy)");

  /* ── 工作台「填入」队列：LLM 侧写，工作台侧取走 ── */
  ctx.effect(() => {
    const d1 = ctx.webServer.register({
      kind: "exact",
      path: ROUTE + "/workbench-fill",
      handler: async (req, res) => {
        if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
        let body;
        try {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          return json(res, 400, { error: "请求体不是合法 JSON" });
        }
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        if (!prompt.trim()) return json(res, 400, { error: "prompt 不能为空" });

        const item = {
          at: Date.now(),
          prompt,
          modeId: typeof body.modeId === "string" ? body.modeId : undefined,
          aspect: typeof body.aspect === "string" ? body.aspect : undefined,
          durationSec: Number.isFinite(body.durationSec) ? body.durationSec : undefined,
          seed: Number.isFinite(body.seed) ? body.seed : undefined,
          reason: typeof body.reason === "string" ? body.reason : undefined,
        };
        dropStaleFills();
        /* ★ 只保留最新一条：连点两次「按这个写」时，用户要的是最后一次 */
        fillQueue.length = 0;
        fillQueue.push(item);
        log.info?.(`[comfy-wb] 已排队填入：${prompt.slice(0, 40)}${prompt.length > 40 ? "…" : ""}`);
        return json(res, 200, { ok: true, queued: 1 });
      },
    });

    const d2 = ctx.webServer.register({
      kind: "exact",
      path: ROUTE + "/workbench-pending",
      handler: async (req, res) => {
        if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
        dropStaleFills();
        const item = fillQueue.shift();
        /* ★ 取走即清 —— 一次填入只生效一次，不重复覆盖用户已经改过的内容 */
        return json(res, 200, item ? { has: true, ...item } : { has: false });
      },
    });

    return () => { try { d1?.(); } catch { /* ignore */ } try { d2?.(); } catch { /* ignore */ } };
  }, "comfy-workbench-tab: workbench fill queue");

  /**
   * ── 工具：comfy_workbench_fill ──
   *
   *   懒人路径的最后一块拼图：
   *     对话框说需求 → LLM 按 skill 反推提示词 → 调这个工具 → 提示词出现在工作台 → 人按生成
   *
   *   ★ 不自动生成（主人 2026-10-25 选 A）：
   *     生成一次 23s~178s，跑错太贵，要留一个用眼睛扫一遍的检查点。
   *     这个工具的价值是「免去复制粘贴」，不是「免去按按钮」。
   */
  ctx.effect(() => {
    /**
     * ★ 与 dsh-editor 保持同一套取值姿势（index-host.mjs:479）：
     *   它判的是 `ctx.tools.register` 是否存在，而 defineTool 从
     *   ctx.tools.defineTool 或全局兜底拿。只看 defineTool 会漏掉
     *   「服务在、但 defineTool 挂在别的字段上」的版本差异。
     */
    if (typeof ctx?.tools?.register !== "function") {
      log.warn?.("[comfy-wb] ctx.tools.register 不可用，comfy_workbench_fill 未注册");
      return;
    }
    const defineTool = ctx.tools.defineTool ?? globalThis.__dshDefineTool;
    if (typeof defineTool !== "function") {
      log.warn?.("[comfy-wb] defineTool 不可用，comfy_workbench_fill 未注册");
      return;
    }
    log.info?.("[comfy-wb] 已注册 comfy_workbench_fill");

    const dispose = defineTool({
      name: "comfy_workbench_fill",
      description:
        "把一段写好的提示词（连同工作流/画幅/时长）填进「视频工作台」的输入框，等人按生成。" +
        "★ 这是「对话框 → 工作台」的唯一通道。用户说「帮我写个提示词」「按这个描述出图」时用它。" +
        "★ 它【不会】自动生成 —— 填完就停，让用户自己看一眼再按。生成一次几十秒到几分钟，跑错代价高。" +
        "写提示词前先看 comfy-mode-dispatch 技能判断该用哪个工作流，再看 h3-prompt-writing 技能（视频）。",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "完整提示词。视频（yz）要按 H3 规范写；生图（krea2）用自然语言描述画面。",
          },
          modeId: {
            type: "string",
            description: "工作流：krea2（生图）/ yz（生视频）/ qwen21-edit（改图）/ qwen21（生图）。省略则不改当前工作流。",
          },
          aspect: { type: "string", description: "画幅，如 16:9 / 9:16 / 1:1。省略则不动。" },
          durationSec: { type: "number", description: "时长（秒），仅 yz 有意义。省略则不动。" },
          seed: { type: "integer", description: "种子。省略则保持随机。" },
          reason: { type: "string", description: "一句话说明你为什么这么写（会显示给用户看）" },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      output: {
        schema: { type: "object" },
        render: (_a, v) => `已填入工作台（${v.modeId ?? "保持当前工作流"}），等用户按生成`,
      },
      execute: async (args) => {
        const prompt = String(args?.prompt ?? "");
        if (!prompt.trim()) throw new Error("prompt 不能为空");

        const item = {
          at: Date.now(),
          prompt,
          modeId: args.modeId,
          aspect: args.aspect,
          durationSec: Number.isFinite(args.durationSec) ? args.durationSec : undefined,
          seed: Number.isFinite(args.seed) ? args.seed : undefined,
          reason: args.reason,
        };
        dropStaleFills();
        fillQueue.length = 0;
        fillQueue.push(item);

        return {
          ok: true,
          queued: true,
          modeId: args.modeId ?? null,
          note: "已排队，工作台最多 1 秒后取走并填入输入框。没有自动生成。",
        };
      },
    });

    return () => { try { dispose?.(); } catch { /* ignore */ } };
  }, "comfy-workbench-tab: comfy_workbench_fill tool");

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "exact",
      path: prefix + "/view",
      handler: async (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return json(res, 405, { error: "method not allowed" });
        }

        const u = new URL(req.url ?? "/", "http://x");
        const filename = safeSeg(u.searchParams.get("filename"));
        const subfolder = safeSeg(u.searchParams.get("subfolder"));
        const type = String(u.searchParams.get("type") ?? "output");
        const wantDownload = u.searchParams.get("download") === "1";

        if (!filename) return json(res, 400, { error: "缺少或非法的 filename" });
        if (subfolder === null) return json(res, 400, { error: "非法的 subfolder" });
        if (!ALLOWED_TYPES.has(type)) {
          return json(res, 400, { error: `type 只允许 ${[...ALLOWED_TYPES].join("/")}` });
        }

        const target =
          `${String(base).replace(/\/+$/, "")}/api/view?` +
          new URLSearchParams({ filename, subfolder, type }).toString();

        /**
         * ★ 关键：这里【不带 Origin】发出去。
         *   实测带 Origin 会 403；不带就是 200。
         *   同时 15s 超时，避免上游挂住把 DSH 请求拖死。
         */
        let upstream;
        try {
          upstream = await fetch(target, {
            signal: AbortSignal.timeout(15000),
            headers: { Accept: "image/*,video/*,*/*" },
          });
        } catch (err) {
          return json(res, 504, { error: `ComfyUI 不可达：${err.message}` });
        }

        if (!upstream.ok) {
          return json(res, upstream.status === 404 ? 404 : 502, {
            error: `ComfyUI 返回 HTTP ${upstream.status}`,
            filename,
            type,
          });
        }

        const ctype = upstream.headers.get("content-type") ?? "application/octet-stream";
        const clen = upstream.headers.get("content-length");
        const headers = {
          "Content-Type": ctype,
          // 内容按文件名寻址，理论上可长缓存；但 temp 会被 ComfyUI 清理，
          // 所以只给短期缓存 —— 太短会让大图重复拉，太长会显示已删的图。
          "Cache-Control": "private, max-age=60",
          "X-Content-Type-Options": "nosniff",
        };
        if (clen) headers["Content-Length"] = clen;

        if (wantDownload) {
          const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
          headers["Content-Disposition"] =
            `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
        }

        res.writeHead(200, headers);

        if (req.method === "HEAD") {
          res.end();
          return;
        }

        // 流式回吐，不把几十 MB 的图整个读进内存
        try {
          const reader = upstream.body?.getReader?.();
          if (!reader) {
            res.end(Buffer.from(await upstream.arrayBuffer()));
            return;
          }
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!res.write(Buffer.from(value))) {
              await new Promise((r) => res.once("drain", r));
            }
          }
          res.end();
        } catch (err) {
          // 头已发出去了，只能粗暴结束 —— 但绝不能把异常抛给宿主
          log.warn?.(`[${name}] 传输中断 ${filename}: ${err?.message ?? err}`);
          try { res.destroy(); } catch { /* ignore */ }
        }
      },
    });

    /**
     * ★ 产物「来源角色」查询 —— 解决主人第 ② 件事：「不知道对应的是哪个的产物」
     *
     * 为什么 host 侧要开这个端点（而不是前端自己判）：
     *   实测（2026-10-18）工作流里输出节点的 filename_prefix 是
     *     node 220 → "zzz-renamed-220"
     *     node 186 → "zzz-renamed-186"
     *     node 174 → "zzz-renamed-174"
     *   它【只带节点号、不带语义】。所以「谁是二采 / 谁是美国高清重绘 /
     *   谁是 SeedVR2」这件事，前端从文件名永远推不出来。
     *
     *   唯一权威是每个工作流 bind 里的 outputs 映射，例如 krea2：
     *     { image:202, imageTwoPass:220, imageUsd:186, imageSeedvr:174 }
     *
     *   但 /comfy-bridge/modes 不返回 outputs（M1 的 handlers.modes() 只给
     *   id/label/defaults/media/toggles/caps），而硬约束是「不改 bridge」。
     *   ⇒ M2 自己的 host 侧去【只读地读一遍那个工作流目录】，
     *     把 nodeId → 角色 的映射吐给前端。桥一行不动，节点号也不写进代码。
     *
     * 拿不到就当空表 —— 前端有纯文件名兜底规则，功能不会因此坏掉。
     */
    const rolesDispose = ctx.webServer.register({
      kind: "exact",
      path: prefix + "/roles",
      handler: async (req, res) => {
        if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
        try {
          json(res, 200, await readOutputRoles(config));
        } catch (err) {
          // 读不到不是错误 —— 前端会退回文件名规则
          json(res, 200, { ok: false, modes: {}, error: String(err?.message ?? err) });
        }
      },
    });

    /* ══════════════════════════════════════════════════════════════
     * 全局资产库（主人 2026-10-18：「我需要那种全局资产库，
     *                 在提示词框中 @ 就能直接调用」）
     *
     * ── 为什么 host 侧要做这件事，前端自己扫不行 ──────────────────
     *   浏览器拿不到 ComfyUI output/ 的目录列表（没有目录 API），
     *   只有 /api/view 单文件。要「列出所有产物」只能在宿主侧读盘。
     *
     * ── 三个数据源 ────────────────────────────────────────────────
     *   ① output/  ComfyUI 产物（一采/二采/USD/SeedVR2/YZ）
     *   ② input/   用户上传（uploadImage 就落这儿）
     *   ③ editor   dsh-editor 的 /timeline/assets —— 用【自指地址】拉，
     *              拉不到就当空（那两个包是可独立装卸的，
     *              不能因为没装 editor 就让整个库 500）
     * ══════════════════════════════════════════════════════════════ */
    const stateStore = createStateStore(config.assetStateFile);
    const stLoad = stateStore.load();
    log.info?.(
      `[${name}] 资产库状态 ${stateStore.stateFile}` +
      (stLoad.ok ? `（收藏 ${stLoad.fav} / 改名 ${stLoad.alias}）` : `（${stLoad.reason}）`)
    );

    const ownPort = ctx?.webServer?.port ?? process.env.DSH_WEB_PORT ?? "19499";
    const ownBase = String(config.selfBaseUrl ?? `http://127.0.0.1:${ownPort}`).replace(/\/+$/, "");
    const editorAssetsUrl = config.editorAssetsUrl ?? `${ownBase}/timeline/assets`;

    /** 拉 dsh-editor 的素材索引。失败一律返回空数组 + 原因，绝不抛。 */
    async function readEditorAssets() {
      try {
        const r = await fetch(editorAssetsUrl, { signal: AbortSignal.timeout(6000) });
        if (!r.ok) return { items: [], reason: `HTTP ${r.status}` };
        const j = await r.json();
        const items = Array.isArray(j?.items) ? j.items : [];
        return { items, reason: null };
      } catch (err) {
        return { items: [], reason: `dsh-editor 未安装或不可达：${err?.message ?? err}` };
      }
    }

    /** 扫两棵根目录 + 拉 editor，合并成一份。每次请求现扫（数据是人工搬的）。 */
    async function buildLibrary() {
      const roots = comfyRoots();
      const [prod, up, ed] = await Promise.all([
        scanMediaRoot(roots.output, "output"),
        scanMediaRoot(roots.input, "input"),
        readEditorAssets(),
      ]);
      /**
       * ★★ 2026-10-20 角色卡桥（跨项目）：
       *   工作站（dsh-editor）已经有角色卡，标签写在 outputs/assets.json 的 tags 里：
       *     role:character / char:<名字> / view:<视角>
       *   而工作台的资产库看不到那份数据 —— 所以「@韩立」搜不到。
       *
       *   实测：两个库扫的是【同一个】ComfyUI output 目录，
       *        工作台 697 项 / 工作站 529 项 / 同名交集 517（98%）
       *        ⇒ 按 basename 对齐即可。
       *
       *   ★ 失败不影响主流程：读不到就当没有角色卡（charTags 为空）。
       *     这是「模块失效只丢那一块」的延伸。
       */
      let charTags = { byBasename: {}, stats: {} };
      try {
        charTags = loadCharacterTags();
      } catch (err) {
        charTags = { byBasename: {}, stats: { ok: false, reason: String(err?.message ?? err) } };
      }
      const merged = mergeLibrary({
        products: prod.items,
        uploads: up.items,
        editor: ed.items,
        state: stateStore,
        charTags,
      });
      return {
        items: merged,
        stats: statsOf(merged),
        sources: {
          output: { ok: true, count: prod.items.length, truncated: prod.truncated, root: roots.output },
          input: { ok: true, count: up.items.length, truncated: up.truncated, root: roots.input },
          editor: { ok: !ed.reason, count: ed.items.length, reason: ed.reason },
        },
        characters: charTags.stats,
        stateFile: stateStore.stateFile,
      };
    }

    const libDispose = ctx.webServer.register({
      kind: "exact",
      path: prefix + "/library",
      handler: async (req, res) => {
        if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
        try {
          const u = new URL(req.url ?? "/", "http://x");
          const q = u.searchParams;
          const lib = await buildLibrary();
            /**
             * ★ 2026-10-21 新增：清掉「指向已删资产」的 folder 条目。
             *
             *   实测：folder 表 8 条，7 条指向不存在的文件 ⇒
             *   项目归属的候选列表里全是幽灵文件夹。
             *
             *   ★ aliveIds 必须来自【真实扫描结果】。
             *     buildLibrary() 刚跑完，items 就是真列表，安全。
             *   ★ 节流 5 分钟：前端会轮询，不必每次都清。
             */
            try {
              const nowMs = Date.now();
              if (!globalThis.__wbLastPrune || nowMs - globalThis.__wbLastPrune > 5 * 60 * 1000) {
                globalThis.__wbLastPrune = nowMs;
                const aliveIds = lib.items.map((x) => x.id);
                const pruned = stateStore.pruneFolderOrphans?.(aliveIds) ?? 0;
                if (pruned > 0) {
                  log.info?.(`[${name}] 清掉 ${pruned} 条幽灵文件夹记录（指向已删资产）`);
                  for (const it of lib.items) it.folder = stateStore.getFolder?.(it.id) ?? null;
                }
              }
            } catch (e) {
              log.warn?.(`[${name}] 清幽灵文件夹失败：${String(e?.message ?? e)}`);
            }
          const items = filterItems(lib.items, {
            kind: q.get("kind"),
            src: q.get("src"),
            q: q.get("q"),
            favOnly: q.get("fav") === "1",
          });
          // ★ limit 只截前端展示，stats 永远按【全量】算 ——
          //   否则「共 593 项」会随搜索词乱跳，那是谎话。
          const limit = Math.max(1, Math.min(2000, Number(q.get("limit") ?? 800)));
          /**
           * ★★ 2026-10-20 加 offset（实测抓出来的真 bug）
           *
           *   ArtCraft 的资产选择器要分页拉完全部素材：
           *     offset=0 → 500 条
           *     offset=500 → 500 条
           *     offset=1000 → 500 条
           *   实测三次返回的内容【完全一样】—— 因为这个路由只做了
           *   `items.slice(0, limit)`，从没读过 offset。
           *
           *   后果：选择器循环 20 次拿到 20×500 = 10000 条重复，
           *        界面显示「可选择 10000 项」（真实只有 857），
           *        并且渲染 10000 张卡片直接把页面卡住。
           *
           *   ⇒ 补 slice(offset, offset + limit)。
           */
          const offset = Math.max(0, Math.min(100000, Number(q.get("offset") ?? 0)));
          const page = items.slice(offset, offset + limit);
          json(res, 200, {
            ok: true,
            items: page,
            offset,
            shown: page.length,
            matched: items.length,
            stats: lib.stats,
            sources: lib.sources,
            /**
             * ★★ 2026-10-20：角色卡桥的统计。
             *   ★ 第一版我漏了这一行 —— buildLibrary() 明明返回了 characters，
             *     但这里自己拼响应体时没带上，于是前端永远读到 null。
             *     实测症状：手工调 loadCharacterTags() 能读到「小明」，
             *     但 /library 的顶层键里没有 characters。
             *   ⇒ 教训：路由自己拼 body 而不是直接透传 buildLibrary() 的返回值时，
             *     新增字段必须【两处都改】。这是 §6.19「新字段必须改三处」的同类。
             */
            characters: lib.characters ?? null,
          });
        } catch (err) {
          json(res, 500, { ok: false, error: String(err?.message ?? err) });
        }
      },
    });

    /**
     * 取一个资产的实际字节 —— 给缩略图和「作为素材送进工作流」用。
     * ★ 不接受任意绝对路径：只接受本库认得的 (src, rel)。
     *   这是代理最容易被写成「任意文件读取」的地方，判据必须是白名单而非黑名单。
     */
    const bytesDispose = ctx.webServer.register({
      kind: "exact",
      path: prefix + "/file",
      handler: async (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return json(res, 405, { error: "method not allowed" });
        }
        const u = new URL(req.url ?? "/", "http://x");
        const src = String(u.searchParams.get("src") ?? "");
        const rel = String(u.searchParams.get("rel") ?? "");

        if (!rel || rel.includes("..") || /^[\\/]/.test(rel) || /[\x00-\x1f]/.test(rel)) {
          return json(res, 400, { error: "非法的 rel" });
        }
        const roots = comfyRoots();
        let abs;
        if (src === "output" || src === "input") {
          const root = path_resolve(roots[src]);
          abs = path_resolve(root, rel.split("/").join(path_sep()));
          if (abs !== root && !abs.startsWith(root + path_sep())) {
            return json(res, 400, { error: "rel 越界" });
          }
        } else if (src === "editor") {
          // editor 的 rel 就是它索引里的绝对路径；只允许本库此刻真的持有的那条
          const ed = await readEditorAssets();
          const hit = ed.items.some((a) => path_resolve(String(a.path ?? "")) === path_resolve(rel));
          if (!hit) return json(res, 403, { error: "该路径不在 dsh-editor 素材库内" });
          abs = path_resolve(rel);
        } else {
          return json(res, 400, { error: "src 只允许 output/input/editor" });
        }

        try {
          const fsp = await import("node:fs/promises");
          const st = await fsp.stat(abs);
          if (!st.isFile()) return json(res, 404, { error: "不是文件" });
          const kind = kindOf(abs);
          const mime = {
            image: /\.jpe?g$/i.test(abs) ? "image/jpeg"
              : /\.webp$/i.test(abs) ? "image/webp"
              : /\.gif$/i.test(abs) ? "image/gif" : "image/png",
            video: /\.webm$/i.test(abs) ? "video/webm"
              : /\.mov$/i.test(abs) ? "video/quicktime" : "video/mp4",
            audio: /\.wav$/i.test(abs) ? "audio/wav"
              : /\.mp3$/i.test(abs) ? "audio/mpeg"
              : /\.m4a$/i.test(abs) ? "audio/mp4" : "application/octet-stream",
          }[kind] ?? "application/octet-stream";

          // ★★ 2026-10-19 加 Range 支持（实测发现的真缺陷）：
          //   原来只有 200 + 全长，Accept-Ranges 为空。
          //   ⇒ <audio> / <video> 拖进度条失效（必须从头播）。
          //   实测：Range: bytes=0-1023 → 返回 200 而不是 206。
          //
          //   dsh-editor 的 /timeline/file 早就有这段（sse.mjs:136），
          //   但 M2 自己这条 /comfy-assets/file 是另一个实现，漏了 ——
          //   和 AGENTS §6.38「修了一半」是同一类：两条同类路由，只修了一条。
          const range = req.headers?.range;
          if (range) {
            const m = /bytes=(\d*)-(\d*)/.exec(String(range));
            if (m) {
              const start = m[1] ? Number(m[1]) : 0;
              const end = m[2] ? Number(m[2]) : st.size - 1;
              if (start >= 0 && end < st.size && start <= end) {
                const len = end - start + 1;
                res.writeHead(206, {
                  "Content-Type": mime,
                  "Content-Length": len,
                  "Content-Range": `bytes ${start}-${end}/${st.size}`,
                  "Accept-Ranges": "bytes",
                  "Cache-Control": "private, max-age=30",
                  "X-Content-Type-Options": "nosniff",
                });
                if (req.method === "HEAD") { res.end(); return; }
                const rs = (await import("node:fs")).createReadStream(abs, { start, end });
                rs.on("error", () => { try { res.destroy(); } catch { /* ignore */ } });
                rs.pipe(res);
                return;
              }
            }
          }

          res.writeHead(200, {
            "Content-Type": mime,
            "Content-Length": st.size,
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=30",
            "X-Content-Type-Options": "nosniff",
          });
          if (req.method === "HEAD") { res.end(); return; }
          const stream = (await import("node:fs")).createReadStream(abs);
          stream.on("error", () => { try { res.destroy(); } catch { /* ignore */ } });
          stream.pipe(res);
        } catch (err) {
          if (err?.code === "ENOENT") return json(res, 404, { error: "文件不存在" });
          return json(res, 500, { error: String(err?.message ?? err) });
        }
      },
    });

    /** 收藏 / 重命名 / 删除（删除=移到 trash/，可复原） */
      /**
       * ★★★ 2026-10-21 新增：LLM 起名
       *
       *   主人原话：「命名可以让 llm 来起一个默认名，用户做最后把关确认」
       *   做成资产卡上的「✨ 起名」按钮 —— 不挡上传路径，用户主动点才花时间。
       *
       *   请求：{ filename, kind?, hint?, provider?, model? }
       *   返回：{ ok, name, provider, model } 或 { ok:false, error }
       */
      /**
       * ★★★ 2026-10-21 新增（任务书三-1）：判断资产归属哪个项目文件夹
       *
       *   POST { filename, kind?, hint?, existingFolders?, provider?, model? }
       *   → { ok, folder, source:"llm"|"rule", reason, llmError?, needCreate? }
       *
       *   ★ 只建议，不自动写 —— 主人的要求是「询问用户」。
       */
      ctx.webServer.register({
        kind: "exact",
        path: prefix + "/suggest-folder",
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          let body;
          try {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            return json(res, 400, { error: "请求体不是合法 JSON" });
          }

          // 候选：调用方给的，否则用状态里已存在的
          const existing = Array.isArray(body?.existingFolders) && body.existingFolders.length
            ? body.existingFolders
            : (stateStore.listFolders?.() ?? []);

          const r = await suggestFolderByLLM({
            llm: ctx.llm,
            args: { ...body, existingFolders: existing },
          });
          if (r.ok) return json(res, 200, r);

          // 没有文件夹 ⇒ 明确告诉前端「先建一个」
          if (r.needCreate) {
            return json(res, 200, { ok: true, folder: null, source: "none", reason: r.error, needCreate: true });
          }

          // LLM 失败 ⇒ 规则兜底
          const fallback = suggestFolderRule(body?.filename ?? "", existing);
          return json(res, 200, { ...fallback, llmError: r.error });
        },
      });

      ctx.webServer.register({
        kind: "exact",
        path: prefix + "/suggest-name",
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          let body;
          try {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            return json(res, 400, { error: "请求体不是合法 JSON" });
          }
          const r = await suggestNameByLLM({ llm: ctx.llm, args: body });
          if (r.ok) return json(res, 200, { ...r, source: "llm" });
          /**
           * ★ 2026-10-21：LLM 失败时降级到规则起名。
           *
           *   实测失败原因：API key 失效（401 AUTH）、429 限流、网络不通。
           *   ⇒ 用规则名当草稿，前端标注 source="rule"，
           *     用户仍可编辑后确认（任务书四-1 的要求没变）。
           */
          const fallback = suggestNameRule(body?.filename ?? "", body?.kind ?? "image");
          return json(res, 200, {
            ok: true,
            name: fallback,
            source: "rule",
            llmError: r.error,
          });
        },
      });

    const mutateDispose = ctx.webServer.register({
      kind: "exact",
      path: prefix + "/mutate",
      handler: async (req, res) => {
        if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
        let body;
        try {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          return json(res, 400, { error: "请求体不是合法 JSON" });
        }

        const action = String(body.action ?? "");
        const id = String(body.id ?? "");
        /**
         * ★ trash-list 不需要 id（它列的是整张表）。
         *   实测（2026-10-18）：原来的「所有 action 都要求 id」把它挡成「缺 id」。
         */
        if (!id && action !== "trash-list") return json(res, 400, { error: "缺 id" });

        try {
          if (action === "fav") {
            const on = body.on !== false;
            stateStore.setFav(id, on);
            return json(res, 200, { ok: true, id, fav: on });
          }
          if (action === "rename") {
            const name = String(body.name ?? "").trim();
            /**
             * ★ name 为空 = 【清掉别名，恢复文件名】。
             *   实测（2026-10-18）：原来一律 400「新名字不能为空」，
             *   于是改名之后没有任何办法改回去 ——
             *   验收脚本跑完还会在状态文件里留一条假别名。
             *   改名的反面操作必须存在，否则它就不是可逆的。
             */
            if (!name) {
              stateStore.setAlias(id, "");
              /**
               * ★ 2026-10-21 修：清别名时必须同时清图片本体。
               *
               *   实测（verify-assets.mjs 抓到的）：
               *     json 清掉了，但 PNG 里还留着旧 workbench_alias，
               *     而「读回时从 PNG 兜底」又把名字读回来了 ⇒ 清不掉。
               *
               *   ⇒ 写两边就清两边 —— 写/清必须对称。
               */
              const clearedTag = await clearTagsInImage(id, ["workbench_alias"]);
              return json(res, 200, { ok: true, id, name: null, cleared: true, imageTag: clearedTag });
            }
            if (name.length > 120) return json(res, 400, { error: "新名字太长（上限 120）" });
            stateStore.setAlias(id, name);
            /**
             * ★ 2026-10-21：同时写进图片本体（主人：「tag 跟着资产走」）
             *   失败不影响 json —— 见 writeTagsToImage 的说明。
             */
            const imgRole0 = stateStore.getRole?.(id) ?? "";
            const imageTag = await writeTagsToImage(id, {
              workbench_alias: name,
              ...(imgRole0 ? { workbench_role: imgRole0 } : {}),
            });
            return json(res, 200, { ok: true, id, name, imageTag });
          }
          /**
           * ★★ 2026-10-20 新增：H3 参考用途标签（role）与项目文件夹（folder）。
           *
           * 主人：「默认保存到图片本体，毕竟只是改一个 tag，不动内容，
           *   如果这个 tag 是在 json 里面，那就把添加了 tag 的保存到资产库」
           *   ⇒ 就是这两个 action：只改状态文件，不碰磁盘上的图片本体。
           *
           * 主人：「资产库要分好项目文件夹，两个不相关的项目不要混在一起，
           *   不过支持 @ 的时候能搜到」
           *   ⇒ folder 只影响【面板分组显示】，@ 搜索仍跨全部文件夹。
           */
          if (action === "role") {
            const roleId = String(body.role ?? "").trim();
            const r = stateStore.setRole(id, roleId);
            if (r && r.ok === false) return json(res, 400, { error: r.reason });
            // ★ 2026-10-21：同时写进图片本体
            const imgAlias0 = stateStore.getAlias?.(id) ?? "";
            const imageTag = await writeTagsToImage(id, {
              ...(roleId ? { workbench_role: roleId } : {}),
              ...(imgAlias0 ? { workbench_alias: imgAlias0 } : {}),
            });
            return json(res, 200, { ok: true, id, role: roleId || null, cleared: !roleId, imageTag });
          }
          if (action === "folder") {
            const folder = String(body.folder ?? "").trim();
            const r = stateStore.setFolder(id, folder);
            if (r && r.ok === false) return json(res, 400, { error: r.reason });
            // ★ 2026-10-21：同时写进图片本体
            const imgRole1 = stateStore.getRole?.(id) ?? "";
            const imgAlias1 = stateStore.getAlias?.(id) ?? "";
            const imageTag = await writeTagsToImage(id, {
              ...(folder ? { workbench_folder: folder } : {}),
              ...(imgRole1 ? { workbench_role: imgRole1 } : {}),
              ...(imgAlias1 ? { workbench_alias: imgAlias1 } : {}),
            });
            return json(res, 200, { ok: true, id, folder: folder || null, cleared: !folder, imageTag });
          }
          /**
           * ★★ 2026-10-20 新增：设置角色卡标签（跨项目写）。
           *
           * 主人要的是「@韩立 引用这个角色」，而角色卡的标签
           * 按设计存在工作站那一份（outputs/assets.json）。
           * 用户在工作台看图，不该为了打标签去手改 json。
           *
           * body: { action:"character", id, basename, character, view, on }
           *   · basename 是给写回用的（工作站按 path.basename 索引）
           *   · on=false 表示摘掉角色标签
           *
           * ★ 响应里带上 backup 路径 —— 写别人的文件必须留下复原线索。
           */
          if (action === "character") {
            const basename = String(body.basename ?? "").trim();
            if (!basename) return json(res, 400, { error: "character 需要 basename" });
            /**
             * ★ 2026-10-20：允许补登记。
             *   工作台「＋上传」的文件落进 ComfyUI 的 input/，
             *   而工作站 assets.json 只收录它自己扫过的文件 ⇒ 不在里面。
             *   不补登记的话「入库时填角色名」必然失败：
             *     assets.json 里没有这个文件：wb_TestCharacter_00001__lx3s1x.png
             *
             *   ★ 这里把【真实存在的路径】查出来传下去 —— 不编造路径。
             */
            let createPath = null;
            if (body.createIfMissing) {
              const roots = comfyRoots();
              /**
               * ★ 2026-10-20 修：这里原来用 `fsSync.existsSync`，但 index.js
               *   顶部没有 import fsSync —— 它是 undefined，
               *   调用直接抛 TypeError，被下面的 catch 吃掉，
               *   于是永远返回「都找不到这个文件」。
               *
               *   实测症状：文件明明在 D:\Comfy-Desktop\ComfyUI-Shared\input\，
               *   但接口说找不到。
               *   ⇒ 本文件其它地方都用 `await import("node:fs")`，
               *     跟着它的既有风格走，别引入新的顶层 import。
               */
              const fsmod = await import("node:fs");
              for (const root of [roots.input, roots.output]) {
                const cand = path_resolve(root, basename);
                try {
                  if (cand.startsWith(path_resolve(root)) && fsmod.existsSync(cand)) {
                    createPath = cand;
                    break;
                  }
                } catch { /* 忽略单个根的异常，继续下一个 */ }
              }
              if (!createPath) {
                return json(res, 400, {
                  error: `在工作区 input/output 里都找不到这个文件：${basename}`,
                });
              }
            }
            const r = setCharacterTag({
              basename,
              character: body.character,
              view: body.view,
              on: body.on !== false,
              createIfMissing: !!body.createIfMissing,
              createPath,
              createKind: body.kind,
            });
            if (!r.ok) return json(res, 400, { error: r.reason });
            return json(res, 200, {
              ok: true,
              id,
              basename,
              tags: r.tags,
              matched: r.matched,
              backup: r.backup,
            });
          }
          if (action === "delete") {
            /**
             * ★ 不可复原的操作必须先转成可复原形式（预设硬规则 ①）。
             *   ⇒ 不做 unlink，一律移到 .state/trash/<时间戳>/，
             *     并把「从哪来、到哪去」记进状态文件 ⇒ 能 undo。
             *   真删只有 body.purge === true 才做，且必须显式传。
             */
            const src = String(body.src ?? "");
            const rel = String(body.rel ?? "");
            if (!rel) return json(res, 400, { error: "delete 需要 src + rel" });
            if (rel.includes("..")) return json(res, 400, { error: "非法 rel" });

            const roots = comfyRoots();
            let abs = null;
            if (src === "output" || src === "input") {
              const root = path_resolve(roots[src]);
              const cand = path_resolve(root, rel.split("/").join(path_sep()));
              if (!cand.startsWith(root + path_sep())) {
                return json(res, 400, { error: "rel 越界" });
              }
              abs = cand;
            } else if (src === "editor") {
              const ed = await readEditorAssets();
              const hit = ed.items.some((a) => path_resolve(String(a.path ?? "")) === path_resolve(rel));
              if (!hit) return json(res, 403, { error: "该路径不在 dsh-editor 素材库内" });
              abs = path_resolve(rel);
            } else {
              return json(res, 400, { error: "src 只允许 output/input/editor" });
            }

            const fsp = await import("node:fs/promises");

            /**
             * ★ 文件已经不在（被别的程序移走 / 重复删）：
             *   这不是服务器错误。把索引项藏起来 + 返回 ok，
             *   否则前端弹一个 ENOENT，用户会以为资产库坏了。
             *   实测（2026-10-18）：删一条此前已被移走的项，原来返回 500。
             */
            let exists = true;
            try { exists = (await fsp.stat(abs)).isFile(); } catch { exists = false; }
            if (!exists) {
              stateStore.setHidden(id, true);
              return json(res, 200, { ok: true, id, alreadyGone: true, path: abs });
            }

            if (body.purge === true) {
              await fsp.unlink(abs);
              stateStore.setHidden(id, true);
              stateStore.setTrash(id, { from: abs, to: null, purged: true, at: Date.now() });
              return json(res, 200, { ok: true, id, purged: true, path: abs });
            }

            const dest = await moveToTrash(stateStore.stateFile, abs);
            stateStore.setHidden(id, true);
            stateStore.setTrash(id, { from: abs, to: dest, purged: false, at: Date.now() });
            return json(res, 200, { ok: true, id, trashed: true, dest, from: abs });
          }

          /** 撤销一次「移到回收区」 —— 把文件搬回原处。 */
          if (action === "undo-delete") {
            const r = stateStore.undoTrash(id);
            if (!r.ok) return json(res, 400, { ok: false, error: r.reason });
            return json(res, 200, { ok: true, id, restored: r.restored });
          }

          /** 回收站列表 —— 让「可复原」这件事对用户是可见的。 */
          if (action === "trash-list") {
            return json(res, 200, { ok: true, items: stateStore.listTrash() });
          }

          return json(res, 400, { error: `未知 action：${action}（可用 fav/rename/delete/undo-delete/trash-list）` });
        } catch (err) {
          return json(res, 500, { ok: false, error: String(err?.message ?? err) });
        }
      },
    });

    // ── 画布持久化（2026-10-18）────────────────────────────────
    //
    // ★ 需求：canvas-room 交付时标了「未验证：画布不持久化」。
    //   切 tab 组件卸载后，用户排好的卡片位置全丢。
    //
    // ★ 为什么还要磁盘（前端已经写了 localStorage）：
    //   localStorage 有 5MB 上限、隐私模式下直接抛异常。
    //   YUH Studio 的日志里就写着「浏览器缓存已满，画布仍保存在磁盘」。
    //   ⇒ 前端即时写 localStorage（防卸载丢），后端存磁盘（防容量丢）。
    //     两者都失败时静默降级 —— 画布还是能用，只是下次回来位置没了。
    let canvasDispose = null;
    // ★ 2026-10-20：上传入库路由的 disposer（与 canvasDispose 并列，
    //   两个都是「后加的路由」，风格保持一致）
    let uploadDispose = null;
    // ★ 2026-10-21：音频转文字路由的 disposer
    let transcribeDispose = null;
    if (typeof ctx?.webServer?.register === "function") {
      // ★ 放在资产库状态文件旁边（它已经知道该写哪），不自己猜 DSH_HOME。
      //   stateStore 只暴露 stateFile，没有 dir —— dirname 一下就行。
      const canvasFile = nodePath.join(nodePath.dirname(String(stateStore.stateFile)), "canvas-state.json");
      canvasDispose = ctx.webServer.register({
        kind: "exact",
        path: prefix + "/canvas",
        handler: async (req, res) => {
          const fsp = await import("node:fs/promises");
          try {
            if (req.method === "GET") {
              try {
                const raw = await fsp.readFile(canvasFile, "utf8");
                return json(res, 200, { ok: true, ...JSON.parse(raw) });
              } catch {
                return json(res, 200, { ok: true, empty: true });
              }
            }
            if (req.method === "POST") {
              // 照 /mutate 的写法读 body（本文件没有 readJsonBody 这个 helper）
              let body;
              try {
                const chunks = [];
                for await (const c of req) chunks.push(c);
                body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
              } catch {
                return json(res, 400, { ok: false, error: "请求体不是合法 JSON" });
              }
              if (!body || typeof body !== "object") {
                return json(res, 400, { ok: false, error: "body 必须是对象" });
              }
              // 只存白名单字段，别把任意东西写进磁盘
              const clean = {
                view: body.view ?? null,
                pos: body.pos ?? {},
                at: Number(body.at) || Date.now(),
              };
              await fsp.mkdir(nodePath.dirname(canvasFile), { recursive: true });
              await fsp.writeFile(canvasFile, JSON.stringify(clean), "utf8");
              return json(res, 200, { ok: true, saved: true, path: canvasFile });
            }
            return json(res, 405, { error: "method not allowed" });
          } catch (err) {
            return json(res, 500, { ok: false, error: String(err?.message ?? err) });
          }
        },
      });
    }

    log.info?.(`[${name}] 已注册资产代理 ${prefix}/view ${prefix}/roles ${prefix}/library ${prefix}/file ${prefix}/mutate ${prefix}/canvas`);
      /**
       * ★★ 2026-10-20 新增：上传文件入库。
       *
       * 主人：「只在入资产库的时候提出改名确认就行了，要可编辑，
       *   然后命名可以让 llm 来起一个默认名，用户做最后把关确认」
       *
       * 在此之前【没有「入库」这个动作】—— 资产来自三源自动合并
       * （ComfyUI output / input / dsh-editor 索引），用户没有办法主动添加。
       * ⇒ 这条路由补上那个入口。
       *
       * 请求体（JSON，因为前端要发 base64）：
       *   { filename, base64, folder?, role? }
       * 返回：
       *   { ok, id, absPath, filename }
       *
       * ★ 落在 ComfyUI 的 input/ 目录 —— 那是三个源里唯一「用户的东西」该待的地方，
       *   而且 ComfyUI 的 LoadImage 本来就从那里取，放这里一份不需要再复制。
       * ★ 文件名规则：wb_<安全名>_<随机6位><扩展名>，绝不覆盖既有文件
       *   （理由见 §6.x「filename 原样透传会覆盖别人的文件」）。
       * ★ 扩展名白名单：只允许媒体与文本，不许传 .exe/.bat。
       */
      uploadDispose = ctx.webServer.register({
        kind: "exact",
        path: prefix + "/upload",
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          let body;
          try {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            return json(res, 400, { error: "请求体不是合法 JSON" });
          }
          const filename = String(body.filename ?? "").trim();
          const base64 = String(body.base64 ?? "");
          if (!filename) return json(res, 400, { error: "缺 filename" });
          if (!base64) return json(res, 400, { error: "缺 base64" });

          const ALLOWED_EXT = [
            ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff",
            ".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v",
            ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus",
            ".txt", ".md", ".srt", ".json",
          ];
          const ext = nodePath.extname(filename).toLowerCase();
          if (!ALLOWED_EXT.includes(ext)) {
            return json(res, 400, { error: `不支持的文件类型：${ext || "(无扩展名)"}` });
          }

          let buf;
          try {
            buf = Buffer.from(base64, "base64");
          } catch {
            return json(res, 400, { error: "base64 解码失败" });
          }
          if (!buf.length) return json(res, 400, { error: "文件为空" });
          if (buf.length > 64 * 1024 * 1024) {
            return json(res, 413, { error: `文件太大：${(buf.length / 1048576).toFixed(1)}MB，上限 64MB` });
          }

          // 安全文件名：去掉路径分隔符与控制字符，再拼随机后缀
          const safeBase = filename
            .slice(0, filename.length - ext.length)
            .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_")
            .replace(/\s+/g, "_")
            .slice(0, 60);
          const rand = Math.random().toString(36).slice(2, 8);
          const outName = `wb_${safeBase}_${rand}${ext}`;

          try {
            const fsp = await import("node:fs/promises");
            const roots = comfyRoots();
            const inputRoot = roots.input;
            await fsp.mkdir(inputRoot, { recursive: true });
            const absPath = path_resolve(inputRoot, outName);
            // 再确认一次没越界（safeBase 已过滤分隔符，这里是双保险）
            if (!absPath.startsWith(path_resolve(inputRoot))) {
              return json(res, 400, { error: "文件名越界" });
            }
            await fsp.writeFile(absPath, buf);

            // 顺带把 displayName / folder / role 记进状态（若前端传了）
            const id = `input:${outName}`;
            /**
             * ★★★ 2026-10-21 补：displayName 之前【完全没被读】。
             *
             *   实测：入库时传 displayName:"入库改名验证"，
             *        资产库里显示的仍是磁盘名 wb_入库测试_mh7vvi.png。
             *   ⇒ 任务书四-1「入库时可以改名」在 host 侧是缺的。
             *
             *   走 mutate 的 rename 同一条路（setAlias），
             *   不碰磁盘文件名 —— 用户要的是显示名，不是重命名文件。
             */
            const wantName = String(body.displayName ?? "").trim();
            if (wantName && wantName.length <= 120) {
              stateStore.setAlias(id, wantName);
            }
            /**
             * ★ 2026-10-21：setRole/setFolder 会返回 {ok:false, reason}，
             *   原来直接丢掉返回值 ⇒ 传了非法 role 时静默不生效。
             *   ⇒ 现在把它们记下来放进响应，前端能看到「哪个字段没存进去」。
             */
            const warnings = [];
            if (body.folder) {
              const r = stateStore.setFolder(id, String(body.folder));
              if (r && r.ok === false) warnings.push("folder: " + r.reason);
            }
            if (body.role) {
              const r = stateStore.setRole(id, String(body.role));
              if (r && r.ok === false) warnings.push("role: " + r.reason);
            }

            return json(res, 200, {
              ok: true,
              id,
              absPath,
              filename: outName,
              sizeBytes: buf.length,
              displayName: wantName || null,
              warnings: warnings.length ? warnings : undefined,
            });
          } catch (err) {
            return json(res, 500, { error: String(err?.message ?? err) });
          }
        },
      });

      /**
       * ★★★ 2026-10-21 新增：POST /transcribe —— 音频转文字（生成字幕用）
       *
       * 主人要求：「是不是还要一个音频转文字的能力，根据音轨生成字幕？」
       *          「装就行了」
       *
       * ── 本轮实测结论（决定用 faster-whisper 而不是 Windows 自带识别器）
       *
       * Windows 自带中文识别器（System.Speech）：能跑，平均 88.1%，
       *   但它【不给时间戳】，且纯音乐时会硬凑字。
       *
       * faster-whisper（最终选它）：
       *   · 已装 faster-whisper 1.2.1 + ctranslate2 4.8.3（腾讯云 pip 镜像可达）
       *   · 模型 Systran/faster-whisper-small 463.7MB
       *     落在 <REPO>\.models\whisper
       *   · 准确率：16 字 100% / 40 字 100%（TTS 已知文本闭环测试）
       *   · 带 segment 级时间戳（start/end 秒）—— 这是排字幕的必要条件
       *   · 纯音效/无声 → 0 段（不乱凑）
       *   · ★ 中文默认输出【繁体】，必须 OpenCC t2s
       *       实测「天氣/視頻/剪輯」→「天气/视频/剪辑」后才 100%
       *   · ★ whisper 自己不做重采样，必须 ffmpeg 先转 16kHz/16bit/单声道
       *
       * ── 为什么走 host 侧
       *   要 spawn python 子进程 + 读本地文件，浏览器做不到。
       *
       * ── 请求体（JSON）
       *   { src?: "input"|"output", rel?: "文件名", absPath?: "绝对路径", language?: "zh" }
       *
       * ── 响应
       *   { ok, segments: [{start,end,text}], full, language, duration, ... }
       *   start/end 是【秒】，前端转 MediaTime 时 × 120000。
       */
      transcribeDispose = ctx.webServer.register({
        kind: "exact",
        path: prefix + "/transcribe",
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });

          let body;
          try {
            const chunks = [];
            for await (const c of req) chunks.push(c);
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            return json(res, 400, { error: "请求体不是合法 JSON" });
          }

          const cp = await import("node:child_process");
          const fsMod = await import("node:fs");
          const pathMod = await import("node:path");
          const osMod = await import("node:os");

          /* ① 定位输入文件 */
          let inputPath = String(body.absPath ?? "").trim();
          if (!inputPath) {
            const src = String(body.src ?? "").trim();
            const rel = String(body.rel ?? "").trim();
            if (!rel) return json(res, 400, { error: "缺 src+rel 或 absPath" });
            const roots0 = comfyRoots();
            const root = src === "input" ? roots0.input : roots0.output;
            if (!root) return json(res, 400, { error: `不认识的 src：${src}` });
            inputPath = pathMod.resolve(root, rel);
          }

          /* ② 路径白名单 —— 只允许读这几棵树下。
                不做这一步的话，任何本地文件都会被读出来转写。 */
          const roots = comfyRoots();
          /**
           * ★★ 2026-10-23 去敏：白名单里不再写死 "<WORKSPACE>"
           *
           *   原来那一项是「开发机的工作区根」，目的是允许读 docs/evidence 下的
           *   实测素材。换机器后这个目录不存在 ⇒ 白名单少了这一棵，
           *   而它本来就不该是一个固定的绝对路径。
           *
           *   现在按「本包所在仓库的根目录」推 —— 与包一起走，换机器自动正确。
           *   仍然是【收窄】的：只放开这一个仓库，不是整个磁盘。
           */
          const REPO_ROOT = pathMod.resolve(
            pathMod.dirname(fileURLToPath(import.meta.url)), "..", "..", "..",
          );
          const allowed = [roots.input, roots.output, REPO_ROOT, osMod.tmpdir()]
            .filter(Boolean)
            .map((p) => pathMod.resolve(p));
          const resolved = pathMod.resolve(inputPath);
          const okPath = allowed.some(
            (r) => resolved === r || resolved.startsWith(r + pathMod.sep),
          );
          if (!okPath) {
            return json(res, 403, {
              error: "路径不在允许范围内（只允许 ComfyUI input/output 与工作区）",
              resolved,
            });
          }
          if (!fsMod.existsSync(resolved)) {
            return json(res, 404, { error: "文件不存在", resolved });
          }

          /* ③ ffmpeg 抽音轨 → 16kHz/16bit/单声道 WAV */
          /**
           * ★★ 2026-10-23 去敏：ffmpeg 路径四级回落
           *
           *   原来写死 "<OLD_REPO>\packages\dsh-editor\bin\ffmpeg.exe"
           *   ⇒ 换机器直接 500「找不到 ffmpeg」。
           *
           *   顺序：config.ffmpegPath → FFMPEG_PATH 环境变量
           *        → 同仓 dsh-editor/bin → imageio-ffmpeg → 裸 "ffmpeg"
           *   （与 comfy-bridge 的 quality.mjs / subtitle.mjs 保持同一套顺序）
           */
          const FFMPEG = (() => {
            if (config.ffmpegPath) return config.ffmpegPath;
            if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
            const here = pathMod.dirname(fileURLToPath(import.meta.url));
            const packagesDir = pathMod.resolve(here, "..", "..");
            const cands = [
              pathMod.join(packagesDir, "dsh-editor", "bin", "ffmpeg.exe"),
              pathMod.join(packagesDir, "dsh-editor", "bin", "ffmpeg"),
              "D:/image/venv/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe",
            ];
            for (const c of cands) {
              try { if (fsMod.existsSync(c)) return c; } catch { /* 忽略 */ }
            }
            return "ffmpeg";
          })();
          if (!fsMod.existsSync(FFMPEG)) {
            return json(res, 500, { error: "找不到 ffmpeg", path: FFMPEG });
          }

          /**
           * ★ 2026-10-21 修（实测第一版失败）：
           *   临时 wav 原本写到 os.tmpdir()，ffmpeg 报
           *     Error opening output C:\Users\ADMINI~1\AppData\Local\Temp\dsh_asr_xxx.wav:
           *     Permission denied（退出码 4294967283）
           *
           *   根因：本机 DSH 文件沙箱只允许写【工作区】。
           *   这与 AGENTS §6.11 ③ 记的是同一件事
           *   （抽帧也不能写 C:\ 或 ComfyUI 的 input）。
           *
           *   ⇒ 临时文件改落工作区的 .frames/ 下。
           *     用完照旧删掉，不留垃圾（§6.46 的纪律）。
           */
          /**
           * ★★ 2026-10-23 去敏：临时目录不再写死 "<REPO>\.frames"
           *
           *   原来那个绝对路径在新机器上不存在 ⇒ mkdir 会尝试创建整条链，
           *   在无权限的盘符上直接失败。
           *
           *   现在按本仓库根推：<repo>/.frames
           *   语义不变（仍然落在工作区内，满足沙箱「只能写工作区」的约束），
           *   但跟着包走。
           */
          const TMP_ROOT = pathMod.join(REPO_ROOT, ".frames");
          try { fsMod.mkdirSync(TMP_ROOT, { recursive: true }); } catch { /* 已存在 */ }
          const tmpWav = pathMod.join(
            TMP_ROOT,
            `_asr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`,
          );

          try {
            await new Promise((resolve, reject) => {
              const p = cp.spawn(
                FFMPEG,
                ["-y", "-i", resolved, "-vn", "-ac", "1", "-ar", "16000",
                 "-acodec", "pcm_s16le", tmpWav],
                { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
              );
              let errBuf = "";
              p.stderr.on("data", (d) => { errBuf += d.toString(); });
              p.on("error", reject);
              p.on("close", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`ffmpeg 退出码 ${code}：${errBuf.slice(-300)}`));
              });
            });
          } catch (err) {
            return json(res, 500, { error: "抽音轨失败：" + String(err?.message ?? err) });
          }

          /* ④ 调 python faster-whisper
                ★ 用 python -c 内联脚本，不依赖 .py 文件的物理位置
                  （lib/ 与 src/ 都可能有，内联最省事）。 */
          /**
           * ★★ 2026-10-23 去敏：python 与 whisper 模型路径都不再写死
           *
           *   PYTHON 顺序：
           *     config.pythonPath → PYTHON_BIN 环境变量
           *     → <ComfyUI>/.venv/Scripts/python.exe（从用户配置的 comfyPath 推）
           *     → 裸 "python"
           *
           *   MODEL_DIR 顺序：
           *     config.whisperModelDir → COMFY_WHISPER_DIR 环境变量
           *     → <repo>/.models/whisper（跟着仓库走）
           */
          const PYTHON = (() => {
            if (config.pythonPath) return config.pythonPath;
            if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
            /* 从 M1 的路径解析拿 ComfyUI 的 python（用户可能在设置页填过） */
            try {
              const rp = comfyRoots();
              void rp;
            } catch { /* 忽略 */ }
            const here = pathMod.dirname(fileURLToPath(import.meta.url));
            const packagesDir = pathMod.resolve(here, "..", "..");
            /* 常见 ComfyUI 便携版位置里的 venv python */
            const cands = [
              pathMod.join(packagesDir, "..", ".venv", "Scripts", "python.exe"),
            ];
            for (const c of cands) {
              try { if (fsMod.existsSync(c)) return c; } catch { /* 忽略 */ }
            }
            return "python";
          })();
          const MODEL_DIR =
            config.whisperModelDir ??
            process.env.COMFY_WHISPER_DIR ??
            pathMod.join(REPO_ROOT, ".models", "whisper");

          const pyScript = [
            "import sys, json, io, time",
            'sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")',
            "try:",
            "    from faster_whisper import WhisperModel",
            "except ImportError as e:",
            '    print(json.dumps({"ok": False, "error": "faster_whisper 未安装: %s" % e})); sys.exit(0)',
            "try:",
            "    from opencc import OpenCC",
            '    _cc = OpenCC("t2s"); HAS_CC = True',
            "except ImportError:",
            "    HAS_CC = False",
            "wav = sys.argv[1]; model_dir = sys.argv[2]",
            'lang = sys.argv[3] if len(sys.argv) > 3 else "zh"',
            'want = sys.argv[4] if len(sys.argv) > 4 else "auto"',
            "t0 = time.time()",
            "try:",
            "    import os, glob",
            "    def pick():",
            "        '''挑一个【本地已存在】的模型，返回它的目录路径。'''",
            "        # 优先级按实测准确率排（见 verify-asr.mjs 的对比数据）：",
            "        #   medium 91.8% > large-v3-turbo 91.6% > small 87.8%",
            "        # ★ 注意 turbo 并没有因为「large 档」就更好 ——",
            "        #   这个 ct2 版本实测反而略输 medium，且耗时更长、体积大 86MB。",
            "        cands = [",
            "            ('medium', 'Systran/faster-whisper-medium'),",
            "            ('large-v3-turbo', 'deepdml/faster-whisper-large-v3-turbo-ct2'),",
            "            ('small', 'Systran/faster-whisper-small'),",
            "        ]",
            "        order = cands",
            "        if want not in ('auto', '', None):",
            "            # 指定了名字就只看它",
            "            order = [c for c in cands if c[0] == want] or cands",
            "        for name, repo in order:",
            "            d = os.path.join(model_dir, 'models--' + repo.replace('/', '--'))",
            "            bins = glob.glob(os.path.join(d, 'snapshots', '*', 'model.bin'))",
            "            for b in bins:",
            "                if os.path.getsize(b) > 100 * 1024 * 1024:",
            "                    return name, os.path.dirname(b)",
            "        return None, None",
            "    picked, picked_dir = pick()",
            "    if not picked:",
            "        print(json.dumps({'ok': False, 'error': '本地没有可用的 whisper 模型（需要 model.bin >100MB）'}))",
            "        sys.exit(0)",
            "    # ★ 用【本地目录】而不是短名：",
            "    #   faster_whisper 的短名映射表里没有 'large-v3-turbo'，",
            "    #   传短名会触发网络查表，网络不稳时会卡住甚至失败。",
            "    #   传目录路径则完全不联网。",
            '    m = WhisperModel(picked_dir, device="cpu", compute_type="int8")',
            "except Exception as e:",
            '    print(json.dumps({"ok": False, "error": "模型加载失败: %s" % str(e)[:300]})); sys.exit(0)',
            "t1 = time.time()",
            "segs = []",
            "try:",
            "    it, info = m.transcribe(wav, language=lang, beam_size=5, vad_filter=True,",
            "                            vad_parameters=dict(min_silence_duration_ms=500))",
            "    for s in it:",
            "        txt = s.text.strip()",
            "        if HAS_CC: txt = _cc.convert(txt)",
            '        segs.append({"start": round(s.start, 2), "end": round(s.end, 2), "text": txt})',
            "    print(json.dumps({",
            '        "ok": True, "segments": segs,',
            '        "full": "".join(x["text"] for x in segs),',
            '        "language": info.language,',
            '        "duration": round(info.duration, 2),',
            '        "loadSeconds": round(t1 - t0, 2),',
            '        "transcribeSeconds": round(time.time() - t1, 2),',
            '        "opencc": HAS_CC,',
            '        "model": picked,',
            "    }, ensure_ascii=False))",
            "except Exception as e:",
            '    print(json.dumps({"ok": False, "error": "转写失败: %s" % str(e)[:300]}))',
          ].join("\n");

          let pyOut = "";
          let pyErr = "";
          try {
            await new Promise((resolve, reject) => {
              const p = cp.spawn(
                PYTHON,
                [
                  "-c", pyScript, tmpWav, MODEL_DIR,
                  String(body.language ?? "zh"),
                  /**
                   * ★ 2026-10-21：第 4 个参数 = 模型名。
                   *   "auto" ⇒ python 侧按能力优先级挑本地已存在的：
                   *     large-v3-turbo > medium > small
                   *   判断标准是「model.bin 存在且 >100MB」——
                   *   只下了 config/tokenizer 的空壳不算。
                   *   这样换模型不用改代码，下完就能用。
                   */
                  String(config.whisperModel ?? body.model ?? "auto"),
                ],
                {
                  windowsHide: true,
                  stdio: ["ignore", "pipe", "pipe"],
                  env: { ...process.env, PYTHONIOENCODING: "utf-8" },
                },
              );
              p.stdout.on("data", (d) => { pyOut += d.toString(); });
              p.stderr.on("data", (d) => { pyErr += d.toString(); });
              p.on("error", reject);
              p.on("close", () => resolve());
            });
          } catch (err) {
            try { fsMod.unlinkSync(tmpWav); } catch { /* ignore */ }
            return json(res, 500, {
              error: "python 调用失败：" + String(err?.message ?? err),
              python: PYTHON,
            });
          }
          /* 临时 wav 用完就删 —— 否则每次转写都在 %TEMP% 留一份 */
          try { fsMod.unlinkSync(tmpWav); } catch { /* ignore */ }

          /* ⑤ 解析 python 的 JSON */
          const line = pyOut.trim().split("\n").filter(Boolean).at(-1) ?? "";
          let parsed = null;
          try { parsed = JSON.parse(line); } catch { /* 下面统一报错 */ }
          if (!parsed) {
            return json(res, 500, {
              error: "python 没有返回可解析结果",
              stdout: pyOut.slice(-400),
              stderr: pyErr.slice(-400),
            });
          }
          if (!parsed.ok) return json(res, 500, { error: parsed.error ?? "转写失败" });
          return json(res, 200, parsed);
        },
      });

    return () => {

      dispose?.(); rolesDispose?.();
      libDispose?.(); bytesDispose?.(); mutateDispose?.();
      canvasDispose?.(); uploadDispose?.();
      transcribeDispose?.();
    };
  }, "comfy-workbench-tab: asset proxy");

  return undefined;
}

/**
 * 扫描工作流目录里的 *.bind.json，抽出「nodeId → 角色 key」。
 *
 * 只读、只在端点被调用时读（不常驻不缓存 —— bind 是人工改的数据，
 * 缓存反而会让改了 bind 之后界面还说谎）。
 * 找不到目录就返回 ok:false，绝不抛到外面。
 */
async function readOutputRoles(config = {}) {
  const dir = config.workflowsDir
    ?? process.env.COMFY_WORKFLOWS_DIR
    ?? DEFAULT_WORKFLOWS_DIR;

  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return { ok: false, modes: {}, dir, error: "工作流目录不可读" };
  }

  const modes = {};
  for (const f of names) {
    if (!f.endsWith(".bind.json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, f), "utf8");
      const bind = JSON.parse(raw);
      const id = bind?.id ?? f.replace(/\.bind\.json$/, "");
      const outputs = bind?.outputs;
      if (!outputs || typeof outputs !== "object") continue;
      // 反转成 nodeId -> roleKey，一个节点只会有一个角色
      const byNode = {};
      for (const [role, nodeId] of Object.entries(outputs)) {
        if (nodeId == null) continue;
        byNode[String(nodeId)] = role;
      }
      modes[id] = byNode;
    } catch {
      // 单个 bind 坏掉不影响其它
    }
  }
  return { ok: true, modes, dir };
}


