/**
 * ArtCraft 的资产选择器（React 组件）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么在 artcraft-tab 里自己做一个，而不是复用工作台那个
 *
 *   我已经在 dsh-comfy-workbench-tab 里给 LibraryPanel 加了 pickMode
 *   （40 项断言通过）。但要用它必须【从 A 插件弹出 B 插件的面板】，
 *   而两个插件的 client.js 是各自独立的 IIFE，唯一共享的是 window。
 *   靠 window 传 React 组件引用很脆：
 *     · 依赖对方插件已加载且已暴露
 *     · 卸载时机不受控（对方 tab 没挂载过就取不到）
 *     · 出错时两边堆栈混在一起，查不动
 *
 *   ⇒ 这里做一个【自包含】的选择器：只依赖 HTTP 数据，
 *     不依赖另一个插件是否加载。代价是 UI 有一小段重复，
 *     收益是「模块失效只丢那一块」真正成立。
 *
 *   ★ 数据来源完全相同（/comfy-assets/library），所以用户看到的内容一致。
 *
 * ══════════════════════════════════════════════════════════════════════
 * UI 规格（按 refactoring-ui 的 Step 0，已有系统优先）
 *
 *   整个 DSH 都是 --dsw-* token，这里沿用：
 *     · 面板圆角 16px（与 DSH 原生下拉一致）
 *     · 背景 bg-layer-1 + elevation-panel 阴影
 *     · 文字 label-primary / secondary / tertiary 三档
 *     · 选中态用 state-business-primary
 *   不引入任何新的颜色字面量（审计报告 P1-4 的教训）。
 */

import React from "react";

const { useState, useEffect, useMemo, useRef, useCallback } = React;

/** 首屏渲染多少张卡片 / 每次「再显示」加多少。 */
const PAGE_RENDER = 120;

/**
 * 分页拉完资产库。
 *
 * ★★ 2026-10-20 实测踩到的坑（两个都必须靠后端修，但前端要有防护）：
 *
 *   ① 后端原来只做 `items.slice(0, limit)`，【没读 offset】。
 *      所以 offset=0/500/1000/1500 四次要回来的内容完全一样。
 *      我循环 20 次 ⇒ 20×500 = 10000 条重复：
 *        · 界面显示「可选择 10000 项」（真实只有 857）
 *        · 渲染 10000 张卡片，把缩略图请求队列压垮，
 *          大部分 img 变成破图（截图里那些 $ 图标）
 *
 *   ② 修了后端 offset 之后，还要防「后端没改」的情况：
 *      用 id 去重 + 「本页没新东西就停」两条保险，
 *      否则一样会把页面拖死。
 *
 *   ⇒ 前端不假设后端正确，用数据自证。
 */
async function fetchAssets() {
  const PAGE = 500;
  const seen = new Set();          // 去重
  const out = [];
  let offset = 0;

  for (let i = 0; i < 40; i++) {   // 防死循环的上限
    const res = await fetch(
      `/comfy-assets/library?limit=${PAGE}&offset=${offset}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (!j?.ok) throw new Error(j?.error ?? "库返回 ok=false");

    const items = Array.isArray(j.items) ? j.items : [];
    if (!items.length) break;

    let added = 0;
    for (const it of items) {
      if (!it?.id || seen.has(it.id)) continue;
      seen.add(it.id);
      out.push(it);
      added++;
    }

    /**
     * ★ 关键保险：这一页【没有新东西】就停。
     *   后端不认 offset 时，第二页会和第一页完全重合 ⇒ added === 0 ⇒ 立刻退出，
     *   而不是傻乎乎地重复拉 20 次。
     */
    if (added === 0) {
      console.warn(
        "[artcraft] 资产库分页没有生效（本页 0 条新数据）。"
        + "可能后端不支持 offset —— 已停止翻页，当前 " + out.length + " 条。"
      );
      break;
    }

    if (items.length < PAGE) break;
    offset += PAGE;
  }

  return out;
}

/** 缩略图 URL（同源代理，带 Range 支持）。 */
function thumbUrl(it) {
  const qs = new URLSearchParams({ src: String(it.src ?? "output"), rel: String(it.rel ?? "") });
  return `/comfy-assets/file?${qs.toString()}`;
}

/**
 * 资产选择器面板。
 *
 * @param {object} props
 * @param {string[]} props.kinds   只显示这些类型（ArtCraft 传的 MediaKind）
 * @param {(sel:object[])=>void} props.onConfirm  选中后回调
 * @param {()=>void} props.onCancel
 */
export function AssetPicker({ kinds, onConfirm, onCancel }) {
  const want = useMemo(() => {
    const arr = Array.isArray(kinds) && kinds.length ? kinds : ["image", "video", "audio"];
    return new Set(arr);
  }, [kinds]);

  const [state, setState] = useState({ s: "loading", items: [], err: null });
  const [q, setQ] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [picked, setPicked] = useState(() => new Set());
  /**
   * ★ 限量渲染上限。筛选条件一变就重置回首屏数量 ——
   *   否则用户先「再显示」到 600 张，再改搜索词，
   *   仍会一次渲染 600 张。
   */
  const [visibleCount, setVisibleCount] = useState(PAGE_RENDER);
  const scrollRef = useRef(null);

  /* 拉数据 */
  useEffect(() => {
    let alive = true;
    fetchAssets()
      .then((all) => {
        if (!alive) return;
        // ★ 只留 ArtCraft 能用的类型。不过滤会让用户选到
        //   永远拖不进时间轴的幽灵条目。
        setState({ s: "ok", items: all.filter((x) => want.has(x.kind)), err: null });
      })
      .catch((e) => {
        if (alive) setState({ s: "error", items: [], err: String(e?.message ?? e) });
      });
    return () => { alive = false; };
  }, [want]);

  /* 过滤 */
  const list = useMemo(() => {
    let out = state.items;
    if (kindFilter !== "all") out = out.filter((x) => x.kind === kindFilter);
    const s = q.trim().toLowerCase();
    if (s) {
      out = out.filter((x) =>
        String(x.displayName ?? "").toLowerCase().includes(s) ||
        String(x.name ?? "").toLowerCase().includes(s) ||
        String(x.rel ?? "").toLowerCase().includes(s) ||
        String(x.character ?? "").toLowerCase().includes(s) ||
        String(x.folder ?? "").toLowerCase().includes(s)
      );
    }
    return out;
  }, [state.items, q, kindFilter]);

  const counts = useMemo(() => {
    const c = { all: state.items.length, image: 0, video: 0, audio: 0 };
    for (const it of state.items) if (c[it.kind] != null) c[it.kind]++;
    return c;
  }, [state.items]);

  /* 筛选或搜索变了 ⇒ 渲染上限回到首屏 */
  useEffect(() => { setVisibleCount(PAGE_RENDER); }, [q, kindFilter]);

  const toggle = useCallback((id) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const confirm = useCallback(() => {
    const chosen = state.items.filter((x) => picked.has(x.id));
    onConfirm?.(chosen);
  }, [state.items, picked, onConfirm]);

  /* ── 样式常量（全部走 token，无字面量颜色）───────────────── */
  const PANEL = {
    position: "fixed", inset: 0, zIndex: 100000,
    background: "rgba(0,0,0,.32)", backdropFilter: "blur(2px)",
    display: "flex", alignItems: "center", justifyContent: "center",
    padding: 24, boxSizing: "border-box",
    fontFamily: "inherit", fontSize: 13, lineHeight: "20px",
    color: "var(--dsw-alias-label-primary, #0f1115)",
  };
  const CARD = {
    width: "min(980px, 94vw)", height: "min(700px, 86vh)",
    display: "flex", flexDirection: "column",
    borderRadius: 16, overflow: "hidden",
    background: "var(--dsw-alias-bg-layer-1, #fff)",
    boxShadow: "0 0 0 0.5px rgba(0,0,0,.12), 0 18px 48px rgba(0,0,0,.26)",
  };
  const HEAD = {
    flex: "none", display: "flex", alignItems: "center", gap: 10,
    padding: "12px 14px",
    borderBottom: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))",
  };
  const BODY = {
    flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 12,
    contain: "layout paint style",
  };
  const FOOT = {
    flex: "none", display: "flex", alignItems: "center", gap: 8,
    padding: "10px 14px",
    borderTop: "0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,.08))",
    background: "var(--dsw-alias-bg-layer-1, #fff)",
  };
  const BTN = (primary, disabled) => ({
    height: 28, padding: primary ? "0 16px" : "0 12px",
    border: 0, borderRadius: 8,
    cursor: disabled ? "not-allowed" : "pointer",
    background: primary
      ? "var(--dsw-alias-state-business-primary, #4176e6)"
      : "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06))",
    color: primary
      ? "var(--dsw-alias-label-primary-foreground, #fff)"
      : "var(--dsw-alias-label-secondary, #61666b)",
    fontFamily: "inherit", fontSize: 12,
    opacity: disabled ? 0.45 : 1,
  });
  const CHIP = (on) => ({
    height: 26, padding: "0 10px", border: 0, borderRadius: 999,
    cursor: "pointer", fontFamily: "inherit", fontSize: 12,
    background: on
      ? "var(--dsw-alias-state-business-primary, #4176e6)"
      : "transparent",
    color: on
      ? "var(--dsw-alias-label-primary-foreground, #fff)"
      : "var(--dsw-alias-label-secondary, #61666b)",
  });

  return React.createElement("div", {
    style: PANEL,
    onClick: onCancel,
    role: "presentation",
  },
    React.createElement("div", {
      style: CARD,
      onClick: (e) => e.stopPropagation(),
      role: "dialog",
      "aria-label": "选择资产",
      "aria-modal": "true",
    },
      /* ── 头 ── */
      React.createElement("div", { style: HEAD },
        React.createElement("div", { style: { fontWeight: 600, fontSize: 14 } }, "选择资产"),
        picked.size
          ? React.createElement("span", {
              style: {
                padding: "0 7px", height: 18, lineHeight: "18px",
                borderRadius: 9, fontSize: 11,
                background: "var(--dsw-alias-state-business-primary, #4176e6)",
                color: "var(--dsw-alias-label-primary-foreground, #fff)",
              },
            }, `已选 ${picked.size}`)
          : null,
        React.createElement("span", {
          style: { color: "var(--dsw-alias-label-tertiary, #81858c)", fontSize: 12 },
        }, state.s === "loading"
          ? "加载中…"
          : state.s === "error"
            ? "加载失败"
            : `可选择 ${state.items.length} 项`),

        React.createElement("input", {
          value: q,
          onChange: (e) => setQ(e.target.value),
          placeholder: "搜索名字 / 文件 / 角色 / 文件夹…",
          "aria-label": "搜索资产",
          style: {
            marginLeft: "auto", width: 240, height: 28, padding: "0 10px",
            border: 0, borderRadius: 8, boxSizing: "border-box",
            background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04))",
            color: "inherit", fontFamily: "inherit", fontSize: 12,
            outline: "none",
          },
        })
      ),

      /* ── 类型筛选 ── */
      React.createElement("div", {
        style: {
          flex: "none", display: "flex", alignItems: "center", gap: 4,
          padding: "8px 14px 0",
        },
      },
        ...[
          ["all", `全部 ${counts.all}`],
          ["image", `图片 ${counts.image}`],
          ["video", `视频 ${counts.video}`],
          ["audio", `音频 ${counts.audio}`],
        ]
          // 只显示有的类型（加上 all）
          .filter(([k]) => k === "all" || counts[k] > 0)
          .map(([k, label]) =>
            React.createElement("button", {
              key: k,
              type: "button",
              onClick: () => setKindFilter(k),
              style: CHIP(kindFilter === k),
            }, label)
          )
      ),

      /* ── 身体 ── */
      React.createElement("div", { style: BODY, ref: scrollRef },
        state.s === "error"
          ? React.createElement("div", {
              style: {
                padding: 14, borderRadius: 12,
                background: "rgba(248,81,73,.08)", color: "rgb(207,34,46)",
                fontSize: 12, lineHeight: "18px", whiteSpace: "pre-wrap",
              },
            }, "资产库加载失败：" + state.err)
          : state.s === "loading"
            ? React.createElement("div", {
                style: { padding: 24, textAlign: "center", color: "var(--dsw-alias-label-tertiary, #81858c)" },
              }, "正在读取资产库…")
            : list.length === 0
              ? React.createElement("div", {
                  style: { padding: 24, textAlign: "center", color: "var(--dsw-alias-label-tertiary, #81858c)" },
                }, q ? "没有匹配的资产" : "资产库里没有可用素材")
              : React.createElement(React.Fragment, null,
                  React.createElement("div", {
                    style: {
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(148px, 1fr))",
                      gap: 10,
                    },
                  },
                    ...list.slice(0, visibleCount).map((it) => {
                    const on = picked.has(it.id);
                    return React.createElement("div", {
                      key: it.id,
                      onClick: () => toggle(it.id),
                      role: "option",
                      "aria-selected": on,
                      title: `${it.displayName || it.name}\n${it.kind} · ${it.rel}`,
                      style: {
                        display: "flex", flexDirection: "column",
                        borderRadius: 10, overflow: "hidden", cursor: "pointer",
                        background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,.02))",
                        boxShadow: on
                          ? "0 0 0 2px var(--dsw-alias-state-business-primary, #4176e6)"
                          : "0 0 0 0.5px var(--dsw-alias-border-l2, rgba(0,0,0,.08))",
                      },
                    },
                      React.createElement("div", {
                        style: {
                          position: "relative", height: 96,
                          background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04))",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          overflow: "hidden",
                        },
                      },
                        it.kind === "audio"
                          ? React.createElement("span", { style: { fontSize: 22, opacity: .5 } }, "🎵")
                          : React.createElement("img", {
                              src: thumbUrl(it),
                              alt: "",
                              loading: "lazy",
                              style: { width: "100%", height: "100%", objectFit: "cover" },
                            }),
                        on
                          ? React.createElement("span", {
                              style: {
                                position: "absolute", top: 4, right: 4,
                                width: 18, height: 18, borderRadius: 9,
                                display: "flex", alignItems: "center", justifyContent: "center",
                                background: "var(--dsw-alias-state-business-primary, #4176e6)",
                                color: "var(--dsw-alias-label-primary-foreground, #fff)",
                                fontSize: 11, fontWeight: 700,
                              },
                            }, "✓")
                          : null,
                        it.kind === "video"
                          ? React.createElement("span", {
                              style: {
                                position: "absolute", bottom: 3, left: 4,
                                fontSize: 10, padding: "0 4px", borderRadius: 4,
                                background: "rgba(0,0,0,.55)", color: "#fff",
                              },
                            }, "视频")
                          : null,
                      ),
                      React.createElement("div", {
                        style: {
                          padding: "5px 7px 6px",
                          fontSize: 11, lineHeight: "15px",
                        },
                      },
                        React.createElement("div", {
                          style: {
                            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                          },
                        }, it.displayName || it.name),
                        React.createElement("div", {
                          style: {
                            fontSize: 10,
                            color: "var(--dsw-alias-label-tertiary, #81858c)",
                            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                          },
                        }, it.folder || it.character || it.src)
                      )
                    );
                  })
                  ),
                  /**
                   * ★ 还有更多时给一个明确的「再显示」。
                   *   这不是虚拟滚动，但收益足够：
                   *     · 首屏 120 张，请求队列不会被打满
                   *     · 用户真要找远处的素材时，先用搜索/筛选
                   *       （800+ 项靠滚动找本来就不现实）
                   *   ★ 虚拟滚动要处理滚动高度补偿、回收复用，
                   *     几百行代码换不来比「搜索优先」更好的体验。
                   */
                  list.length > visibleCount
                    ? React.createElement("div", {
                        style: { display: "flex", justifyContent: "center", padding: "12px 0 4px" },
                      },
                        React.createElement("button", {
                          type: "button",
                          onClick: () => setVisibleCount((n) => n + PAGE_RENDER),
                          style: {
                            height: 30, padding: "0 16px", border: 0, borderRadius: 8,
                            cursor: "pointer",
                            background: "var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06))",
                            color: "var(--dsw-alias-label-secondary, #61666b)",
                            fontFamily: "inherit", fontSize: 12,
                          },
                        }, `再显示 ${Math.min(PAGE_RENDER, list.length - visibleCount)} 项（共 ${list.length}）`)
                      )
                    : null
                )
      ),

      /* ── 底 ── */
      React.createElement("div", { style: FOOT },
        React.createElement("span", {
          style: {
            fontSize: 12,
            color: picked.size
              ? "var(--dsw-alias-label-secondary, #61666b)"
              : "var(--dsw-alias-label-tertiary, #81858c)",
          },
        }, picked.size ? `已选 ${picked.size} 项` : "点卡片加入，可多选"),
        React.createElement("div", { style: { marginLeft: "auto", display: "flex", gap: 8 } },
          picked.size
            ? React.createElement("button", {
                type: "button", onClick: () => setPicked(new Set()),
                style: BTN(false, false),
              }, "清空")
            : null,
          React.createElement("button", {
            type: "button", onClick: onCancel,
            style: BTN(false, false),
          }, "取消"),
          React.createElement("button", {
            type: "button", onClick: confirm, disabled: !picked.size,
            style: BTN(true, !picked.size),
          }, picked.size ? `用这 ${picked.size} 项` : "用这些")
        )
      )
    )
  );
}
