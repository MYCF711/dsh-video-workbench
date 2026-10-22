/**
 * shortcuts.js · 快捷键注册与自定义（2026-10-21）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人要求（原话）：
 *   「最好可以在设置里面增加一个快捷键设置，让用户根据自身习惯修改各种功能的
 *     快捷键，并同步到二级菜单提示的快捷键」
 *
 * ── 为什么自己实现，不用 DSH 的
 *   实测：DSH 的 dsh-client-shortcuts 插件打包在 app.asar 里，
 *   磁盘上找不到源码，也没有可复用的 npm 包。
 *   ⇒ 自己实现，但【视觉规格照 DSH 的来】（见下）。
 *
 * ── DSH 快捷键面板的实测规格（作为对齐基准）
 *   480 宽居中外浮层 / 16px 圆角 / 白色 + 阴影
 *   顶部「快捷键」+ ×
 *   搜索框「搜索快捷键」
 *   分组标题：小字灰色
 *   行：「功能名 ………… 键位」行高 28
 *   键位是【纯文字】不加胶囊背景（DPR 截图核对过）
 *   底部「恢复全部默认」
 *
 * ── 默认值来源
 *   Premiere Pro 官方快捷键文档：
 *   https://helpx.adobe.com/cn/premiere-pro/using/print-premiere-pro-shortcuts-windows.html
 *   能对上的就直接用 PR 的键；对不上的（如"复制片段"PR 是 Ctrl+Shift+/
 *   太反直觉）用更通用的 Ctrl+D。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 设计要点
 *
 * ① 键位表示
 *   normalize 成 { ctrl, shift, alt, key } 的规范化字符串，
 *   如 "Control+Shift+KeyZ"。这样比较、去重、序列化都稳。
 *
 * ② 冲突检测
 *   两条绑定同一个键 ⇒ 拒绝保存并报出冲突的另一个功能名。
 *   这是必须的：静默覆盖会让用户以为设置成功了。
 *
 * ③ 即时生效
 *   不用刷新。store 变更 → 通知所有订阅者（工具栏、菜单、快捷键处理器）。
 *
 * ④ 持久化
 *   localStorage['artcraft.shortcuts.v1']，只存【与默认不同的项】。
 *   这样将来加新功能、改默认值时，用户的自定义不会被旧快照覆盖。
 *
 * ⑤ 双系统键位
 *   Windows/Linux 用 Ctrl，macOS 用 Meta（Cmd）。
 *   存的时候存抽象层（"Mod"），显示时按平台展开。
 *   —— 不做这个的话，同一个配置在 mac 上全是错的。
 */

/** localStorage 键。带版本号，将来结构变了可以迁移。 */
const STORE_KEY = "artcraft.shortcuts.v1";

/**
 * 平台抽象修饰键。
 * Mod = Ctrl（Win/Linux）/ Cmd（mac）
 */
const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || "");

export const MOD_LABEL = IS_MAC ? "⌘" : "Ctrl";

/**
 * 快捷键定义表。
 *
 * group 用于设置面板分组（DSH 的面板就是这么分的）。
 * default 用 PR 的键。
 */
export const SHORTCUT_DEFS = [
  /* 剪辑 */
  { id: "split",          group: "剪辑", name: "分割片段",     default: "Mod+K" },
  { id: "splitRipple",    group: "剪辑", name: "波纹删除",     default: "Shift+Delete" },
  { id: "delete",         group: "剪辑", name: "删除片段",     default: "Delete" },
  { id: "duplicate",      group: "剪辑", name: "复制片段",     default: "Mod+D" },

  /* 历史 */
  { id: "undo",           group: "历史", name: "撤销",         default: "Mod+Z" },
  { id: "redo",           group: "历史", name: "重做",         default: "Mod+Shift+Z" },

  /* 视图 */
  { id: "zoomIn",         group: "视图", name: "放大时间轴",   default: "=" },
  { id: "zoomOut",        group: "视图", name: "缩小时间轴",   default: "-" },
  { id: "trackTaller",    group: "视图", name: "增高轨道",     default: "Mod+=" },
  { id: "trackShorter",   group: "视图", name: "减矮轨道",     default: "Mod+-" },

  /* 标记 */
  { id: "addBookmark",    group: "标记", name: "添加书签",     default: "M" },
  { id: "toggleSnap",     group: "标记", name: "自动吸附",     default: "S" },
];

const DEF_BY_ID = new Map(SHORTCUT_DEFS.map((d) => [d.id, d]));

/* ── 键位规范化 ──────────────────────────────────────────────── */

/**
 * 把配置里写的 "Mod+Shift+Z" 或键盘事件转成统一字符串。
 *
 * 输出形如 "Mod+Shift+KeyZ" / "Delete" / "Equal"
 * —— 用 event.code 而不是 event.key：
 *   · key 会受输入法/大小写影响（按 Shift+A 时 key 是 "A"）
 *   · code 是物理键位，稳定
 *   · 但 code 对非字母键不直观（"=" 是 "Equal"）⇒ 显示时再映射回来
 */
export function normalizeChord(input) {
  if (!input) return "";
  if (typeof input === "string") {
    // 配置串 → 事件式片段
    const parts = input.split("+").map((s) => s.trim()).filter(Boolean);
    const mods = new Set();
    let key = "";
    for (const p of parts) {
      const low = p.toLowerCase();
      if (low === "mod" || low === "ctrl" || low === "control") mods.add("Mod");
      else if (low === "shift") mods.add("Shift");
      else if (low === "alt" || low === "option") mods.add("Alt");
      else if (low === "meta" || low === "cmd" || low === "command") mods.add("Mod");
      else key = p;
    }
    return buildChord(mods, keyToCode(key));
  }
  return "";
}

/** 从键盘事件生成同一个规范串 */
export function chordFromEvent(e) {
  const mods = new Set();
  if (e.ctrlKey || e.metaKey) mods.add("Mod");
  if (e.shiftKey) mods.add("Shift");
  if (e.altKey) mods.add("Alt");
  // 只按修饰键本身时不构成完整快捷键
  if (/^(Shift|Control|Alt|Meta)$/.test(e.code)) return "";
  return buildChord(mods, e.code);
}

function buildChord(mods, code) {
  if (!code) return "";
  const order = ["Mod", "Alt", "Shift"];
  const head = order.filter((m) => mods.has(m));
  return [...head, code].join("+");
}

/** 把显示名映射成 event.code */
function keyToCode(k) {
  if (!k) return "";
  const t = k.trim();
  if (t.length === 1) {
    const up = t.toUpperCase();
    if (/[A-Z]/.test(up)) return "Key" + up;
    if (/[0-9]/.test(t)) return "Digit" + t;
  }
  const named = {
    "=": "Equal", "-": "Minus", ",": "Comma", ".": "Period",
    "/": "Slash", "\\": "Backslash", ";": "Semicolon", "'": "Quote",
    "[": "BracketLeft", "]": "BracketRight", "`": "Backquote",
    Delete: "Delete", Backspace: "Backspace", Enter: "Enter",
    Escape: "Escape", Space: "Space", Tab: "Tab",
    ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
  };
  return named[t] ?? t;
}

/* ── 显示 ────────────────────────────────────────────────────── */

const CODE_LABEL = {
  Equal: "=", Minus: "-", Comma: ",", Period: ".", Slash: "/",
  Backslash: "\\", Semicolon: ";", Quote: "'", BracketLeft: "[",
  BracketRight: "]", Backquote: "`", Delete: "Del", Backspace: "退格",
  Enter: "Enter", Escape: "Esc", Space: "空格", Tab: "Tab",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
};

/**
 * 规范串 → 给人看的字符串。用于工具条提示、二级菜单、设置面板。
 *
 * "Mod+Shift+KeyZ" → "Ctrl+Shift+Z"（Win） / "⌘+Shift+Z"（Mac）
 */
export function chordToLabel(chord) {
  if (!chord) return "";
  const parts = chord.split("+");
  const out = [];
  for (const p of parts) {
    if (p === "Mod") out.push(MOD_LABEL);
    else if (p === "Shift") out.push("Shift");
    else if (p === "Alt") out.push(IS_MAC ? "⌥" : "Alt");
    else if (p.startsWith("Key")) out.push(p.slice(3));
    else if (p.startsWith("Digit")) out.push(p.slice(5));
    else out.push(CODE_LABEL[p] ?? p);
  }
  return out.join("+");
}

/* ── 存储 ────────────────────────────────────────────────────── */

function loadOverrides() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

function saveOverrides(ov) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(ov));
  } catch {
    /* 存不下不影响当前会话 */
  }
}

/* ── store ───────────────────────────────────────────────────── */

const _listeners = new Set();
/** id → 当前规范串（已含默认与覆盖） */
let _current = buildCurrent();
/** id → 是否被用户改过 */
let _overrides = loadOverrides();

function buildCurrent() {
  const ov = loadOverrides();
  const out = {};
  for (const d of SHORTCUT_DEFS) {
    out[d.id] = ov[d.id] ? normalizeChord(ov[d.id]) : normalizeChord(d.default);
  }
  return out;
}

function emit() {
  for (const fn of _listeners) {
    try {
      fn();
    } catch {
      /* 单个订阅者出错不影响别人 */
    }
  }
}

export function subscribeShortcuts(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** 取某个功能的当前规范串 */
export function getChord(id) {
  return _current[id] ?? "";
}

/** 取某个功能的显示标签（给菜单、tooltip 用） */
export function getChordLabel(id) {
  return chordToLabel(_current[id]);
}

/** 全部（设置面板用） */
export function listShortcuts() {
  return SHORTCUT_DEFS.map((d) => ({
    ...d,
    chord: _current[d.id],
    label: chordToLabel(_current[d.id]),
    isCustom: Boolean(_overrides[d.id]),
  }));
}

/** 找某个规范串被谁占了（排除自己） */
export function findConflict(chord, exceptId) {
  if (!chord) return null;
  for (const d of SHORTCUT_DEFS) {
    if (d.id === exceptId) continue;
    if (_current[d.id] === chord) {
      return { id: d.id, name: d.name };
    }
  }
  return null;
}

/**
 * 设置一条快捷键。
 *
 * 返回 { ok:true } 或 { ok:false, reason, conflictWith }
 * ★ 冲突时【拒绝】，不静默覆盖 —— 否则用户以为改成功了。
 */
export function setShortcut(id, chord) {
  const def = DEF_BY_ID.get(id);
  if (!def) return { ok: false, reason: "未知功能" };

  const norm = normalizeChord(chord);
  if (!norm) return { ok: false, reason: "键位为空" };

  const clash = findConflict(norm, id);
  if (clash) {
    return {
      ok: false,
      reason: `与「${clash.name}」冲突`,
      conflictWith: clash,
    };
  }

  // 与默认相同时删掉覆盖项，让「是否自定义」的语义准确
  if (norm === normalizeChord(def.default)) {
    delete _overrides[id];
  } else {
    _overrides[id] = norm;
  }
  saveOverrides(_overrides);
  _current = buildCurrent();
  emit();
  return { ok: true };
}

/** 单条恢复默认 */
export function resetShortcut(id) {
  delete _overrides[id];
  saveOverrides(_overrides);
  _current = buildCurrent();
  emit();
}

/** 全部恢复默认 */
export function resetAllShortcuts() {
  _overrides = {};
  saveOverrides(_overrides);
  _current = buildCurrent();
  emit();
}

/* ── 全局按键处理 ────────────────────────────────────────────── */

/**
 * 安装全局按键监听。返回卸载函数。
 *
 * ★ 只在剪辑台激活时安装（由调用方控制生命周期）。
 * ★ 输入框里不触发：target 是 input/textarea/contenteditable 时跳过，
 *   否则用户在提示词框里打 "M" 就加了个书签。
 */
export function installShortcutHandler(handlers, { enabled = () => true } = {}) {
  const onKeyDown = (e) => {
    if (!enabled()) return;

    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
      return;
    }

    const chord = chordFromEvent(e);
    if (!chord) return;

    for (const [id, fn] of Object.entries(handlers)) {
      if (_current[id] === chord) {
        e.preventDefault();
        e.stopPropagation();
        try {
          fn(e);
        } catch (err) {
          console.error("[shortcuts]", id, err);
        }
        return;
      }
    }
  };

  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
