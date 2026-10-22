/**
 * ShortcutSettings.js · 快捷键设置（2026-10-22 重写）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人要求（原话）：
 *   「最好可以在设置里面增加一个快捷键设置，让用户根据自身习惯修改各种功能的
 *     快捷键，并同步到二级菜单提示的快捷键」
 *
 * ── 两种形态（主人 2026-10-21 纠正的第四点）
 *   纠正-DSH原生一体 §五 ②：「快捷键设置从『自己画模态』改为
 *   『注册进 settings.section』，复用 DSH 设置面板」。
 *
 *     embedded = true   → 只画内容，外壳交给 DSH 的 settings.section。★ 真机走这条
 *     embedded = false  → 自己画浮层。只用于没有 DSH 外壳的场合（预览页 / 独立测试）
 *
 *   ⇒ 一份列表 + 一份录制逻辑，两个壳。不是两套实现。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-22 重写原因（一次真实的自我破坏，记下来）
 *
 *   为了把 embedded 分支用到的那段列表提到 if(embedded) 之前（修 TDZ），
 *   我用 PowerShell 按下标切数组重排。下标算错一位，
 *   把整个文件切成了两段乱码 —— 连 SHORTCUT_DEFS 和 Kbd 都没了。
 *
 *   ⇒ 判据：**大段挪代码不要用下标切片**。宁可整文件重写，
 *     或者用「插入一处、删掉一处」的精确文本替换。
 *     下标是基于「这一刻的精确行数」，中间任何一次编辑都会让它失效。
 *
 * ★★ 那个 TDZ 本身也值得记（AGENTS §6.26 同类）：
 *   const 声明的 renderGroups 定义在 `if (embedded) return`【之后】，
 *   而 embedded 分支调用它 ⇒ ReferenceError: Cannot access 'k' before
 *   initialization（minify 后变量名变单字母，栈里只剩 'k'）。
 *   ⇒ 本文件把 renderGroups 定义放在两个 return 分支【之前】。
 */

import React from "react";
import {
  listShortcuts,
  setShortcut,
  resetShortcut,
  resetAllShortcuts,
  subscribeShortcuts,
  normalizeChord,
  chordFromEvent,
  chordToLabel,
  MOD_LABEL,
} from "./shortcuts.js";

const h = React.createElement;

/**
 * 颜色全部走 DSH token。
 * ★ 语义色（danger）可以硬编码 —— token 在不同主题下保持同一语义。
 * ★ 中性色必须走 token，否则切主题就崩（AGENTS §3.10）。
 */
const C = {
  labelPrimary: "var(--dsw-alias-label-primary, #0f1115)",
  labelSecondary: "var(--dsw-alias-label-secondary, #61666b)",
  labelTertiary: "var(--dsw-alias-label-tertiary, #81858c)",
  borderL2: "var(--dsw-alias-border-l2, #0000001a)",
  borderL3: "var(--dsw-alias-border-l3, #0000001f)",
  borderL4: "var(--dsw-alias-border-l4, #00000029)",
  hover: "var(--dsw-alias-interactive-bg-hover, #2631480f)",
  active: "var(--dsw-alias-interactive-bg-active, #2631481a)",
  bg: "var(--dsw-alias-bg-base, #fff)",
  brand: "var(--dsw-alias-state-business-primary, #4176e6)",
  danger: "rgb(207,34,46)",
  radiusSm: "var(--dsw-radius-sm, 8px)",
  radiusLg: "var(--dsw-radius-lg, 16px)",
  elevation: "var(--dsw-elevation-prominent)",
};

/** 搜索框（两种形态共用） */
function SearchInput({ value, onChange }) {
  return h("input", {
    value,
    onChange: (e) => onChange(e.target.value),
    placeholder: "搜索快捷键",
    "aria-label": "搜索快捷键",
    style: {
      width: "100%",
      height: 32,
      border: `0.5px solid ${C.borderL3}`,
      borderRadius: C.radiusSm,
      background: "transparent",
      padding: "0 10px",
      fontSize: 13,
      fontFamily: "inherit",
      color: C.labelPrimary,
      outline: "none",
      boxSizing: "border-box",
      boxShadow: "none",
      appearance: "none",
    },
  });
}

/** 「恢复全部默认」（两种形态共用） */
function ResetAllButton({ onClick }) {
  return h(
    "button",
    {
      type: "button",
      onClick,
      style: {
        height: 26,
        padding: "0 10px",
        border: `0.5px solid ${C.borderL4}`,
        borderRadius: 6,
        background: "transparent",
        color: C.labelPrimary,
        fontSize: 12,
        fontFamily: "inherit",
        cursor: "pointer",
      },
    },
    "恢复全部默认",
  );
}

/** 底部说明文字 */
function FootNote() {
  return h(
    "span",
    { style: { fontSize: 11, color: C.labelTertiary } },
    `点键位即可重设 · ${MOD_LABEL} 是 ${MOD_LABEL === "⌘" ? "Cmd" : "Ctrl"}`,
  );
}

/**
 * 快捷键设置。
 *
 * @param {{ open?:boolean, onClose?:()=>void, embedded?:boolean }} props
 */
export function ShortcutSettings({ open = true, onClose, embedded = false }) {
  const [items, setItems] = React.useState(() => listShortcuts());
  const [query, setQuery] = React.useState("");
  const [capturing, setCapturing] = React.useState(null); // 正在录制哪一条
  const [error, setError] = React.useState(null);
  const [flash, setFlash] = React.useState(null);         // 刚改成功的那条 id

  /* ── 订阅 store：快捷键变了立刻刷新（不用重开面板）── */
  React.useEffect(() => {
    if (!open) return;
    setItems(listShortcuts());
    return subscribeShortcuts(() => setItems(listShortcuts()));
  }, [open]);

  /* ── Esc 关闭（录制中则取消录制）── */
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        if (capturing) {
          setCapturing(null);
          setError(null);
        } else if (typeof onClose === "function") {
          onClose();
        }
        e.stopPropagation();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, capturing, onClose]);

  /* ── 录制按键 ── */
  React.useEffect(() => {
    if (!capturing) return;
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        setError(null);
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) return; // 只按了修饰键，继续等
      const r = setShortcut(capturing, chord);
      if (!r.ok) {
        /* ★ 冲突不静默：报出和谁冲突（静默覆盖会让用户以为设置成功） */
        setError({ id: capturing, msg: r.reason });
        return;
      }
      setError(null);
      setCapturing(null);
      setFlash(capturing);
      setTimeout(() => setFlash(null), 1200);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [capturing]);

  if (!open) return null;

  /* ── 过滤 + 分组 ── */
  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter(
        (it) =>
          String(it.name).toLowerCase().includes(q) ||
          String(it.label).toLowerCase().includes(q) ||
          String(it.group).toLowerCase().includes(q),
      )
    : items;

  const groups = [];
  for (const it of filtered) {
    let g = groups.find((x) => x.name === it.group);
    if (!g) { g = { name: it.group, items: [] }; groups.push(g); }
    g.items.push(it);
  }

  /**
   * 分组列表。
   *
   * ★★ 必须在两个 return 分支【之前】定义 ——
   *   embedded 分支要用它，const 在定义前不可访问（TDZ）。
   *   见文件头注释。
   */
  const renderGroups = () => {
    if (groups.length === 0) {
      return h(
        "div",
        {
          style: {
            padding: "32px 16px",
            textAlign: "center",
            color: C.labelTertiary,
            fontSize: 12,
          },
        },
        /* ★ 空态要说清「为什么空」，不是「没有」 */
        `没有匹配「${query}」的快捷键`,
      );
    }

    return groups.map((g) =>
      h(
        "div",
        { key: g.name },
        h(
          "div",
          {
            style: {
              padding: "10px 8px 4px",
              fontSize: 11,
              color: C.labelTertiary,
              fontWeight: 500,
            },
          },
          g.name,
        ),
        g.items.map((it) => {
          const isCapturing = capturing === it.id;
          const isFlash = flash === it.id;
          const err = error && error.id === it.id ? error.msg : null;

          return h(
            "div",
            {
              key: it.id,
              style: {
                height: 28,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 8px",
                borderRadius: 6,
                background: isFlash ? C.active : "transparent",
                transition: "background 200ms",
              },
              onMouseEnter: (e) => {
                if (!isFlash) e.currentTarget.style.background = C.hover;
              },
              onMouseLeave: (e) => {
                if (!isFlash) e.currentTarget.style.background = "transparent";
              },
            },

            /* 功能名 */
            h(
              "span",
              {
                style: {
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 12.5,
                  color: err ? C.danger : C.labelPrimary,
                },
                title: err || it.name,
              },
              it.name,
              it.isCustom
                ? h(
                    "span",
                    { style: { marginLeft: 6, fontSize: 10, color: C.labelTertiary } },
                    "已改",
                  )
                : null,
            ),

            /* 冲突原因 */
            err
              ? h(
                  "span",
                  { style: { flex: "none", fontSize: 11, color: C.danger, marginRight: 8 } },
                  err,
                )
              : null,

            /* 键位：录制中显示提示，否则显示当前键位 */
            isCapturing
              ? h(
                  "span",
                  {
                    style: {
                      flex: "none",
                      fontSize: 12,
                      color: C.brand,
                      fontVariantNumeric: "tabular-nums",
                    },
                  },
                  "按下新键…",
                )
              : h(
                  "button",
                  {
                    type: "button",
                    onClick: () => {
                      setCapturing(it.id);
                      setError(null);
                    },
                    "aria-label": `重设「${it.name}」的快捷键`,
                    title: "点击后按下新键（Esc 取消）",
                    style: {
                      flex: "none",
                      minWidth: 64,
                      textAlign: "right",
                      border: 0,
                      background: "transparent",
                      color: C.labelSecondary,
                      fontSize: 12,
                      fontFamily: "inherit",
                      cursor: "pointer",
                      padding: "2px 4px",
                      borderRadius: 4,
                      fontVariantNumeric: "tabular-nums",
                    },
                  },
                  it.label || "未设置",
                ),
          );
        }),
      ),
    );
  };

  /* ══════════════════════════════════════════════════════════════
     embedded：只画内容，外壳由 DSH 设置面板提供
     ══════════════════════════════════════════════════════════════ */
  if (embedded) {
    return h(
      "div",
      {
        "data-ac-shortcut-settings": "",
        "data-embedded": "",
        style: {
          display: "flex",
          flexDirection: "column",
          width: "100%",
          color: C.labelPrimary,
          fontFamily: "inherit",
          fontSize: 13,
        },
      },
      h("div", { style: { padding: "0 0 8px", flex: "none" } },
        h(SearchInput, { value: query, onChange: setQuery })),
      h(
        "div",
        { style: { maxHeight: 380, overflowY: "auto", padding: "0 0 8px" } },
        renderGroups(),
      ),
      h(
        "div",
        {
          style: {
            flex: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingTop: 8,
            borderTop: `0.5px solid ${C.borderL3}`,
          },
        },
        h(FootNote),
        h(ResetAllButton, {
          onClick: () => { resetAllShortcuts(); setError(null); },
        }),
      ),
    );
  }

  /* ══════════════════════════════════════════════════════════════
     浮层形态（预览页 / 独立测试用）
     ══════════════════════════════════════════════════════════════ */
  return h(
    "div",
    {
      onClick: onClose,
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 99990,
        background: "rgba(0,0,0,0.32)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      },
    },
    h(
      "div",
      {
        role: "dialog",
        "aria-label": "快捷键设置",
        onClick: (e) => e.stopPropagation(),
        style: {
          width: 480,
          maxWidth: "100%",
          maxHeight: "min(600px, 84vh)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: C.bg,
          borderRadius: C.radiusLg,
          boxShadow: C.elevation,
          color: C.labelPrimary,
          fontFamily: "inherit",
          fontSize: 13,
        },
      },
      /* 标题行 */
      h(
        "div",
        {
          style: {
            height: 48,
            flex: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 16px",
            borderBottom: `0.5px solid ${C.borderL3}`,
          },
        },
        h("span", { style: { fontSize: 14, fontWeight: 500 } }, "快捷键"),
        h(
          "button",
          {
            type: "button",
            onClick: onClose,
            "aria-label": "关闭",
            style: {
              width: 26, height: 26, border: 0, borderRadius: 6,
              background: "transparent", color: C.labelSecondary,
              cursor: "pointer", fontSize: 16, lineHeight: 1,
            },
          },
          "×",
        ),
      ),
      h("div", { style: { padding: "10px 16px 6px", flex: "none" } },
        h(SearchInput, { value: query, onChange: setQuery })),
      h(
        "div",
        { style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 8px 8px" } },
        renderGroups(),
      ),
      h(
        "div",
        {
          style: {
            flex: "none",
            height: 44,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 16px",
            borderTop: `0.5px solid ${C.borderL3}`,
          },
        },
        h(FootNote),
        h(ResetAllButton, {
          onClick: () => { resetAllShortcuts(); setError(null); },
        }),
      ),
    ),
  );
}

/**
 * 单条快捷键的「键位文本」—— 给工具栏、二级菜单用。
 *
 * ★ 这是主人要的「同步到二级菜单提示的快捷键」的落点：
 *   所有地方都读这个组件，改完之后自动跟着变。
 */
export function Kbd({ id }) {
  const [, force] = React.useState(0);
  React.useEffect(() => subscribeShortcuts(() => force((n) => n + 1)), []);
  const label = chordToLabel(
    listShortcuts().find((x) => x.id === id)?.chord ?? "",
  );
  if (!label) return null;
  return h(
    "span",
    {
      "data-kbd": id,
      style: {
        fontSize: 11,
        color: C.labelTertiary,
        padding: "1px 4px",
        borderRadius: 4,
        background: "transparent",
        fontVariantNumeric: "tabular-nums",
      },
    },
    label,
  );
}
