/**
 * 角色卡 —— F1（外部源调研优先级第一）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 解决什么问题
 *   同一个角色跨镜头变脸。yz 有 6 个参考图槽位，但每生成一段都要
 *   人工重新挑图、重新写 `<Subject 1>` 指向第几张；换一段就忘。角色一多必乱。
 * ══════════════════════════════════════════════════════════════════════
 *
 * ★ 设计：不新增数据结构，用素材库已有的 tags 承载角色信息。
 *
 *   约定（写在 tags 里）：
 *     role:character        这是一张角色定妆图
 *     char:<角色名>         属于哪个角色
 *     view:<视角>           可选：front / side / back / closeup / full
 *
 *   ⇒ 好处：素材库的既有能力（扫描 / 去重 / 收藏 / 改名 / 删除）全部照用，
 *     不需要第二套存储，也不会出现「素材库里改了名，角色卡不知道」的分裂。
 *
 * ★ 与 H3 参考标签的衔接（已完成的 h3-labels.js）：
 *   角色卡填完槽位后，每张图应该被标成「角色外观」，而不是「画面帧」
 *   ——这是 H3 官方规则：
 *     「只用来定义角色/场景/服装/风格的图，不要单独开 <Picture> 条目」
 *   ⇒ injectCharacters() 返回的 refs 直接带 role:"subject.character"，
 *     交给 tagReferences() 就能生成正确的 subject_definitions。
 *
 * ★★ 2026-10-20 更正：这里原来写的是 role:"appearance"。
 *   "appearance" 是 h3-labels.js 重构【之前】的 4 个平铺 role 之一，
 *   重构后 4 个 H3 标签（Subject/Picture/Video/Audio）+ 19 个细分角色，
 *   「角色外观」的正式 id 是 "subject.character"。
 *   虽然新 h3-labels.js 有 migrateLegacyRole() 能兼容旧值，
 *   但生产方应该直接产出新 id，不要依赖消费方的兼容层。
 */

import path from "node:path";

/** 标签常量（避免各处硬编码字符串）。 */
export const TAG_ROLE = "role:character";
export const CHAR_PREFIX = "char:";
export const VIEW_PREFIX = "view:";

/** 常用视角（给 UI 下拉用）。 */
export const VIEWS = ["front", "side", "back", "closeup", "full"];

/**
 * 从一条素材解析出角色信息。
 * @param {object} asset 素材库的一条记录（含 tags）
 * @returns {{isCharacter:boolean, name:string|null, view:string|null}|null}
 */
export function parseCharacterTag(asset) {
  const tags = Array.isArray(asset?.tags) ? asset.tags : [];
  if (!tags.includes(TAG_ROLE)) return null;

  const name = tags
    .filter((t) => typeof t === "string" && t.startsWith(CHAR_PREFIX))
    .map((t) => t.slice(CHAR_PREFIX.length).trim())
    .filter(Boolean)[0] ?? null;

  const view = tags
    .filter((t) => typeof t === "string" && t.startsWith(VIEW_PREFIX))
    .map((t) => t.slice(VIEW_PREFIX.length).trim())
    .filter(Boolean)[0] ?? null;

  return { isCharacter: true, name, view };
}

/**
 * 把素材库里的角色整理成「角色名 → 定妆图组」。
 *
 * @param {Array<object>} assets 素材库全量列表
 * @returns {Record<string, Array<{id:string,name:string,path:string,view:string|null}>>}
 *   只含真的标了 char:<名字> 的图；没标名字的进 "_unnamed"。
 */
export function groupByCharacter(assets) {
  const out = {};
  for (const a of assets ?? []) {
    const c = parseCharacterTag(a);
    if (!c) continue;
    const key = c.name ?? "_unnamed";
    if (!out[key]) out[key] = [];
    out[key].push({
      id: a.id,
      name: a.name ?? path.basename(String(a.path ?? "")),
      path: a.path ?? null,
      view: c.view,
    });
  }
  // 视角排序：front 优先，其余按字母 —— 让「正面照」总是第一个被填进槽位
  for (const k of Object.keys(out)) {
    out[k].sort((x, y) => {
      const rank = (v) => (v == null ? 9 : VIEWS.indexOf(v) === -1 ? 8 : VIEWS.indexOf(v));
      return rank(x.view) - rank(y.view) || String(x.name).localeCompare(String(y.name));
    });
  }
  return out;
}

/**
 * 给一张素材打上角色标签（返回新的 tags 数组，不改原对象）。
 *
 * @param {string[]} tags    原标签
 * @param {string} name      角色名
 * @param {string} [view]    视角
 * @param {boolean} [on]     false = 移除角色标记
 * @returns {string[]}
 */
export function withCharacterTag(tags, name, view, on = true) {
  const base = (Array.isArray(tags) ? tags : [])
    .filter((t) => typeof t === "string")
    .filter((t) => !t.startsWith(CHAR_PREFIX) && !t.startsWith(VIEW_PREFIX) && t !== TAG_ROLE);
  if (!on) return base;
  const next = [...base, TAG_ROLE];
  if (name && String(name).trim()) next.push(CHAR_PREFIX + String(name).trim());
  if (view && String(view).trim()) next.push(VIEW_PREFIX + String(view).trim());
  return next;
}

/**
 * 核心：把角色卡注入到参考图槽位。
 *
 * ★ 为什么要「按顺序填」而不是「按名字找槽」：
 *   yz 的槽是 ref_image_0..5（位置编号，无语义），H3 靠提示词里的
 *   <Subject N> / <Picture N> 区分用途。所以填槽只需要「不冲突、不覆盖
 *   用户已手动放的图」，语义交给提示词层。
 *
 * ★ 什么时候不填：
 *   · 槽已被占用（用户手动选的图优先，绝不覆盖）
 *   · 该角色没有任何定妆图
 *   · 所有槽都满了 → 返回 unfilled，让调用方决定要不要覆盖
 *
 * @param {object} opts
 * @param {Record<string, Array>} opts.characters  groupByCharacter 的结果
 * @param {string[]} opts.names                     要注入的角色名（按顺序）
 * @param {string[]} opts.slots                     可用槽位名（如 ["ref_image_0",...]）
 * @param {Record<string, any>} [opts.files]        当前已填的槽（不会被覆盖）
 * @param {number} [opts.perCharacter]              每个角色最多用几张（默认 1）
 * @returns {{ok:boolean, filled:Record<string,object>, assigned:Array, unfilled:Array, missing:string[], warnings:string[]}}
 */
export function injectCharacters(opts) {
  const {
    characters = {},
    names = [],
    slots = [],
    files = {},
    perCharacter = 1,
  } = opts ?? {};

  const filled = {};
  const assigned = [];
  const unfilled = [];
  const missing = [];
  const warnings = [];

  // 可用槽位 = 空着的那些，保持原顺序
  const free = slots.filter((s) => !files?.[s]);

  if (!names.length) {
    return { ok: false, filled, assigned, unfilled, missing, warnings: ["没有指定角色名"] };
  }
  if (!slots.length) {
    return { ok: false, filled, assigned, unfilled, missing, warnings: ["这个工作流没有参考图槽位"] };
  }

  // 同名角色重复指定 → 只算一次
  const seen = new Set();
  const ordered = [];
  for (const n of names) {
    const k = String(n ?? "").trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    ordered.push(k);
  }

  let cursor = 0;
  for (const name of ordered) {
    const pics = characters[name];
    if (!Array.isArray(pics) || pics.length === 0) {
      missing.push(name);
      continue;
    }
    const take = Math.max(1, Math.min(Number(perCharacter) || 1, pics.length));
    for (let i = 0; i < take; i++) {
      if (cursor >= free.length) {
        unfilled.push({ character: name, picture: pics[i].name });
        continue;
      }
      const slot = free[cursor++];
      filled[slot] = {
        /**
         * ★★ 2026-10-20 改（H3 标签体系重建后）：
         *   旧值是 "appearance"，那是 h3-labels.js 重构【之前】的 4 分类之一。
         *   重构后 4 个平铺 role 变成了 4 个 H3 标签 + 19 个细分角色，
         *   「角色外观」的正式 id 是 "subject.character"。
         *
         *   虽然 h3-labels.js 的 migrateLegacyRole() 能兼容 "appearance"，
         *   但依赖兼容层不是正解 —— 新代码必须直接用新 id
         *   （AGENTS §6.38：「跨模块传递的状态字段」要三个问题都回答：
         *     生产方产出什么 / 消费方接到什么 / 有没有生产了但没人处理的值）。
         */
        role: "subject.character",
        filename: pics[i].name,
        path: pics[i].path,
        character: name,
        view: pics[i].view,
      };
      assigned.push({ slot, character: name, picture: pics[i].name, view: pics[i].view });
    }
  }

  if (unfilled.length) {
    warnings.push(`槽位不够：${unfilled.length} 张定妆图没地方放（${free.length} 个空槽）`);
  }
  if (missing.length) {
    warnings.push(`这些角色没有定妆图：${missing.join("、")}`);
  }
  // ★ 照 YUH 的做法：角色多于槽位时当场说，不要让人试错
  if (ordered.length > 3) {
    warnings.push(
      `${ordered.length} 个角色共用 ${slots.length} 个槽：H3 的 <Subject N> 是一主体一条，` +
      `角色过多时模型容易混淆，建议分镜拆开生成。`
    );
  }

  return {
    ok: assigned.length > 0,
    filled,
    assigned,
    unfilled,
    missing,
    warnings,
  };
}

/**
 * 生成角色卡的提示词片段。
 *
 * 与 h3-labels.js 的分工：
 *   · 这里只负责「每个角色叫什么、用哪张图当外观来源」
 *   · h3-labels.js 负责把它翻译成 <Subject N> 的完整句式
 * ⇒ 两边不重复写句子，避免改写一处忘了另一处。
 *
 * @param {Array<{character:string, filename:string, slot:string}>} assigned
 * @returns {Array<{slot:string, name:string, kind:string, role:string, note:string}>}
 *   直接喂给 tagReferences()
 */
export function toRefSpecs(assigned) {
  return (assigned ?? []).map((a) => ({
    slot: a.slot,
    name: a.filename,
    kind: "image",
    // ★ 2026-10-20：与 injectCharacters 保持一致，用 H3 细分角色 id
    role: "subject.character",
    note: a.character + (a.view ? `（${a.view}）` : ""),
  }));
}
