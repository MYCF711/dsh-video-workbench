/**
 * AssetLibrary —— 「全局资产库 + 提示词框 @ 引用」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人原话（需求本身，逐字）
 *   「资产库怎么没弄？我需要那种全局资产库，在提示词框中 @ 就能直接调用」
 *
 * ★ 关键判据（这条决定了整个设计）：
 *   「引用必须能真的影响生成结果，不能只是文字好看」。
 *
 *   所以 @ 引用不是「在提示词里插一段 @xxx.png 文字」——
 *   它是【把资产绑到当前工作流的一个 media 槽】：
 *     · 文字标记 `@文件名` 给用户看（知道引用了哪张）
 *     · 同时把该资产的字节填进 files[slot]
 *       （走 WorkbenchView 已有的 MediaSlots 那条路 →
 *         后端 uploadImage → ComfyUI LoadImage 的 image 值）
 *   ⇒ 后端起作用的永远是 files[slot]，文字标记只是票据。
 *
 * ── 为什么复用 MediaSlots 而不是另开一条上传通道 ────────────────────
 *   MediaSlots 那条路已经真机验过（uploadImage → 节点 image 值）。
 *   另开一条就要再验一遍「文件怎么进 ComfyUI 的 input/」，
 *   多一条未验证路径 = 多一个主人验收时才会发现的黑洞。
 *
 * ── 数据来源（三源合并，host 侧做的）─────────────────────────────────
 *   GET /comfy-assets/library
 *     ① output/ ComfyUI 产物   ② input/ 用户上传   ③ dsh-editor 素材索引
 *   前端只 do 展示 + 选择，不扫盘（浏览器没有目录 API）。
 *
 * ── 失效隔离 ────────────────────────────────────────────────────────
 *   本模块自带 Boundary，并额外用 SafeAssetLibrary 包一层 try。
 *   库挂了 → 只丢库，提示词框和生成按钮照常（验收第 ⑥ 条）。
 * ══════════════════════════════════════════════════════════════════════
 */

import React from "react";
import { createPortal } from "react-dom";
// ★ 2026-10-20：H3 参考用途标签体系（按官方 ref-en.txt 重建）
//   资产卡上的「用途」下拉从这里取选项，保证「能选的都在 H3 标签里存在」。
import { REF_ROLES, rolesForKind, defaultRoleFor } from "./h3-labels.js";
// ★ 2026-10-20：@ 引用的纯逻辑单独一个文件（node 侧可测，见文件头说明）
import { parseAtTrigger, atKeyAction } from "./at-mentions.js";

const { useState, useEffect, useRef, useMemo, useCallback } = React;
const h = React.createElement;

const API = "/comfy-assets";
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const KIND_META = {
  image: { label: "图片", icon: "🖼" },
  video: { label: "视频", icon: "🎬" },
  audio: { label: "音频", icon: "🎵" },
  text: { label: "文本", icon: "📄" },
  other: { label: "其他", icon: "📦" },
};
const SRC_META = {
  output: "工作台产物",
  input: "我上传的",
  editor: "编辑器素材",
};

/* ── 小工具 ──────────────────────────────────────────────────────── */

export function assetThumbUrl(it) {
  if (!it) return null;
  return `${API}/file?src=${encodeURIComponent(it.src)}&rel=${encodeURIComponent(it.rel)}`;
}

/**
 * 按文件扩展名推 MIME。
 *
 * ★ 2026-10-21 加：修「@卡片没有预览」时发现 blob 的 type 是空字符串，
 *   浏览器拿到 type="" 的 blob URL 不认，<img> 静默失败（naturalWidth=0，
 *   不报错、DOM 里也有元素），用户看到的就是白块 = 「没有预览」。
 *   资产数据里没有可靠的 mime 字段，只能按扩展名推。
 */
function mimeFromName(name) {
  const ext = String(name ?? "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  const M = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
    ".tif": "image/tiff", ".tiff": "image/tiff", ".avif": "image/avif",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".m4v": "video/x-m4v",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
    ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg",
    ".opus": "audio/opus",
  };
  return M[ext] || "";
}

function fmtSize(bytes) {
  const n = Number(bytes ?? 0);
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${Math.round(n / 1024)}KB`;
  return `${n}B`;
}

function fmtTime(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return "";
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 文件名 → ComfyUI 能安全收下的名字（保留扩展名，不留空格与中文）。 */
function safeUploadName(name) {
  const s = String(name ?? "asset.png");
  const dot = s.lastIndexOf(".");
  const base = dot > 0 ? s.slice(0, dot) : s;
  const ext = dot > 0 ? s.slice(dot) : "";
  const clean = base.replace(/[^\w.\-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "asset";
  return clean + ext.replace(/[^\w.]/g, "");
}

/**
 * 上传名：库内 basename 唯一时原样用（这样 ComfyUI 里看到的文件名
 * 就是资产原名，验收时一眼能对上）；重名才加 id 前缀去撞。
 */
export function uploadNameFor(it, allItems) {
  const base = String(it?.name ?? "asset.png");
  const same = (allItems ?? []).filter((x) => x.name === base).length;
  if (same <= 1) return safeUploadName(base);
  let hsum = 0;
  const id = String(it?.id ?? "");
  for (let i = 0; i < id.length; i++) hsum = (hsum * 31 + id.charCodeAt(i)) >>> 0;
  const tag = hsum.toString(16).padStart(8, "0").slice(0, 8);
  const safe = safeUploadName(base);
  const dot = safe.lastIndexOf(".");
  return dot > 0 ? `${safe.slice(0, dot)}_${tag}${safe.slice(dot)}` : `${safe}_${tag}`;
}

/** 拉一个资产的实际字节，转成 MediaSlots 认的 { base64, filename, kind }。 */
async function fetchAsFilePayload(it, allItems) {
  const res = await fetch(assetThumbUrl(it), { cache: "no-store" });
  if (!res.ok) throw new Error(`取资产字节失败 HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`文件太大：${(buf.byteLength / 1024 / 1024).toFixed(1)}MB，上限 20MB`);
  }
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CH = 0x8000; // 分块，避免超长字符串卡住主线程
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  /**
   * ★★★ 2026-10-21 修（主人两次报「对话框中的@卡片还是没有预览」）
   *
   * —— 根因：blob 的 MIME 是【空字符串】
   *     const blob = new Blob([buf], { type: "" });
   *     preview: URL.createObjectURL(blob)
   *   ⇒ 浏览器拿到一个 type="" 的 blob URL，<img> 无法判断怎么解码，
   *     加载失败且【不报错】（只是 naturalWidth=0）。
   *   ⇒ 渲染侧的条件是 `info.preview && kind === "image"`，preview 是个
   *     非空字符串（blob:...）所以条件成立、<img> 被画出来了，
   *     尺寸也占好了 15×15，但里面是白的 —— 用户看到的就是「没有预览」。
   *
   *   ★ 这个缺陷特别隐蔽：DOM 里有 <img>、有尺寸、src 也非空，
   *     只有看 naturalWidth 或截图才看得出来。
   *
   * —— 修法：按实际 kind 给正确的 MIME。
   *   不能统一给 image/jpeg（视频/音频会走同一条路）。
   */
  const blobType = it.kind === "image"
    ? (it.mime || mimeFromName(uploadNameFor(it, allItems)) || "image/png")
    : it.kind === "video"
      ? (it.mime || mimeFromName(uploadNameFor(it, allItems)) || "video/mp4")
      : it.kind === "audio"
        ? (it.mime || mimeFromName(uploadNameFor(it, allItems)) || "audio/mpeg")
        : "application/octet-stream";
  const blob = new Blob([buf], { type: blobType });
  return {
    base64: btoa(bin),
    filename: uploadNameFor(it, allItems),
    kind: it.kind,
    assetId: it.id,
    // ★ src + rel 要一起带上：切 tab / 刷新后靠它把字节重新取回来
    //   （提示词里的 @文字 存在 sessionStorage，槽绑定也得能复原，
    //    否则界面看起来引用了、实际什么都没送进工作流）。
    src: it.src,
    rel: it.rel,
    displayName: it.displayName || it.name,
    /**
     * ★★★ 2026-10-21 修：必须带上资产库里存的用途。
     *
     *   实测：改完用途写回资产库成功（role=picture.key），
     *   但重新 @ 同一张图时 chip 显示的是【默认值】而不是 picture.key。
     *   根因就是这里少了 role 字段 —— 写回做了，读回没做。
     *
     *   ⇒ 任务书一-4「改完即默认保存（下次 @ 它自动带上）」靠这一行成立。
     */
    ...(it.role ? { role: it.role } : {}),
    preview: URL.createObjectURL(blob),
  };
}

/* ── 槽绑定的持久化（切 tab / 刷新后不丢）────────────────────────── */

/**
 * ★ 实测踩到的坑（2026-10-18）：
 *   提示词存在 sessionStorage 里（PERSIST_KEY），切到别的 tab 再切回来，
 *   文字 `@HD重绘-验收藏顶` 还在，但 files[slot] 是空的（base64 没存）。
 *   ⇒ 界面看起来「引用了」，实际什么都没送进工作流 ——
 *     正是主人明确禁止的那种「只是文字好看」。
 *
 * 解法：只存【资产引用】（id/src/rel/显示名，几百字节），
 *   重新挂载时按引用把字节重新取一遍再重建 base64。
 *   不存 base64 的理由：单张 20MB 上限 × 10 个槽，sessionStorage 会被写爆
 *   （YUH 的日志里就有「浏览器缓存已满」这一条）。
 */
const REFS_KEY = "dsh-comfy-workbench:slotrefs:v1";

export function saveSlotRefs(files) {
  try {
    const refs = {};
    for (const [slot, f] of Object.entries(files ?? {})) {
      if (!f?.assetId) continue;   // 本地手选的文件没法复原，不存
      refs[slot] = {
        assetId: f.assetId, src: f.src, rel: f.rel,
        filename: f.filename, displayName: f.displayName, kind: f.kind,
        /**
         * ★ 2026-10-21 补：role 也要存。
         *
         *   实测：刷新后 chip 显示默认用途，用户改过的看起来丢了。
         *   根因就是这里没存 —— 恢复时 files[slot].role 是 undefined。
         */
        ...(f.role ? { role: f.role } : {}),
      };
    }
    sessionStorage.setItem(REFS_KEY, JSON.stringify(refs));
  } catch { /* 配额满 / 隐私模式 —— 静默降级 */ }
}

export function loadSlotRefs() {
  try {
    const raw = sessionStorage.getItem(REFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

/* ── 库数据 hook ─────────────────────────────────────────────────── */

/**
 * 拉一次全量，前端本地过滤。
 * ★ 为什么不每次筛选都打网络：@ 浮层是跟着按键走的，
 *   每敲一个字符打一次请求，既慢又会把「输入不卡」这条底线踩掉。
 *   612 条元数据的 JSON 约 200KB，一次拉够。
 */
export function useAssetLibrary() {
  const [state, setState] = useState({ s: "loading", items: [], stats: null, sources: null, error: null });

  const reload = useCallback(async () => {
    setState((cur) => ({ ...cur, s: cur.items.length ? "refreshing" : "loading", error: null }));
    try {
      const r = await fetch(`${API}/library?limit=1200`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error ?? "资产库返回 ok:false");
      setState({ s: "ok", items: j.items ?? [], stats: j.stats ?? null, sources: j.sources ?? null, error: null });
    } catch (err) {
      setState({ s: "error", items: [], stats: null, sources: null, error: String(err?.message ?? err) });
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${API}/library?limit=1200`, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!alive) return;
        if (!j?.ok) throw new Error(j?.error ?? "资产库返回 ok:false");
        setState({ s: "ok", items: j.items ?? [], stats: j.stats ?? null, sources: j.sources ?? null, error: null });
      } catch (err) {
        if (alive) setState({ s: "error", items: [], stats: null, sources: null, error: String(err?.message ?? err) });
      }
    })();
    return () => { alive = false; };
  }, []);

  return { ...state, reload };
}

/* ── 收藏 / 重命名 / 删除 ─────────────────────────────────────────── */

async function mutate(payload) {
  const r = await fetch(`${API}/mutate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j;
}

/* ── @ 选择器浮层 ─────────────────────────────────────────────────── */

/**
 * 打 `@` 之后弹出的资产选择器。
 *
 * ★ 这里是【纯展示】组件：过滤结果、光标位置都由 useAssetAtMentions 持有。
 *   原因：焦点必须一直留在 textarea 上（否则用户打字就被打断），
 *   键盘事件只能由 textarea 的 onKeyDown 接。若光标状态放在本组件里，
 *   外层就得通过 `Component.__handleKey` 这种渲染期赋值去拿 ——
 *   那是在 render 里做副作用，既不合规也会拿到上一帧的闭包。
 *
 * 为什么 portal 到 body：conversation.view 的祖先带 transform，
 * 形成新的 stacking context，里面的 z-index 再大也只在该 context 内排序。
 * 这是画布 lightbox 踩过的同一个坑（AGENTS §6.10）。
 */
function AtPicker({
  filtered, cursor, setCursor, query, media, files,
  anchorRect, onPick, onClose, onlyCompatible, setOnlyCompatible, slotKinds, hasSlots, t,
  // ★ 2026-10-20：整组引用（@角色名 一次绑多张定妆图）
  charGroup, onApplyCharacter,
}) {
  const listRef = useRef(null);

  useEffect(() => {
    const el = listRef.current?.querySelector?.('[data-cur="1"]');
    if (el?.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const it of filtered) {
      const k = it.kind in KIND_META ? it.kind : "other";
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(it);
    }
    // 保持 filtered 的原始顺序（本身就是收藏优先 + 时间倒序）
    return [...map.entries()];
  }, [filtered]);

  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const W = 520, H = 360;
  let left = (anchorRect?.left ?? 200);
  let top = (anchorRect?.bottom ?? 400) + 6;
  if (left + W > vw - 12) left = Math.max(12, vw - W - 12);
  if (top + H > vh - 12) top = Math.max(12, (anchorRect?.top ?? 400) - H - 6);

  let flat = -1;

  return createPortal(
    h(React.Fragment, null,
      h("div", {
        onClick: onClose,
        style: { position: "fixed", inset: 0, zIndex: 99998, background: "transparent" },
      }),
      h("div", {
        role: "listbox",
        "aria-label": t?.("asset.picker") ?? "选择资产",
        onWheel: (e) => e.stopPropagation(),
        style: {
          position: "fixed", left, top, width: W, maxHeight: H, zIndex: 99999,
          display: "flex", flexDirection: "column",
          boxSizing: "border-box", overflow: "hidden",
          borderRadius: 12,
          background: "var(--dsw-alias-bg-layer-1, #fff)",
          boxShadow: "0 0 0 0.5px rgba(0,0,0,.12), 0 8px 28px rgba(0,0,0,.16)",
          color: "var(--dsw-alias-label-primary, #0f1115)",
          fontFamily: "inherit", fontSize: 12, lineHeight: "18px",
        },
      },
        // 头：搜索词 + 兼容过滤
        h("div", {
          style: {
            flex: "none", display: "flex", alignItems: "center", gap: 8,
            padding: "7px 10px",
            borderBottom: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))",
          },
        },
          h("span", {
            style: { flex: "1 1 auto", minWidth: 0, color: "var(--dsw-alias-label-tertiary, #81858c)" },
          }, query ? `@${query}` : (t?.("asset.pickerHint") ?? "继续打字可筛选 · ↑↓ 选择 · Enter 插入 · Esc 关闭")),
          hasSlots
            ? h("button", {
                type: "button",
                onClick: () => setOnlyCompatible((v) => !v),
                title: "只显示当前工作流素材槽能吃的类型",
                style: {
                  flex: "none", height: 22, padding: "0 8px", border: 0, borderRadius: 999,
                  cursor: "pointer", fontFamily: "inherit", fontSize: 11, lineHeight: "20px",
                  background: onlyCompatible
                    ? "var(--dsw-alias-state-business-primary, #4176e6)"
                    : "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
                  color: onlyCompatible
                    ? "var(--dsw-alias-label-primary-foreground, #fff)"
                    : "var(--dsw-alias-label-secondary, #61666b)",
                },
              }, onlyCompatible ? "只看可用" : "全部类型")
            : null,
          /**
           * ★★ 2026-10-20 新增：「整组引用」。
           *
           * 主人要的是「@韩立 引用这个角色」—— 一个角色往往有多张定妆图
           * （正面/侧面/背面/特写），逐张点太慢。
           *
           * 只在「当前搜索命中了同一个角色的多张图」时出现 ——
           * 否则这个按钮没有明确的目标，摆在那里只会让人误点。
           */
          hasSlots && charGroup && charGroup.total > 1
            ? h("button", {
                type: "button",
                onClick: () => {
                  // ★ 这是独立组件，通过 props 拿到回调（不是同作用域闭包）
                  const r = onApplyCharacter?.(charGroup.character);
                  if (r && r.catch) r.catch(() => {});
                },
                title: `把「${charGroup.character}」的 ${charGroup.total} 张定妆图一次填进参考槽（已占用的不覆盖）`,
                style: {
                  flex: "none", height: 22, padding: "0 8px", border: 0, borderRadius: 999,
                  cursor: "pointer", fontFamily: "inherit", fontSize: 11, lineHeight: "20px",
                  background: "rgba(255,171,0,.16)",
                  color: "rgb(163,106,3)",
                },
              }, `整组引用 ${charGroup.character}（${charGroup.total}）`)
            : null
        ),

        // 列表
        h("div", {
          ref: listRef,
          style: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 6 },
        },
          filtered.length === 0
            ? h("div", {
                style: {
                  padding: "22px 12px", textAlign: "center",
                  color: "var(--dsw-alias-label-tertiary, #81858c)",
                },
              }, query ? `没有匹配「${query}」的资产` : "资产库是空的")
            : grouped.map(([kind, arr]) =>
                h("div", { key: kind },
                  h("div", {
                    style: {
                      padding: "5px 6px 3px", fontSize: 11, lineHeight: "16px",
                      color: "var(--dsw-alias-label-tertiary, #81858c)",
                    },
                  }, `${KIND_META[kind]?.label ?? kind} · ${arr.length}`),
                  ...arr.map((it) => {
                    flat += 1;
                    const idx = flat;
                    const compatible = !hasSlots || slotKinds.has(it.kind);
                    const cur = idx === cursor;
                    const slotFree = compatible
                      ? firstFreeSlotFor(media, files, it.kind)
                      : null;
                    const disabled = hasSlots && !compatible;
                    return h("div", {
                      key: it.id,
                      role: "option",
                      "aria-selected": cur,
                      "aria-disabled": disabled,
                      "data-cur": cur ? "1" : "0",
                      onMouseEnter: () => setCursor(idx),
                      onMouseDown: (e) => { e.preventDefault(); },  // 别抢 textarea 焦点
                      onClick: () => { if (!disabled) onPick(it); },
                      title: disabled
                        ? `当前工作流的素材槽只接受 ${[...slotKinds].join("/")}，这个 ${KIND_META[it.kind]?.label ?? it.kind} 放不进去`
                        : `${it.displayName}\n${SRC_META[it.src] ?? it.src} · ${fmtSize(it.sizeBytes)}${it.mtime ? " · " + fmtTime(it.mtime) : ""}`,
                      style: {
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "4px 6px", borderRadius: 8,
                        cursor: disabled ? "not-allowed" : "pointer",
                        opacity: disabled ? 0.4 : 1,
                        background: cur && !disabled
                          ? "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))"
                          : "transparent",
                      },
                    },
                      h("div", {
                        style: {
                          width: 40, height: 30, flex: "none", borderRadius: 6,
                          overflow: "hidden", background: "rgba(128,128,128,.10)",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 13,
                        },
                      },
                        it.kind === "image"
                          ? h("img", {
                              src: assetThumbUrl(it), alt: "", loading: "lazy",
                              style: { width: "100%", height: "100%", objectFit: "cover" },
                            })
                          // ★★ 2026-10-19 新增：音频给播放按钮。
                          //   主人：「资产库也需要有一个音频专栏」
                          //   原来音频只有一个 🎵 图标 —— 能看到、不能听，
                          //   等于「导进来了但不知道是什么」。
                          //   ⇒ 换成小播放键，点一下就地播（不新开窗口、不打断面板）。
                          : it.kind === "audio"
                            ? h("button", {
                                type: "button",
                                title: "播放 / 暂停",
                                "aria-label": "播放预览",
                                onClick: (e) => {
                                  e.stopPropagation();   // 别把「选中」也触发掉
                                  const el = e.currentTarget.querySelector("audio");
                                  if (!el) return;
                                  if (el.paused) {
                                    // 同屏只播一个 —— 否则两个音频会叠着响
                                    document.querySelectorAll("[data-wb-audio]").forEach((a) => {
                                      if (a !== el) a.pause();
                                    });
                                    el.play().catch(() => {});
                                  } else {
                                    el.pause();
                                  }
                                },
                                style: {
                                  width: "100%", height: "100%", padding: 0, border: 0,
                                  background: "transparent", cursor: "pointer",
                                  display: "flex", alignItems: "center", justifyContent: "center",
                                  fontSize: 15, color: "var(--dsw-alias-label-secondary, #61666b)",
                                },
                              },
                                "▶",
                                h("audio", {
                                  "data-wb-audio": "1",
                                  preload: "none",
                                  src: assetThumbUrl(it),
                                  style: { display: "none" },
                                })
                              )
                            : h("span", null, KIND_META[it.kind]?.icon ?? "📦")
                      ),
                      h("div", {
                        style: { flex: "1 1 auto", minWidth: 0 },
                      },
                        h("div", {
                          style: {
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                            fontWeight: it.fav ? 600 : 400,
                          },
                        },
                          (it.fav ? "★ " : "") + it.displayName,
                          it.renamed ? h("span", {
                            style: { marginLeft: 6, opacity: .55, fontSize: 11 },
                          }, `(${it.name})`) : null
                        ),
                        h("div", {
                          style: {
                            fontSize: 11, lineHeight: "15px",
                            color: "var(--dsw-alias-label-tertiary, #81858c)",
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          },
                        }, `${SRC_META[it.src] ?? it.src} · ${fmtSize(it.sizeBytes)}`)
                      ),
                      // 槽提示：能进哪个槽，一眼看到
                      hasSlots
                        ? h("span", {
                            style: {
                              flex: "none", height: 20, padding: "0 7px", borderRadius: 999,
                              display: "inline-flex", alignItems: "center",
                              fontSize: 11, lineHeight: "18px",
                              background: disabled
                                ? "rgba(248,81,73,.10)"
                                : slotFree
                                  ? "rgba(63,185,80,.12)"
                                  : "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
                              color: disabled
                                ? "rgb(207,34,46)"
                                : slotFree
                                  ? "rgb(46,160,67)"
                                  : "var(--dsw-alias-label-tertiary, #81858c)",
                            },
                          }, disabled ? "类型不符" : slotFree ? "→ " + slotFree.label : "槽已满")
                        : null
                    );
                  })
                )
              )
        )
      )
    ),
    document.body
  );
}

/** 找一个空着、且 kind 匹配的 media 槽。 */
export function firstFreeSlotFor(media, files, kind) {
  for (const [slot, spec] of Object.entries(media ?? {})) {
    if (spec?.kind && spec.kind !== kind) continue;
    if (!files?.[slot]) return { slot, label: spec?.label ?? slot, spec };
  }
  return null;
}

/* ── 提示词高亮层（胶囊底 + 可点 tag）────────────────────────────── */

/**
 * ★★ 2026-10-20 第三轮改（主人指着截图说了三件事）：
 *
 *   「文本里面的卡片和下面引用的文件名不一样？应该把文件名同步修改」
 *     → 已在 WorkbenchView 的 MediaSlots 修（用 displayName 不用 filename）
 *
 *   「现在还是有两个卡片，只留文本中的卡片」
 *     → 下方那排槽（含文件名 + 用途下拉）整个去掉，
 *       信息全部收进正文 chip。
 *
 *   「tag 也要在文本卡片旁边，并且可以直接点击切换 tag」
 *     → chip 里内嵌一个透明的 <select>，盖在 chip 右侧，
 *       点它就能换用途。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么是「透明 select 盖在 chip 上」而不是自绘下拉
 *
 *   textarea 是纯文本控件，塞不了 DOM 节点。要真 chip 必须换 contenteditable，
 *   那会丢掉光标测量 / 撤销栈 / 输入法合成（中文输入必须）。
 *
 *   但【视觉上的 chip + 可点切换 tag】可以不改 textarea：
 *     · 高亮层已经与 textarea 逐像素对齐（字体/行高/padding 都抄的）
 *     · 高亮层原本 pointer-events:none，现在只对 chip 那一小块打开
 *     · chip 内部放一个 opacity:0 的原生 <select>，点它弹系统下拉
 *   ⇒ 用户看到的是「正文里一个带 tag 的胶囊，点 tag 能换」，
 *     实际点击落在原生 select 上。零风险，且原生下拉在任何环境都能用。
 *
 * ★ 为什么只给「已绑定到槽」的 chip 加下拉：
 *   没绑槽的 @xxx 只是一段文字，没有「用途」可言。
 *   给它加下拉会让用户以为改了有用，其实没用 —— 那是假控件。
 */
/**
 * ★★★ 2026-10-21 新增：chip 的悬停大图预览
 *
 * 主人要求：「实在做不了鼠标放上去就展示预览，就放一个按钮吧」
 *  → 做得到，而且比按钮好（少一次点击）。
 *
 * —— 为什么用 fixed + 手动挂到 body：
 *   高亮层的祖先链上有 overflow:hidden（要与 textarea 对齐），
 *   浮层若放在 chip 内部会被裁掉。
 *   position:fixed 的元素只要祖先没有 transform/filter/perspective
 *   就不受裁切影响 —— 但这一点不能靠赌，
 *   所以直接把节点 append 到 document.body，彻底脱离那条祖先链。
 *
 * —— 为什么用鼠标事件而不是 CSS :hover：
 *   需要在「浮层出现的位置」上做翻转计算（靠近右边缘/底边时反向弹出），
 *   CSS 做不到条件翻转。
 */
let chipPreviewEl = null;

/**
 * ★★ 2026-10-21 修（实测发现残留空节点）
 *
 * 原来的实现只在 chipPreviewEl 非空时 remove。
 * 实测看到：文档里留下一个 0×0、无子元素的 fixed 浮层 ——
 * 因为 img.onload 里调 hideChipPreview 时，
 * **el 已经 append 到 body 了**（append 在设置 onload 之后），
 * 但那次调用发生在 chipPreviewEl 被赋值【之前】还是之后不确定，
 * 一旦时序错开，就漏删。
 *
 * ⇒ 修法：不依赖模块级变量，直接扫 body 上所有带标记的浮层节点删掉。
 *   给它一个 data 属性作为唯一标识，这样无论谁创建的都能清干净。
 */
function hideChipPreview() {
  // ① 按标记全量清理（兜住时序问题）
  try {
    document.querySelectorAll('[data-dsh-chip-preview]').forEach((n) => n.remove());
  } catch { /* ignore */ }
  // ② 再清模块级引用
  if (chipPreviewEl) {
    try { chipPreviewEl.remove(); } catch { /* ignore */ }
    chipPreviewEl = null;
  }
}

function showChipPreview(e, info) {
  hideChipPreview();
  if (!info?.preview) return;

  const SIZE = 180;          // 预览图边长
  const GAP = 10;            // 与鼠标的距离
  const MARGIN = 8;          // 与视口边缘的最小距离

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 默认在鼠标【上方】弹出：文本区通常在页面下方，向下弹会被视口裁掉
  let left = e.clientX - SIZE / 2;
  let top = e.clientY - SIZE - GAP;

  // 水平方向：靠近左右边缘时夹回来
  left = Math.max(MARGIN, Math.min(left, vw - SIZE - MARGIN));
  // 垂直方向：上方空间不够就翻到下方
  if (top < MARGIN) top = e.clientY + GAP;
  // 下方也不够就夹到视口内
  top = Math.max(MARGIN, Math.min(top, vh - SIZE - MARGIN));

  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  // ★ 唯一标记：hideChipPreview 靠它全量清理，避免时序问题留下残留节点
  el.setAttribute("data-dsh-chip-preview", "1");
  el.style.cssText = [
    "position:fixed",
    `left:${left}px`, `top:${top}px`,
    `width:${SIZE}px`, `height:${SIZE}px`,
    "z-index:2147483647",
    "pointer-events:none",
    "border-radius:8px",
    "overflow:hidden",
    "background:#000",
    "box-shadow:0 8px 24px rgba(0,0,0,.28), 0 0 0 1px rgba(65,118,230,.5)",
  ].join(";");

  const img = document.createElement("img");
  img.src = info.preview;
  img.alt = info.names?.[0] ?? "";
  img.style.cssText = `width:100%;height:100%;object-fit:contain;display:block`;

  /**
   * ★★ 2026-10-21 补：小图不放大
   *
   * 实测（主人截图可见）：资产库里有一张 166 字节的 1×1 PNG（探针图），
   * 悬停后它被 object-fit:contain 放大成 180×180 的纯色块 ——
   * 既没有信息量，又挡住界面。
   *
   * ⇒ 加载完成后判 naturalWidth：
   *     < 16px  ⇒ 直接不弹（这种尺寸不可能是用户真正想看的图）
   *     否则     ⇒ 正常显示
   *   ★ 用 img.onload 而不是同步判 —— createObjectURL 的解码是异步的，
   *     同步读 naturalWidth 一定是 0。
   */
  el.appendChild(img);
  document.body.appendChild(el);
  /**
   * ★ 赋值必须在 onload 之前 —— 否则 onload 里调 hideChipPreview 时
   *   chipPreviewEl 还是 null，那个节点就漏删了（实测留下了 0×0 残留）。
   *   hideChipPreview 现在还会按 data-dsh-chip-preview 全量扫一遍，双保险。
   */
  chipPreviewEl = el;

  img.onload = () => {
    if (img.naturalWidth > 0 && img.naturalWidth < 16) {
      hideChipPreview();
      return;
    }
    // 小于 SIZE 的图按原尺寸显示，不放大 —— 放大只会变糊
    const w = img.naturalWidth, h = img.naturalHeight;
    if (w > 0 && h > 0 && Math.max(w, h) < SIZE) {
      el.style.width = `${Math.max(64, w)}px`;
      el.style.height = `${Math.max(64, h)}px`;
    }
  };
}

function PromptHighlight({ text, height, scrollTop, refEl, chips, onRoleChange }) {
  const parts = useMemo(() => {
    const out = [];
    const re = /@([^\s@]{1,120})/g;
    let last = 0, m;
    while ((m = re.exec(String(text ?? ""))) !== null) {
      if (m.index > last) out.push({ t: "plain", v: text.slice(last, m.index) });
      out.push({ t: "at", v: m[0] });
      last = m.index + m[0].length;
    }
    if (last < String(text ?? "").length) out.push({ t: "plain", v: text.slice(last) });
    return out;
  }, [text]);

  /**
   * 名字 → chip 信息（用途 + 所属槽）。
   * ★ 用 name 做 key 而不是整段文本：同一张图在正文里可能出现多次，
   *   它们应该显示同一个 tag（绑定是按槽的，不是按出现次数）。
   */
  const chipMap = useMemo(() => {
    const m = new Map();
    for (const c of chips ?? []) {
      for (const nm of c.names ?? []) if (nm) m.set(nm, c);
    }
    // ★ 2026-10-21 删除临时探针 window.__CHIP_DEBUG__
    //   它由 2026-10-20 那次「chip 里没有缩略图」的诊断留下（原文写着
    //   「把 chipMap 的内容挂到 window 上，用真值判断 preview 有没有传过来」）。
    //   那次诊断已经完成，结论落在 AGENTS §6.16 / verify-role-contract。
    //   留着它有三个害处：
    //     ① 每次渲染都往 window 上重建数组，长会话累积
    //     ② 它把资产名、用途 id 复制到全局变量，等于泄露用户数据面
    //     ③ 后人读代码会以为它有用，不敢删
    //   判据（可复跑）：grep -c "__CHIP_DEBUG__" src/*.js lib/*.js → 0
    return m;
  }, [chips]);

  const hasAt = parts.some((p) => p.t === "at");
  if (!hasAt) return null;

  const CHIP_SHADOW_BASE =
    "inset 0 0 0 100vmax rgba(65,118,230,.10), inset 0 0 0 1px rgba(65,118,230,.30)";
  const CHIP_SHADOW_TAG =
    "inset 0 0 0 100vmax rgba(65,118,230,.10), inset 0 0 0 1px rgba(65,118,230,.30), inset 3px 0 0 rgba(65,118,230,.60)";

  return h("div", {
    ref: refEl,
    style: {
      position: "absolute", inset: 0,
      /**
       * ★★ 2026-10-20 实测修（关键）：
       *
       *   原来没有 z-index，高亮层在 DOM 里排在 textarea 之前
       *   ⇒ textarea 盖在它上面 ⇒ chip 里的 select 永远点不到。
       *   实测判据：elementFromPoint(chip 右端) 命中 TEXTAREA 而不是 SELECT。
       *
       *   修法：z-index:2 把高亮层提到 textarea 之上，
       *   但整层仍是 pointer-events:none —— 只有 chip 那一小块
       *   （以及 chip 里的 select）打开了 pointer-events:auto。
       *   ⇒ 正文其他地方的点击/选中/光标定位仍然落在 textarea 上，
       *     不受影响（这正是这条改法安全的原因）。
       */
      zIndex: 2,
      pointerEvents: "none",
      boxSizing: "border-box",
      // ★ 必须与 textarea 完全一致：字体/行高/内边距/换行
      padding: "4px 0",
      fontFamily: "inherit", fontSize: 14, lineHeight: "24px", fontWeight: 400,
      whiteSpace: "pre-wrap", wordBreak: "break-word", overflow: "hidden",
      color: "transparent",
      transform: "translateY(" + (-scrollTop) + "px)",
    },
  },
    ...parts.map((p, i) => {
      if (p.t !== "at") {
        return h("span", {
          key: i, "aria-hidden": "true", style: { color: "transparent" },
        }, p.v);
      }

      const nm = p.v.slice(1);
      const info = chipMap.get(nm) ?? null;
      const hasTag = !!(info && info.roleId);

      return h("span", {
        key: i,
        "aria-hidden": hasTag ? undefined : "true",
        style: {
          // ★★ 2026-10-20 内联 chip（主人：「把那个小卡片放在正文中 @韩立 这个部分」）
          //   文字仍透明（textarea 的字在上面透出来），只画胶囊底。
          borderRadius: 6,
          background: "transparent",
          opacity: 1,
          color: "transparent",
          boxShadow: hasTag ? CHIP_SHADOW_TAG : CHIP_SHADOW_BASE,
          position: "relative",
          /**
           * ★★★ 2026-10-21 反复修了两版，最终结论：不在这里加 padding
           *
           * 第一版：缩略图 left:-18px（chip 外侧）⇒ 压住前一个词
           * 第二版：缩略图 left:2px + chip paddingLeft:17px ⇒ 仍像重影
           *   实测原因（不是 padding 没生效，是它生效了反而更糟）：
           *     chip0 的 x 范围 1014~1270（宽 256px），
           *     而它对应的文字只有约 110px，多出来的是右侧那个 select。
           *     padding 让胶囊整体右移 17px ⇒ 胶囊右缘顶进了
           *     后一个 chip 的文字区，两层透明文字叠在一起 = 重影。
           *
           * ⇒ 正确的做法：缩略图【不占任何空间】，也不改 chip 内边距。
           *   它画在 chip 的左侧【上沿之外】（top 负值），
           *   像一个小角标，完全不碰文字行。
           *   这样既能看到是哪张图，又绝不产生任何位移或重叠。
           */
          paddingLeft: 0,
          boxSizing: "border-box",
          // ★ chip 里的 select 要能点，这一小块必须打开 pointer-events
          pointerEvents: hasTag ? "auto" : "none",
        },
      },
        /**
         * ★★ 2026-10-20 补（主人：「文本框里面的卡片没有预览！！！」）
         *
         *   chip 要能看出引用的**是哪张图**，不能只有名字。
         *
         *   ★ 为什么用 position:absolute 而不是在文字前插一个 <img>：
         *     高亮层的文字必须与 textarea 逐像素对齐 ——
         *     在行内插入一个 16px 的图会把后面所有字挤开几像素，
         *     于是「蓝色胶囊」和「真正的文字」错位，看起来像重影。
         *     ⇒ 缩略图绝对定位到 chip 左侧外缘，**不参与行内布局**。
         *
         *   ★ 为什么 left 用负值：
         *     chip 左边就是 `@` 字符，图放到 chip 内部会盖住文字。
         *     放到左边外侧（-18px）刚好在 @ 前面，视觉上像「标签前缀」。
         */
        /**
         * ★★★ 2026-10-21 主人要求：
         *   「实在做不了鼠标放上去就展示预览，就放一个按钮吧」
         *
         * —— 做得到，而且这是更好的方案（不用多一次点击）：
         *   鼠标停在 chip 上 → 在鼠标附近浮出一张 180px 的大预览图。
         *
         * —— 实现要点（都是踩过的坑）：
         *   ① 用 onMouseEnter/onMouseLeave 挂在 chip 的 span 上，
         *      但缩略图本身 pointerEvents:none，不会自己触发
         *   ② 浮层用 position:fixed + z-index 极大值 ——
         *      不能挂在 chip 内部（祖先 overflow:hidden 会裁掉）
         *      所以直接用 portal 到 body 的做法：fixed 定位不受没设置
         *      transform 的祖先影响
         *   ③ 浮层要避开双击选字：pointerEvents:none
         *   ④ 位置要翻转：靠近右边缘时向左弹出，靠近底部时向上弹出
         *      （实测文本区在页面下方，向下弹会被裁）
         *
         * ★ 浮层状态用一个 ref 保存，避免每次 hover 都重渲染整个
         *   高亮层（那是逐字符对齐的，重渲染有闪烁风险）。
         */
        info && info.preview && info.kind === "image"
          ? h("img", {
              src: info.preview,
              alt: "",
              "aria-hidden": "true",
              onMouseEnter: (e) => showChipPreview(e, info),
              onMouseLeave: hideChipPreview,
              style: {
                position: "absolute",
                left: 0,
                top: "50%", transform: "translateY(-50%)",
                width: 13, height: 13,
                borderRadius: 3,
                objectFit: "cover",
                boxShadow: "0 0 0 1px rgba(65,118,230,.35)",
                // ★ 缩略图要能触发 hover，所以不能是 none
                pointerEvents: "auto",
                cursor: "zoom-in",
                zIndex: 1,
              },
            })
          : null,
        // 非图片素材：用一个小图标占同样的位置，保持视觉节奏一致
        info && !info.preview && info.kind && info.kind !== "image"
          ? h("span", {
              "aria-hidden": "true",
              style: {
                position: "absolute",
                left: 0, top: "50%", transform: "translateY(-50%)",
                fontSize: 10, lineHeight: "13px", width: 13, textAlign: "center",
                opacity: 0.75, pointerEvents: "none",
                zIndex: 1,
              },
            }, info.kind === "video" ? "🎬" : info.kind === "audio" ? "🎵" : "📄")
          : null,
        p.v,
        hasTag ? buildTagSelect({ info, nm, onRoleChange }) : null
      );
    })
  );
}

/**
 * chip 右侧那个「透明原生 select」—— 点它就能换用途。
 *
 * ★ 为什么用透明原生 select 而不是自绘下拉：
 *   高亮层与 textarea 逐像素对齐，但焦点永远在 textarea 上。
 *   自绘下拉要自己处理「点外面关闭 / 键盘导航 / 滚动跟随」，
 *   而原生 select 任何环境都能用、点了就弹系统菜单 ⇒ 零风险。
 *
 * ★ 为什么宽度用 em：chip 宽度随名字长短变化
 *   （@韩立 vs @Krea2-USD-20261018_00008_），
 *   固定 px 会在短名字上溢出、长名字上够不着右端。
 */
/**
 * chip 里那个「tag 显示 + 可点切换」的组合。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-20 第二次修（主人指着截图：「没有 tag 显示，也没有 tag 修改」）
 *
 *   第一版我做错了：把 <select> 设成 opacity:0 盖在 chip 右侧，
 *   想的是「透明但可点」。结果 tag 文字完全看不见 —— 用户既看不到
 *   当前用途，也不知道那里能点。
 *
 *   ★ 这个错误的性质：我把「让下拉的默认外观不干扰视觉」
 *     错做成了「让整个控件不可见」。
 *     控件的可见性是它能不能被发现的前提，不能拿来当美观手段。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 现在的做法（三层）
 *
 *   ① 可见层：chip 右侧画「用途中文名 + ▾」（纯 <span>，正常可见）
 *   ② 点击层：一个透明的 <select> 精确盖在①上面 —— 点它弹系统菜单
 *      ★ 它透明是为了不重复渲染一份文字（那会和①的文字重叠），
 *        但它的【位置和大小等于①】，所以用户点到的就是看到的。
 *   ③ 提示层：title 写明「角色外观 → <Subject>　点击切换用途」
 *
 *   这样三个诉求同时满足：看得见 tag、点得到、能改。
 */
function buildTagSelect({ info, nm, onRoleChange }) {
  const label = info.roleZh ?? info.roleId;
  const tag = info.roleTag ?? "Subject";

  return h("span", {
    style: {
      position: "relative",
      display: "inline-flex", alignItems: "center",
      gap: 1, marginLeft: 4,
      // ★ 可见层的样式：与 chip 同一色系，稍深一点以便区分
      padding: "0 3px", borderRadius: 4,
      background: "rgba(65,118,230,.16)",
      pointerEvents: "auto",
    },
    title: `${label} → <${tag}>\n点击切换用途（改完即保存到资产库）`,
  },
    // ① 可见文字（用途中文名 + 小三角）
    h("span", {
      "aria-hidden": "true",
      style: {
        fontSize: 11, lineHeight: "19px",
        color: "rgba(38,86,190,.95)",
        fontWeight: 500,
        whiteSpace: "nowrap",
        // ★ 名字太长时截断，否则会把 chip 撑得很长
        maxWidth: "5.5em", overflow: "hidden", textOverflow: "ellipsis",
      },
    }, label),
    h("span", {
      "aria-hidden": "true",
      style: { fontSize: 8, lineHeight: "19px", color: "rgba(38,86,190,.75)" },
    }, "▾"),

    // ② 透明点击层 —— 精确覆盖上面那两块
    h("select", {
      value: info.roleId,
      onChange: (e) => onRoleChange?.(info, e.target.value),
      title: `${label} → <${tag}>\n点击切换用途（改完即保存到资产库）`,
      "aria-label": "用途：" + nm,
      style: {
        position: "absolute", inset: 0,
        /**
         * ★★★ 2026-10-21 修（主人：「这个卡片的框不是跟随文字了」）
         *
         * —— 根因：select 的【原生 option 文本】参与了宽度计算。
         *   实测：可见文字只有约 60px，但 chip 被撑到 239px。
         *   因为 <select> 里是 10 个用途选项（动作/表情、角色外观、
         *   物品/道具外观、场景/环境…），浏览器按【最长选项】算 select 的
         *   固有宽度，而 select 的 width:100% 又反过来把这个宽度
         *   传给了外层 chip ⇒ 胶囊比文字长出一大截。
         *
         * —— 修法：width:0 + minWidth:100%
         *   width:0 让 select 的固有宽度不参与父级计算；
         *   minWidth:100% 保证它仍能盖住可见层（点击区域不缩小）。
         *   这是「不占位但铺满」的标准写法。
         *
         * —— 判据：chip 的 getBoundingClientRect().width 应≈ 可见文字宽度
         *   （实测修前 239px / 修后应 ≈100px）
         */
        width: 0, minWidth: "100%",
        height: "100%",
        // ★ 透明但占满位置：用户点到的就是看到的（① 的文字）
        opacity: 0,
        cursor: "pointer", border: 0, padding: 0, margin: 0,
        appearance: "none", WebkitAppearance: "none",
        fontFamily: "inherit",
        background: "transparent",
        color: "transparent",
        pointerEvents: "auto",
      },
    },
      ...(info.roleOptions ?? []).map((o) =>
        h("option", { key: o.value, value: o.value }, o.text)
      )
    )
  );
}

/* ── 槽选择小浮层（槽都满时）─────────────────────────────────────── */

function SlotChooser({ kind, media, files, onPick, onClose, onTextOnly }) {
  const slots = Object.entries(media ?? {}).filter(([, spec]) => !spec?.kind || spec.kind === kind);
  return createPortal(
    h(React.Fragment, null,
      h("div", { onClick: onClose, style: { position: "fixed", inset: 0, zIndex: 99998 } }),
      h("div", {
        style: {
          position: "fixed", left: "50%", top: "50%", transform: "translate(-50%,-50%)",
          zIndex: 99999, width: 320, boxSizing: "border-box", padding: 12,
          borderRadius: 12, background: "var(--dsw-alias-bg-layer-1, #fff)",
          boxShadow: "0 0 0 0.5px rgba(0,0,0,.12), 0 10px 32px rgba(0,0,0,.18)",
          color: "var(--dsw-alias-label-primary, #0f1115)",
          fontFamily: "inherit", fontSize: 12, lineHeight: "18px",
        },
      },
        h("div", { style: { fontWeight: 600, marginBottom: 8 } },
          "槽都满了 —— 替换哪一个？"),
        ...slots.map(([slot, spec]) =>
          h("button", {
            key: slot,
            type: "button",
            onClick: () => onPick(slot),
            style: {
              display: "block", width: "100%", textAlign: "left",
              marginBottom: 6, padding: "6px 8px", borderRadius: 8, border: 0,
              background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
              color: "inherit", fontFamily: "inherit", fontSize: 12,
              cursor: "pointer",
            },
          },
            h("div", null, spec?.label ?? slot),
            h("div", {
              style: {
                fontSize: 11, opacity: .65,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              },
            }, "现在：" + (files?.[slot]?.displayName || files?.[slot]?.filename || "（空）"))
          )
        ),
        h("button", {
          type: "button",
          onClick: onTextOnly,
          style: {
            display: "block", width: "100%", textAlign: "center",
            marginTop: 4, padding: "6px 8px", borderRadius: 8, border: 0,
            background: "transparent",
            color: "var(--dsw-alias-label-tertiary, #81858c)",
            fontFamily: "inherit", fontSize: 12, cursor: "pointer",
          },
        }, "只作文本引用（不进工作流）")
      )
    ),
    document.body
  );
}

/* ── 完整资产库面板 ───────────────────────────────────────────────── */

/**
 * 「全局资产库」面板本身 —— 浏览 / 筛选 / 搜索 / 收藏 / 重命名 / 删除。
 * 它是浮层（portal 到 body），不占布局、不挤动 DSH 原生元素（验收第 ⑤ 条）。
 */
function LibraryPanel({ lib, onClose, onInsert, media, files, t, pickMode, pickKinds, onPickConfirm }) {
  /**
   * ★★ 2026-10-20 加 pickMode / pickKinds（ArtCraft 的 assetGallery 选择器）
   *
   *   主人定的顺序：「先做后端，再匹配前端 ui」。
   *   后端（artcraft-adapter.mjs 的 openPicker）已就绪，这里补它的界面。
   *
   *   ★ 为什么不新写一个选择器组件，而是给 LibraryPanel 加两个可选参数：
   *     现有面板已有 11 个内部 state、虚拟滚动、文件夹分组、搜索、
   *     上传入库、改名、删除、回收站 —— 复制一份出来就是两套要同步维护的 UI。
   *     而「选资产」和「管资产」本来就该是同一块界面，只是出口不同。
   *
   *   ★ 不传这两个参数时，行为与之前【完全一致】。
   *     pickMode     true 时：顶部显示「选择」语义、卡片点击即选中、底部有确认栏
   *     pickKinds    ArtCraft 传的 kinds（如 ["video"]），非空时过滤掉不合格的类型
   */
  const [kind, setKind] = useState("all");
  const [src, setSrc] = useState("all");
  const [q, setQ] = useState("");
  const [favOnly, setFavOnly] = useState(false);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [big, setBig] = useState(null);
  // ★ 2026-10-20：上传入库的两个状态
  //   uploading —— 上传中（禁用按钮，避免连点传两遍）
  //   namePrompt —— 「确认名字」弹窗：{ id, defaultName, filename, folder }
  const [uploading, setUploading] = useState(false);
  const [namePrompt, setNamePrompt] = useState(null);
  // ★ 2026-10-20：新建项目文件夹的弹窗
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  // ★ 2026-10-20：localStorage 里「已知文件夹」变了要重算 knownFolders，
  //   但 localStorage 不能直接进依赖数组（每次读都是新值 → 无限重算）
  //   ⇒ 用这个计数器当触发器
  const [knownBump, setKnownBump] = useState(0);
  const [trash, setTrash] = useState([]);

  /**
   * ★★ 2026-10-20 pickMode 的多选状态（ArtCraft 的 openPicker 允许一次选多个）
   *
   *   用 Set 而不是数组：选中判断是 O(1)，且天然去重。
   *   存 id 而不是整个 item：item 会随 lib.reload() 换新对象，
   *   存对象会导致「重载后选中全丢」。
   */
  const [picked, setPicked] = useState(() => new Set());

  /**
   * ArtCraft 只要 image/video/audio 三种（见它的 MediaKind）。
   * pickKinds 非空时，把不符合的挡掉 —— 否则用户会选到一个
   * 拖不进时间轴的幽灵条目。
   */
  const pickAllowed = useMemo(() => {
    if (!pickMode) return null;
    const k = Array.isArray(pickKinds) && pickKinds.length ? pickKinds : null;
    return k ? new Set(k) : null;
  }, [pickMode, pickKinds]);

  const items = useMemo(() => {
    let out = lib.items ?? [];
    /**
     * ★ pickAllowed 在 kind 筛选【之前】生效：
     *   即使面板当前显示「全部」，pickMode 下也只列能用的类型。
     */
    if (pickAllowed) out = out.filter((i) => pickAllowed.has(i.kind));
    if (kind !== "all") out = out.filter((i) => i.kind === kind);
    if (src !== "all") out = out.filter((i) => i.src === src);
    if (favOnly) out = out.filter((i) => i.fav);
    const s = q.trim().toLowerCase();
    if (s) {
      out = out.filter((i) =>
        String(i.displayName).toLowerCase().includes(s) ||
        String(i.name).toLowerCase().includes(s) ||
        String(i.rel).toLowerCase().includes(s) ||
        // ★ 2026-10-20：角色名也参与（跨项目角色卡桥过来的字段）
        String(i.character ?? "").toLowerCase().includes(s)
      );
    }
    return out;
  }, [lib.items, kind, src, q, favOnly, pickAllowed]);

  /**
   * ★★ 2026-10-20 按项目文件夹分组（主人：「资产库要分好项目文件夹，
   *   两个不相关的项目不要混在一起，不过支持 @ 的时候能搜到」）。
   *
   * 排序：有名字的文件夹按名字排，**「未归类」永远最后** ——
   *   新资产默认没文件夹，把它排前面会挡住有组织的那部分。
   *
   * 注意：这里只影响【面板显示】。@ 搜索走的是 atFiltered，
   *   它不经过这里 ⇒ 跨文件夹也能搜到（正是主人要的）。
   */
  const byFolder = useMemo(() => {
    const map = new Map();
    for (const it of items) {
      const key = it.folder || "";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(it);
    }
    const named = [...map.keys()].filter((k) => k).sort();
    const order = [...named, ...(map.has("") ? [""] : [])];
    return order.map((folder) => ({ folder, list: map.get(folder) ?? [] }));
  }, [items]);

  /**
   * ★★ 2026-10-20 虚拟滚动（性能修复）。
   *
   * ══════════════════════════════════════════════════════════════════════
   * 为什么必须做
   *
   *   实测（829 张卡 / 29,569 个 DOM 节点）：
   *     滚动 60 帧：平均 116.1ms/帧 → 9 FPS
   *     p95 = 230.1ms   max = 247.2ms
   *   ⇒ 不是「可能卡」，是实测确认卡。每张卡带两个 <select>（用途 + 文件夹），
   *     829 × 2 = 1658 个 select，每个 12~13 个 option ⇒ 约 2 万个节点。
   *
   * ══════════════════════════════════════════════════════════════════════
   * 做法（不引依赖，自己算行）
   *
   *   ① 按容器宽度算列数：cols = floor((w + GAP) / (MIN_CARD + GAP))
   *   ② 每张卡高度固定 CARD_H（缩略图 108 + 名称/信息 + 操作行）
   *   ③ 只渲染 [firstRow - OVERSCAN, lastRow + OVERSCAN] 区间的行
   *   ④ 上下用空 div 撑出「没渲染的那些行」的高度，滚动条长度保持不变
   *
   *   ★ 为什么用「行」而不是「项」：网格是多列的，
   *     按项算会让同一行的卡片出现/消失不同步，视觉上会闪。
   *   ★ 为什么高度固定：卡片内容都是定高（缩略图 108 + 三个文本行 + 22px 操作行），
   *     没有可变高度内容。这让计算简单且不会错位。
   *
   * ══════════════════════════════════════════════════════════════════════
   * 为什么不用 react-window
   *
   *   它是依赖（+约 6KB gzip），而这里只需要「按行切片 + 撑高度」约 60 行代码。
   *   而且它不直接支持「分组标题 + 网格」这种混合布局，
   *   要用得自己包一层，反而更绕。
   */

  const CARD_W = 168;     // 与 gridTemplateColumns 的 minmax 一致
  const CARD_H = 214;     // 实测单卡总高（缩略图 108 + 文本 + 操作行）
  const GAP = 10;
  const OVERSCAN = 2;     // 视口外多渲染 2 行，滚动时不会看到空白

  /** 网格列数（随容器宽度变）。 */
  const colsOf = useCallback((w) => {
    if (!w || w < CARD_W) return 1;
    return Math.max(1, Math.floor((w + GAP) / (CARD_W + GAP)));
  }, []);

  /**
   * 渲染按文件夹分组的卡片区（虚拟滚动版）。
   *
   * ★ 为什么抽成函数：之前内联在 JSX 里，嵌套到了 8 层，
   *   我连改 6 次都在同一处配错括号（每次都只差一两个） 。
   *   ⇒ 结构复杂度必须往下沉到普通函数，不要留在 JSX 表达式中。
   *
   * ★ 卡片本体仍由 renderCard 渲染（下面），这里只负责分组、切片与撑高。
   */
  function renderGroupedCards() {
    const viewH = viewportRef.current?.clientHeight ?? 600;
    // 「累计到当前分组之前」的高度 —— 每个分组自己的偏移要加上它
    let acc = 0;
    const out = [];

    for (let gi = 0; gi < byFolder.length; gi++) {
      const sec = byFolder[gi];
      const folder = sec.folder;
      const list = sec.list;
      const cols = colsOf(viewportW);
      const rows = Math.ceil(list.length / cols);

      const hasHead = byFolder.length > 1;
      const headH = hasHead ? 26 : 0;          // 标题 + marginBottom
      const sectionH = headH + rows * CARD_H + (rows - 1) * 0 + GAP;  // 组间靠外层 gap

      // 这个分组在总内容里的纵向区间
      const secTop = acc;
      const secBottom = acc + sectionH;

      // 整组都在视口外 → 只撑高，不渲染
      if (secBottom < scrollTop - viewH * OVERSCAN * 0.5 ||
          secTop > scrollTop + viewH * (1 + OVERSCAN * 0.5)) {
        out.push(h("div", { key: "sp-" + (folder || "__none"), style: { height: sectionH } }));
        acc = secBottom + 14;   // 外层 flex gap
        continue;
      }

      // 组内可视行区间
      const localTop = scrollTop - secTop - headH;
      const firstRow = Math.max(0, Math.floor((localTop - viewH * OVERSCAN * 0.5) / CARD_H));
      const lastRow = Math.min(
        rows - 1,
        Math.ceil((localTop + viewH * (1 + OVERSCAN * 0.5)) / CARD_H)
      );

      const startIdx = firstRow * cols;
      const endIdx = Math.min(list.length, (lastRow + 1) * cols);
      const visible = list.slice(startIdx, endIdx);

      const padTop = firstRow * CARD_H;
      const padBottom = Math.max(0, rows * CARD_H - (lastRow + 1) * CARD_H);

      out.push(h("div", { key: "sec-" + (folder || "__none") },
        hasHead
          ? h("div", {
              style: {
                display: "flex", alignItems: "center", gap: 6,
                marginBottom: 6, fontSize: 12, fontWeight: 600,
                color: folder
                  ? "var(--dsw-alias-label-primary, #0f1115)"
                  : "var(--dsw-alias-label-tertiary, #81858c)",
              },
            },
              h("span", { style: { fontSize: 13, opacity: 0.7 } }, folder ? "📁" : "📂"),
              folder || "未归类",
              h("span", { style: { fontSize: 11, fontWeight: 400, opacity: 0.55 } },
                list.length + " 项")
            )
          : null,
        // 上垫片
        padTop > 0 ? h("div", { style: { height: padTop } }) : null,
        h("div", {
            style: {
              display: "grid", gap: GAP,
              gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_W}px, 1fr))`,
            },
          },
          ...visible.map(function (it) { return renderCard(it); })
        ),
        // 下垫片
        padBottom > 0 ? h("div", { style: { height: padBottom } }) : null
      ));

      acc = secBottom + 14;
    }

    return h("div", {
        style: { display: "flex", flexDirection: "column", gap: 14 },
      },
      ...out
    );
  }

  /**
   * 单张资产卡（2026-10-20 从内联 JSX 抽出来）。
   *
   * 抽出理由：它原来嵌在 items.map 里，外面还套着 byFolder.map + grid，
   * 三层 JSX 让括号根本数不清。现在卡片自己是一个普通函数，
   * 要改卡片样式只改这里，不用碰分组逻辑。
   */
  function renderCard(it) {
    const thumbH = 108;
    const isImg = it.kind === "image";
    const canInsert = !!onInsert;

    return h("div", {
        key: it.id,
        style: {
          display: "flex", flexDirection: "column",
          borderRadius: 10, overflow: "hidden",
          background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,.02))",
          boxShadow: "0 0 0 0.5px var(--dsw-alias-border-l2, rgba(0,0,0,.08))",
        },
      },
      // 缩略图区
      h("div", {
          onClick: () => setBig(it),
          title: "点击放大",
          style: {
            position: "relative", height: thumbH, flex: "none",
            background: "rgba(128,128,128,.10)", cursor: "zoom-in",
            display: "flex", alignItems: "center", justifyContent: "center",
          },
        },
        isImg
          ? h("img", {
              src: assetThumbUrl(it), alt: "", loading: "lazy",
              style: { width: "100%", height: "100%", objectFit: "cover" },
            })
          : it.kind === "audio"
            ? h(AudioCardButton, { item: it })
            : h("span", { style: { fontSize: 26 } }, KIND_META[it.kind]?.icon ?? "📦"),
        // 收藏角标
        h("button", {
          type: "button",
          onClick: (e) => { e.stopPropagation(); doFav(it); },
          title: it.fav ? "取消收藏" : "收藏（收藏的排在 @ 选择器最前面）",
          style: {
            position: "absolute", right: 5, top: 5,
            width: 22, height: 22, border: 0, borderRadius: 999,
            cursor: "pointer", fontSize: 12, lineHeight: "22px", padding: 0,
            background: "rgba(0,0,0,.42)",
            color: it.fav ? "#ffce3d" : "rgba(255,255,255,.85)",
          },
        }, it.fav ? "★" : "☆")
      ),

      // 名称 + 元信息
      h("div", {
          style: { padding: "6px 8px 4px", minWidth: 0 },
        },
        h("div", {
            style: {
              fontSize: 12, fontWeight: 500, lineHeight: "16px",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            },
            title: it.displayName,
          }, it.displayName),
        h("div", {
            style: {
              fontSize: 10, lineHeight: "14px", opacity: 0.6,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            },
          },
          (SRC_META[it.src]?.label ?? it.src ?? "") + " · " + fmtSize(it.sizeBytes ?? 0))
      ),
      // 操作区：3 个常显 + popover 收纳低频操作
      // ★ 2026-10-21：原来 7 个一字排开，实测 6 个溢出卡片右边界（最多 172px）
      //   ⇒ 分成「高频 3 个常显」+「低频 5 个进 popover」
      h("div", {
          style: {
            display: "flex", alignItems: "center", gap: 2,
            padding: "2px 6px 6px",
            // ★ 超宽时不许溢出到隔壁卡片：允许内部压缩，不许 nowrap 撑破
            minWidth: 0, overflow: "hidden",
          },
        },
        // ★ 2026-10-21：用途下拉允许被压缩（否则 145px 会把「更多」挤出卡片）
        h("div", {
            style: {
              flex: "1 1 auto", minWidth: 0, overflow: "hidden",
              display: "flex", alignItems: "center",
            },
          },
          h(RoleSelect, { item: it, onSaved: onSavedStable }),
        ),
        pickMode
          ? h("button", {
              type: "button",
              onClick: () => {
                setPicked((prev) => {
                  const next = new Set(prev);
                  if (next.has(it.id)) next.delete(it.id); else next.add(it.id);
                  return next;
                });
              },
              title: picked.has(it.id) ? "取消选择" : "选择这个资产",
              "aria-pressed": picked.has(it.id),
              style: {
                height: 22, padding: "0 8px", border: 0, borderRadius: 6,
                cursor: "pointer", flex: "0 0 auto",
                background: picked.has(it.id)
                  ? "var(--dsw-alias-state-business-primary, #4176e6)"
                  : "transparent",
                color: picked.has(it.id)
                  ? "var(--dsw-alias-label-primary-foreground, #fff)"
                  : "var(--dsw-alias-label-secondary, #61666b)",
                boxShadow: picked.has(it.id)
                  ? "none"
                  : "inset 0 0 0 0.5px var(--dsw-alias-border-l2, rgba(0,0,0,.12))",
                fontFamily: "inherit", fontSize: 11, lineHeight: "20px",
              },
            }, picked.has(it.id) ? "✓ 已选" : "选择")
          : h("button", {
              type: "button",
              onClick: () => onInsert?.(it),
              disabled: !canInsert,
              title: canInsert ? "插入提示词并绑定到素材槽" : "当前模式没有可绑定的素材槽",
              style: {
                height: 22, padding: "0 8px", border: 0, borderRadius: 6,
                cursor: canInsert ? "pointer" : "not-allowed",
                background: "var(--dsw-alias-state-business-primary, #4176e6)",
                color: "var(--dsw-alias-label-primary-foreground, #fff)",
                fontFamily: "inherit", fontSize: 11, lineHeight: "20px",
                flex: "0 0 auto",
                opacity: canInsert ? 1 : .4,
              },
            }, "@引用"),
        // ★ 2026-10-21：低频操作收进这里
        h(CardMoreButton, {
          item: it,
          folders: knownFoldersRef.current,
          onSaved: onSavedStable,
          onRename: () => setRenaming(it.id),
          onDelete: () => setConfirmDel(it),
        })
      )
        )
  }

  const doFav = async (it) => {
    setBusy(it.id);
    try {
      await mutate({ action: "fav", id: it.id, on: !it.fav });
      await lib.reload();
    } catch (e) { setNote(String(e.message ?? e)); }
    finally { setBusy(null); }
  };

  const doRename = async (it, name) => {
    setBusy(it.id);
    try {
      await mutate({ action: "rename", id: it.id, name });
      setRenaming(null);
      await lib.reload();
    } catch (e) { setNote(String(e.message ?? e)); }
    finally { setBusy(null); }
  };

  const doDelete = async (it) => {
    setBusy(it.id);
    try {
      const r = await mutate({ action: "delete", id: it.id, src: it.src, rel: it.rel });
      if (r.alreadyGone) setNote(`文件已不在磁盘上，已从库里移除：${it.rel}`);
      else setNote(`已移到回收区（可复原）：${r.dest}`);
      setConfirmDel(null);
      await lib.reload();
      // 刷新回收站列表，让「撤销」按钮立刻可用
      refreshTrash();
    } catch (e) { setNote(String(e.message ?? e)); }
    finally { setBusy(null); }
  };

  /**
   * 读取弹窗里三个字段并提交（2026-10-20）。
   * ★ 抽成函数而不是内联在 onClick 里：Enter 键和「确定」按钮都要用，
   *   内联两遍就会写成两份（其中一份迟早忘记改）。
   */
  const submitPrompt = () => {
    const g = (id) => {
      const el = document.getElementById(id);
      return el ? String(el.value ?? "").trim() : "";
    };
    const name = g("wb-name-prompt-input") || namePrompt?.defaultName || "";
    const folder = g("wb-folder-prompt-input");
    const character = g("wb-char-prompt-input");
    const view = g("wb-view-prompt-input");
    confirmName(name, folder, character, view);
  };

  const refreshTrash = useCallback(async () => {
    try {
      const r = await mutate({ action: "trash-list" });
      setTrash(r.items ?? []);
    } catch { setTrash([]); }
  }, []);

  /**
   * 上传入库第一步：选文件 → 上传落盘 → 弹「确认名字」。
   *
   * ★ 为什么先上传再问名字（而不是先问再传）：
   *   用户点「上传」时心里已经选好了文件，先传（1~2 秒）再问名字，
   *   确认框出现时文件已经安全落盘 —— 用户中途取消名字也只是不改名，
   *   不会丢掉已上传的文件。反过来先问名字再传，一旦上传失败，
   *   用户白填一次，还得重来。
   */
  const pickUpload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,video/*,audio/*,.srt,.txt,.md,.json";
    input.multiple = false;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setUploading(true);
      try {
        const r = await uploadToLibrary(file, { folder: "" });
        const kind = file.type.startsWith("video") ? "video"
          : file.type.startsWith("audio") ? "audio"
          : file.type.startsWith("image") ? "image" : "text";
        setNamePrompt({
          id: r.id,
          filename: r.filename,
          defaultName: suggestName(file.name, kind),
          sizeBytes: r.sizeBytes,
        });
        await lib.reload();
      } catch (e) {
        setNote(`上传失败：${e?.message ?? e}`);
      } finally {
        setUploading(false);
      }
    };
    input.click();
  };

  /**
   * 确认入库信息（2026-10-20 扩充）。
   *
   * 主人原话：「弹出来一个窗口，让用户自己填」
   * ⇒ 一个弹窗里填三件事：名字 / 项目文件夹 / 角色（可选）。
   *   不问 LLM 判断归属 —— 客户端拿不到 LLM，
   *   而且让用户直接填比让模型猜再确认更快。
   *
   * @param {string} name     资产名（空 = 用原文件名）
   * @param {string} folder   项目文件夹（空 = 未归类）
   * @param {string} character 角色名（空 = 不是角色定妆图）
   * @param {string} view     视角（character 为空时忽略）
   */
  const confirmName = async (name, folder, character, view) => {
    if (!namePrompt) return;
    const tasks = [];
    if (name !== undefined) tasks.push(saveAliasToLibrary(namePrompt.id, name));
    if (folder) tasks.push(saveFolderToLibrary(namePrompt.id, folder));
    if (character) {
      // ★ 上传流程里用 createIfMissing —— 刚上传的图工作站还没收录
      tasks.push(saveCharacterTag(namePrompt.filename, character, view, true, {
        createIfMissing: true,
        kind: namePrompt.kind,
      }));
    }
    try {
      await Promise.all(tasks);
      const bits = [];
      if (name) bits.push(`名「${name}」`);
      if (folder) bits.push(`放入「${folder}」`);
      if (character) bits.push(`角色「${character}」`);
      setNote(`已入库${bits.length ? "：" + bits.join(" · ") : ""}`);
      setNamePrompt(null);
      await lib.reload();
      setKnownBump((v) => v + 1);   // 新文件夹要立刻出现在下拉里
    } catch (e) {
      setNote(`入库失败：${e?.message ?? e}`);
    }
  };

  /**
   * 已知文件夹清单（2026-10-20）。
   *
   * 来源有两处，合并去重：
   *   ① 资产里已经用到的 folder 值（byFolder 里带名字的那些）
   *   ② localStorage 里手动建过但还没放资产的名字
   *
   * ★ 为什么要 ②：用户刚建完文件夹时里面是空的，
   *   如果清单只从资产推导，那个新名字会立刻消失 —— 看起来像没建成。
   */
  const knownFolders = useMemo(() => {
    const set = new Set();
    for (const it of lib.items ?? []) if (it.folder) set.add(it.folder);
    try {
      const raw = localStorage.getItem("wb-known-folders");
      if (raw) for (const f of JSON.parse(raw)) if (f) set.add(f);
    } catch { /* localStorage 不可用就只用 ① */ }
    return [...set].sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib.items, knownBump]);   // ← knownBump 是 localStorage 变更的触发器（见上）

  /**
   * ★ renderCard 是普通函数（不是组件），它读不到 knownFolders 这个 let 的最新值
   *   —— 因为 renderCard 在每次渲染时重新定义，闭包捕获的应当是【本次】的值。
   *   实测直接用 knownFolders 会因为「定义顺序」报 TDZ（§6.26 同类）。
   *   ⇒ 用 ref 中转：useEffect 里同步，renderCard 里读 ref.current。
   */
  const knownFoldersRef = useRef([]);
  useEffect(() => { knownFoldersRef.current = knownFolders; }, [knownFolders]);

  /**
   * ★★ 2026-10-20 性能：memo 化下拉的前提是【回调引用稳定】。
   *
   *   原来写的是 `onSaved: () => lib.reload()` —— 每次渲染都是新函数，
   *   即使子组件包了 React.memo，浅比较也永远 false ⇒ memo 完全失效。
   *   ⇒ 收成一个 useCallback 常量，引用跨渲染不变。
   */
  const onSavedStable = useCallback(() => { lib.reload(); }, [lib.reload]);

  /* ── 虚拟滚动的三个测量值（2026-10-20）───────────────────────────
   *
   *   viewportRef  —— 滚动容器的 DOM 引用（要在 body 里挂 ref）
   *   scrollTop    —— 当前滚动位置（驱动「渲染哪些行」）
   *   viewportW    —— 容器宽度（决定列数）
   *
   * ★ 为什么用 state 而不是 ref：scrollTop 变了必须触发重渲染，
   *   ref 改了不会重渲染（那张卡片永远停在初始可见范围）。
   * ★ 为什么要 requestAnimationFrame 节流：scroll 事件可能一帧触发多次，
   *   不节流会在一帧内重渲染多次，反而更卡。
   */
  const viewportRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportW, setViewportW] = useState(0);
  const rafRef = useRef(0);

  const onScrollRaf = useCallback((e) => {
    const el = e.currentTarget;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      setScrollTop(el.scrollTop);
    });
  }, []);

  // 容器宽度测量（侧栏开合 / 窗口缩放都要重算列数）
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setViewportW(el.clientWidth);
    measure();
    const ro = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(measure)
      : null;
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  /** 创建一个项目文件夹（只记名字，具体归属用卡片上的下拉设）。 */
  const createFolder = (raw) => {
    const name = String(raw ?? "").trim();
    if (!name) { setNote("文件夹名不能为空"); return; }
    if (name.length > 80) { setNote("文件夹名太长（上限 80）"); return; }
    try {
      const raw2 = localStorage.getItem("wb-known-folders");
      const list = raw2 ? JSON.parse(raw2) : [];
      if (!list.includes(name)) list.push(name);
      localStorage.setItem("wb-known-folders", JSON.stringify(list));
    } catch { /* 存不了也不阻断，本次会话仍能用 */ }
    /**
     * ★★ 2026-10-20 实测修的 bug：
     *   建完之后下拉里看不到新名字 —— 因为 knownFolders 的 useMemo
     *   只依赖 lib.items，localStorage 变了不会触发重算。
     *   ⇒ 用 knownBump 这个计数器强制重算（比把 localStorage 放进依赖更明确：
     *     依赖数组里放 localStorage.getItem(...) 每次渲染都是新值，会无限重算）。
     */
    setKnownBump((v) => v + 1);
    setNewFolderOpen(false);
    setNote(`已创建文件夹「${name}」—— 用资产卡上的文件夹下拉把资产放进去`);
  };

  const doUndoDelete = async (id) => {
    try {
      const r = await mutate({ action: "undo-delete", id });
      setNote(`已复原：${r.restored}`);
      setTrash((cur) => cur.filter((x) => x.id !== id));
      await lib.reload();
    } catch (e) { setNote(String(e.message ?? e)); }
  };

  useEffect(() => { refreshTrash(); }, [refreshTrash]);

  const counts = lib.stats?.byKind ?? {};

  return createPortal(
    h("div", {
      onClick: onClose,
      style: {
        position: "fixed", inset: 0, zIndex: 99990,
        background: "rgba(0,0,0,.32)", backdropFilter: "blur(2px)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24, boxSizing: "border-box",
      },
    },
      h("div", {
        onClick: (e) => e.stopPropagation(),
        style: {
          width: "min(1080px, 94vw)", height: "min(760px, 88vh)",
          display: "flex", flexDirection: "column",
          borderRadius: 16, overflow: "hidden",
          background: "var(--dsw-alias-bg-layer-1, #fff)",
          boxShadow: "0 0 0 0.5px rgba(0,0,0,.12), 0 18px 48px rgba(0,0,0,.26)",
          color: "var(--dsw-alias-label-primary, #0f1115)",
          fontFamily: "inherit", fontSize: 13, lineHeight: "20px",
        },
      },
        // 头部
        h("div", {
          style: {
            flex: "none", display: "flex", alignItems: "center", gap: 10,
            padding: "12px 14px",
            borderBottom: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))",
          },
        },
          /**
           * ★★ 2026-10-20：pickMode 下标题与统计行换成「选择器」语义。
           *
           *   为什么改标题而不只改按钮：
           *     用户从 ArtCraft 点「Browse gallery」进来，需要一眼看出
           *     这【不是】管理资产的界面，而是「挑几个拿回去用」。
           *     标题是唯一的全局信号。
           *
           *   ★ 选中数量显示在标题旁而不是底部，是因为
           *     底部确认栏在长列表滚动时可能不在视野里。
           */
          h("div", { style: { fontWeight: 600, fontSize: 14 } },
            pickMode ? "选择资产" : "全局资产库"),
          pickMode && picked.size
            ? h("span", {
                style: {
                  padding: "0 7px", height: 18, lineHeight: "18px",
                  borderRadius: 9, fontSize: 11,
                  background: "var(--dsw-alias-state-business-primary, #4176e6)",
                  color: "var(--dsw-alias-label-primary-foreground, #fff)",
                },
              }, `已选 ${picked.size}`)
            : null,
          h("span", {
            style: { color: "var(--dsw-alias-label-tertiary, #81858c)", fontSize: 12 },
          }, lib.stats
            ? (pickMode
                // pickMode 下只报「可选的」数量 —— 报总数会让用户以为
                // 剩下的也能选（ArtCraft 只要 3 种类型）
                ? `可选择 ${items.length} 项`
                : `共 ${lib.stats.total} 项 · 图片 ${counts.image ?? 0} / 视频 ${counts.video ?? 0} / 音频 ${counts.audio ?? 0} · 收藏 ${lib.stats.fav}`)
            : (lib.s === "loading" ? "加载中…" : "")
          ),
          h("input", {
            value: q,
            onChange: (e) => setQ(e.target.value),
            placeholder: "搜索文件名…",
            style: {
              marginLeft: "auto", width: 220, height: 28, padding: "0 10px",
              boxSizing: "border-box", border: 0, borderRadius: 8,
              background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
              color: "inherit", fontFamily: "inherit", fontSize: 12, outline: "none",
            },
          }),
          // ★★ 2026-10-20 新增：上传入库按钮。
          //   主人：「只在入资产库的时候提出改名确认就行了，要可编辑，
          //     然后命名可以让 llm 来起一个默认名，用户做最后把关确认」
          //   点击 → 选文件 → 上传落盘 → 弹「确认名字」（可编辑，默认名来自 suggestName）
          h("button", {
            type: "button",
            onClick: () => pickUpload(),
            disabled: !!uploading,
            title: "上传文件到资产库（会上传后让你确认名字）",
            style: {
              height: 28, padding: "0 10px", border: 0, borderRadius: 8,
              cursor: uploading ? "wait" : "pointer",
              background: "var(--dsw-alias-state-business-primary, #4176e6)",
              color: "var(--dsw-alias-label-primary-foreground, #fff)",
              fontFamily: "inherit", fontSize: 12,
              opacity: uploading ? 0.6 : 1,
            },
          }, uploading ? "上传中…" : "＋ 上传"),
          h("button", {
            type: "button", onClick: () => lib.reload(), title: "重新扫描（新产物要刷新才看得到）",
            style: {
              height: 28, padding: "0 10px", border: 0, borderRadius: 8, cursor: "pointer",
              background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
              color: "var(--dsw-alias-label-secondary, #61666b)",
              fontFamily: "inherit", fontSize: 12,
            },
          }, lib.s === "refreshing" ? "刷新中…" : "刷新"),
          h("button", {
            type: "button", onClick: onClose, title: "关闭",
            style: {
              width: 28, height: 28, border: 0, borderRadius: 8, cursor: "pointer",
              background: "transparent", color: "var(--dsw-alias-label-tertiary, #81858c)",
              fontFamily: "inherit", fontSize: 16, lineHeight: "28px",
            },
          }, "×")
        ),

        // 筛选行
        h("div", {
          style: {
            flex: "none", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
            padding: "8px 14px",
            borderBottom: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))",
          },
        },
          ...[["all", `全部 ${lib.stats?.total ?? 0}`],
              ["image", `图片 ${counts.image ?? 0}`],
              ["video", `视频 ${counts.video ?? 0}`],
              ["audio", `音频 ${counts.audio ?? 0}`]].map(([k, label]) =>
            h("button", {
              key: k, type: "button", onClick: () => setKind(k),
              style: {
                height: 24, padding: "0 10px", border: 0, borderRadius: 999, cursor: "pointer",
                fontFamily: "inherit", fontSize: 12, lineHeight: "22px",
                background: kind === k
                  ? "var(--dsw-alias-state-business-primary, #4176e6)"
                  : "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
                color: kind === k
                  ? "var(--dsw-alias-label-primary-foreground, #fff)"
                  : "var(--dsw-alias-label-secondary, #61666b)",
              },
            }, label)
          ),
          h("span", {
            style: { width: 1, height: 16, background: "var(--dsw-alias-border-l2, rgba(0,0,0,.08))" },
          }),
          ...[["all", "全部来源"], ["output", "工作台产物"], ["input", "我上传的"], ["editor", "编辑器素材"]].map(([k, label]) =>
            h("button", {
              key: "src-" + k, type: "button", onClick: () => setSrc(k),
              style: {
                height: 24, padding: "0 10px", border: 0, borderRadius: 999, cursor: "pointer",
                fontFamily: "inherit", fontSize: 12, lineHeight: "22px",
                background: src === k
                  ? "var(--dsw-alias-interactive-bg-active, #e9ecef)"
                  : "transparent",
                color: "var(--dsw-alias-label-secondary, #61666b)",
              },
            }, label)
          ),
          h("button", {
            type: "button", onClick: () => setFavOnly((v) => !v),
            title: "只看收藏",
            style: {
              height: 24, padding: "0 10px", border: 0, borderRadius: 999, cursor: "pointer",
              fontFamily: "inherit", fontSize: 12, lineHeight: "22px",
              background: favOnly ? "rgba(210,153,34,.18)" : "transparent",
              color: favOnly ? "rgb(163,106,3)" : "var(--dsw-alias-label-secondary, #61666b)",
            },
          }, favOnly ? "★ 只看收藏" : "☆ 收藏"),
          // ★★ 2026-10-20 新增：新建项目文件夹。
          //   主人：「文件夹可以是新会话的时候 llm 来判断然后询问用户，
          //     也可以用户自己创建文件夹」
          //   ⇒ 这一颗按钮补上「用户自己创建」这条路径。
          h("button", {
            type: "button",
            onClick: () => setNewFolderOpen(true),
            title: "新建项目文件夹（把不相关的项目分开）",
            style: {
              height: 24, padding: "0 10px", border: 0, borderRadius: 999, cursor: "pointer",
              fontFamily: "inherit", fontSize: 12, lineHeight: "22px",
              background: "transparent",
              color: "var(--dsw-alias-label-secondary, #61666b)",
            },
          }, "＋ 文件夹"),
          h("span", {
            style: {
              marginLeft: "auto", fontSize: 12,
              color: "var(--dsw-alias-label-tertiary, #81858c)",
            },
          }, `${items.length} 项`)
        ),

        // 身体
        h("div", {
          // ★ 2026-10-20：虚拟滚动要读这个容器的 scrollTop / clientWidth / clientHeight
          ref: viewportRef,
          onScroll: onScrollRaf,
          style: {
            flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 12,
            // ★ 加 contain 让浏览器把这一块的重排限制在容器内 ——
            //   829 项 → 只渲染约 24 张后，这条进一步降低整页重排成本
            contain: "layout paint style",
          },
        },
          lib.s === "error"
            ? h("div", {
                style: {
                  padding: 14, borderRadius: 12,
                  background: "rgba(248,81,73,.08)", color: "rgb(207,34,46)",
                  fontSize: 12, lineHeight: "18px", whiteSpace: "pre-wrap",
                },
              }, "资产库加载失败：" + lib.error)
            : lib.s === "loading"
              ? h("div", {
                  style: { padding: 24, textAlign: "center", color: "var(--dsw-alias-label-tertiary, #81858c)" },
                }, "正在扫描产物 / 上传 / 编辑器素材…")
              : items.length === 0
                ? h("div", {
                    style: { padding: 24, textAlign: "center", color: "var(--dsw-alias-label-tertiary, #81858c)" },
                  }, "没有符合筛选条件的资产")
                : renderGroupedCards()
        ),

        // 提示条
        note || trash.length
          ? h("div", {
              style: {
                flex: "none", display: "flex", alignItems: "center", gap: 8,
                padding: "6px 14px",
                borderTop: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))",
                fontSize: 11, lineHeight: "16px",
                color: "var(--dsw-alias-label-tertiary, #81858c)",
              },
            },
              h("span", {
                style: { flex: "1 1 auto", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
              }, note ?? ""),
              // ★ 回收区：删除是移到这儿，不是真删。给「撤销」按钮，
              //   否则「可复原」对用户就是不存在的。
              trash.length
                ? h("button", {
                    type: "button",
                    onClick: () => doUndoDelete(trash[trash.length - 1].id),
                    title: `回收区 ${trash.length} 项\n点此复原最近一项：${trash[trash.length - 1].from}`,
                    style: {
                      flex: "none", height: 20, padding: "0 8px", border: 0, borderRadius: 999,
                      background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
                      color: "var(--dsw-alias-state-business-primary, #4176e6)",
                      fontFamily: "inherit", fontSize: 11, lineHeight: "16px", cursor: "pointer",
                    },
                  }, `↩ 撤销删除（${trash.length}）`)
                : null,
              note
                ? h("button", {
                    type: "button", onClick: () => setNote(null),
                    style: {
                      flex: "none", border: 0, background: "transparent", cursor: "pointer",
                      color: "inherit", fontFamily: "inherit", fontSize: 11,
                    },
                  }, "×")
                : null
            )
          : null
      ),

      /**
       * ★★ 2026-10-20 底部确认栏（仅 pickMode）
       *
       *   为什么确认栏是必需的，而不是「点一下就返回」：
       *     ArtCraft 的 openPicker 返回的是一个【数组】，
       *     用户要能一次挑多张图一起拖进时间轴。
       *     点一下就关掉的话，选第二张得重新打开面板。
       *
       *   ★ 视觉规格抄 DSH 原生底部操作栏：
       *     与头部同样的 borderTop、同样的 padding，
       *     让面板上下对称，不像是「后加的」。
       */
      pickMode
        ? h("div", {
            style: {
              flex: "none", display: "flex", alignItems: "center", gap: 8,
              padding: "10px 14px",
              borderTop: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))",
              background: "var(--dsw-alias-bg-layer-1, #fff)",
            },
          },
            h("span", {
              style: {
                fontSize: 12,
                color: picked.size
                  ? "var(--dsw-alias-label-secondary, #61666b)"
                  : "var(--dsw-alias-label-tertiary, #81858c)",
              },
            }, picked.size ? `已选 ${picked.size} 项` : "点卡片右下角「选择」加入，可多选"),

            h("div", { style: { marginLeft: "auto", display: "flex", gap: 8 } },
              // 清空选择（有选中时才出现）
              picked.size
                ? h("button", {
                    type: "button",
                    onClick: () => setPicked(new Set()),
                    style: {
                      height: 28, padding: "0 12px", border: 0, borderRadius: 8,
                      cursor: "pointer", background: "transparent",
                      color: "var(--dsw-alias-label-secondary, #61666b)",
                      fontFamily: "inherit", fontSize: 12,
                    },
                  }, "清空")
                : null,
              // 取消：等同于什么都不选
              h("button", {
                type: "button",
                onClick: onClose,
                style: {
                  height: 28, padding: "0 12px", border: 0, borderRadius: 8,
                  cursor: "pointer",
                  background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06))",
                  color: "var(--dsw-alias-label-secondary, #61666b)",
                  fontFamily: "inherit", fontSize: 12,
                },
              }, "取消"),
              // 确认
              h("button", {
                type: "button",
                disabled: !picked.size,
                onClick: () => onPickConfirm?.(
                  // 返回【完整的 item】而不是 id —— 上层要 name/kind 才能转
                  // 成 ArtCraft 的 MediaPickerSelection
                  (lib.items ?? []).filter((x) => picked.has(x.id))
                ),
                style: {
                  height: 28, padding: "0 16px", border: 0, borderRadius: 8,
                  cursor: picked.size ? "pointer" : "not-allowed",
                  background: "var(--dsw-alias-state-business-primary, #4176e6)",
                  color: "var(--dsw-alias-label-primary-foreground, #fff)",
                  fontFamily: "inherit", fontSize: 12, fontWeight: 500,
                  opacity: picked.size ? 1 : .45,
                },
              }, picked.size ? `用这 ${picked.size} 项` : "用这些")
            )
          )
        : null,

      // ★★ 2026-10-20 新增：入库改名确认弹窗。
      //   主人：「只在入资产库的时候提出改名确认就行了，要可编辑，
      //     然后命名可以让 llm 来起一个默认名，用户做最后把关确认」
      //
      //   ★ 默认名来自 suggestName（本地规则），不在这里调 LLM ——
      //     上传路径上等一次 LLM 会让确认框延迟数秒，体验更差。
      //     用户可自由编辑，回车确认、Esc 取消。
      namePrompt
        ? h("div", {
            onClick: (e) => { e.stopPropagation(); setNamePrompt(null); },
            style: {
              position: "fixed", inset: 0, zIndex: 99996,
              background: "rgba(0,0,0,.35)",
              display: "flex", alignItems: "center", justifyContent: "center",
            },
          },
            h("div", {
              onClick: (e) => e.stopPropagation(),
              style: {
                width: 420, padding: 16, borderRadius: 12,
                background: "var(--dsw-alias-bg-layer-1, #fff)",
                boxShadow: "0 12px 40px rgba(0,0,0,.28)",
                color: "var(--dsw-alias-label-primary, #0f1115)",
                fontFamily: "inherit", fontSize: 13, lineHeight: "20px",
              },
            },
              h("div", { style: { fontWeight: 600, marginBottom: 4 } }, "入库：填一下信息"),
              h("div", {
                style: {
                  fontSize: 11, color: "var(--dsw-alias-label-tertiary, #81858c)",
                  marginBottom: 10, wordBreak: "break-all",
                },
              }, `已落盘：${namePrompt.filename}  ·  ${(namePrompt.sizeBytes / 1024).toFixed(1)}KB`),

              // ① 名字
              h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #61666b)", marginBottom: 3 } }, "名字"),
              h("input", {
                type: "text",
                autoFocus: true,
                defaultValue: namePrompt.defaultName,
                "aria-label": "资产名字",
                id: "wb-name-prompt-input",
                onKeyDown: (e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitPrompt();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setNamePrompt(null);
                  }
                },
                style: {
                  width: "100%", height: 30, padding: "0 10px", boxSizing: "border-box",
                  border: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15))",
                  borderRadius: 8,
                  background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.03))",
                  color: "inherit", fontFamily: "inherit", fontSize: 13, outline: "none",
                },
              }),
              h("div", {
                style: { fontSize: 10, color: "var(--dsw-alias-label-tertiary, #81858c)", marginTop: 3, marginBottom: 8 },
              }, "@ 引用时显示这个名字。留空 = 用原文件名。"),

              /**
               * ★★ 2026-10-20 新增：项目文件夹（主人：「弹出来一个窗口，让用户自己填」）
               *
               * 任务书原文：「新会话时由 LLM 判断项目归属并询问用户」。
               * 查实：客户端拿不到 LLM（可用服务只有 comfyBridge/effect/locale/slots），
               * 而让用户在入库那一刻直接填，比「模型猜 → 用户再确认」少一步。
               * ⇒ 做成这个输入框 + 已有文件夹的快选。
               */
              h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #61666b)", marginBottom: 3 } }, "项目文件夹"),
              h("input", {
                type: "text",
                defaultValue: "",
                placeholder: "例如：韩立传（留空 = 未归类）",
                "aria-label": "项目文件夹",
                id: "wb-folder-prompt-input",
                style: {
                  width: "100%", height: 30, padding: "0 10px", boxSizing: "border-box",
                  border: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15))",
                  borderRadius: 8,
                  background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.03))",
                  color: "inherit", fontFamily: "inherit", fontSize: 13, outline: "none",
                },
              }),
              knownFolders.length
                ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 3, marginTop: 4, marginBottom: 8 } },
                    ...knownFolders.slice(0, 8).map((f) =>
                      h("button", {
                        key: f,
                        type: "button",
                        onClick: () => {
                          const el = document.getElementById("wb-folder-prompt-input");
                          if (el) el.value = f;
                        },
                        style: {
                          height: 20, padding: "0 7px", border: 0, borderRadius: 999,
                          background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
                          color: "var(--dsw-alias-label-secondary, #61666b)",
                          fontFamily: "inherit", fontSize: 10, cursor: "pointer",
                        },
                      }, f)
                    )
                  )
                : h("div", { style: { marginBottom: 8 } }),

              // ② 角色（可选）
              h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #61666b)", marginBottom: 3 } }, "角色（可选）"),
              h("div", { style: { display: "flex", gap: 6 } },
                h("input", {
                  type: "text",
                  defaultValue: "",
                  placeholder: "角色名，如 韩立",
                  "aria-label": "角色名",
                  id: "wb-char-prompt-input",
                  style: {
                    flex: "1 1 auto", height: 30, padding: "0 10px", boxSizing: "border-box",
                    border: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15))",
                    borderRadius: 8,
                    background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.03))",
                    color: "inherit", fontFamily: "inherit", fontSize: 13, outline: "none",
                  },
                }),
                h("select", {
                  "aria-label": "角色视角",
                  id: "wb-view-prompt-input",
                  defaultValue: "",
                  style: {
                    flex: "none", width: 78, height: 30, padding: "0 6px", boxSizing: "border-box",
                    border: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15))",
                    borderRadius: 8,
                    background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.03))",
                    color: "inherit", fontFamily: "inherit", fontSize: 12, outline: "none",
                  },
                },
                  h("option", { value: "" }, "视角"),
                  ...["front", "side", "back", "closeup", "full"].map((v) =>
                    h("option", { key: v, value: v },
                      { front: "正面", side: "侧面", back: "背面", closeup: "特写", full: "全身" }[v])
                  )
                )
              ),
              h("div", {
                style: { fontSize: 10, color: "var(--dsw-alias-label-tertiary, #81858c)", marginTop: 3 },
              }, "填了角色名，之后 @角色名 就能搜到这张图。"),

              h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 } },
                h("button", {
                  type: "button", onClick: () => setNamePrompt(null),
                  style: {
                    height: 28, padding: "0 12px", border: 0, borderRadius: 8, cursor: "pointer",
                    background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
                    color: "inherit", fontFamily: "inherit", fontSize: 12,
                  },
                }, "稍后再说"),
                h("button", {
                  type: "button",
                  onClick: submitPrompt,
                  style: {
                    height: 28, padding: "0 12px", border: 0, borderRadius: 8, cursor: "pointer",
                    background: "var(--dsw-alias-state-business-primary, #4176e6)",
                    color: "var(--dsw-alias-label-primary-foreground, #fff)",
                    fontFamily: "inherit", fontSize: 12,
                  },
                }, "确定")
              )
            )
          )
        : null,

      // ★★ 2026-10-20 新增：新建项目文件夹。
      //   主人：「资产库要分好项目文件夹，两个不相关的项目不要混在一起……
      //     也可以用户自己创建文件夹」
      //
      //   ★ 这个弹窗只【创建名字】并把它记住（localStorage 里的「已知文件夹」），
      //     真正把资产放进去是「把卡片拖到文件夹」或卡片上的文件夹下拉。
      //     但为了让用户建完立刻能用，这里建完就把当前筛选到的资产里
      //     最近一个「未归类」的放进去 —— 不，那太自作聪明。
      //     ⇒ 只建名字 + 提示「用卡片上的文件夹下拉把资产放进去」。
      newFolderOpen
        ? h("div", {
            onClick: (e) => { e.stopPropagation(); setNewFolderOpen(false); },
            style: {
              position: "fixed", inset: 0, zIndex: 99996,
              background: "rgba(0,0,0,.35)",
              display: "flex", alignItems: "center", justifyContent: "center",
            },
          },
            h("div", {
              onClick: (e) => e.stopPropagation(),
              style: {
                width: 380, padding: 16, borderRadius: 12,
                background: "var(--dsw-alias-bg-layer-1, #fff)",
                boxShadow: "0 12px 40px rgba(0,0,0,.28)",
                color: "var(--dsw-alias-label-primary, #0f1115)",
                fontFamily: "inherit", fontSize: 13, lineHeight: "20px",
              },
            },
              h("div", { style: { fontWeight: 600, marginBottom: 8 } }, "新建项目文件夹"),
              h("input", {
                type: "text",
                autoFocus: true,
                id: "wb-new-folder-input",
                "aria-label": "新文件夹名",
                placeholder: "例如：韩立传",
                onKeyDown: (e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    createFolder(e.currentTarget.value);
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setNewFolderOpen(false);
                  }
                },
                style: {
                  width: "100%", height: 32, padding: "0 10px", boxSizing: "border-box",
                  border: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15))",
                  borderRadius: 8,
                  background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.03))",
                  color: "inherit", fontFamily: "inherit", fontSize: 13, outline: "none",
                },
              }),
              knownFolders.length
                ? h("div", { style: { marginTop: 10 } },
                    h("div", {
                      style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #81858c)", marginBottom: 4 },
                    }, "已有的文件夹（点一下用它）"),
                    h("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
                      ...knownFolders.map((f) =>
                        h("button", {
                          key: f,
                          type: "button",
                          onClick: () => {
                            const el = document.getElementById("wb-new-folder-input");
                            if (el) el.value = f;
                          },
                          style: {
                            height: 22, padding: "0 8px", border: 0, borderRadius: 999,
                            background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
                            color: "var(--dsw-alias-label-secondary, #61666b)",
                            fontFamily: "inherit", fontSize: 11, cursor: "pointer",
                          },
                        }, f)
                      )
                    )
                  )
                : null,
              h("div", {
                style: {
                  fontSize: 11, color: "var(--dsw-alias-label-tertiary, #81858c)",
                  marginTop: 8,
                },
              }, "建好后，用资产卡上的文件夹下拉把资产放进去。@ 搜索仍然跨全部文件夹。"),
              h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 } },
                h("button", {
                  type: "button", onClick: () => setNewFolderOpen(false),
                  style: {
                    height: 28, padding: "0 12px", border: 0, borderRadius: 8, cursor: "pointer",
                    background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
                    color: "inherit", fontFamily: "inherit", fontSize: 12,
                  },
                }, "取消"),
                h("button", {
                  type: "button",
                  onClick: () => {
                    const el = document.getElementById("wb-new-folder-input");
                    createFolder(el ? el.value : "");
                  },
                  style: {
                    height: 28, padding: "0 12px", border: 0, borderRadius: 8, cursor: "pointer",
                    background: "var(--dsw-alias-state-business-primary, #4176e6)",
                    color: "var(--dsw-alias-label-primary-foreground, #fff)",
                    fontFamily: "inherit", fontSize: 12,
                  },
                }, "创建")
              )
            )
          )
        : null,

      // 删除确认
      confirmDel
        ? h("div", {
            onClick: (e) => { e.stopPropagation(); setConfirmDel(null); },
            style: {
              position: "fixed", inset: 0, zIndex: 99995,
              background: "rgba(0,0,0,.35)",
              display: "flex", alignItems: "center", justifyContent: "center",
            },
          },
            h("div", {
              onClick: (e) => e.stopPropagation(),
              style: {
                width: 380, padding: 16, borderRadius: 12,
                background: "var(--dsw-alias-bg-layer-1, #fff)",
                boxShadow: "0 12px 40px rgba(0,0,0,.28)",
                color: "var(--dsw-alias-label-primary, #0f1115)",
                fontFamily: "inherit", fontSize: 13, lineHeight: "20px",
              },
            },
              h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "删除这个资产？"),
              h("div", {
                style: {
                  fontSize: 12, color: "var(--dsw-alias-label-secondary, #61666b)",
                  whiteSpace: "pre-wrap", wordBreak: "break-all", marginBottom: 10,
                },
              }, `${confirmDel.displayName}\n${confirmDel.rel}\n\n不会真删 —— 移到 .state/trash/，随时能拿回来。`),
              h("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
                h("button", {
                  type: "button", onClick: () => setConfirmDel(null),
                  style: {
                    height: 28, padding: "0 12px", border: 0, borderRadius: 8, cursor: "pointer",
                    background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
                    color: "inherit", fontFamily: "inherit", fontSize: 12,
                  },
                }, "取消"),
                h("button", {
                  type: "button", onClick: () => doDelete(confirmDel),
                  style: {
                    height: 28, padding: "0 12px", border: 0, borderRadius: 8, cursor: "pointer",
                    background: "rgb(207,34,46)", color: "#fff",
                    fontFamily: "inherit", fontSize: 12,
                  },
                }, "移到回收区")
              )
            )
          )
        : null,

      // 放大预览
      big
        ? h("div", {
            onClick: (e) => { e.stopPropagation(); setBig(null); },
            style: {
              position: "fixed", inset: 0, zIndex: 99997,
              background: "rgba(0,0,0,.92)",
              display: "flex", alignItems: "center", justifyContent: "center",
            },
          },
            big.kind === "image"
              ? h("img", {
                  src: assetThumbUrl(big), alt: "",
                  style: { maxWidth: "92vw", maxHeight: "88vh", objectFit: "contain" },
                })
              // ★ 2026-10-19：音频放大时给完整播放器（进度条 / 音量）
              //   列表里的小 ▶ 只是「快速听一下」，这里才是认真听。
              : big.kind === "audio"
                ? h("div", {
                    onClick: (e) => e.stopPropagation(),
                    style: {
                      display: "flex", flexDirection: "column", gap: 12,
                      alignItems: "center", maxWidth: "80vw",
                    },
                  },
                    h("div", { style: { color: "#fff", fontFamily: "inherit", fontSize: 14 } }, big.displayName),
                    h("audio", {
                      controls: true, autoPlay: true,
                      src: assetThumbUrl(big),
                      style: { width: "min(640px, 80vw)" },
                    })
                  )
                : h("div", {
                    style: { color: "#fff", fontFamily: "inherit", fontSize: 14 },
                  }, `${KIND_META[big.kind]?.label ?? big.kind}：${big.displayName}`)
          )
        : null
    ),
    document.body
  );
}

/**
 * 音频卡片上的播放键（2026-10-19 新增）。
 *
 * 主人：「资产库也需要有一个音频专栏」
 *
 * ★ 为什么单独做成组件而不是内联：
 *   播放状态（正在播 / 已暂停）必须反映在图标上，否则用户点了没反馈，
 *   会以为「点了没反应」。内联写法拿不到组件级 state。
 *
 * ★ 实测到的两件事：
 *   ① headless 环境里 play() 会被浏览器挡：
 *        NotAllowedError: the user didn't interact with the document first
 *      ⇒ 不是缺陷，真人点击不会触发。但代码必须 catch 住，
 *        不能让它变成未处理的 rejection。
 *   ② 同一时刻只允许一个音频在放，否则两个会叠着响。
 */
function AudioCardButton({ item }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = React.useRef(null);

  const toggle = async (e) => {
    e.stopPropagation();          // 别触发「点卡片放大预览」
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      // 同屏只播一个
      document.querySelectorAll("audio[data-wb-audio]").forEach((a) => {
        if (a !== el) a.pause();
      });
      try {
        await el.play();
        setPlaying(true);
      } catch (err) {
        // 自动播放被挡（headless / 首次交互前）—— 不影响用户手动再点
        console.warn("[comfy-wb] 音频播放被浏览器拦截：", err?.message ?? err);
        setPlaying(false);
      }
    } else {
      el.pause();
      setPlaying(false);
    }
  };

  return h("button", {
      type: "button",
      title: playing ? "暂停" : "播放（点卡片本身是放大预览）",
      "aria-label": playing ? "暂停预览" : "播放预览",
      "aria-pressed": playing,
      onClick: toggle,
      style: {
        width: "100%", height: "100%", padding: 0, border: 0,
        background: playing ? "rgba(65,118,230,.10)" : "transparent",
        cursor: "pointer",
        display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", gap: 4,
        color: playing
          ? "var(--dsw-alias-state-business-primary, #4176e6)"
          : "var(--dsw-alias-label-secondary, #61666b)",
        transition: "background 140ms ease, color 140ms ease",
      },
    },
      h("span", { style: { fontSize: 22 } }, playing ? "⏸" : "▶"),
      h("span", { style: { fontSize: 11, opacity: 0.75 } }, playing ? "暂停" : "播放"),
      h("audio", {
        ref: audioRef,
        "data-wb-audio": "1",
        preload: "none",
        src: assetThumbUrl(item),
        onEnded: () => setPlaying(false),
        onPause: () => setPlaying(false),
        onPlay: () => setPlaying(true),
        style: { display: "none" },
      })
    );
}

/**
 * 把「用途」写回资产库（2026-10-20 新增）。
 *
 * 主人：「要能在编辑框中临时修改，修改后就默认保存」
 *
 * 调用方：WorkbenchView 的 onRole（编辑框里改槽用途时）
 * 行为：POST /comfy-assets/mutate { action:"role" }
 * 返回：{ ok } 或抛错
 *
 * ★ 为什么单独导出而不是复用 RoleSelect 里的逻辑：
 *   RoleSelect 是「资产卡上改」，这里是「编辑框里改」。
 *   两者都要写同一个接口，但错误处理不同：
 *     · 卡片上改：失败要回滚 UI（用户正看着那个下拉）
 *     · 编辑框改：失败只 warn（本次生成的 role 已经生效，不该被回滚）
 */
export async function saveRoleToLibrary(assetId, roleId) {
  if (!assetId) return { ok: false, reason: "缺 assetId" };
  const r = await fetch(`${API}/mutate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "role", id: assetId, role: String(roleId ?? "") }),
  });
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON */ }
  if (!r.ok || j?.ok === false) {
    throw new Error(j?.error ?? `HTTP ${r.status}`);
  }
  return j ?? { ok: true };
}

/**
 * 把「项目文件夹」写回资产库。
 * 主人：「资产库要分好项目文件夹，两个不相关的项目不要混在一起」
 */
export async function saveFolderToLibrary(assetId, folder) {
  if (!assetId) return { ok: false, reason: "缺 assetId" };
  const r = await fetch(`${API}/mutate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "folder", id: assetId, folder: String(folder ?? "") }),
  });
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON */ }
  if (!r.ok || j?.ok === false) {
    throw new Error(j?.error ?? `HTTP ${r.status}`);
  }
  return j ?? { ok: true };
}

/**
 * 上传文件入库（2026-10-20 新增）。
 *
 * 主人：「只在入资产库的时候提出改名确认就行了，要可编辑，
 *   然后命名可以让 llm 来起一个默认名，用户做最后把关确认」
 *
 * 流程（分两步，中间夹着「确认名字」）：
 *   ① 用户选文件 → 本函数负责上传（拿到 id + 落盘名）
 *   ② 弹确认框（默认名 = LLM 起的或文件名），用户改 → saveAliasToLibrary
 *
 * @param {File} file
 * @param {{folder?:string, role?:string}} opts
 * @returns {Promise<{ok, id, filename, absPath, sizeBytes}>}
 */
export async function uploadToLibrary(file, opts = {}) {
  if (!file) throw new Error("没有文件");
  if (file.size > 64 * 1024 * 1024) {
    throw new Error(`文件太大：${(file.size / 1048576).toFixed(1)}MB，上限 64MB`);
  }
  const buf = await file.arrayBuffer();
  // 分块转 base64（大文件一次性 fromCharCode 会爆栈）
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  const base64 = btoa(bin);

  const r = await fetch(`${API}/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      base64,
      folder: opts.folder ?? "",
      role: opts.role ?? "",
    }),
  });
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON */ }
  if (!r.ok || j?.ok === false) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j;
}

/** 把资产改名（别名）写回资产库。空字符串 = 恢复文件名。 */
export async function saveAliasToLibrary(assetId, name) {
  if (!assetId) return { ok: false, reason: "缺 assetId" };
  const r = await fetch(`${API}/mutate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "rename", id: assetId, name: String(name ?? "") }),
  });
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON */ }
  if (!r.ok || j?.ok === false) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j ?? { ok: true };
}

/**
 * 设置角色的定妆图标签（2026-10-20 新增，跨项目写）。
 *
 * 主人要的是「@韩立 引用这个角色」。角色卡的标签按设计存在
 * 工作站那一份（outputs/assets.json），所以这条要写另一个项目的文件。
 *
 * @param {string} basename  文件名（工作站按 path.basename 索引）
 * @param {string} character 角色名（空 = 摘掉标签）
 * @param {string} [view]    视角 front/side/back/closeup/full
 * @param {boolean} [on=true] false = 只摘标签不改名字
 * @param {object} [opts]
 *   opts.createIfMissing —— 工作站 assets.json 里没有这条时补登记一条。
 *   ★ 2026-10-20 加：工作台「＋上传」的图落在 ComfyUI input/，
 *     工作站 assets.json 里没有它 ⇒ 不补登记的话入库填角色名必然失败。
 *     只在上传流程里传 true；从资产卡上打标签时保持 false（严格）。
 *   opts.kind —— 补登记时写进 kind 字段
 */
export async function saveCharacterTag(basename, character, view, on = true, opts = {}) {
  const r = await fetch(`${API}/mutate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "character",
      id: `char:${basename}`,     // mutate 要求 id 非空，这只是个占位
      basename,
      character: String(character ?? ""),
      view: String(view ?? ""),
      on,
      createIfMissing: !!opts.createIfMissing,
      kind: opts.kind,
    }),
  });
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON */ }
  if (!r.ok || j?.ok === false) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j ?? { ok: true };
}

/**
 * 给一个文件名起「人话名」的默认建议（本地规则，不调 LLM）。
 *
 * ★ 为什么不在这里调 LLM：
 *   这是纯前端组件，没有 provider 访问权。而且上传时同步等一次 LLM
 *   会让确认框延迟 2~5 秒 —— 体验比「先用规则起名、用户可改」差得多。
 *   ⇒ 规则起名立刻给建议；用户不满意可以自己改。
 *   （「让 LLM 起名」可以以后做成资产卡上的「✨ 起名」按钮，
 *    那是有网络请求的场景，不该挡在上传路径上。）
 */
export function suggestName(filename, kind) {
  const base = String(filename ?? "").replace(/\.[^.]+$/, "");
  // 去掉工作台自己加的前缀与随机后缀
  let s = base
    .replace(/^wb_/, "")
    .replace(/_[a-z0-9]{6}$/i, "")
    .replace(/^(ref_image|ref_video|ref_audio)_\d+_/, "")
    .replace(/_/g, " ");
  // 去掉常见的机器名特征（时间戳、长串数字）
  s = s.replace(/\b20\d{6}\b/g, "").replace(/_{2,}/g, " ").replace(/\s+/g, " ").trim();
  if (!s) s = base || "未命名";
  const kindWord = { image: "图", video: "视频", audio: "音频", text: "文本" }[kind] ?? "素材";
  return s.length > 40 ? s.slice(0, 40) : s;
}

/**
 * 资产卡上的「角色」按钮（2026-10-20 新增）。
 *
 * 主人要的是「@韩立 引用这个角色」。
 * 角色卡的标签存在工作站那一份（outputs/assets.json），
 * 这个按钮是【唯一入口】—— 否则用户得手改 json，功能等于不可用。
 *
 * 显示逻辑：
 *   · 不是角色定妆图 → 灰色「＋ 角色」
 *   · 是角色定妆图   → 橙色「韩立·front」
 */
function CharacterButton({ item, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState(item.character ?? "");
  const [view, setView] = useState(item.charView ?? "");

  useEffect(() => {
    setCur(item.character ?? "");
    setView(item.charView ?? "");
  }, [item.character, item.charView, item.id]);

  const isChar = !!cur;

  const save = async (name, v) => {
    setBusy(true);
    try {
      await saveCharacterTag(item.name, name, v, !!name);
      await onSaved?.();
      setOpen(false);
    } catch (e) {
      setNoteGlobal(`角色标签保存失败：${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  const VIEWS = ["front", "side", "back", "closeup", "full"];
  const VIEW_ZH = { front: "正面", side: "侧面", back: "背面", closeup: "特写", full: "全身" };

  return h("span", { style: { position: "relative", display: "inline-flex", flex: "none" } },
    h("button", {
      type: "button",
      onClick: () => setOpen((v) => !v),
      disabled: busy,
      title: isChar ? `角色定妆图：${cur}${view ? `（${VIEW_ZH[view] ?? view}）` : ""}` : "标为角色定妆图（之后 @角色名 就能搜到）",
      style: {
        height: 22, padding: "0 6px", border: 0, borderRadius: 6,
        cursor: busy ? "wait" : "pointer",
        background: isChar ? "rgba(255,171,0,.16)" : "transparent",
        color: isChar ? "rgb(163,106,3)" : "var(--dsw-alias-label-tertiary, #81858c)",
        fontFamily: "inherit", fontSize: 11, maxWidth: 88,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        opacity: busy ? 0.6 : 1,
      },
    }, isChar ? `${cur}${view ? "·" + (VIEW_ZH[view] ?? view).slice(0, 2) : ""}` : "＋角色"),

    // 浮层：填角色名 + 选视角
    open
      ? h("div", {
          onClick: (e) => e.stopPropagation(),
          style: {
            position: "absolute", bottom: "calc(100% + 4px)", left: 0, zIndex: 99994,
            width: 190, padding: 8, borderRadius: 8,
            background: "var(--dsw-alias-bg-layer-1, #fff)",
            boxShadow: "0 6px 24px rgba(0,0,0,.22), 0 0 0 0.5px rgba(0,0,0,.1)",
            display: "flex", flexDirection: "column", gap: 6,
          },
        },
          h("div", { style: { fontSize: 11, fontWeight: 600, color: "var(--dsw-alias-label-primary, #0f1115)" } },
            "标为角色定妆图"),
          h("input", {
            type: "text",
            autoFocus: true,
            defaultValue: cur,
            placeholder: "角色名，如 韩立",
            "aria-label": "角色名",
            onKeyDown: (e) => {
              if (e.key === "Enter") { e.preventDefault(); save(e.currentTarget.value.trim(), view); }
              else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
            },
            id: "wb-char-name-" + item.id.replace(/[^\w]/g, "_"),
            style: {
              width: "100%", height: 26, padding: "0 8px", boxSizing: "border-box",
              border: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.15))",
              borderRadius: 6, background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.03))",
              color: "inherit", fontFamily: "inherit", fontSize: 12, outline: "none",
            },
          }),
          h("div", { style: { display: "flex", gap: 3, flexWrap: "wrap" } },
            ...VIEWS.map((v) =>
              h("button", {
                key: v,
                type: "button",
                onClick: () => setView((p) => (p === v ? "" : v)),
                style: {
                  height: 20, padding: "0 6px", border: 0, borderRadius: 999,
                  cursor: "pointer", fontFamily: "inherit", fontSize: 10,
                  background: view === v ? "rgba(255,171,0,.22)" : "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
                  color: view === v ? "rgb(163,106,3)" : "var(--dsw-alias-label-secondary, #61666b)",
                },
              }, VIEW_ZH[v])
            )
          ),
          h("div", { style: { display: "flex", gap: 4, justifyContent: "flex-end" } },
            isChar
              ? h("button", {
                  type: "button", onClick: () => save("", ""),
                  style: {
                    height: 22, padding: "0 8px", border: 0, borderRadius: 6, cursor: "pointer",
                    background: "transparent", color: "rgb(207,34,46)",
                    fontFamily: "inherit", fontSize: 11,
                  },
                }, "取消角色")
              : null,
            h("button", {
              type: "button",
              onClick: () => {
                const el = document.getElementById("wb-char-name-" + item.id.replace(/[^\w]/g, "_"));
                save((el?.value ?? "").trim(), view);
              },
              style: {
                height: 22, padding: "0 10px", border: 0, borderRadius: 6, cursor: "pointer",
                background: "var(--dsw-alias-state-business-primary, #4176e6)",
                color: "var(--dsw-alias-label-primary-foreground, #fff)",
                fontFamily: "inherit", fontSize: 11,
              },
            }, "确定")
          )
        )
      : null
  );
}

/**
 * ★ 给 CharacterButton 用的极简提示（它不在 LibraryPanel 内部，
 *   拿不到 setNote）。挂到 body 上一条浮层，2 秒消失。
 */
function setNoteGlobal(msg) {
  try {
    const el = document.createElement("div");
    el.textContent = msg;
    el.style.cssText = [
      "position:fixed", "left:50%", "bottom:80px", "transform:translateX(-50%)",
      "z-index:99999", "padding:8px 14px", "border-radius:8px",
      "background:rgba(207,34,46,.95)", "color:#fff", "font:12px system-ui,sans-serif",
      "box-shadow:0 6px 24px rgba(0,0,0,.25)", "pointer-events:none",
    ].join(";");
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  } catch { /* 提示失败不影响主流程 */ }
}

/**
 * 资产卡上的「项目文件夹」下拉（2026-10-20 新增）。
 *
 * 主人：「资产库要分好项目文件夹，两个不相关的项目不要混在一起，
 *   不过支持 @ 的时候能搜到」
 *
 * 语义：
 *   · 值 = 文件夹名，空 = 未归类
 *   · 改完立即 POST /comfy-assets/mutate { action:"folder" } 并刷新
 *   · 只在【面板里】影响分组；@ 搜索走的是另一条路，跨全部文件夹
 *
 * ★ 与 RoleSelect 分开写而不是合成一个通用组件：
 *   两者的选项来源完全不同（一个是 H3 标签表，一个是用户动态建的文件夹），
 *   合成一个就要传一堆回调，反而更难读。
 */
/**
 * 「判断项目归属」按钮 —— 任务书三-1。
 *
 * 点一下 → 问后端该归哪个项目 → 弹确认条 → 用户点了才写。
 * ★ 不自动写：主人要的是「询问用户」。
 */
const SuggestFolderButton = React.memo(function SuggestFolderButton({ item, folders, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [sug, setSug] = useState(null);   // { folder, source, reason, llmError }
  const [note, setNote] = useState("");   // 一行提示（看不出归属 / 先建文件夹 / 失败）

  useEffect(() => { setSug(null); setNote(""); }, [item.id]);

  const ask = async () => {
    setBusy(true);
    setNote("");
    setSug(null);
    try {
      const r = await fetch("/comfy-assets/suggest-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: item.name ?? item.rel ?? "",
          kind: item.kind ?? "image",
          existingFolders: folders ?? [],
        }),
      });
      const j = await r.json();
      if (!j?.ok) { setNote(j?.error ?? "判断失败"); return; }
      if (j.needCreate) { setNote("还没有项目文件夹，先在别的资产上建一个"); return; }
      if (!j.folder) { setNote(j.reason ?? "看不出归属"); return; }
      setSug({
        folder: j.folder,
        source: j.source,
        reason: j.reason ?? "",
        llmError: j.llmError ?? "",
      });
    } catch (e) {
      setNote(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    if (!sug?.folder) return;
    setBusy(true);
    try {
      await saveFolderToLibrary(item.id, sug.folder);
      await onSaved?.();
      setSug(null);
      setNote("");
    } catch (e) {
      setNote("保存失败：" + String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return h("span", {
      style: { display: "inline-flex", alignItems: "center", gap: 2, position: "relative" },
    },
    h("button", {
        type: "button",
        onClick: ask,
        disabled: busy,
        title: "判断这个资产属于哪个项目（只建议，不会自动改）",
        "aria-label": "判断项目归属",
        style: {
          height: 22, padding: "0 6px", border: 0, borderRadius: 6,
          background: busy
            ? "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))"
            : "rgba(65,118,230,.12)",
          color: "rgb(38,86,190)",
          cursor: busy ? "wait" : "pointer",
          fontFamily: "inherit", fontSize: 11, lineHeight: "20px",
        },
      }, busy ? "…" : "✨"),

    sug && h("span", {
        style: {
          display: "inline-flex", alignItems: "center", gap: 3,
          marginLeft: 2, padding: "0 4px", height: 22,
          borderRadius: 6, background: "rgba(255,171,0,.16)",
          fontSize: 10, lineHeight: "20px", color: "rgb(140,92,3)",
          whiteSpace: "nowrap",
        },
        title: sug.reason + (sug.llmError ? "（LLM 不可用：" + sug.llmError + "）" : ""),
      },
      h("span", { style: { maxWidth: "8em", overflow: "hidden", textOverflow: "ellipsis" } },
        "归到「" + sug.folder + "」"),
      h("button", {
          type: "button", onClick: accept, disabled: busy,
          title: "确认归入",
          style: {
            height: 18, padding: "0 5px", border: 0, borderRadius: 4,
            background: "rgb(255,171,0)", color: "#fff",
            cursor: "pointer", fontFamily: "inherit", fontSize: 10, lineHeight: "18px",
          },
        }, "归入"),
      h("button", {
          type: "button", onClick: () => { setSug(null); }, disabled: busy,
          title: "忽略",
          style: {
            height: 18, padding: "0 4px", border: 0, borderRadius: 4,
            background: "transparent", color: "rgb(140,92,3)",
            cursor: "pointer", fontFamily: "inherit", fontSize: 10, lineHeight: "18px",
          },
        }, "×")
    ),

    !sug && note && h("span", {
        style: {
          fontSize: 10, lineHeight: "20px", marginLeft: 2,
          color: "var(--dsw-alias-label-tertiary, #81858c)",
          maxWidth: "12em", overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        },
        title: note,
      }, note)
  );
});


/**
 * 「更多」按钮 + popover —— 收纳资产卡的低频操作。
 *
 * ★ Portal 到 body：卡片 overflow:hidden 会裁掉卡片内的浮层（§6.10 ③）。
 * ★ 关闭方式：点外面 / Esc / 点自己。
 */
const CardMoreButton = React.memo(function CardMoreButton({
  item, folders, onSaved, onRename, onDelete,
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [anchorRect, setAnchorRect] = useState(null);
  const btnRef = React.useRef(null);
  /**
   * ★★ 2026-10-21 修（实测发现的真缺陷）
   *
   * —— 现象：连续点两张卡的「更多操作」，两个 popover 同时挂在那儿。
   *   实测：页面上出现两个 `z-index:99999` 的浮层，
   *         一个在 y=603（第一张卡），一个在 y=1461（第二张卡，已超出视口）。
   *         第一个不会消失 ⇒ 用户可以同时开着 N 个菜单。
   *
   * —— 根因（本文件 3037 行）：
   *     const onDown = (e) => {
   *       if (btnRef.current?.contains(e.target)) return;
   *       if (e.target?.closest?.("[data-wb-card-more]")) return;   ← 这里
   *       setOpen(false);
   *     };
   *   `[data-wb-card-more]` 这一句是为了「点浮层内部不关闭」，
   *   但它同时也把【别的卡的按钮】当成了浮层内部 ——
   *   因为所有卡的「更多」按钮都带这个属性。
   *   ⇒ 点第二张卡时，第一张卡的监听器看到目标在 [data-wb-card-more] 里，
   *     就 return 了，不关自己。
   *
   * —— 修法：用「全局单例 id」而不是「让所有按钮都免疫」。
   *   每个 CardMoreButton 有一个唯一 id；打开时把自己登记为「当前唯一打开的」。
   *   任何卡片打开时，先看是否已有别人打开 —— 有就让那个关掉。
   *
   * —— 判据（可复跑）：连续点两张卡的「更多」，
   *   页面上 z-index:99999 的卡片菜单浮层数量必须是 1。
   */
  const instanceId = React.useRef(
    `cardmore-${Math.random().toString(36).slice(2, 10)}`,
  );
  const openIt = () => {
    // 通知上一个打开的实例关掉自己
    try {
      const prev = window.__WB_CARD_MORE_OPEN__;
      if (prev && prev !== instanceId.current) {
        window.dispatchEvent(
          new CustomEvent("wb:card-more-open", { detail: instanceId.current }),
        );
      }
      window.__WB_CARD_MORE_OPEN__ = instanceId.current;
    } catch { /* ignore */ }
    const r = btnRef.current?.getBoundingClientRect();
    setAnchorRect(r ? { left: r.left, top: r.top, bottom: r.bottom, width: r.width } : null);
    setOpen(true);
  };

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target)) return;
      if (e.target?.closest?.("[data-wb-card-more]")) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    /**
     * 别的卡片打开时，关掉自己。
     * ★ 和上面那条 onDown 的区别：
     *   onDown 处理「点空白处」，这条处理「点另一个同类按钮」——
     *   后者在 DOM 上属于 [data-wb-card-more]，所以 onDown 会放过它。
     */
    const onOtherOpen = (e) => {
      if (e.detail !== instanceId.current) setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("wb:card-more-open", onOtherOpen);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wb:card-more-open", onOtherOpen);
    };
  }, [open]);

  React.useEffect(() => { setOpen(false); }, [item.id]);

  const runAnd = async (fn) => {
    setBusy(true);
    try { await fn?.(); } finally { setBusy(false); }
  };

  const rowStyle = {
    display: "flex", alignItems: "center", gap: 6,
    width: "100%", height: 26, padding: "0 8px",
    border: 0, borderRadius: 4, background: "transparent",
    cursor: busy ? "wait" : "pointer",
    fontFamily: "inherit", fontSize: 11, lineHeight: "24px",
    color: "var(--dsw-alias-label-secondary, #61666b)",
    textAlign: "left",
  };

  return h(React.Fragment, null,
    h("button", {
        ref: btnRef,
        type: "button",
        onClick: () => (open ? setOpen(false) : openIt()),
        title: "更多操作（项目文件夹 / 角色 / 改名 / 删除）",
        "aria-label": "资产卡更多操作",
        "aria-expanded": open,
        style: {
          height: 22, padding: "0 6px", border: 0, borderRadius: 6,
          background: open
            ? "rgba(65,118,230,.16)"
            : "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
          color: "rgb(38,86,190)",
          cursor: "pointer", flex: "0 0 auto",
          fontFamily: "inherit", fontSize: 11, lineHeight: "20px",
        },
      }, "更多 ▾"),

    open && anchorRect && createPortal(
      h("div", {
          "data-wb-card-more": "1",
          style: {
            position: "fixed",
            /**
             * ★★ 2026-10-21 G1b：浮层位置必须在视口内（三个方向都要管）
             *
             *   原来的钳制只处理水平，而且是「按固定宽 168 猜」：
             *     left: Math.max(8, Math.min(r.left + r.width - 168, innerWidth - 176))
             *   两个问题：
             *     ① 168/176 是魔数，改宽度就得同步改，漏一处就超屏
             *     ② 完全没管垂直 —— 卡片在面板底部时，浮层向下展开会掉出视口，
             *        用户看不到「删除」这一项（实测卡片区可滚到最底部）
             *
             *   现在的做法（不引入 ResizeObserver，避免给每次渲染加开销）：
             *     · 宽度仍取 168，但作为常量 W 只出现一次，所有计算都用它
             *     · 水平：left 落在 [8, innerWidth - W - 8]
             *     · 垂直：默认向下弹（anchor.bottom + 4）；
             *             若下方放不下（估计高度 H 估算 240px），改向上弹
             *             再不够就把 top 钳到 [8, innerHeight - H - 8]
             *   ★ H 用估算值而不是真实测量，是因为此刻浮层还没挂载，
             *     measure 不到。240px 是按 6 项 × 26px + 分组标题 + padding 估的，
             *     偏大不偏小 —— 估大了只会让它更早向上弹，不会让它掉出去。
             */
            left: (() => {
              const W = 168, GAP = 8;
              const want = anchorRect.left + anchorRect.width - W;
              const max = window.innerWidth - W - GAP;
              return Math.max(GAP, Math.min(want, max));
            })(),
            top: (() => {
              /**
               * ★★ 2026-10-21 补：无论走哪条分支，最终都必须落在视口内。
               *
               * —— 实测到的情况：
               *     页面上出现了一个 top:1461px 的浮层（视口高 914）。
               *     追下去发现是【我用脚本点了视口外的按钮】造成的——
               *     真实用户点不到不可见按钮，所以这不是用户能触发的路径。
               *
               * 但旧逻辑确实有这个漏洞：
               *     const above = anchorRect.top - H - 4;
               *     if (above >= GAP) return above;      ← 只要 above ≥ 8 就直接返回
               *   anchorRect.top = 1461 时，above = 1217，
               *   1217 ≥ 8 成立 ⇒ 返回 1217，仍在视口外。
               *   最后那条 clamp 只在「above < GAP」时才执行，兜不住这种情况。
               *
               * ⇒ 改成：先算出「想要的位置」，最后【统一】钳进
               *    [GAP, innerHeight - effH - GAP]。
               *    effH 用 min(H, 视口高 - 2*GAP)，避免视口比浮层还矮时
               *    innerHeight - effH - GAP 变成负数、clamp 区间反向。
               */
              const H = 240, GAP = 8;
              const vh = window.innerHeight;
              const effH = Math.min(H, Math.max(0, vh - GAP * 2));
              const below = anchorRect.bottom + 4;
              const fitsBelow = below + effH <= vh - GAP;
              let want;
              if (fitsBelow) {
                want = below;
              } else {
                const above = anchorRect.top - effH - 4;
                want = above >= GAP ? above : below;
              }
              const hi = Math.max(GAP, vh - effH - GAP);
              return Math.max(GAP, Math.min(want, hi));
            })(),
            zIndex: 99999,
            width: 168,
            /* ★ 2026-10-21：boxSizing 必须显式给
               实测：写 width:168 + padding:4，computed 宽度是 176（多出 8px）。
               因为默认 box-sizing 是 content-box，168 是内容宽，加上左右 padding 就溢出。
               而我上面的位置计算用的 W=168 —— 计算与实际不符，
               最右那一列卡片上会出现「按 168 算在视口内，实际 176 顶出去 8px」。
               ⇒ border-box 让 width 就是总宽，与位置计算的 W 一致。 */
            boxSizing: "border-box",
            maxHeight: "min(60vh, 320px)",
            overflowY: "auto",
            padding: 4,
            borderRadius: 8,
            /**
             * ★ 2026-10-21 G1c：原来用 --dsw-alias-bg-elevated（不存在）
             *   ⇒ 回退 #fff，暗色下白底白字，对比度 1.0:1
             *   ⇒ 改用真实存在的 --dsw-alias-bg-layer-1（资产库面板自己就用它）
             */
            background: "var(--dsw-alias-bg-layer-1, #fff)",
            boxShadow: "0 6px 24px rgba(0,0,0,.14), 0 0 0 0.5px var(--dsw-alias-border-l2, rgba(0,0,0,.12))",
            display: "flex", flexDirection: "column", gap: 1,
          },
        },
        h("div", { style: { padding: "0 4px" } },
          h("div", {
              style: {
                fontSize: 10, lineHeight: "16px", marginBottom: 2,
                color: "var(--dsw-alias-label-tertiary, #81858c)",
              },
            }, "项目文件夹"),
          h(FolderSelect, { item: item, folders, onSaved })
        ),
        h("div", { style: { padding: "0 4px" } },
          h(SuggestFolderButton, { item: item, folders, onSaved })
        ),
        h("div", {
            style: { height: 1, margin: "3px 4px", background: "var(--dsw-alias-border-l2, rgba(0,0,0,.08))" },
          }),
        // ★ CharacterButton 本身就是「＋角色」入口，不要再写一个
        h("div", { style: { padding: "0 4px" } },
          h(CharacterButton, { item: item, onSaved })
        ),
        h("button", {
            type: "button", style: rowStyle, disabled: busy,
            onClick: () => { setOpen(false); onRename?.(); },
            title: "重命名",
          }, "改名"),
        h("button", {
            type: "button",
            style: { ...rowStyle, color: "rgb(207,34,46)" },
            disabled: busy,
            onClick: () => { setOpen(false); onDelete?.(); },
            title: "删除（移到回收区，可复原）",
          }, "删除")
      ),
      document.body
    )
  );
});


const FolderSelect = React.memo(function FolderSelect({ item, folders, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [cur, setCur] = useState(item.folder ?? "");

  useEffect(() => { setCur(item.folder ?? ""); }, [item.folder, item.id]);

  // 当前值可能是个已存在但不在 knownFolders 里的（别的地方设的），补进去
  const all = useMemo(() => {
    const set = new Set(folders ?? []);
    if (cur) set.add(cur);
    return [...set].sort();
  }, [folders, cur]);

  const pick = async (folder) => {
    const prev = cur;
    setCur(folder);
    setBusy(true);
    try {
      await saveFolderToLibrary(item.id, folder);
      await onSaved?.();
    } catch (e) {
      setCur(prev);
      console.warn("[comfy-wb] 文件夹保存失败：", e?.message ?? e);
    } finally {
      setBusy(false);
    }
  };

  return h("span", {
      style: { position: "relative", display: "inline-flex", alignItems: "center", flex: "1 1 auto", minWidth: 0, overflow: "hidden" },
    },
      h("select", {
        value: cur,
        disabled: busy,
        onChange: (e) => pick(e.target.value),
        title: cur ? `项目文件夹：${cur}` : "未归类（点此放入某个项目文件夹）",
        "aria-label": "项目文件夹",
        style: {
          height: 22, padding: "0 16px 0 5px", border: 0, borderRadius: 6,
          background: cur
            ? "rgba(255,171,0,.14)"
            : "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
          color: cur
            ? "rgb(163,106,3)"
            : "var(--dsw-alias-label-tertiary, #81858c)",
          fontFamily: "inherit", fontSize: 11, lineHeight: "20px",
          cursor: busy ? "wait" : "pointer",
          appearance: "none", WebkitAppearance: "none",
          maxWidth: 92,
          opacity: busy ? 0.6 : 1,
        },
      },
        h("option", { value: "" }, "未归类"),
        ...all.map((f) => h("option", { key: f, value: f }, f))
      ),
      h("span", {
        style: {
          position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
          fontSize: 8, opacity: 0.6, pointerEvents: "none",
        },
      }, "▾")
    );
});

/**
 * ★★ 2026-10-20 性能修复：把「用途下拉的选项结构」提到模块级，只算一次。
 *
 *   实测（829 张卡 / 滚动 60 帧）：
 *     优化前 9 FPS（116.1ms/帧），DOM 29,569 节点
 *     虚拟滚动后 16 FPS（63.1ms/帧），DOM 2,109 节点
 *   ⇒ DOM 少了 93%，FPS 只从 9 涨到 16 —— 瓶颈不在节点数，
 *     而在「每次滚动都重建 32~66 个 select × 13 个 option」。
 *
 *   这里按 kind 预先算好「标签分组 → 选项列表」的结构，
 *   渲染时只是引用同一批 React 元素（key 稳定 ⇒ React 直接复用，不重建 DOM）。
 *
 *   ★ 为什么可以用【同一个元素实例】多次：
 *     React 元素是不可变的描述对象，同一个对象可以在多处渲染。
 *     只要 key 与结构不变，diff 就是恒等，不会产生 DOM 操作。
 */
const ROLE_OPTIONS_BY_KIND = (() => {
  const cache = new Map();
  for (const kind of ["image", "video", "audio"]) {
    const list = rolesForKind(kind);
    const groups = [];
    for (const tagName of ["Subject", "Picture", "Video", "Audio"]) {
      const grp = list.filter((r) => r.tag === tagName);
      if (!grp.length) continue;
      groups.push({ tag: tagName, items: grp });
    }
    cache.set(kind, groups);
  }
  return cache;
})();

/**
 * 资产卡上的「用途」下拉（2026-10-20 新增）。
 *
 * 主人：「需要给资产打分类标签，根据标签放入模型支持的参考中。
 *   然后要能在编辑框中临时修改，修改后就默认保存。」
 *
 * 语义：
 *   · 值 = REF_ROLES 的 id（如 subject.character）
 *   · 空 = 没设标签，@ 时按 kind 取默认
 *   · 改完立即 POST /comfy-assets/mutate { action:"role" } 并刷新列表
 *
 * ★ 选项按素材 kind 过滤（rolesForKind）——
 *   音频不可能选「首帧」，因为 H3 里那根本不存在。
 *
 * ★ 选项按 H3 标签分组（optgroup）——
 *   用户能直接看到「这个用途会变成哪种标签」。
 */
const RoleSelect = React.memo(function RoleSelect({ item, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [cur, setCur] = useState(item.role ?? "");

  useEffect(() => { setCur(item.role ?? ""); }, [item.role, item.id]);

  const opts = rolesForKind(item.kind ?? "image");
  const currentMeta = cur ? REF_ROLES[cur] : null;

  /**
   * ★★ 2026-10-20 修（问题文档 Q3 记录的不一致）：
   *
   *   原来空值显示「未设用途」，但 @ 引用时实际会用 defaultRoleFor(kind)
   *   （图片 → 角色外观）。用户看到的和实际提交的不是一回事。
   *
   *   修法：不把默认值写进库（那会污染数据），只在文案里说明它会变成什么。
   *   ⇒ 「未设（默认：角色外观）」
   */
  const fallbackMeta = REF_ROLES[defaultRoleFor(item.kind ?? "image")];
  const emptyLabel = fallbackMeta ? `未设（默认：${fallbackMeta.zh}）` : "未设（默认）";

  const pick = async (roleId) => {
    const prev = cur;
    setCur(roleId);
    setBusy(true);
    try {
      await mutate({ action: "role", id: item.id, role: roleId });
      await onSaved?.();
    } catch (e) {
      setCur(prev);              // 失败回滚，不留下「界面改了但没存上」
      console.warn("[comfy-wb] 用途保存失败：", e?.message ?? e);
    } finally {
      setBusy(false);
    }
  };

  return h("span", {
      style: { position: "relative", display: "inline-flex", alignItems: "center", flex: "1 1 auto", minWidth: 0, overflow: "hidden" },
    },
      h("select", {
        value: cur,
        disabled: busy,
        onChange: (e) => pick(e.target.value),
        title: currentMeta
          ? `${currentMeta.zh} → <${currentMeta.tag}>\n${currentMeta.hint}`
          : "没设用途时，@ 引用会按素材类型取默认",
        "aria-label": "参考用途",
        style: {
          height: 22, padding: "0 18px 0 6px", border: 0, borderRadius: 6,
          background: currentMeta
            ? "rgba(65,118,230,.10)"
            : "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
          color: currentMeta
            ? "var(--dsw-alias-state-business-primary, #4176e6)"
            : "var(--dsw-alias-label-tertiary, #81858c)",
          fontFamily: "inherit", fontSize: 11, lineHeight: "20px",
          cursor: busy ? "wait" : "pointer",
          appearance: "none", WebkitAppearance: "none",
          opacity: busy ? 0.6 : 1,
        },
      },
        h("option", { value: "" }, emptyLabel),
        // ★★ 2026-10-20 性能：用模块级预构建的分组结构（不每次重建 option）
        ...(ROLE_OPTIONS_BY_KIND.get(item.kind ?? "image") ?? []).map((g) =>
          h("optgroup", { key: g.tag, label: `<${g.tag}>` },
            ...g.items.map((r) => h("option", { key: r.id, value: r.id }, r.zh))
          )
        )
      ),
      h("span", {
        style: {
          position: "absolute", right: 5, top: "50%", transform: "translateY(-50%)",
          fontSize: 8, opacity: 0.6, pointerEvents: "none",
        },
      }, "▾")
    );
});

/* ── 失效隔离 ─────────────────────────────────────────────────────── */

export class AssetLibraryBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(e) { return { err: e }; }
  componentDidCatch(e) {
    console.error("[comfy-wb] 资产库模块出错（只丢库，工作台照常）：", e);
  }
  render() {
    if (this.state.err) {
      return h("div", {
        style: {
          padding: "6px 10px", borderRadius: 8, margin: "0 8px 4px",
          background: "rgba(248,81,73,.08)", color: "rgb(207,34,46)",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 11, lineHeight: "16px", whiteSpace: "pre-wrap",
        },
      }, "[资产库模块出错，已隔离 — 提示词与生成不受影响]\n" +
         String(this.state.err?.message ?? this.state.err));
    }
    return this.props.children;
  }
}

export default AssetLibraryBoundary;

/* ── 对外：把 @ 引用接到提示词框 ──────────────────────────────────── */

/**
 * useAssetAtMentions —— @ 引用的全部逻辑，WorkbenchView 只调这几个返回值。
 *
 * 返回：
 *   prompt / setPromptWithAt   —— 带 @ 触发检测的受控值
 *   at                         —— 当前浮层状态（null = 没开）
 *   pickerNode                 —— 要渲染的浮层（放 JSX 里）
 *   panelNode                  —— 完整库面板（打开时才有）
 *   openLibrary()              —— 「资产库」按钮调它
 *   highlightNode              —— 提示词高亮层
 *   onTextareaKeyDown(e)       —— 挂在 textarea 的 onKeyDown 最前面
 */
export function useAssetAtMentions({
  prompt, setPrompt, media, files, setFiles, textareaRef, t, mediaReady = true,
}) {
  const lib = useAssetLibrary();
  const [at, setAt] = useState(null);       // { start: number, query: string }
  const [cursor, setCursor] = useState(0);
  const [onlyCompatible, setOnlyCompatible] = useState(false);
  const [panel, setPanel] = useState(false);
  const [chooser, setChooser] = useState(null); // { asset, kind }
  const [hover, setHover] = useState(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [caretRect, setCaretRect] = useState(null);


  /** 当前模式素材槽能接受的 kind 集合。空集 = 没有槽（krea2 / qwen21）。 */
  const slotKinds = useMemo(() => {
    const s = new Set();
    for (const spec of Object.values(media ?? {})) {
      if (spec?.kind) s.add(spec.kind);
    }
    return s;
  }, [media]);
  const hasSlots = slotKinds.size > 0;

  /**
   * @ 浮层里的候选列表。
   * ★ 这个 useMemo 必须放在【任何 early return 之前】，且所有 filter 逻辑
   *   都在这里 —— AtPicker 只渲染它。理由见 AtPicker 上的注释。
   */
  const atFiltered = useMemo(() => {
    const q = String(at?.query ?? "").trim().toLowerCase();
    let out = lib.items ?? [];
    if (onlyCompatible && hasSlots) out = out.filter((it) => slotKinds.has(it.kind));
    if (q) {
      out = out.filter((it) =>
        String(it.displayName).toLowerCase().includes(q) ||
        String(it.name).toLowerCase().includes(q) ||
        String(it.rel).toLowerCase().includes(q) ||
        // ★ 2026-10-20：@韩立 要能搜到角色卡桥过来的图
        String(it.character ?? "").toLowerCase().includes(q)
      );
    }
    return out.slice(0, 300);
  }, [lib.items, at?.query, onlyCompatible, hasSlots, slotKinds]);

  /**
   * ★★ 2026-10-20 新增：「整组引用」的目标角色。
   *
   * 主人要的是「@韩立 引用这个角色」—— 一个角色常有多张定妆图
   * （正面/侧面/背面/特写），逐张点太慢。
   *
   * 判定：当前搜索命中的资产里，如果【所有】带 character 的项都是同一个角色，
   *       且该角色的图总数 > 1，就给一个「整组引用」按钮。
   *
   * ★ 为什么要求「全部同一个角色」：
   *   如果搜索命中了两个角色（比如搜「立」同时命中韩立和李立），
   *   那个按钮该绑谁？说不清。宁可不显示，也不要猜。
   */
  const charGroup = useMemo(() => {
    const withChar = atFiltered.filter((x) => x.character);
    if (!withChar.length) return null;
    const names = [...new Set(withChar.map((x) => x.character))];
    if (names.length !== 1) return null;              // 命中多个角色 → 不猜
    const character = names[0];
    const total = (lib.items ?? []).filter(
      (x) => x.character === character && x.kind === "image"
    ).length;
    if (total < 2) return null;                        // 只有一张 → 直接点那张就行
    return { character, total };
  }, [atFiltered, lib.items]);

  // 查询词一变就回到第一项
  const lastQ = useRef("");
  useEffect(() => {
    const q = String(at?.query ?? "");
    if (q !== lastQ.current) { lastQ.current = q; setCursor(0); }
  }, [at?.query]);

  /* ── 槽绑定：变化即落 sessionStorage ──────────────────────────── */
  /**
   * ★ 必须先恢复、再允许写回（2026-10-18 实测踩到）：
   *   files 的初值是 {}，而这个 effect 在【挂载瞬间】就会跑一次，
   *   把 sessionStorage 里的引用直接覆盖成 {}。
   *   接着恢复流程读到的是空表 ⇒ 引用永久丢失，界面还显示「引用了」。
   *   判据：切一次 tab 回来，提示词里的 @文字 还在、槽却是空的。
   *   ⇒ 用 hydratedRef 把「恢复完成」之前的写回全部挡掉。
   */
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!hydratedRef.current) return;
    saveSlotRefs(files);
  }, [files]);

  /**
   * ── 正文里删掉 @名字 ⇒ 自动解绑对应的槽 ─────────────────────────
   *
   * ★★ 2026-10-20 新增。为什么必须有：
   *   主人要求把「独立小卡片（RefStrip）」去掉，citation 只在正文里显示。
   *   而 RefStrip 上本来有一个「×」是唯一的解绑入口。
   *   去掉它之后如果不同步，就会出现最糟的那种状态：
   *     正文里 @韩立 已经删了，但 files[slot] 里那张图还在
   *     ⇒ 用户以为没引用，实际生成时却把它送进了工作流。
   *   （这正是 AGENTS 反复记的那类「界面看起来对、数据是错的」）
   *
   * 判据：遍历 files 里每个已绑定的槽，看它的 displayName/filename 是否
   *       还以 `@名字` 的形式出现在 prompt 里。不在 ⇒ 解绑。
   *
   * ⚠ 只在 prompt 发生变化时跑（依赖 [prompt]），不在 files 变化时跑 ——
   *   否则刚通过 @ 选完、marker 还没写进 prompt 的那一帧会被误判成「已删除」。
   */
  const autoUnbindRef = useRef(null);
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (!media || !Object.keys(media).length) return;
    const text = String(prompt ?? "");
    const toClear = [];
    for (const [slot, f] of Object.entries(files ?? {})) {
      if (!f || (!f.assetId && !f.fromAsset)) continue;   // 只处理「来自资产库」的绑定
      /**
       * ★★ 2026-10-20：优先用 markerName（整组引用时它是角色名）。
       *
       *   实测踩到的坑：整组引用往提示词里写的是 `@测试组C`（角色名），
       *   而这里原来只认 `f.displayName || f.name || f.filename`（完整文件名），
       *   ⇒ 判定「用户删了」⇒ 刚绑的 2 个槽立刻被清掉。
       *   症状是 bound 有值但 UI 一个槽都不显示，且零报错。
       */
      const nm = f.markerName || f.displayName || f.name || f.filename;
      if (!nm) continue;
      // 名字可能含正则元字符，用 indexOf 而不是正则
      if (text.indexOf(`@${nm}`) < 0) toClear.push(slot);
    }
    if (!toClear.length) return;
    // 用 ref 防止同一批重复清理（StrictMode 下 effect 会跑两次）
    const key = toClear.join("|");
    if (autoUnbindRef.current === key) return;
    autoUnbindRef.current = key;
    setFiles((s) => {
      const next = { ...s };
      for (const slot of toClear) delete next[slot];
      return next;
    });
  }, [prompt, media, files, setFiles]);

  /**
   * ── 重新挂载后按引用重建槽 ──────────────────────────────────
   * 条件：
   *   ① 当前模式有槽     ② 该槽现在是空的     ③ 存档里有它的引用
   * 重建失败（文件被删 / 接口挂了）就当没有 ——
   * 不留下「看起来引用了、实际没送进去」的假象，生成前会提示缺哪个槽。
   */
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    /**
     * ★ 实测踩到的坑（2026-10-18）：媒体槽是【异步】来的（/modes 要请求）。
     *   首帧 currentMode 为 null ⇒ media = {} ⇒ hasSlots = false。
     *   如果这时就把 restoredRef 置成 true，等 modes 到了也不会再恢复 ——
     *   表现为「切 tab 回来，@文字还在、槽全空，点生成说请先选择素材」。
     *   ⇒ 判据：只有【真的知道这个模式有没有槽】之后才允许收尾。
     */
    if (!mediaReady) return;                 // modes 还没加载完 —— 继续等
    if (!hasSlots) {                          // 该模式本来就没槽，没什么可恢复
      restoredRef.current = true;
      hydratedRef.current = true;
      return;
    }
    const refs = loadSlotRefs();
    const slots = Object.keys(refs ?? {}).filter((s) => media?.[s] && !files?.[s]);
    if (!slots.length) {
      restoredRef.current = true;
      hydratedRef.current = true;
      return;
    }
    restoredRef.current = true;

    let alive = true;
    (async () => {
      // ★ 全部取完再一次性 setFiles —— 逐槽 setFiles 会触发上面那个
      //   写回 effect，用「只恢复了一个槽」的半截状态覆盖掉存档里的另一槽。
      const restored = {};
      for (const slot of slots) {
        const r = refs[slot];
        if (!alive) return;
        try {
          const res = await fetch(
            `${API}/file?src=${encodeURIComponent(r.src)}&rel=${encodeURIComponent(r.rel)}`,
            { cache: "no-store" }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          if (buf.byteLength > MAX_UPLOAD_BYTES) throw new Error("文件超过 20MB");
          const bytes = new Uint8Array(buf);
          let bin = "";
          const CH = 0x8000;
          for (let i = 0; i < bytes.length; i += CH) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
          }
          restored[slot] = {
            base64: btoa(bin),
            filename: r.filename,
            kind: r.kind,
            assetId: r.assetId,
            src: r.src,
            rel: r.rel,
            displayName: r.displayName,
            /**
             * ★ 2026-10-21 补：恢复时也要把 role 接回来。
             *
             *   这条链路有三处要同时改，缺一处都白改：
             *     ① saveSlotRefs 存 role        ✅ 刚修
             *     ② 恢复时构造对象带上 role      ← 本条
             *     ③ 绑定槽位时带 role           ✅ 之前修过
             */
            ...(r.role ? { role: r.role } : {}),
            /**
             * ★★★ 2026-10-21 第二条构造路径（踩到 §6.43「只修一处 = 没修」）
             *
             *   上一次我只修了 fetchAsFilePayload 里的
             *     new Blob([buf], { type: "" })  → { type: blobType }
             *   而【这条恢复路径】是独立构造的：
             *     new Blob([buf])     ← 连 type 参数都没有，等价于 type:""
             *   ⇒ 刷新页面后从 sessionStorage 恢复的 chip，
             *     预览图依然是不解码的白块。
             *
             *   ★ 这是 mimeFromName 断言抓出来的（反向断言「不许有 type 为空的 Blob」），
             *     不是我看代码看出来的 —— 说明「反向断言」值得每个契约都写一条。
             */
            preview: URL.createObjectURL(
              new Blob([buf], {
                type: mimeFromName(r.filename || r.displayName || "") || "application/octet-stream",
              }),
            ),
          };
        } catch {
          // 引用失效 —— 这个槽留空
        }
      }
      if (!alive) return;
      hydratedRef.current = true;             // 先开闸，再写
      if (Object.keys(restored).length) {
        setFiles((cur) => ({ ...cur, ...restored }));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSlots, media, mediaReady]);

  /** 取当前光标所在的屏幕矩形（浮层贴光标，不贴整个框）。 */
  const measureCaret = useCallback(() => {
    const el = textareaRef?.current;
    if (!el) return;
    let r = null;
    try {
      const idx = el.selectionStart ?? 0;
      // 用一个等宽等行高的临时节点量——textarea 没有 caretRange API
      const div = document.createElement("div");
      const cs = window.getComputedStyle(el);
      for (const k of ["fontFamily", "fontSize", "fontWeight", "lineHeight",
                       "letterSpacing", "paddingTop", "paddingLeft", "paddingRight",
                       "borderLeftWidth", "borderTopWidth", "boxSizing", "whiteSpace",
                       "wordBreak", "width"]) {
        div.style[k] = cs[k];
      }
      div.style.position = "absolute";
      div.style.visibility = "hidden";
      div.style.top = "-99999px";
      div.style.height = "auto";
      div.style.whiteSpace = "pre-wrap";
      div.textContent = String(el.value ?? "").slice(0, idx);
      const marker = document.createElement("span");
      marker.textContent = "\u200b";
      div.appendChild(marker);
      document.body.appendChild(div);
      const mr = marker.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      div.remove();
      const rh = parseFloat(cs.lineHeight) || 24;
      r = {
        left: er.left + mr.width + (parseFloat(cs.paddingLeft) || 0) - el.scrollLeft,
        top: er.top + mr.height - el.scrollTop,
        bottom: er.top + mr.height - el.scrollTop + rh,
      };
      // 夹进视口
      if (!Number.isFinite(r.left) || !Number.isFinite(r.top)) r = null;
      else r = { left: Math.max(8, Math.min(r.left, window.innerWidth - 540)), top: r.top, bottom: r.bottom };
    } catch { r = null; }
    if (!r) {
      const er = el.getBoundingClientRect();
      r = { left: er.left + 16, top: er.bottom - 30, bottom: er.bottom };
    }
    setCaretRect(r);
  }, [textareaRef]);

  /**
   * 取一个资产的字节并落到指定槽。
   * ★ 只有这里会碰 setFiles —— 顶层 applyAsset 与「换槽」小浮层都走它，
   *   免得两条路各自写一份 setFiles 而漏掉持久化。
   */
  const bindAsset = useCallback(async (it, slot) => {
    const payload = await fetchAsFilePayload(it, lib.items);
    setFiles((cur) => ({ ...cur, [slot]: payload }));
    return payload;
  }, [lib.items, setFiles]);

  /** 在 prompt 里把 `@query` 换成 `@显示名`。 */
  const insertMarker = useCallback((it, atState) => {
    const name = it.displayName || it.name;
    const marker = `@${name}`;
    const cur = String(prompt ?? "");
    if (atState) {
      const before = cur.slice(0, atState.start);
      const caret = textareaRef?.current?.selectionStart ?? (atState.start + 1 + atState.query.length);
      const after = cur.slice(caret);
      const next = `${before}${marker} ${after.replace(/^\s+/, "")}`;
      setPrompt(next);
      const pos = before.length + marker.length + 1;
      requestAnimationFrame(() => {
        const el = textareaRef?.current;
        if (el) { el.focus(); el.setSelectionRange(pos, pos); }
      });
    } else {
      const el = textareaRef?.current;
      const pos = el?.selectionStart ?? cur.length;
      /**
       * ★ 前后要留空格分隔。实测（2026-10-18）：从库面板点「@引用」时
       *   光标常在句尾，直接拼会得到
       *     `Replace costumes for the character@qwen-edit-src.png`
       *   —— 用户看着像粘连，而且下一次 @ 触发正则会因为前面不是空白而失效。
       */
      const needBefore = pos > 0 && !/\s/.test(cur[pos - 1]) ? " " : "";
      const needAfter = pos < cur.length && !/\s/.test(cur[pos]) ? " " : " ";
      const next = `${cur.slice(0, pos)}${needBefore}${marker}${needAfter}${cur.slice(pos)}`;
      setPrompt(next);
      const caret = pos + needBefore.length + marker.length + needAfter.length;
      requestAnimationFrame(() => {
        if (el) { el.focus(); el.setSelectionRange(caret, caret); }
      });
    }
  }, [prompt, setPrompt, textareaRef]);

  /** 选定一个资产（来自 @ 浮层 或 库面板的「@引用」按钮）。 */
  const applyAsset = useCallback(async (it, atState) => {
    const kindOk = Object.values(media ?? {}).some((s) => !s?.kind || s.kind === it.kind);

    // 当前模式完全没槽 → 只作文本引用
    if (!media || !Object.keys(media).length) {
      insertMarker(it, atState);
      setAt(null);
      return { textOnly: true };
    }
    if (!kindOk) {
      // 类型不符：不静默，明说
      setChooser(null);
      setAt(null);
      window.alert?.(`这个资产是「${KIND_META[it.kind]?.label ?? it.kind}」，` +
        `当前工作流的素材槽只接受其它类型，不能绑定。`);
      return { rejected: true };
    }
    const free = firstFreeSlotFor(media, files, it.kind);
    if (free) {
      try {
        await bindAsset(it, free.slot);
        insertMarker(it, atState);
      } catch (err) {
        window.alert?.(`绑定失败：${err?.message ?? err}`);
      }
      setAt(null);
      return { slot: free.slot };
    }
    // 槽都满了 → 让用户选替换哪个
    setAt(null);
    setChooser({ asset: it, kind: it.kind });
    return { chooser: true };
  }, [media, files, bindAsset, insertMarker]);

  /**
   * ★★ 2026-10-20 新增：一次绑多张（角色定妆图组）。
   *
   * 主人要的是「@韩立 引用这个角色」—— 而一个角色往往有多张定妆图
   * （正面/侧面/背面/特写）。逐张点太慢。
   *
   * 做法：
   *   ① 从 atFiltered 里挑出同一个 character 的全部图
   *   ② 按「视角优先级」排序（正面 → 侧面 → 特写 → 全身 → 背面）
   *      —— 为什么不是按文件名：文件名是机器名，跟视角无关；
   *         而 H3 里「正面」是最能定住长相的那张
   *   ③ 逐个找空槽绑定，槽不够就停，并在提示里说明「只填了 N 张」
   *
   * ★ 为什么不覆盖已占用的槽：
   *   用户手动选的图优先，这是 characters.mjs 里已经定下的规则
   *   （`free = slots.filter(s => !files[s])`），这里保持一致。
   */
  const applyCharacterGroup = useCallback(async (character, atState) => {
    if (!character) return { ok: false, reason: "没有角色名" };
    const group = (lib.items ?? []).filter((x) => x.character === character && x.kind === "image");
    if (!group.length) return { ok: false, reason: `「${character}」没有定妆图` };

    const VIEW_ORDER = ["front", "side", "closeup", "full", "back"];
    const rank = (v) => {
      const i = VIEW_ORDER.indexOf(String(v ?? ""));
      return i < 0 ? VIEW_ORDER.length : i;
    };
    const sorted = group.slice().sort((a, b) => {
      const d = rank(a.charView) - rank(b.charView);
      return d !== 0 ? d : String(a.name).localeCompare(String(b.name));
    });

    let filesNow = files;          // 每绑一张就要更新，否则会抢同一个空槽
    const bound = [];
    const skipped = [];
    const errors = [];
    for (const it of sorted) {
      const free = firstFreeSlotFor(media, filesNow, it.kind);
      if (!free) {
        skipped.push({ name: it.name, why: "没有空槽" });
        continue;
      }
      try {
        const payload = await fetchAsFilePayload(it, lib.items);
        /**
         * ★★ 2026-10-20 修（实测踩到）：不能逐个调 bindAsset()。
         *
         *   bindAsset 内部是 `setFiles(cur => ({...cur, [slot]: payload}))`，
         *   函数式更新本身没问题。但这里连续 await 两次，
         *   中间 React 会重渲染 —— 而 applyCharacterGroup 是 useCallback([files])，
         *   files 一变它就换了新实例，正在跑的这个旧实例继续用旧的 filesNow。
         *
         *   实测症状：bound 里有 2 个槽，UI 只显示 1 个。
         *
         *   修法：先把所有 payload 取完（无副作用），
         *        最后【一次性】setFiles 全写进去。
         *        ⇒ 只有一次 state 更新，不会中途被换掉。
         */
        filesNow = { ...filesNow, [free.slot]: payload };
        bound.push({ name: it.name, slot: free.slot });
      } catch (err) {
        errors.push({ name: it.name, why: String(err?.message ?? err) });
        skipped.push({ name: it.name, why: String(err?.message ?? err) });
      }
    }

    // ★ 一次性写入（见上面注释）
    if (bound.length) {
      setFiles((cur) => {
        const next = { ...cur };
        for (const b of bound) {
          const payload = filesNow[b.slot];
          if (payload) next[b.slot] = { ...payload, markerName: character };
        }
        return next;
      });
    }

    if (bound.length) {
      /**
       * ★★ 2026-10-20 修（实测踩到，值得记清楚）：
       *
       *   原来写的是 `insertMarker({ name: character }, atState)` ——
       *   提示词里只写 `@测试组C`（角色名），一张图一个标记也没有。
       *
       *   而下面那条「正文删掉 @ 就自动解绑」的 effect 是按
       *   `f.displayName || f.name || f.filename`（完整文件名）判断的：
       *     text.indexOf("@20261015_160328_QwenEdit_00001_.png") < 0
       *   ⇒ 判定「用户删了它」⇒ 立刻把刚绑的 2 个槽全清掉。
       *
       *   症状：window.__LAST_GROUP_BIND__.bound 有 2 条（绑定成功），
       *        但 MediaSlots 一个都不显示，console 零错误 ——
       *        因为解绑是「正常逻辑」而非异常，不会报任何错。
       *
       *   修法：给每个绑定记录一个 markerName（这组用角色名），
       *        自动解绑时优先用它判断，而不是硬套文件名。
       *   ⇒ 用户删掉 `@测试组C` 就整组解绑，符合直觉。
       */
      insertMarker({ name: character, displayName: character }, atState);
      // ★ markerName 已在上面那一次 setFiles 里一起写进去了（不重复更新）
    }
    setAt(null);
    // ★ 2026-10-21 删除临时探针 window.__LAST_GROUP_BIND__
    //   它由 2026-10-20 那次「整组引用点了没反应」的诊断留下。
    //   那次诊断已完成，结论落在 AGENTS §6.42~43 与 verify-role-contract：
    //     根因是「自动解绑 effect 用完整文件名判断，而整组引用写的是角色名」
    //     ⇒ 修法是给绑定记录加 markerName，已实装并有用例覆盖。
    //   删除理由同 __CHIP_DEBUG__：每次绑定都写全局、泄露资产名、误导后来者。
    //   判据（可复跑）：grep -c "__LAST_GROUP_BIND__" src/*.js lib/*.js → 0

    // ★ 失败原因必须让人看见（原来被吞掉，实测无从排查）
    if (!bound.length) {
      const why = errors.length
        ? `「${character}」一张都没绑上：${errors[0].why}`
        : `槽位不够，「${character}」一张都没绑上`;
      window.alert?.(why);
      return { ok: false, reason: why };
    }
    const note = skipped.length
      ? `「${character}」绑了 ${bound.length} 张，还有 ${skipped.length} 张没地方放`
      : `「${character}」绑了 ${bound.length} 张定妆图`;
    if (skipped.length) window.alert?.(note);
    return { ok: true, character, bound, skipped: skipped.length, note };
  }, [lib.items, media, files, bindAsset, insertMarker]);

  const textareaProps = useMemo(() => ({
    /**
     * ★ 键盘必须在这里接，不能挂在浮层上：
     *   焦点永远在 textarea，浮层拿不到 keydown。
     */
    onKeyDown: (e) => {
      if (!at) return;
      /**
       * ★ 2026-10-20：决策逻辑抽到 atKeyAction() —— 它可被验收脚本直接测，
       *   而内联在这里的话「Tab 能不能引用」只能靠人肉试。
       */
      const cur = atFiltered[cursor];
      const compatOk = cur ? (!onlyCompatible || !hasSlots || slotKinds.has(cur.kind)) : false;
      const act = atKeyAction(e.key, { count: atFiltered.length, cursor }, {
        composing: !!(e.nativeEvent?.isComposing || e.keyCode === 229),
        compatOk,
      });

      if (act === "accept") { e.preventDefault(); applyAsset(cur, at); return; }
      if (act === "close") { e.preventDefault(); setAt(null); return; }
      if (act === "down") { e.preventDefault(); setCursor((c) => Math.min(atFiltered.length - 1, c + 1)); return; }
      if (act === "up") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); return; }
    },
    onChange: (e) => {
      const val = e.target.value;
      const caret = e.target.selectionStart ?? val.length;
      setPrompt(val);
      // @ 触发：光标前一段是 `@xxx`
      //
      // ★★ 2026-10-20 放宽（主人实测反馈：「输入@之后并不能弹出一个可选窗口」）
      //
      //   原正则：/(^|\s)@([^\s@]*)$/
      //     · @ 前必须是【行首或空白】⇒ 中文标点后面打 @ 不触发
      //       实测「a red apple，@」完全不弹窗
      //     · 查询词不能含空格，@韩 立 会关闭
      //
      //   新正则：/(^|[\s，。、；：！？（）【】「」《》,.;:!?()\[\]"'])@([^\s@]*)$/
      //     · 中文标点、括号、引号后面也能触发
      //     · 仍然不允许查询词含空格（含空格就说明用户不想要这个引用了，
      //       否则「@A 然后继续写正文」会被误判成还在选）
      const before = val.slice(0, caret);
      // ★ 2026-10-20：触发判定抽到 parseAtTrigger()（见文件上方），可被验收直接测
      const hit = parseAtTrigger(before);
      if (hit) {
        setAt((cur) => (cur && cur.start === hit.start && cur.query === hit.query)
          ? cur
          : { start: hit.start, query: hit.query });
        requestAnimationFrame(measureCaret);
      } else {
        setAt(null);
      }
    },
    onKeyUp: (e) => {
      if (at && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End")) {
        requestAnimationFrame(measureCaret);
      }
    },
    onClick: () => { if (at) requestAnimationFrame(measureCaret); },
    onScroll: (e) => setScrollTop(e.currentTarget.scrollTop),
  }), [
    at, setPrompt, atFiltered, cursor, onlyCompatible, hasSlots, slotKinds,
    measureCaret, applyAsset,
  ]);

  const pickerNode = at
    ? h(AtPicker, {
        filtered: atFiltered,
        cursor, setCursor,
        query: at.query,
        media, files,
        anchorRect: caretRect,
        onPick: (it) => applyAsset(it, at),
        onClose: () => setAt(null),
        onlyCompatible, setOnlyCompatible,
        slotKinds, hasSlots,
        // ★ 2026-10-20：整组引用（@角色名 一次绑多张定妆图）
        charGroup,
        onApplyCharacter: (name) => applyCharacterGroup(name, at),
        t,
      })
    : null;

  const panelNode = panel
    ? h(LibraryPanel, {
        lib, media, files, t,
        onClose: () => setPanel(false),
        onInsert: async (it) => {
          await applyAsset(it, null);
          setPanel(false);
        },
      })
    : null;

  const chooserNode = chooser
    ? h(SlotChooser, {
        kind: chooser.kind,
        media, files,
        onClose: () => setChooser(null),
        onPick: async (slot) => {
          try {
            await bindAsset(chooser.asset, slot);
            insertMarker(chooser.asset, null);
          } catch (err) {
            window.alert?.(`绑定失败：${err?.message ?? err}`);
          }
          setChooser(null);
        },
        onTextOnly: () => {
          insertMarker(chooser.asset, null);
          setChooser(null);
        },
      })
    : null;


  /**
   * ★★ 2026-10-20：把「已绑定的槽」整理成正文 chip 能吃的形状。
   *
   * 主人指着截图说的第三件事：「tag 也要在文本卡片旁边，并且可以直接点击切换 tag」
   * ⇒ chip 上要显示用途，且点它能换。
   *
   * 每个 chip 条目给：
   *   names        这张图在正文里可能出现的形式（显示名 / 文件名 / 无扩展名）
   *   roleId       当前用途 id
   *   roleZh/roleTag  中文名与 H3 标签（做 title 提示）
   *   roleOptions  可选项（按 H3 标签分组的平铺列表，给原生 select 用）
   *   slot         绑在哪个槽（切换时要用）
   */
  const chips = useMemo(() => {
    const out = [];
    for (const [slot, f] of Object.entries(files ?? {})) {
      if (!f || (!f.assetId && !f.base64 && !f.filename)) continue;
      const fn = String(f.filename ?? "");
      const dn = String(f.displayName ?? "");
      const noExt = fn.replace(/\.[^.]+$/, "");
      const names = [...new Set([dn, fn, noExt, dn.replace(/\.[^.]+$/, "")].filter(Boolean))];

      const kinds = rolesForKind(f.kind ?? "image");
      const roleId = f.role || defaultRoleFor(f.kind ?? "image");
      const meta = REF_ROLES[roleId] ?? null;

      out.push({
        slot,
        names,
        roleId,
        roleZh: meta?.zh ?? roleId,
        roleTag: meta?.tag ?? "Subject",
        roleOptions: kinds.map((r) => ({ value: r.id, text: r.zh })),
        /**
         * ★★ 2026-10-20 补（主人：「文本框里面的卡片没有预览！！！」）
         *
         *   chip 之前只画了胶囊底色，用户看不到引用的到底是哪张图。
         *   素材卡的 fetchAsFilePayload 里已经带了 preview（blob URL），
         *   这里把它透出来，chip 左侧画一个 16×16 缩略图。
         *
         *   ★ 为什么要按 kind 分别处理：
         *     图片 → <img>
         *     视频 → <img>（ComfyUI 的 video 也能靠 <img> 显示第一帧？
         *            不行，需要 <video>。但 chip 里放 <video> 太重，
         *            这里用「视频图标 + 首帧缩略」的退化方案）
         *     音频 → 图标（没有视觉内容）
         */
        preview: f.preview || null,
        kind: f.kind ?? "image",
      });
    }
    return out;
  }, [files]);

  /** chip 上换用途 → 更新 files[slot].role，同时写回资产库（与 MediaSlots 一致）。 */
  const onChipRoleChange = useCallback((info, roleId) => {
    if (!info?.slot) return;
    let assetId = null;
    setFiles((s) => {
      const cur = s[info.slot];
      if (cur?.assetId) assetId = cur.assetId;
      return { ...s, [info.slot]: { ...cur, role: roleId } };
    });
    if (assetId) {
      saveRoleToLibrary(assetId, roleId).catch((e) =>
        console.warn("[comfy-wb] chip 用途写回资产库失败（本次仍生效）：", e?.message ?? e)
      );
    }
  }, [setFiles]);

  const highlightNode = h(PromptHighlight, {
    text: prompt,
    scrollTop,
    // ★ 2026-10-20：正文 chip 显示用途 + 可点切换
    chips,
    onRoleChange: onChipRoleChange,
  });

  const hoverNode = hover?.f?.preview
    ? createPortal(
        h("div", {
          style: {
            position: "fixed",
            left: Math.min(window.innerWidth - 220, hover.rect.left),
            top: Math.max(8, hover.rect.top - 150),
            zIndex: 99999, padding: 4, borderRadius: 10,
            background: "var(--dsw-alias-bg-layer-1, #fff)",
            boxShadow: "0 0 0 0.5px rgba(0,0,0,.12), 0 8px 26px rgba(0,0,0,.2)",
            pointerEvents: "none",
          },
        },
          h("img", {
            src: hover.f.preview, alt: "",
            style: { width: 200, height: 140, objectFit: "cover", borderRadius: 7, display: "block" },
          })
        ),
        document.body
      )
    : null;

  return {
    lib,
    at,
    pickerNode, panelNode, chooserNode, highlightNode, hoverNode,
    openLibrary: () => setPanel(true),
    textareaProps,
    applyAsset,
  };
}

/* ── 安全挂载器 ───────────────────────────────────────────────────── */

export function SafeAssetLibrary(props) {
  try {
    return h(AssetLibraryBoundary, null, props.children);
  } catch (err) {
    console.warn("[comfy-wb] 资产库挂载失败，已跳过：", err?.message ?? err);
    return null;
  }
}

/* ── ArtCraft 的资产选择器 ─────────────────────────────────────────── */

/**
 * 给 ArtCraft 的 assetGallery.openPicker 用的 React 版本。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人定的顺序：「先做后端，再匹配前端 ui」。
 *   后端（src/artcraft-adapter.mjs 的 openPicker 契约）已就绪，
 *   这里是它的界面。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么单独做一个 hook，而不复用 useAssetAtMentions
 *
 *   useAssetAtMentions 有 1200 多行，管着：@ 触发、键盘导航、槽绑定、
 *   sessionStorage 持久化、chip 高亮、拖拽悬停预览……
 *   它绑死了「提示词 textarea + 素材槽」这套上下文。
 *
 *   ArtCraft 要的只是「打开面板 → 选几个 → 拿回数组」，
 *   没有 textarea、没有素材槽。硬塞进那个 hook 会引入大量用不到的状态，
 *   而且任何一处改动都可能影响 @ 引用（那是已经在跑的功能）。
 *
 *   ⇒ 单独一个 30 行的 hook，只依赖 useAssetLibrary。
 *     两个界面共用同一个 LibraryPanel（避免两套 UI 要同步维护），
 *     只是出口不同。
 * ══════════════════════════════════════════════════════════════════════
 *
 * 用法（前端接 ArtCraft 时）：
 *
 *   const picker = useAssetPicker();
 *   // 别处调用：
 *   const items = await picker.open({ kinds: ["video"] });   // → 我们的 asset 数组
 *   // 渲染：
 *   picker.node      // 面板（null 时什么都不渲染）
 *
 * @returns {{ open: (opts?: {kinds?: string[]}) => Promise<object[]>, node: any, close: () => void }}
 */
export function useAssetPicker() {
  const lib = useAssetLibrary();
  const [req, setReq] = useState(null);   // { kinds, resolve }

  const open = useCallback((opts = {}) => {
    return new Promise((resolve) => {
      setReq({ kinds: Array.isArray(opts.kinds) ? opts.kinds : [], resolve });
    });
  }, []);

  const close = useCallback(() => {
    // 用户取消 ⇒ 返回空数组（ArtCraft 拿到空数组就是「没选」）
    req?.resolve?.([]);
    setReq(null);
  }, [req]);

  const confirm = useCallback((items) => {
    req?.resolve?.(items ?? []);
    setReq(null);
  }, [req]);

  const node = req
    ? h(LibraryPanel, {
        lib,
        // pickMode + pickKinds 是 2026-10-20 新加的两个可选参数，
        // 不传时 LibraryPanel 行为与之前完全一致
        pickMode: true,
        pickKinds: req.kinds,
        onClose: close,
        onPickConfirm: confirm,
      })
    : null;

  return { open, node, close };
}

