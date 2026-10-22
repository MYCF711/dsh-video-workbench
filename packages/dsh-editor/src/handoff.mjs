/**
 * 人机分镜交接 —— F6（外部源调研 P0，「协同」真正落地的那一格）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 解决什么问题
 *   现在人和 Agent 都能改同一份分镜，但【分不清谁改了什么】：
 *     · 人粗排了 10 个镜头，Agent 精修时把人的意图覆盖了 → 人白干
 *     · Agent 写了提示词，人改了一版，Agent 下次又改回去 → 循环拉锯
 *     · 出了问题不知道「这镜是谁定的」，没法追责也没法回退
 *
 *   已有的 prompt-gate 解决的是「Agent 不许乱改提示词」；
 *   这一层解决的是「**改了什么、谁改的、能不能撤回**」。
 * ══════════════════════════════════════════════════════════════════════
 *
 * ★ 核心设计：锁字段，不是锁整段。
 *
 *   一个镜头有 8 个可改字段（prompt / durationSec / steps / seed /
 *   toggles / media / aspect / modeId）。人和 Agent 的强项完全不同：
 *
 *     人擅长：prompt 的意图、durationSec 的节奏、挑哪张参考图
 *     Agent 擅长：steps / seed / toggles 这类参数调优、批量套用
 *
 *   ⇒ 不搞「谁占了这段谁说了算」，而是【按字段授权】：
 *     人改过的字段自动上锁（locked），Agent 改被锁字段会被拒，
 *     除非显式 unlock 并在返回值里说明「我覆盖了你改的 prompt」。
 *
 * ★ 为什么不做成「人与 Agent 轮流独占整段」：
 *   实测过的情形是「人改 prompt 的同时 Agent 在调参数」——
 *   整段独占会让两边互相卡死，比冲突更烦。
 *
 * ★ 为什么锁记的是「字段 + 值指纹」而不是「字段 + 时间」：
 *   值没变就说明没被覆盖，时间戳只会产生误报（Agent 写了个相同值也算冲突）。
 */

/** 可被锁的字段（与 host-store.updateShot 的 allowed 对齐）。 */
export const LOCKABLE = [
  "modeId", "prompt", "aspect", "durationSec", "steps", "seed", "toggles", "media",
];

/** 人默认拿哪些字段的锁 —— prompt 与节奏是人最该拍板的。 */
export const HUMAN_OWNS = ["prompt", "durationSec"];

/** Agent 优先用哪些字段 —— 参数调优是它的强项。 */
export const AGENT_OWNS = ["steps", "seed", "toggles"];

/**
 * 简易指纹（与 prompt-gate 的 hash 同算法，便于比对）。
 *
 * ★ 2026-10-18 修（自测抓到的真缺陷）：
 *   原来直接 String(v) —— 数字 8 和字符串 "8" 得到同一指纹。
 *   后果：Agent 把 steps 从 8 改成 "8" 时被判定「值未变」而放行，
 *   结果工作流收到字符串，ComfyUI 静默按默认值跑。
 *   ⇒ 指纹必须带上类型。
 */
export function fingerprint(v) {
  let t;
  if (v == null) t = "\u0000null";
  else if (typeof v === "object") {
    try { t = "\u0001obj:" + JSON.stringify(v, Object.keys(v).sort()); } catch { t = "\u0001obj:" + String(v); }
  } else t = "\u0001" + typeof v + ":" + String(v);
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

/**
 * 在 clip 上记录一次改动。
 *
 * ★ 为什么不改 host-store 的结构：
 *   clip 上已经有一个 `shot` 对象，把交接记录挂在 `clip.handoff` 上，
 *   不动既有字段 —— 老代码读 clip.shot 一切照旧，读不到 handoff 就当没有。
 *   这样即使这段逻辑出问题，也只是「没有交接记录」，不会让整个时间轴废掉。
 *
 * @param {object} clip     目标片段（会被原地修改）
 * @param {string} field    字段名
 * @param {any}    value    新值
 * @param {"user"|"agent"} who 谁改的
 * @returns {{ok:boolean, locked:boolean, reason?:string, record:object}}
 */
export function recordChange(clip, field, value, who) {
  if (!clip) return { ok: false, locked: false, reason: "没有片段" };
  if (!LOCKABLE.includes(field)) {
    return { ok: false, locked: false, reason: `字段 ${field} 不可交接` };
  }

  const h = clip.handoff ?? {};
  const locks = h.locks ?? {};
  const log = Array.isArray(h.log) ? h.log : [];

  const fp = fingerprint(value);
  const lock = locks[field];

  // ① Agent 想改人锁住的字段 → 拒绝，并说清是谁锁的、什么时候
  if (who === "agent" && lock && lock.by === "user") {
    // 值没变就不算冲突（Agent 写了个相同值）
    if (lock.fp === fp) {
      return { ok: true, locked: false, reason: "值未变化，无需改写" };
    }
    return {
      ok: false,
      locked: true,
      reason:
        `字段 ${field} 已被用户锁定（${new Date(lock.at).toLocaleString()}）。` +
        `Agent 若要覆盖，必须先 unlock —— 或者在返回值里说明「我覆盖了用户改的 ${field}」。`,
    };
  }

  // ② 记录这次改动
  const rec = { at: Date.now(), by: who, field, fp };
  log.push(rec);
  // 只留最近 50 条，避免 clip 无限膨胀
  const trimmed = log.slice(-50);

  // ③ 人改的字段自动上锁；Agent 改的只在没有锁时记一笔（不改锁）
  const nextLocks = { ...locks };
  if (who === "user") {
    nextLocks[field] = { by: "user", at: rec.at, fp };
  } else if (!nextLocks[field]) {
    // Agent 第一个改的字段：记成「agent 占过」，但不阻止人改
    nextLocks[field] = { by: "agent", at: rec.at, fp };
  } else if (nextLocks[field].by === "agent") {
    // Agent 连续改自己占的字段：更新指纹
    nextLocks[field] = { by: "agent", at: rec.at, fp };
  }

  clip.handoff = { locks: nextLocks, log: trimmed };
  return { ok: true, locked: who === "user", record: rec };
}

/**
 * 检查一次批量 patch 里有没有会被拒的字段。
 *
 * ★ 为什么先整体检查再落地：
 *   如果边改边判，前半段改成功、后半段被拒，clip 就处于「改了一半」的状态，
 *   比直接拒绝更难收拾。
 *
 * @param {object} clip
 * @param {Record<string, any>} patch
 * @param {"user"|"agent"} who
 * @returns {{ok:boolean, blocked:Array<{field:string, reason:string}>}}
 */
export function checkPatch(clip, patch, who) {
  const blocked = [];
  if (who !== "agent") return { ok: true, blocked };
  const locks = clip?.handoff?.locks ?? {};
  for (const [field, value] of Object.entries(patch ?? {})) {
    if (!LOCKABLE.includes(field)) continue;
    const lock = locks[field];
    if (lock?.by === "user" && lock.fp !== fingerprint(value)) {
      blocked.push({ field, reason: `被用户锁定（${new Date(lock.at).toLocaleString()}）` });
    }
  }
  return { ok: blocked.length === 0, blocked };
}

/**
 * 解锁。人可以解任何锁；Agent 只能解自己占的。
 * @returns {{ok:boolean, reason?:string, locks:object}}
 */
export function unlock(clip, field, who) {
  const locks = { ...(clip?.handoff?.locks ?? {}) };
  if (field === "*") {
    if (who === "agent") {
      // Agent 只能解自己的
      for (const k of Object.keys(locks)) {
        if (locks[k].by === "agent") delete locks[k];
      }
    } else {
      for (const k of Object.keys(locks)) delete locks[k];
    }
    clip.handoff = { ...(clip.handoff ?? {}), locks };
    return { ok: true, locks };
  }
  const lock = locks[field];
  if (!lock) return { ok: true, locks };
  if (who === "agent" && lock.by === "user") {
    return { ok: false, reason: `字段 ${field} 是用户锁的，Agent 不能解锁`, locks };
  }
  delete locks[field];
  clip.handoff = { ...(clip.handoff ?? {}), locks };
  return { ok: true, locks };
}

/**
 * 给某一段生成「交接单」—— 人和 Agent 都能读的一页说明。
 *
 * @param {object} clip
 * @returns {{clipId:string, owned:Record<string,string>, changes:Array, summary:string}}
 */
export function handoffReport(clip) {
  const h = clip?.handoff ?? {};
  const locks = h.locks ?? {};
  const log = Array.isArray(h.log) ? h.log : [];

  const owned = {};
  for (const [k, v] of Object.entries(locks)) owned[k] = v.by;

  const userFields = Object.keys(owned).filter((k) => owned[k] === "user");
  const agentFields = Object.keys(owned).filter((k) => owned[k] === "agent");

  const parts = [];
  if (userFields.length) parts.push(`人定了 ${userFields.join("/")}`);
  if (agentFields.length) parts.push(`Agent 调了 ${agentFields.join("/")}`);
  const summary = parts.length ? parts.join("；") : "还没有交接记录";

  return {
    clipId: clip?.id ?? null,
    owned,
    changes: log.slice(-10),
    summary,
  };
}

/**
 * 批量交接报告（整条时间轴）。
 *
 * @param {Array<object>} clips
 * @returns {{total:number, touched:number, conflicts:Array, summary:string}}
 */
export function handoffOverview(clips) {
  const list = clips ?? [];
  const conflicts = [];
  let touched = 0;

  for (const c of list) {
    const h = c?.handoff;
    if (!h) continue;
    touched++;
    const locks = h.locks ?? {};
    // 「人锁了 prompt，但 Agent 后来改过 prompt」= 冲突
    const log = Array.isArray(h.log) ? h.log : [];
    for (const field of Object.keys(locks)) {
      if (locks[field].by !== "user") continue;
      const later = log.find((r) => r.field === field && r.by === "agent" && r.at > locks[field].at);
      if (later) {
        conflicts.push({
          clipId: c.id, name: c.name ?? c.id, field,
          reason: `人先改（${new Date(locks[field].at).toLocaleString()}），Agent 后改（${new Date(later.at).toLocaleString()}）`,
        });
      }
    }
  }

  return {
    total: list.length,
    touched,
    conflicts,
    summary: conflicts.length
      ? `${conflicts.length} 处人机覆盖冲突，需要人确认`
      : touched
        ? `${touched}/${list.length} 段有交接记录，无冲突`
        : "还没有任何交接记录",
  };
}
