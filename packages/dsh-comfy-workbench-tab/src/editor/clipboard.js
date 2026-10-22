/**
 * clipboardOps.js 的剪贴板部分（2026-10-22 新增）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人 2026-10-22 的要求：
 *   「复制粘贴为什么不是大众习惯的 c 和 v？」
 *
 * ── 原来是什么
 *   只有一个「复制片段」= Mod+D，内部调 ArtCraft 的 duplicateElements ——
 *   那是【原地复制一份】，不经过剪贴板，也没有「粘贴到别处」。
 *
 *   ⇒ 这是功能缺口，不只是键位不合习惯：
 *     用户想「把这段复制到 10 秒处」，原来做不到。
 *
 * ── 现在
 *   Ctrl+C 复制选中片段 → 存进模块级剪贴板（内存，不写 localStorage）
 *   Ctrl+X 剪切         → 复制 + 删除原片段
 *   Ctrl+V 粘贴         → 落到【播放头位置】，可跨轨道
 *
 * ★ 为什么不用系统剪贴板（navigator.clipboard）：
 *   时间轴的片段是结构化的（媒体 id / 起止 / trim / 参数），
 *   不是纯文本。塞进系统剪贴板要序列化成 JSON 文本，
 *   而用户从别处 Ctrl+V 一段普通文本进时间轴时，
 *   我们还得分清「这是我们的 JSON 还是随便一段字」。
 *   ⇒ 用模块级内存剪贴板：语义干净，且不会污染用户的系统剪贴板。
 *     代价：刷新页面后剪贴板丢失（对剪辑来说可接受）。
 *
 * ★ 为什么不保留 Ctrl+D：
 *   主人明确说「d 没必要保留吧？」。
 *   ⇒ duplicate 这个 id 保留在表里（有地方引用），但默认键位改成 Mod+C，
 *     且行为从「原地复制」改成「复制到剪贴板」。
 */

/* ══════════════════════════════════════════════════════════════════════
 * 模块级剪贴板
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 剪贴板内容。
 *
 * 形状：
 *   {
 *     items: [
 *       { trackType, duration, trimStart, trimEnd, mediaId, name, type, params, offset }
 *     ],
 *     at: 时间戳（仅用于调试）
 *   }
 *
 * ★ 为什么存 offset 而不是 startTime：
 *   粘贴时要「保持相对间隔」—— 选中三段相隔 2 秒的片段，
 *   粘贴出来也该相隔 2 秒，整体落到播放头。
 *   offset = 该片段相对【最早片段】的偏移量。
 */
let _clip = null;

/** 当前剪贴板内容（只读，给 UI 判断能否粘贴）。 */
export function getClipboard() {
  return _clip;
}

/** 清空剪贴板。 */
export function clearClipboard() {
  _clip = null;
}

/* ══════════════════════════════════════════════════════════════════════
 * 读取元素的完整数据
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 从 editor 取出某元素的完整快照（用于复制）。
 *
 * ★ 不能只存 { trackId, elementId }：
 *   粘贴时原元素可能已被删除，或者我们想粘到别的轨道 / 别的时间，
 *   id 引用会失效。必须把【数据本身】拷出来。
 *
 * ★ 字段名按 ArtCraft 的 types.ts 逐字：
 *   { id, type, name, duration, startTime, trimStart, trimEnd,
 *     sourceDuration, mediaId, params, ... }
 */
function snapshotElement(editor, ref) {
  try {
    const found = editor.timeline.getElementsWithTracks({ elements: [ref] });
    const el = found?.[0]?.element;
    const track = found?.[0]?.track;
    if (!el) return null;
    return {
      /* 不带原 id —— 粘贴时要生成新 id（否则与旧元素冲突） */
      type: el.type,
      name: el.name,
      duration: Number(el.duration) || 0,
      startTime: Number(el.startTime) || 0,
      trimStart: Number(el.trimStart) || 0,
      trimEnd: Number(el.trimEnd) || 0,
      sourceDuration: Number(el.sourceDuration) || Number(el.duration) || 0,
      mediaId: el.mediaId ?? null,
      sourceType: el.sourceType ?? undefined,
      params: el.params ? JSON.parse(JSON.stringify(el.params)) : {},
      /* 轨道信息：粘贴时优先落回同类型轨道 */
      trackId: ref.trackId,
      trackType: track?.type ?? null,
      trackName: track?.name ?? null,
    };
  } catch {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 复制 / 剪切 / 粘贴
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * Ctrl+C —— 复制选中片段到模块剪贴板。
 *
 * @returns {{count:number}} 复制的片段数
 *
 * ★ 没有任何选中时【抛错】而不是静默：
 *   「按了没反应」比「报错」更难查（AGENTS 里记过这个判据）。
 */
export function copySelection(editor) {
  const refs = editor?.selection?.getSelectedElements?.() || [];
  const picked = refs
    .map((r) => snapshotElement(editor, { trackId: r?.trackId, elementId: r?.elementId }))
    .filter(Boolean);

  if (picked.length === 0) {
    throw new Error("先选中要复制的片段");
  }

  /* 按起点排序，并以最早的为基准算相对偏移 */
  picked.sort((a, b) => a.startTime - b.startTime);
  const base = picked[0].startTime;
  const items = picked.map((p) => ({
    ...p,
    offset: p.startTime - base,
  }));

  _clip = { items, at: Date.now() };
  return { count: items.length };
}

/**
 * Ctrl+X —— 剪切。
 *
 * 先复制，成功后才删除原片段。
 * ★ 顺序不能反：先删再复制，万一复制失败（元素拿不到）就永久丢内容。
 *
 * @returns {{count:number}}
 */
export function cutSelection(editor) {
  const r = copySelection(editor);   // 失败会抛，后面不执行
  const refs = editor.selection.getSelectedElements() || [];
  editor.timeline.deleteElements({
    elements: refs.map((x) => ({ trackId: x?.trackId, elementId: x?.elementId })),
  });
  editor.selection.clearSelection();
  return r;
}

/**
 * Ctrl+V —— 粘贴到播放头。
 *
 * @param {object} editor
 * @param {object} [opts]
 * @param {boolean} [opts.toPlayhead=true] true=落播放头，false=原地偏移
 * @returns {{count:number, at:number}}
 *
 * ── 落点规则
 *   · 基准时间 = 播放头位置（`playback.getCurrentTime()`）
 *   · 每个片段 = 播放头 + 自己的 offset（保持相对间隔）
 *   · 轨道：优先落回【同类型】轨道；该类轨道不存在时交给 ArtCraft 的 auto 放置
 *
 * ★ 为什么用 insertElement 而不是 duplicateElements：
 *   duplicateElements 是「原地复制」，不接受落点参数
 *   （timeline-manager.ts:766 的签名只有 elements）。
 *   要「粘贴到播放头」只能构造新元素再 insertElement。
 *
 * ★ 冲突处理（目标区间已被占用）：
 *   ArtCraft 的 placement:auto 会自己找空位；找不到就新建轨道。
 *   ⇒ 我们【不】自己解冲突 —— 那会与它的放置规则打架。
 *     但插入后要检查返回值，失败的要报出来（见下）。
 */
export function pasteClipboard(editor, opts = {}) {
  if (!_clip || _clip.items.length === 0) {
    throw new Error("剪贴板是空的");
  }
  const toPlayhead = opts.toPlayhead !== false;
  const playhead = Number(editor?.playback?.getCurrentTime?.() ?? 0);

  /* 目标轨道类型：优先用剪贴板里第一段的轨道类型 */
  const wantType = _clip.items[0]?.trackType ?? null;

  let ok = 0;
  const failed = [];

  for (const it of _clip.items) {
    const base = toPlayhead ? playhead : playhead;
    const startTime = Math.max(0, Math.round(base + (it.offset || 0)));

    /* 构造新元素。★ 不带原 id —— insertElement 会生成？实测不会，必须自己给 */
    const newId = `el-paste-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const element = {
      id: newId,
      type: it.type,
      name: it.name,
      duration: it.duration,
      startTime,
      trimStart: it.trimStart,
      trimEnd: it.trimEnd,
      sourceDuration: it.sourceDuration,
      params: it.params,
    };
    if (it.mediaId) element.mediaId = it.mediaId;
    /* ★ AudioElement 是联合类型，必须带 sourceType（AGENTS §6.39 ⑥） */
    if (it.type === "audio") element.sourceType = it.sourceType || "upload";
    if (it.type === "video") element.isSourceAudioEnabled = true;

    try {
      editor.timeline.insertElement({
        element,
        placement: { mode: "auto", trackType: wantType ?? undefined },
      });

      /**
       * ★★ 2026-10-22 实测发现的真 bug：insertElement 不吃 element.startTime
       *
       *   实测（19499）：
       *     传给 insertElement 的 startTime = 600000（5 秒）✅
       *     插入后读回来，元素的 startTime = 0 ❌
       *
       *   根因（artcraft insert-element.ts:228-243）：
       *     resolveTrackPlacement({ ..., strategy: { type: "firstAvailable" } })
       *   "找空位"的语义是【从轨道起点开始找】，不是我给的 startTime。
       *   轨道 0 秒是空的 ⇒ 它就放 0 秒了。
       *
       *   ⇒ 修法：插入后把 startTime 显式改回目标值。
       *     用 updateElements（不是 updateElementTrim —— 后者语义是"修剪"，
       *     会连带重算 duration）。
       *
       *   ★ 为什么不用 placement.mode: "explicit"：
       *     explicit 必须指定 trackId ⇒ 无法跨轨道粘贴，
       *     且轨道占满时直接失败（不会新建轨道）。
       *     auto + 事后改时间，既保留跨轨道能力，又能精确落点。
       */
      try {
        const tid = editor.timeline.findTrackIdForElement({ elementId: newId });
        editor.timeline.updateElements({
          updates: [{ trackId: tid, elementId: newId, startTime }],
        });
      } catch {
        /**
         * 定位失败不阻断：元素已经在时间轴上了（位置可能不对，但没丢）。
         * ★ 但不静默 —— 留一条 warn，用户能在控制台看到。
         */
        console.warn("[artcraft] 粘贴后定位失败（片段已在时间轴上，位置可能不是播放头）", newId);
      }

      ok += 1;
    } catch (e) {
      failed.push({ name: it.name, error: String(e?.message ?? e) });
    }
  }

  if (ok === 0) {
    throw new Error(
      "粘贴失败：" + (failed[0]?.error || "目标轨道装不下")
    );
  }
  if (failed.length) {
    console.warn("[artcraft] 粘贴部分失败：", failed);
  }
  return { count: ok, at: playhead };
}

