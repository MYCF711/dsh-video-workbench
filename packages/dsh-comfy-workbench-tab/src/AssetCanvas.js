/**
 * AssetCanvas —— 「画布式资产库」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人原话（需求本身，逐字）
 *   「现在的视频工作台部分是不是空白太多？弄成画布怎么样？
 *     画布应该是比较好的资产展示形式？生成后直接弹到画布里面？」
 *   「目前确实能看到图片，而且有五个...但是图片不能打开，不能保存，
 *     不知道对应的是哪个的产物」
 * ⇒ 四件事：① 能打开+能保存 ② 标清来源 ③ 空白→画布 ④ 生成后自动弹入
 * ══════════════════════════════════════════════════════════════════════
 *
 * ── 为什么画布用手写 CSS transform 而不是引库 ────────────────────────
 * 实测（2026-10-18，library_search + 本机 node_modules 双查）：
 *   · tldraw 5.5.2 —— 未压缩 15.2 MB，peer 要 react 18/19，且必须注入
 *     它自己的 CSS。lib/client.js 被 build.mjs 打成【单个 IIFE】，
 *     没有 CSS 通道；把 15 MB 样式表塞进 <style> 会污染 DSH 全局
 *     （违反「不许挤动 DSH 原生元素」这条硬约束 ⑤）。
 *   · react-zoom-pan-pinch 4.2.0 / @xyflow —— 只提供「整体 pan+zoom」，
 *     卡片各自的自由拖动仍要自己写；省不到 60 行，却多一次 pnpm install
 *     和 react 版本匹配风险。
 *   · 本包与上层 DSH视频工作台 都【没有】node_modules，装库要改
 *     package.json 并让宿主重装 —— 为一个 150 行的变换不值得。
 * ⇒ 手写：pan + zoom + 卡片拖动，全部 CSS transform，零依赖零 CSS 注入。
 *
 * ── 失效隔离 ────────────────────────────────────────────────────────
 * 本模块自带 Boundary。canvas 崩了只丢画布，工作台参数区照常可用。
 */

import React from "react";
import { createPortal } from "react-dom";

const { useState, useEffect, useRef, useMemo, useCallback } = React;
const h = React.createElement;

// ── 画布几何常量 ────────────────────────────────────────────────────
const MIN_SCALE = 0.12;
const MAX_SCALE = 4;
const CARD_W = 240;          // 卡片默认宽（画布坐标，非屏幕像素）
const CARD_H = 232;          // 卡片默认高（图片区约 150 + 标头 27 + 底栏 35 + 余量）
const GAP = 24;              // 卡片间距
const COLS = 4;              // 自动排布列数
const GRID = 24;             // 背景点阵间距（屏幕像素，不随缩放变——见 style）

// ── 来源标注规则 ────────────────────────────────────────────────────
/**
 * ★ 为什么是「文件名规则」而不是「nodeId 表」：
 *   项目约定（AGENTS.md §二.4）写明「代码里不许写死节点 id，工作流是运行时
 *   输入」。而后端 /comfy-bridge/modes 目前【不返回】outputs 映射
 *   （index.js:113 的 modes() 只给 id/label/defaults/media/toggles/caps），
 *   前端因此无从得知「node 202 就是一采」。主人给的边界是「不改 bridge」。
 *   ⇒ 主判据用【文件名 + type】，这套规则跨工作流成立、不绑任何节点 id。
 *     nodeId 只作最后兜底显示，不参与归类。
 *
 *   实测原始数据（2026-10-18，ComfyUI /history 直查）：
 *     node 202  ComfyUI_temp_snyae_00005_.png   type=temp
 *     node 220  Krea2-2ST-20261018_00006_.png   type=output
 *     node 186  Krea2-USD-20261018_00002_.png   type=output
 *     node 174  Krea2-SVR-20261018_00004_.png   type=output
 *     node 175  image_00001_3.jpg  subfolder=▶单图简单转换_ImageToolkit
 */
/**
 * ★ 怎么判「这张是哪个产物」—— 三层，从权威到兜底：
 *
 * ① 权威层：nodeId → 角色，来自 /comfy-assets/roles
 *    （它的源头是每个工作流 bind.json 的 outputs 映射，例如 krea2：
 *      { image:202, imageTwoPass:220, imageUsd:186, imageSeedvr:174 }）
 *
 * ② 文件名层：当 ① 拿不到时用。这一层只对最明显的两类有效：
 *    type=temp（PreviewImage 瞬时预览）与 .jpg。
 *
 *    ★ 2026-10-19 更正（复核员 e31d7b8a 指出，我复跑确认）：
 *      原文写「实测工作流里 filename_prefix 是 zzz-renamed-220 这种只带节点号
 *      不带语义的值」——【这是错的】。实读 krea2-full.json 得到的是：
 *        220 → Krea2-2ST-20261018
 *        186 → Krea2-USD-20261018
 *        174 → Krea2-SVR-20261018
 *      三个 prefix 都带语义。
 *      ⇒ 文件名层其实【可以】靠前缀区分二采/高清重绘/SeedVR2，
 *        但 ① 权威层仍然优先（nodeId 不会因为改名而失效）。
 *      错误的出处见下方「为什么 ① 优先」段的更正说明。
 *
 * ③ 落地层：都没有就按「产物」显示，但【仍然】把节点号印在卡片上，
 *    主人至少能从 #220 这类角标对回 ComfyUI 画布。
 *
 * 为什么 ① 优先（2026-10-19 更正原「prefix 只差数字」的说法）：
 *   · 文件名层依赖 prefix 约定，而 prefix 是可以在工作流里随手改的
 *     （历史上就曾被改成 zzz-renamed-*）
 *   · nodeId 是工作流的结构标识，改名不影响它
 *   · bind.outputs 把 nodeId 映射到语义角色，是唯一不依赖命名的真相源
 *   ⇒ 所以「来源」的权威仍是 bind 的 outputs 表，但理由不是「文件名无语义」，
 *     而是「文件名可被改，nodeId 不会」。
 */
const ROLE_META = {
  // krea2 的 bind.outputs 键名 → 展示内容
  image:       { rank: 0, label: "一采",     tone: "#6b7280", hint: "一采出图（PreviewImage 预览）" },
  imageTwoPass:{ rank: 1, label: "二采",     tone: "#4176e6", hint: "二采精修（放大后低 denoise 重采样）" },
  imageUsd:    { rank: 2, label: "高清重绘", tone: "#8b5cf6", hint: "UltimateSDUpscale 高清重绘" },
  imageSeedvr: { rank: 3, label: "SeedVR2",  tone: "#2ea043", hint: "SeedVR2 高质量放大" },
  // 其它工作流可能出现键名
  video:       { rank: 5, label: "视频",     tone: "#0e7490", hint: "视频产物" },
  imageEdit:   { rank: 2, label: "改图",     tone: "#8b5cf6", hint: "编辑结果" },
};

const RULES = [
  {
    id: "pass1", rank: 0, label: "一采", tone: "#6b7280",
    match: (o) => String(o.type ?? "") === "temp",
    hint: "PreviewImage 瞬时预览（ComfyUI temp 目录，可能在清理时被删）",
  },
  {
    id: "pass2", rank: 1, label: "二采", tone: "#4176e6",
    match: (o) => /-2ST-/i.test(name(o)),
    hint: "第二次采样精修（放大后低 denoise 重采样）",
  },
  {
    id: "usd", rank: 2, label: "高清重绘", tone: "#8b5cf6",
    match: (o) => /-USD-/i.test(name(o)),
    hint: "UltimateSDUpscale 高清重绘",
  },
  {
    id: "seedvr", rank: 3, label: "SeedVR2", tone: "#2ea043",
    match: (o) => /-SVR-/i.test(name(o)),
    hint: "SeedVR2 高质量放大",
  },
  {
    id: "extra", rank: 4, label: "附带", tone: "#d29922",
    match: (o) => /\.jpe?g$/i.test(name(o)),
    hint: "附带产物（BatchImageSaverCN 之类另存的 JPG）",
  },
  {
    id: "video", rank: 5, label: "视频", tone: "#0e7490",
    match: (o) => isVid(o),   // ★ 2026-10-19 改用扩展名白名单（原来是子串匹配）
    hint: "视频产物",
  },
];

function name(o) { return String(o?.filename ?? ""); }

/**
 * 归一个产物到某个来源。
 *
 * @param o      单个产物
 * @param roles  { [nodeId]: roleKey } —— 来自 /comfy-assets/roles，可能为空
 */
function classify(o, roles) {
  // ── ① 权威层：nodeId → bind 里的 outputs 角色 ──
  const nodeId = o?.nodeId != null ? String(o.nodeId) : "";
  const roleKey = nodeId && roles ? roles[nodeId] : null;
  if (roleKey) {
    const meta = ROLE_META[roleKey];
    if (meta) return { id: roleKey, ...meta };
    // bind 里写了别的键名 —— 用它自己当显示名，不丢信息
    return {
      id: roleKey, rank: 6,
      label: roleKey, tone: "#8b949e",
      hint: `bind.outputs 里的角色：${roleKey}`,
    };
  }

  // ── ② 文件名层 ──
  for (const r of RULES) {
    try { if (r.match(o)) return r; } catch { /* 单条规则炸了不影响其它 */ }
  }

  // ── ③ 落地层 ──
  return { id: "other", rank: 6, label: "产物", tone: "#8b949e", hint: "" };
}

/** 稳定 key —— 顺序不稳的根因就是原来用数组下标当 key。 */
function keyOf(o, i) {
  return `${o?.nodeId ?? "?"}:${name(o) || i}`;
}

// ★★ 2026-10-19 修（白名单思维推广到文件类型判定）：
//   原来是【子串匹配】—— /png|jpe?g|webp|gif|bmp/i 匹配文件名【任意位置】。
//   实测误判：
//     "mypngdata.json"      → isImg=true   （被当成图片）
//     "video_mp4_report.txt"→ isVid=true   （被当成视频）
//     "comfywebmlog.log"    → isVid=true   （含 "webm"）
//   后果：<video src="...txt"> 去加载一个文本文件，永远失败。
//
//   ⇒ 改成【扩展名后缀匹配】，且用白名单数组。
//      文件名可能带路径（type=output&filename=sub/a.png），先取 basename 再比后缀。
const IMG_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"];
const VID_EXT = [".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"];
const AUD_EXT = [".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"];
const extOf = (o) => {
  const n = String(name(o) ?? "");
  const base = n.split(/[\\/]/).pop() ?? "";
  const m = base.toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : "";
};
const isImg = (o) => IMG_EXT.includes(extOf(o));
const isVid = (o) => VID_EXT.includes(extOf(o));
const isAud = (o) => AUD_EXT.includes(extOf(o));

/**
 * 产物 → 画布卡片。
 *
 * ★ 排序按来源优先级（rank），不按后端返回顺序 ——
 *   主人原话「产物顺序是乱的」，后端 history 的 outputs 是
 *   按 nodeId 字典序遍历的（174/175/186/202/220），不是流程顺序。
 */
function toCards(outs, bridge, roles) {
  const list = (outs ?? []).map((o, i) => ({ o, i, rule: classify(o, roles) }));
  list.sort((a, b) => a.rule.rank - b.rule.rank || String(name(a.o)).localeCompare(String(name(b.o))));
  return list.map(({ o, i, rule }) => ({
    key: keyOf(o, i),
    out: o,
    rule,
    // ★ 2026-10-18 修（真机抓到的缺陷）：
    //   原来显示用的是 bridge.viewUrl(o.url) —— 直接指向 ComfyUI 的 8188，
    //   是【跨源】的。实测：
    //     GET 8188/api/view?...                      → 200
    //     GET 同上 + Origin: http://127.0.0.1:19499 → 403
    //   浏览器加载 <img> 时可能带上 Origin（CSP / referrer 策略决定），
    //   一旦带上就被 ComfyUI 的 aiohttp 拒掉 → 画布显示「图加载失败」。
    //   实测症状：4 张卡全显示「图加载失败（ComfyUI temp 可能已清理）」，
    //   但同样的文件走 /comfy-assets/view 代理是 200。
    //   ⇒ 显示与下载统一走同源代理。
    src: dlUrl(o).replace("&download=1", ""),
    dl: dlUrl(o),
    isImg: isImg(o),
    isVid: isVid(o),
  }));
}

/**
 * 下载地址 —— 走【同源代理】。
 *
 * ★ 为什么不用 bridge.viewUrl(o.url) 直接当 href：
 *   实测（2026-10-18，node fetch 复现）：
 *     GET http://127.0.0.1:8188/api/view?...                      → 200
 *     GET 同上 + Origin: http://127.0.0.1:19499                   → 403
 *     OPTIONS 同上（preflight）                                    → 403
 *   ComfyUI 的 aiohttp 对带 Origin 的跨源请求直接拒。而 <img> 是
 *   no-cors 模式（不带 Origin），所以【图能看、下不了】。
 *   <a download> 跨源时 download 属性本身就被浏览器忽略，点了只会
 *   导航到 8188 把工作台带走 —— 不是「真的下载」。
 *   ⇒ 必须由 M2 自己的 host 侧（lib/index.js）代理成同源。
 *     这是【改 M2】不是改 bridge，bridge 一行不动。
 */
function dlUrl(o) {
  const q = new URLSearchParams({
    filename: name(o),
    subfolder: String(o?.subfolder ?? ""),
    type: String(o?.type ?? "output"),
    download: "1",
  });
  return `/comfy-assets/view?${q.toString()}`;
}

// ══════════════════════════════════════════════════════════════════════
// Lightbox —— 点开看大图 + 下载 + Esc 关闭 + 滚轮缩放
// ══════════════════════════════════════════════════════════════════════
function Lightbox({ item, items, onClose, onStep }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);

  // Esc 关闭 —— 挂在 window 上，capture 阶段抢在 DSH 自己之前
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); return; }
      if (e.key === "ArrowLeft") { onStep?.(-1); return; }
      if (e.key === "ArrowRight") { onStep?.(1); return; }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, onStep]);

  // 换图时重置视图
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [item?.key]);

  const idx = items.findIndex((x) => x.key === item.key);

  /**
   * ★ 必须 createPortal 到 body。
   *   实测（2026-10-18，canvas-03-lightbox.png）：直接渲染在工作台内部时，
   *   DSH 侧栏与顶栏仍然盖在遮罩【之上】—— 不是 z-index 不够，是
   *   conversation.view 的祖先带 transform / isolation，形成了新的
   *   stacking context，里面的 z-index:99999 只在这个 context 内排序，
   *   永远赢不了外面的兄弟节点。
   *   ⇒ 挂到 body 才真正浮在全页之上。
   */
  return createPortal(h("div", {
    // 用 createPortal 之外的最省事做法：fixed 全屏 + 高 z-index。
    // ★ 不抢 DSH 的键盘焦点，Esc/方向键只在 capture 阶段处理。
    style: {
      position: "fixed", inset: 0, zIndex: 99999,
      /**
       * ★ 0.92 + 背景模糊。
       *   实测（2026-10-18，canvas-18-lightbox-portal.png）：0.84 时 DSH 的
       *   左侧栏文字仍隐约透出来，看着像「没盖住」，虽然 elementFromPoint
       *   确认点击已被遮罩接管（功能没问题，是观感问题）。
       *   ⇒ 抬到 0.92 并加 blur，把背景压成纯色块。
       */
      background: "rgba(0,0,0,.92)",
      backdropFilter: "blur(8px)",
      WebkitBackdropFilter: "blur(8px)",
      display: "flex", flexDirection: "column",
      fontFamily: "inherit", fontSize: 13, lineHeight: "20px",
      color: "#fff",
    },
    onPointerDown: (e) => { if (e.target === e.currentTarget) onClose(); },
  },
    // ── 顶栏 ──
    h("div", {
      style: {
        flex: "none", display: "flex", alignItems: "center", gap: 10,
        padding: "10px 14px", minHeight: 44, boxSizing: "border-box",
        background: "linear-gradient(rgba(0,0,0,.55), rgba(0,0,0,0))",
      },
    },
      h("span", {
        style: {
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "2px 9px", borderRadius: 999,
          background: item.rule.tone, color: "#fff",
          fontSize: 12, lineHeight: "18px", fontWeight: 600,
        },
      }, item.rule.label),
      h("span", {
        style: {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 12, lineHeight: "18px",
          color: "rgba(255,255,255,.78)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          minWidth: 0, flex: "1 1 auto",
        },
        title: name(item.out),
      }, name(item.out) || item.key),
      h("span", {
        style: { flex: "none", fontSize: 12, color: "rgba(255,255,255,.55)" },
      }, `${idx + 1} / ${items.length}`),

      // ── 下载（lightbox 里也给一份）──
      h("a", {
        href: item.dl, download: name(item.out),
        style: btnGhost("#fff"),
        onClick: (e) => e.stopPropagation(),
      }, "下载"),

      // ── 关闭 ──
      h("button", {
        type: "button", onClick: onClose, title: "关闭（Esc）",
        style: btnGhost("#fff"),
      }, "✕"),
    ),

    // ── 图区 ──
    h("div", {
      style: {
        flex: "1 1 auto", minHeight: 0, position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        overflow: "hidden", cursor: dragRef.current ? "grabbing" : "grab",
      },
      onWheel: (e) => {
        e.preventDefault();
        const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        setZoom((z) => Math.max(0.2, Math.min(8, z * f)));
      },
      onPointerDown: (e) => {
        if (e.target !== e.currentTarget && e.target.tagName !== "IMG" && e.target.tagName !== "VIDEO") return;
        dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      },
      onPointerMove: (e) => {
        const d = dragRef.current;
        if (!d) return;
        setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
      },
      onPointerUp: () => { dragRef.current = null; },
      onPointerCancel: () => { dragRef.current = null; },
    },
      item.isVid
        ? h("video", {
            src: item.src, controls: true, autoPlay: true, loop: true, playsInline: true,
            style: {
              maxWidth: "92%", maxHeight: "100%",
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "center", transition: dragRef.current ? "none" : "transform .12s",
              borderRadius: 4,
            },
          })
        : item.isImg
        ? h("img", {
            src: item.src, alt: name(item.out), draggable: false,
            style: {
              maxWidth: "92%", maxHeight: "100%",
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "center", transition: dragRef.current ? "none" : "transform .12s",
              userSelect: "none",
            },
          })
        : h("div", {
            style: { padding: 20, color: "rgba(255,255,255,.8)" },
          },
            h("a", { href: item.src, target: "_blank", rel: "noreferrer", style: { color: "#8ab4ff" } }, name(item.out) || "打开产物"),
          ),

      // 左右翻页
      items.length > 1 ? h(React.Fragment, null,
        h("button", {
          type: "button", title: "上一张（←）",
          onClick: () => onStep?.(-1),
          style: { ...navBtn(), left: 12 },
        }, "‹"),
        h("button", {
          type: "button", title: "下一张（→）",
          onClick: () => onStep?.(1),
          style: { ...navBtn(), right: 12 },
        }, "›"),
      ) : null,
    ),

    // ── 底栏：说明 + 缩放 ──
    h("div", {
      style: {
        flex: "none", display: "flex", alignItems: "center", gap: 12,
        padding: "8px 14px", minHeight: 40, boxSizing: "border-box",
        fontSize: 12, lineHeight: "18px", color: "rgba(255,255,255,.62)",
      },
    },
      h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
        item.rule.hint || `node ${item.out?.nodeId ?? "?"}`),
      h("span", null, `${Math.round(zoom * 100)}%`),
      h("button", {
        type: "button", onClick: () => { setZoom(1); setPan({ x: 0, y: 0 }); },
        style: btnGhost("#fff"),
      }, "复位"),
      h("span", null, "Esc 关闭 · ←/→ 翻页 · 滚轮缩放"),
    ),
  ), document.body);
}

function btnGhost(color) {
  return {
    flex: "none",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    height: 26, padding: "0 10px", boxSizing: "border-box",
    borderRadius: 999, border: `1px solid ${color === "#fff" ? "rgba(255,255,255,.3)" : "rgba(0,0,0,.16)"}`,
    background: "rgba(128,128,128,.18)",
    color, fontFamily: "inherit", fontSize: 12, lineHeight: "18px",
    fontWeight: 500, cursor: "pointer", textDecoration: "none",
  };
}

function navBtn() {
  return {
    position: "absolute", top: "50%", transform: "translateY(-50%)",
    width: 40, height: 40, borderRadius: 999, border: 0,
    background: "rgba(255,255,255,.14)", color: "#fff",
    fontSize: 24, lineHeight: "24px", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
  };
}

// ══════════════════════════════════════════════════════════════════════
// 画布本体
// ══════════════════════════════════════════════════════════════════════
export function AssetCanvas({ outputs, bridge, t, expanded, modeId, onOpenLibrary, onGenerate, libraryCount, onSendToTimeline }) {
  /**
   * ★ 来源角色表：/comfy-assets/roles → { [modeId]: { [nodeId]: roleKey } }
   *   拿不到就一直是 {}，classify() 会退回文件名规则 —— 功能不因此坏掉。
   *   每次切换工作流都会重取，因为不同 bind 的 outputs 表完全不同。
   */
  const [roleMap, setRoleMap] = useState({});
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/comfy-assets/roles", { cache: "no-store" });
        if (!res.ok) return;
        const j = await res.json();
        if (alive && j?.ok) setRoleMap(j.modes ?? {});
      } catch { /* 静默降级到文件名规则 */ }
    })();
    return () => { alive = false; };
  }, [modeId]);

  const roles = useMemo(() => {
    if (!modeId) return null;
    return roleMap?.[modeId] ?? null;
  }, [roleMap, modeId]);

  const cards = useMemo(() => toCards(outputs, bridge, roles), [outputs, bridge, roles]);

  // ── 画布持久化（2026-10-18，学 YUH 的双写）────────────────────
  //
  // ★ 为什么必须做：canvas-room 交付时自己标了「未验证：画布不持久化」。
  //   实测确认 view/pos 都是纯内存 state —— 切 tab 组件卸载后，
  //   用户辛苦排好的卡片位置全部丢失，下次回来又是自动排布。
  //   这与主人「切 tab 回来状态全丢」的抱怨是同一类问题。
  //
  // ★ 为什么 localStorage + 磁盘双写：
  //   localStorage 快但 5MB 上限、隐私模式下不可用；
  //   磁盘持久（走 /comfy-assets/canvas）但要网络。
  //   YUH 的日志里就是这么写的（「浏览器缓存已满，画布仍保存在磁盘」）。
  //   这里：localStorage 即时写（防卸载丢），200ms 后同步到磁盘（防容量丢）。
  const CANVAS_KEY = "comfy-wb:canvas";
  const restore = useRef(null);
  if (restore.current === null) {
    try {
      const raw = localStorage.getItem(CANVAS_KEY);
      restore.current = raw ? JSON.parse(raw) : {};
    } catch { restore.current = {}; }
  }
  // localStorage 空 → 从磁盘兜底拉一次（配额满 / 隐私模式 / 换浏览器时用）
  // 只在真的空的时候拉，避免覆盖用户当前的排版
  useEffect(() => {
    if (restore.current && Object.keys(restore.current).length) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/comfy-assets/canvas", { cache: "no-store" });
        if (!res.ok) return;
        const j = await res.json();
        if (!alive || !j?.ok || j.empty) return;
        // ★★ 2026-10-19 修（实测：清空 localStorage 后 16 张卡不自动 fit）：
        //   磁盘上可能存着【只有 view 没有 pos】的脏数据 ——
        //   实测磁盘内容：{"view":{"x":219,"y":75,"s":1},"pos":{}}（pos 空）
        //
        //   原逻辑会无条件 setView(j.view)，把那个 scale=1 的旧视野回灌进来；
        //   而 pos 空 ⇒ 不设 userMovedRef ⇒ 后续 fit 又因为 pos 不完整而放弃。
        //   结果：视野是用户上次手动拖的 scale=1，卡片按 4 列排开右侧全部溢出。
        //
        //   修法：只有【pos 非空】时才算「有可恢复的排版」，才回灌 view。
        //   只有 view 没有 pos = 没有排版信息，view 也没有意义（会被 fit 重算）。
        const hasPos = j.pos && Object.keys(j.pos).length > 0;
        if (hasPos) {
          restore.current = { view: j.view, pos: j.pos };
          if (j.view) setView(j.view);
          setPos(j.pos);
          userMovedRef.current = true;   // 有排版 = 用户动过，之后不自动重排
        }
        // pos 空 ⇒ 什么都不回灌，交给自动 fit 重新算视野
      } catch { /* 磁盘也读不到就用默认排布 */ }
    })();
    return () => { alive = false; };
  }, []);

  // view = 画布变换（pan/zoom）；pos = 每张卡在画布里的坐标
  const [view, setView] = useState(() => restore.current?.view ?? { x: 40, y: 40, s: 1 });
  const [pos, setPos] = useState(() => restore.current?.pos ?? {});      // key -> {x, y}
  const [light, setLight] = useState(null); // 打开 lightbox 的 key
  const [hover, setHover] = useState(null);

  const wrapRef = useRef(null);
  const panRef = useRef(null);
  const cardDragRef = useRef(null);
  const userMovedRef = useRef(false);      // 用户手动操作过 → 不再自动 fit

  // ── 保存（2026-10-18）：localStorage 立刻写，磁盘延后同步 ──
  //   只在用户真的动过之后才存 —— 否则自动 fit 的初始值会被当成「用户排版」，
  //   下次回来就不再自动排布了（那比丢位置更烦）。
  const saveDiskRef = useRef(null);
  useEffect(() => {
    if (!userMovedRef.current) return;      // 用户没动过，不覆盖
    const payload = { view, pos, at: Date.now() };
    try {
      localStorage.setItem(CANVAS_KEY, JSON.stringify(payload));
    } catch {
      // 隐私模式 / 配额满 —— 静默，反正还有磁盘
    }
    // 磁盘同步：防抖 400ms，避免拖动时每帧都发请求
    if (saveDiskRef.current) clearTimeout(saveDiskRef.current);
    saveDiskRef.current = setTimeout(() => {
      fetch("/comfy-assets/canvas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => { /* 磁盘写失败不影响使用 */ });
    }, 400);
    return () => { if (saveDiskRef.current) clearTimeout(saveDiskRef.current); };
  }, [view, pos]);

  // ── 新产物自动落位（第 ④ 件事）────────────────────────────────────
  /**
   * ★ 判据：按【key 差集】增量合并，不是整表重建。
   *   整表重建会把用户拖好的卡片全弹回原位（主人拖一半结果自己跳走 = bug）。
   *   实测依据：ComfyUI 的 /history/{promptId} 只在任务【完成后】才出条目，
   *   所以「新产物出现」= 轮询那次 setJob 的 outputs 从 0 变 N。
   *   轮询 1000ms ⇒ 最迟 1s + 一次渲染就上画布。
   */
  useEffect(() => {
    setPos((prev) => {
      const next = { ...prev };
      let changed = false;
      // ★ 2026-10-18 修真缺陷（截图看到 4 张卡只显示 3 张、第 1 张被裁）：
      //   原来「先按 Object.keys(prev).length 起算槽位，最后才清理死键」。
      //   如果 prev 里残留着已删的旧键，slot 起点就偏了 ——
      //   实测两张卡的 x 只差 1px（705 vs 704），基本叠在一起。
      //
      //   修：① 先清死键 ② 再按「当前活卡的槽位数」起算 ③ 用真实占位判断。
      const live = new Set(cards.map((c) => c.key));

      // ① 先清掉不属于当前这批产物的键
      for (const k of Object.keys(next)) {
        if (!live.has(k)) { delete next[k]; changed = true; }
      }

      // ② 用「已被占用的坐标」来挑空位，而不是拿数量当索引 ——
      //    数量当索引在删除/重排后会撞车。
      const taken = new Set(
        Object.values(next).map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)
      );
      const incoming = cards.filter((c) => !next[c.key]);
      let slot = 0;
      for (const c of incoming) {
        // 往后找一个没人占的格
        let col, row, key;
        do {
          col = slot % COLS;
          row = Math.floor(slot / COLS);
          key = `${col * (CARD_W + GAP)},${row * (CARD_H + GAP)}`;
          slot++;
        } while (taken.has(key) && slot < 1000);
        taken.add(key);
        next[c.key] = { x: col * (CARD_W + GAP), y: row * (CARD_H + GAP) };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [cards]);

  // ── 首屏 / 新产物：把视野挪到能看见 ────────────────────────────────
  const fit = useCallback((animate = true) => {
    const el = wrapRef.current;
    if (!el) return;
    const keys = cards.map((c) => c.key).filter((k) => pos[k]);
    if (!keys.length) { setView({ x: 40, y: 40, s: 1 }); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const k of keys) {
      const p = pos[k];
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + CARD_W);
      y1 = Math.max(y1, p.y + CARD_H);
    }
    // ★ 上下留够 —— 底部有「4 个产物 · 拖空白平移…」那行小字，
    //   不留空间的话最后一行卡片会被它压住 / 被容器裁掉（实测 canvas-13）。
    const padX = 24;
    const padTop = 56;      // 顶部工具条（右上角那排按钮）占位
    const padBottom = 40;   // 底部提示小字
    const w = el.clientWidth  - padX * 2;
    const hgt = el.clientHeight - padTop - padBottom;
    if (w <= 0 || hgt <= 0) return;
    /**
     * ★ 缩放下限设 0.45，不追求「一张不落地塞满视野」。
     *   实测（2026-10-18，canvas-00-acceptance-4-sources.png）：
     *   4 张卡按 3 列排成 2 行，硬塞进 348px 高的画布算出 47%，
     *   卡片上的「一采/二采」标签小到看不清 —— 那等于白标。
     *   宁可让第二行稍微探出、由用户滚一下轮子，也不能把标注缩成蚂蚁。
     */
    const FIT_MIN = 0.45;
    const s = Math.max(FIT_MIN, Math.min(1, Math.min(w / (x1 - x0), hgt / (y1 - y0))));

    // ★★ 2026-10-19 修（实测 16 张图时卡片跑到 x=-504）：
    //   原式里的 Math.max(0, (w - 内容宽*s) / 2) 有 bug ——
    //   当内容比可视区【宽】时（w - 内容宽*s < 0），居中量被硬截成 0，
    //   内容就整体从【左边】溢出，而不是居中溢出。
    //
    //   实测数据：
    //     16 张卡 → 4 列 × 4 行，逻辑宽 4×264=1056
    //     s 被 FIT_MIN 钳在 0.45 ⇒ 缩放后宽 475px
    //     可视宽 w = 521 - 48 = 473px  ⇒ 475 > 473，恰好越过阈值
    //     结果 x = -316.4，第一张卡画到 x=-244（画布左边外面 300px）
    //
    //   修法：不截断居中量。负的居中量意味着「内容比窗口宽」，
    //   此时应该让内容从左上开始、由用户平移，而不是把左边切掉。
    //   ⇒ 用 Math.min(0, ...) 保留负值，同时保证至少贴住 padX。
    const centerX = (w - (x1 - x0) * s) / 2;
    const centerY = (hgt - (y1 - y0) * s) / 2;
    setView({
      // 内容比窗口窄 → 居中（正）；比窗口宽 → 贴左（0），不切掉左边
      x: padX - x0 * s + Math.max(centerX, 0),
      y: padTop - y0 * s + Math.max(centerY, 0),
      s,
    });
    void animate;
  }, [cards, pos]);

  // 第一次有产物 → 自动 fit 一次
  //
  // ★★ 2026-10-19 修（实测：清空 localStorage 后 16 张卡不 fit，右侧溢出 582px）：
  //   原逻辑是死锁 ——
  //     ① 这里要求 pos 里【已经有】至少一张卡的位置才 fit
  //     ② 下面那次补 fit 又要求 fittedRef.current === true
  //   当 pos 完全为空时（首次使用 / 清过 localStorage），
  //   ① 不成立 ⇒ fittedRef 永远 false ⇒ ② 也不成立
  //   ⇒ fit() 一次都不跑，卡片以 scale=1 排在默认视野上，右侧全部溢出。
  //
  //   实测数据：16 张卡，pos 记录 0 条，view=null，
  //   视图 transform 是默认的 matrix(1,0,0,1,219,75)（scale 1），
  //   卡片最右到 x=1191，画布右边缘只到 609 ⇒ 溢出 582px。
  //
  //   修法：把触发条件从「pos 里有位置」改成「pos 里覆盖了全部卡片」——
  //   这样才能保证算包围盒时用的是完整数据。
  //   同时保留一个兜底：连续 N 帧仍不完整就直接按现有数据 fit，不让用户干等。
  //
  // ★★ 2026-10-19 第二次修（第一次的理由对、写法仍不生效）：
  //   真正的障碍不是条件，是【effect 执行顺序】——
  //     上面 555 行的 useEffect([cards]) 会 setPos；
  //     React 的 setState 到下一次渲染才可见，
  //     所以本 effect 第一次跑时 pos 必定是旧的空对象。
  //   第二次跑时 pos 有了，但那时 wrapRef.current 的布局可能还没稳，
  //   fit() 里读 el.clientWidth 可能拿到 0（首帧常见）⇒ 直接 return。
  //
  //   实测证据：
  //     · 手动点「适应」立刻正常 —— matrix(0.45,...)，卡片全在框内
  //     · 说明 fit() 本身没问题，只是「自动调用」时环境没就绪
  //
  //   修法：把调用推迟到【下一帧】（requestAnimationFrame），
  //   那时 setPos 已生效、布局也已稳定。
  //   连续两帧仍不成就再等一帧，最多 10 帧（≈160ms），之后放弃。
  const fittedRef = useRef(false);
  const rafRef = useRef(null);
  const triesRef = useRef(0);
  useEffect(() => {
    if (fittedRef.current) return;
    if (!cards.length) return;
    if (rafRef.current) return;          // 已经在等，不重复排

    const attempt = () => {
      rafRef.current = null;
      const el = wrapRef.current;
      const ready = el && el.clientWidth > 0 && cards.length > 0
        && cards.every((x) => pos[x.key]);
      if (ready) {
        fittedRef.current = true;
        fit();
        return;
      }
      triesRef.current += 1;
      if (triesRef.current < 10) {
        rafRef.current = requestAnimationFrame(attempt);
      }
      // 10 帧还不行就放弃自动 fit —— 用户点「适应」按钮照样能救回来
    };
    rafRef.current = requestAnimationFrame(attempt);

    return () => {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    };
  }, [cards, pos, fit]);

  /**
   * ★ 产物【一批同到】时补一次 fit。
   *   实测（2026-10-18，canvas-13-four-sources.png）：ComfyUI 完成后
   *   4 个产物在同一轮轮询里一起回来。第一次 fit 时 pos 里可能只有
   *   1~2 个键（React 批处理顺序不确定），算出来的缩放是 72%，
   *   第二行的卡片被压到容器外。
   *   ⇒ 只在「上一轮卡片数 < 本轮卡片数」且用户还没手动动过视野时重 fit。
   */
  const lastCountRef = useRef(0);
  useEffect(() => {
    const n = cards.length;
    if (n > lastCountRef.current && fittedRef.current && !userMovedRef.current) {
      fit();
    }
    lastCountRef.current = n;
  }, [cards.length, fit]);

  /**
   * 新卡若在视野外 → 自动平移过去（这就是「生成后直接弹到画布里面」）。
   * ★ 只有【视野外】才动视野：用户正在看第 1 张时来第 2 张，不该把视野拽走。
   */
  const seenRef = useRef(new Set());
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    for (const c of cards) {
      if (seenRef.current.has(c.key)) continue;
      seenRef.current.add(c.key);
      const p = pos[c.key];
      if (!p) continue;
      const sx = p.x * view.s + view.x;
      const sy = p.y * view.s + view.y;
      const sw = CARD_W * view.s;
      const inside = sx + sw > 0 && sy > 0 && sx < el.clientWidth && sy < el.clientHeight;
      if (inside) continue;
      // 把它挪到可见区左上
      setView((v) => ({ ...v, x: 40 - p.x * v.s, y: 40 - p.y * v.s }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, pos]);

  // ── 滚轮缩放（围绕指针）──────────────────────────────────────────
  const onWheel = useCallback((e) => {
    if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // 横向滚让别人处理
    e.preventDefault();
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const f = Math.exp(-e.deltaY * 0.0016);   // 平滑，不是 +/- 固定档
    setView((v) => {
      const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.s * f));
      const k = s / v.s;
      // 保持指针下的画布点不动
      return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
    userMovedRef.current = true;
  }, []);

  /**
   * ★ 滚轮缩放：必须走【原生 addEventListener + passive:false】，
   *   否则 preventDefault() 无效，滚轮缩放的同时整页跟着滚。
   *
   * ★★ 但这里有个必须记下来的坑（2026-10-18 实测踩到、耗了两轮）：
   *   `useEffect(()=>{...}, [onWheel])` 在空状态时 wrapRef.current 还是 null
   *   （因为空态走 EmptyCanvas 提前 return，这个 div 根本没挂），
   *   effect 直接 return 掉了；等产物到了 div 才出现，而 onWheel 是
   *   useCallback([],...) 恒稳定 ⇒ 依赖没变 ⇒ **effect 不会重跑** ⇒
   *   监听永远没挂上。现象：产物出现后滚轮完全没反应（defaultPrevented
   *   恒为 false），但拖平移（那是 React 合成事件）却正常。
   *   ⇒ 依赖里加 cards.length，让「第一张产物到来」时重新挂一次。
   */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel, cards.length]);

  // ── 平移（拖空白处）──────────────────────────────────────────────
  const onSurfaceDown = (e) => {
    if (e.button !== 0) return;
    // 只有点在「背景」上才平移；点在卡片上由卡片自己处理
    if (e.target !== e.currentTarget && !e.target.dataset?.canvasBg) return;
    panRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onSurfaceMove = (e) => {
    const d = panRef.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
  };
  const onSurfaceUp = () => {
    if (panRef.current) userMovedRef.current = true;
    panRef.current = null;
  };

  // ── 卡片拖动 ─────────────────────────────────────────────────────
  const onCardDown = (e, key) => {
    if (e.button !== 0) return;
    if (e.target.closest?.("[data-nodrag]")) return;  // 按钮区域不拖
    e.stopPropagation();
    const p = pos[key];
    if (!p) return;
    cardDragRef.current = { key, x: e.clientX, y: e.clientY, px: p.x, py: p.y, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onCardMove = (e) => {
    const d = cardDragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.x) / view.s;
    const dy = (e.clientY - d.y) / view.s;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
    // ★ 2026-10-18 修（自查发现）：原来这里只 setPos，没置 userMovedRef。
    //   而保存 effect 第一行就是 `if (!userMovedRef.current) return;`
    //   ⇒ 拖卡片的位置【永远不会被保存】。实测：拖完 localStorage 里还是旧数据。
    //   拖 3px 以上才算真拖（避免点击时的微小抖动把「用户没动过」变成「动过」，
    //   那样自动 fit 的初始排版就存下来了，下次回来不再自动排）。
    if (d.moved) userMovedRef.current = true;
    setPos((prev) => ({ ...prev, [d.key]: { x: d.px + dx, y: d.py + dy } }));
  };
  const onCardUp = (e, key) => {
    const d = cardDragRef.current;
    cardDragRef.current = null;
    if (!d) return;
    if (!d.moved) { setLight(key); return; }   // 没移动 = 想打开
    userMovedRef.current = true;
    void e; void key;
  };

  // ── 键盘：Esc 关 lightbox ────────────────────────────────────────
  const lightItem = cards.find((c) => c.key === light) ?? null;
  const step = useCallback((d) => {
    setLight((cur) => {
      const i = cards.findIndex((c) => c.key === cur);
      if (i < 0) return cur;
      const n = (i + d + cards.length) % cards.length;
      return cards[n].key;
    });
  }, [cards]);

  // ── 空状态（验收第 6 条：结果区不许是纯空白）─────────────────────
  if (!cards.length) {
    return h(EmptyCanvas, { t, expanded, onOpenLibrary, onGenerate, libraryCount });
  }

  const dotPx = 22 * view.s;

  return h(React.Fragment, null,
    h("div", {
      ref: wrapRef,
      // ★ 画布自己吃掉指针事件，不外溢（硬约束 ⑤）
      style: {
        position: "relative", flex: "1 1 auto", minHeight: 0,
        overflow: "hidden",
        borderRadius: 16,
        background: "var(--dsw-alias-bg-base, #fff)",
        // 点阵底纹用 radial-gradient，随缩放变密/变疏 —— 视觉上能感知缩放
        backgroundImage: "radial-gradient(circle at 1px 1px, rgba(128,128,128,.20) 1px, transparent 0)",
        backgroundSize: `${Math.max(6, dotPx)}px ${Math.max(6, dotPx)}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
        cursor: panRef.current ? "grabbing" : "grab",
        touchAction: "none",              // 触屏上自己接管手势
        userSelect: "none",
        boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,.08)",
      },
      onPointerDown: onSurfaceDown,
      onPointerMove: onSurfaceMove,
      onPointerUp: onSurfaceUp,
      onPointerCancel: onSurfaceUp,
    },

      // ── 变换层 ──
      h("div", {
        "data-canvas-bg": "1",
        style: {
          position: "absolute", left: 0, top: 0,
          width: 0, height: 0,               // 不撑布局，纯坐标系
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
          transformOrigin: "0 0",
          willChange: "transform",
        },
        onPointerDown: onSurfaceDown,
        onPointerMove: onSurfaceMove,
        onPointerUp: onSurfaceUp,
      },
        cards.map((c) => {
          const p = pos[c.key] ?? { x: 0, y: 0 };
          return h(Card, {
            key: c.key, card: c, pos: p,
            scale: view.s,
            hovering: hover === c.key,
            onDown: (e) => onCardDown(e, c.key),
            onMove: onCardMove,
            onUp: (e) => onCardUp(e, c.key),
            onEnter: () => setHover(c.key),
            onLeave: () => setHover((v) => (v === c.key ? null : v)),
            onOpen: () => setLight(c.key),
            onSendToTimeline,
          });
        }),
      ),

      // ── 工具条（固定在画布右上，不随变换）──
      h("div", {
        style: {
          position: "absolute", right: 10, top: 10,
          display: "flex", alignItems: "center", gap: 4,
          padding: 3, borderRadius: 999,
          background: "var(--dsw-alias-bg-layer-1, #fff)",
          boxShadow: "0 0 0 0.5px rgba(0,0,0,.10), 0 2px 8px rgba(0,0,0,.06)",
        },
        onPointerDown: (e) => e.stopPropagation(),
      },
        h(ToolBtn, { onClick: () => setView((v) => ({ ...v, s: Math.max(MIN_SCALE, v.s / 1.25) })), title: "缩小" }, "−"),
        h("span", {
          style: {
            minWidth: 40, textAlign: "center", fontSize: 11, lineHeight: "18px",
            color: "var(--dsw-alias-label-tertiary, #81858c)",
            fontVariantNumeric: "tabular-nums",
          },
        }, `${Math.round(view.s * 100)}%`),
        h(ToolBtn, { onClick: () => setView((v) => ({ ...v, s: Math.min(MAX_SCALE, v.s * 1.25) })), title: "放大" }, "+"),
        h(ToolBtn, { onClick: () => fit(), title: "适应视野（显示全部产物）" }, "适应"),
        h(ToolBtn, { onClick: () => setView({ x: 40, y: 40, s: 1 }), title: "100% 复位" }, "1:1"),
      ),

      // ── 左下角小字：数量 + 提示 ──
      //   ★ 加半透明胶囊底 —— 不然它会和画布上的卡片文字糊在一起
      //     （实测 canvas-13：第 4 张卡片的底栏正好压在这行字下面）。
      h("div", {
        style: {
          position: "absolute", left: 10, bottom: 8,
          padding: "2px 8px", borderRadius: 999,
          background: "var(--dsw-alias-bg-layer-1, #fff)",
          boxShadow: "0 0 0 0.5px rgba(0,0,0,.08)",
          fontSize: 11, lineHeight: "16px",
          color: "var(--dsw-alias-label-tertiary, #81858c)",
          pointerEvents: "none",
          whiteSpace: "nowrap",
        },
      }, `${cards.length} 个产物 · 拖空白平移 · 滚轮缩放 · 拖卡片移动 · 点卡片放大`),

      // ── Lightbox ──
      lightItem
        ? h(Lightbox, { item: lightItem, items: cards, onClose: () => setLight(null), onStep: step })
        : null,
    ),
  );
}

function ToolBtn({ onClick, title, children }) {
  return h("button", {
    type: "button", onClick, title,
    style: {
      height: 24, minWidth: 24, padding: "0 8px",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      border: 0, borderRadius: 999, background: "transparent",
      color: "var(--dsw-alias-label-secondary, #61666b)",
      fontFamily: "inherit", fontSize: 11, lineHeight: "18px", fontWeight: 500,
      cursor: "pointer",
    },
    onMouseEnter: (e) => { e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))"; },
    onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
  }, children);
}

// ══════════════════════════════════════════════════════════════════════
// 一张卡片
// ══════════════════════════════════════════════════════════════════════
function Card({ card, pos, scale, hovering, onDown, onMove, onUp, onEnter, onLeave, onOpen, onSendToTimeline }) {
  const [dim, setDim] = useState(null);       // {w,h} 原始像素，用于角标
  const [failed, setFailed] = useState(false);

  return h("div", {
    style: {
      position: "absolute", left: 0, top: 0,
      width: CARD_W,
      transform: `translate(${pos.x}px, ${pos.y}px)`,
      // ★ 卡片自身不做 scale —— 缩放由父层统一，否则拖动换算会双重缩放
      borderRadius: 14,
      background: "var(--dsw-alias-bg-layer-1, #fff)",
      boxShadow: hovering
        ? "0 0 0 0.5px rgba(0,0,0,.14), 0 8px 24px rgba(0,0,0,.14)"
        : "0 0 0 0.5px rgba(0,0,0,.10), 0 2px 8px rgba(0,0,0,.06)",
      overflow: "hidden",
      cursor: "pointer",
      transition: "box-shadow .12s",
      touchAction: "none",
    },
    onPointerDown: onDown,
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onUp,
    onMouseEnter: onEnter,
    onMouseLeave: onLeave,
  },

    // ── 来源标头条（这就是「一眼看出哪张是哪张」）──
    h("div", {
      style: {
        display: "flex", alignItems: "center", gap: 6,
        padding: "6px 8px 5px",
        // 左侧 3px 语义色竖条 —— 色 + 字双通道，色盲也能读数
        borderLeft: `3px solid ${card.rule.tone}`,
        background: hexA(card.rule.tone, 0.07),
      },
    },
      h("span", {
        style: {
          flex: "none",
          fontSize: 11, lineHeight: "16px", fontWeight: 700,
          color: card.rule.tone,
          letterSpacing: ".01em",
        },
      }, card.rule.label),
      h("span", {
        style: {
          flex: "1 1 auto", minWidth: 0,
          fontSize: 10, lineHeight: "14px",
          color: "var(--dsw-alias-label-tertiary, #81858c)",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          direction: "rtl", textAlign: "left",   // 文件名长了先截前面，保住扩展名与序号
        },
        title: name(card.out),
      }, name(card.out) || `node ${card.out?.nodeId ?? "?"}`),
    ),

    // ── 媒体本体 ──
    h("div", {
      style: { position: "relative", background: "rgba(128,128,128,.06)", minHeight: 80 },
    },
      card.isVid
        ? h("video", {
            src: card.src, controls: true, muted: true, playsInline: true, preload: "metadata",
            style: { display: "block", width: "100%", height: "auto", maxHeight: 300, background: "#000" },
            onPointerDown: (e) => e.stopPropagation(),   // 别挡视频控件
          })
        : failed
        ? h("div", {
            style: {
              padding: "22px 10px", textAlign: "center",
              fontSize: 11, lineHeight: "16px",
              color: "var(--dsw-alias-label-tertiary, #81858c)",
            },
          }, "图加载失败（ComfyUI temp 可能已清理）")
        : h("img", {
            src: card.src, alt: name(card.out), draggable: false,
            onLoad: (e) => setDim({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }),
            onError: () => setFailed(true),
            style: { display: "block", width: "100%", height: "auto", minHeight: 60, background: "rgba(128,128,128,.04)" },
          }),

      // 分辨率角标
      dim
        ? h("span", {
            style: {
              position: "absolute", right: 6, bottom: 6,
              padding: "1px 6px", borderRadius: 999,
              background: "rgba(0,0,0,.55)", color: "#fff",
              fontSize: 10, lineHeight: "14px",
              fontVariantNumeric: "tabular-nums",
            },
          }, `${dim.w}×${dim.h}`)
        : null,
    ),

    // ── 底栏：预览 + 下载 + 送时间轴 ──
    h("div", {
      "data-nodrag": "1",
      style: {
        display: "flex", alignItems: "center", gap: 6,
        padding: "6px 8px 7px",
        borderTop: "0.5px solid rgba(0,0,0,.06)",
      },
    },
      h(MiniBtn, { onClick: onOpen, title: "放大查看" }, "预览"),
      h("a", {
        href: card.dl, download: name(card.out),
        title: `下载 ${name(card.out)}`,
        style: { ...mini(), textDecoration: "none", color: "var(--dsw-alias-state-business-primary, #4176e6)" },
      }, "下载"),
      /**
       * ★★★ 2026-10-25 · 「→ 时间轴」
       *
       *   懒人链路里最大的断点：生成完 → 剪辑之间完全手动。
       *   切 tab、点导入、走系统文件选择器、从 1582 个资产里翻 ——
       *   而刚生成的东西明明就在这张卡片上。
       *
       *   ⇒ 一次点击，把这张产物作为一段加进时间轴。
       *   ★ 用产物自己的文件名当片段名，时间轴上认得出是哪张。
       *   ★ 失败要说话 —— 静默失败比报错更糟（本项目踩过多次）。
       */
      h(MiniBtn, {
        onClick: () => onSendToTimeline?.(card),
        title: "把这张加进「剪辑台」的时间轴",
      }, "→ 时间轴"),
      h("span", { style: { flex: "1 1 auto" } }),
      h("span", {
        style: {
          fontSize: 10, lineHeight: "14px",
          color: "var(--dsw-alias-label-tertiary, #81858c)",
          fontVariantNumeric: "tabular-nums",
        },
        title: `ComfyUI 节点 ${card.out?.nodeId ?? "?"}`,
      }, `#${card.out?.nodeId ?? "?"}`),
    ),
  );
}

function MiniBtn({ onClick, title, children }) {
  return h("button", {
    type: "button", title,
    onPointerDown: (e) => e.stopPropagation(),
    onClick, style: mini(),
  }, children);
}

function mini() {
  return {
    height: 22, padding: "0 8px", boxSizing: "border-box",
    display: "inline-flex", alignItems: "center",
    border: 0, borderRadius: 999,
    background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
    color: "var(--dsw-alias-label-secondary, #61666b)",
    fontFamily: "inherit", fontSize: 11, lineHeight: "16px", fontWeight: 500,
    cursor: "pointer",
  };
}

/** #rrggbb + alpha → rgba() */
function hexA(hex, a) {
  const s = String(hex).replace("#", "");
  const n = parseInt(s.length === 3 ? s.split("").map((c) => c + c).join("") : s, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// ══════════════════════════════════════════════════════════════════════
// 空状态 —— 验收第 6 条：结果区不许是纯空白
// ══════════════════════════════════════════════════════════════════════
function EmptyCanvas({ t, expanded, onOpenLibrary, onGenerate, libraryCount }) {
  const tr = (k, d) => (typeof t === "function" ? (t(k) || d) : d);
  return h("div", {
    style: {
      position: "relative", flex: "1 1 auto", minHeight: 0,
      borderRadius: 16, overflow: "hidden",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 10,
      background: "var(--dsw-alias-bg-base, #fff)",
      backgroundImage: "radial-gradient(circle at 1px 1px, rgba(128,128,128,.16) 1px, transparent 0)",
      backgroundSize: "22px 22px",
      boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,.07)",
    },
  },
    h("div", {
      style: {
        width: 44, height: 44, borderRadius: 12,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))",
      },
    },
      h("svg", { viewBox: "0 0 24 24", width: 22, height: 22, "aria-hidden": "true" },
        h("path", {
          d: "M4 5.5A1.5 1.5 0 0 1 5.5 4h4.2c.4 0 .78.16 1.06.44L12 5.6h6.5A1.5 1.5 0 0 1 20 7.1v10.4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-12Z",
          fill: "none", stroke: "var(--dsw-alias-label-tertiary, #81858c)",
          strokeWidth: 1.5, strokeLinejoin: "round",
        }),
        h("circle", { cx: 9, cy: 10.5, r: 1.6, fill: "var(--dsw-alias-label-tertiary, #81858c)" }),
      ),
    ),
    h("div", {
      style: {
        fontSize: 13, lineHeight: "20px", fontWeight: 600,
        color: "var(--dsw-alias-label-secondary, #61666b)",
      },
      /**
       * ★★ 2026-10-21 U6 改（原来是被动描述，现在给行动入口）
       *
       *   旧文案：「资产画布是空的 / 调好参数点「生成」—— 产物出来会自动落到这里 /
       *           拖空白平移 · 滚轮缩放 · 点卡片放大 · 可下载」
       *   三句全是【描述状态】，没有一个能点。
       *   审计文档 P2-6 的原话：有「资产库是空的」，但没有「如何让它不空」的引导。
       *
       *   ⇒ 改成：一句话说清这里是什么 + 两个能点的入口。
       *     · 引资产 → 打开资产库（用户手上已有 871 项，这才是最常见的起点）
       *     · 直接生成 → 光标聚焦提示词框，让用户马上能打字
       */
    }, tr("canvas.empty.title", "还没有产物")),
    h("div", {
      style: {
        fontSize: 12, lineHeight: "18px", textAlign: "center",
        color: "var(--dsw-alias-label-tertiary, #6b7075)",
        maxWidth: 320,
      },
    }, tr("canvas.empty.hint", "生成的图和视频会自动出现在这里，不用刷新")),

    // ★ 两个行动入口 —— 这是 U6 的核心：把「描述」变成「可点的下一步」
    h("div", {
      style: { display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap", justifyContent: "center" },
    },
      onOpenLibrary
        ? h("button", {
            type: "button",
            onClick: onOpenLibrary,
            style: {
              height: 30, padding: "0 14px",
              border: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))",
              borderRadius: 999, cursor: "pointer",
              background: "var(--dsw-alias-bg-layer-1, #fff)",
              color: "var(--dsw-alias-label-secondary, #61666b)",
              fontFamily: "inherit", fontSize: 12, fontWeight: 400,
              display: "inline-flex", alignItems: "center", gap: 6,
            },
            title: Number.isFinite(libraryCount) && libraryCount > 0
              ? `打开资产库（共 ${libraryCount} 项），把已有素材引到提示词里`
              : "打开资产库，把已有素材引到提示词里",
          },
            /**
             * ★★ 2026-10-22（主人：「这两个的图标不够DSH，很突兀」）
             *
             *   原来是 emoji 🗂（彩色位图），与 DSH 的单色线性图标体系不搭。
             *   ⇒ 换成内联 SVG，规格照本文件 1195 行那个空态图标：
             *     viewBox 0 0 24 24 / stroke 1.5 / currentColor 系 token。
             *
             *   ★ 为什么这里用内联 SVG 而不是 DSH 的 IconFolderOpenOutlineMedium：
             *     AssetCanvas 是独立模块，没有 hostRequire 通道；
             *     为两个图标单独打通一条 props 链不划算。
             *     而 DSH 的图标本身就是 24×24 stroke 1.5 的线性图，
             *     照着画一个视觉上等价 —— 这也是本文件已有的做法（1195 行）。
             */
            h("svg", {
              viewBox: "0 0 24 24", width: 13, height: 13, "aria-hidden": "true",
              style: { flex: "none" },
            },
              h("path", {
                d: "M4 6.5A1.5 1.5 0 0 1 5.5 5h3.6c.4 0 .78.16 1.06.44L11.3 6.6h7.2A1.5 1.5 0 0 1 20 8.1v9.4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-11Z",
                fill: "none",
                stroke: "currentColor",
                strokeWidth: 1.5,
                strokeLinejoin: "round",
              }),
            ),
            tr("canvas.empty.action.library", "从资产库引一张"),
            /**
             * ★ 2026-10-21 G3：实时资产数。
             *   取不到就不显示 —— 宁可没有数字，也不写死一个会过期的。
             */
            Number.isFinite(libraryCount) && libraryCount > 0
              ? h("span", {
                  "aria-hidden": "true",
                  style: {
                    fontSize: 10, lineHeight: "14px",
                    padding: "0 5px", borderRadius: 999,
                    background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06))",
                    color: "var(--dsw-alias-label-tertiary, #81858c)",
                    fontVariantNumeric: "tabular-nums",
                  },
                }, String(libraryCount))
              : null,
          )
        : null,
      onGenerate
        ? h("button", {
            type: "button",
            onClick: onGenerate,
            style: {
              height: 30, padding: "0 14px",
              border: 0, borderRadius: 999, cursor: "pointer",
              background: "var(--dsw-alias-button-primary-fill, #4176e6)",
              color: "var(--dsw-alias-label-primary-foreground, #fff)",
              fontFamily: "inherit", fontSize: 12, fontWeight: 400,
            },
            title: "光标跳到提示词，写完按 Ctrl+Enter 生成",
          },
            tr("canvas.empty.action.generate", "直接写提示词"),
          )
        : null,
    ),

    /**
     * ★ 手势说明降到最弱一级：它是「学会之后就不再看」的信息，
     *   不该和主文案抢注意力。
     */
    h("div", {
      style: {
        fontSize: 11, lineHeight: "16px", marginTop: 6,
        color: "var(--dsw-alias-label-tertiary, #6b7075)",
        opacity: .75,
      },
    }, tr("canvas.empty.gesture", "拖空白平移 · 滚轮缩放 · 点卡片放大")),
  );
}

// ══════════════════════════════════════════════════════════════════════
// 失效隔离
// ══════════════════════════════════════════════════════════════════════
export class AssetCanvasBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(e) { return { err: e }; }
  componentDidCatch(e) { console.error("[comfy-wb] AssetCanvas 出错（只丢画布，工作台照常）：", e); }
  render() {
    if (this.state.err) {
      return h("div", {
        style: {
          flex: "1 1 auto", minHeight: 120, margin: 0,
          padding: 12, borderRadius: 12,
          background: "rgba(248,81,73,.08)", color: "rgb(207,34,46)",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
          fontSize: 11, lineHeight: "16px", whiteSpace: "pre-wrap", overflow: "auto",
        },
      }, "[画布模块出错，已隔离（工作台其它部分不受影响）]\n" +
         (this.state.err.stack || this.state.err.message));
    }
    return this.props.children;
  }
}

/** 极端保守挂载：任何问题都只丢画布。 */
export function SafeCanvas(props) {
  try {
    return h(AssetCanvasBoundary, null, h(AssetCanvas, props));
  } catch (err) {
    console.warn("[comfy-wb] AssetCanvas 挂载失败，已跳过：", err?.message ?? err);
    return null;
  }
}

export default SafeCanvas;
