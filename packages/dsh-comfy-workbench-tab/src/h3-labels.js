/**
 * H3 参考标签体系 —— 按官方文档重建（2026-10-20）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 数据来源（唯一权威）
 *
 *   <HOME>\.agents\skills\h3-prompt-writing\references\ref-en.txt
 *   23.3KB / 341 行 · H3 官方 Full-Reference Mode 改写格式指南
 *
 *   完整推导见 docs\H3-参考标签体系-20261020.md
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么重写（主人 2026-10-20）
 *
 *   主人原话：「按照 h3 支持的参考源 tag 来分类，否则的话分了也没意义」
 *
 *   旧实现只有 4 个平铺的 role：frame / appearance / motion / sound。
 *   问题：
 *     · `appearance` 把「角色 / 物品 / 场景 / 服装 / 风格 / 姿势」全混在一起，
 *       而这六者在官方文档里是【同一个 Subject 下的不同方面】，不是六个标签。
 *     · `motion` 被当成独立的 <Video N>，但官方第 88 行明确：
 *       「从视频里取动作当可见内容 → 仍属 <Subject N>」。
 *       <Video N> 只标「这个视频是结构来源」。
 *     · 缺 `storyboard`（分镜图）—— 官方第 72 行专门为它开了规则。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 核心约束（写代码时不许违反）
 *
 *   ① 一级分类【只能是】官方那四个标签：Subject / Picture / Video / Audio。
 *      一个细分可以有很多个，但每个细分必须唯一映射到其中一个标签。
 *   ② 只用来定角色/场景/服装/风格的图，不许单独开 <Picture N>
 *      （官方第 68 行逐字）。必须并进对应 <Subject N> 的定义里。
 *   ③ <Video N> 与 <Audio N> 编号互相独立（官方第 110 行）。
 *      带音轨的视频不自动产生 <Audio N>。
 *   ④ 一个 <Subject> 可由多个资产定义，一个资产可提供多个 <Subject>
 *      （官方第 48 行）。
 */

/* ══════════════════════════════════════════════════════════════════════
   一 · H3 的四个标签（官方原文第 26-33 行）
   ══════════════════════════════════════════════════════════════════════ */

export const H3_TAGS = {
  Subject: {
    id: "Subject",
    label: "<Subject N>",
    zh: "可复用的可见内容",
    official:
      "Visible content abstracted from reference assets that can be reused or modified in the target video",
    /** 官方第 68 行：这类图不许单独开 Picture */
    neverStandalonePicture: true,
  },
  Picture: {
    id: "Picture",
    label: "<Picture N>",
    zh: "目标帧 / 分镜规划锚点",
    official:
      "A reference image used as a concrete target frame or shot-planning anchor",
    neverStandalonePicture: false,
  },
  Video: {
    id: "Video",
    label: "<Video N>",
    zh: "结构来源（编辑/续接/运镜/节奏）",
    official:
      "A reference video that provides an editing source, continuation starting point, or whole-video temporal structure",
    neverStandalonePicture: false,
  },
  Audio: {
    id: "Audio",
    label: "<Audio N>",
    zh: "音频信号",
    official: "An audio signal that is copied or referenced",
    neverStandalonePicture: false,
  },
};

/* ══════════════════════════════════════════════════════════════════════
   二 · 细分角色 —— 每个必须唯一映射到上面四个标签之一
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 每个角色：
 *   id       稳定标识（存进资产标签，不许改）
 *   tag      唯一归属的 H3 标签
 *   zh       中文名（UI 上显示）
 *   hint     给用户的一句话说明
 *   kinds    接受哪些素材类型（决定 UI 里能不能选）
 *   source   官方依据（行号 + 原文关键词，便于以后核对）
 */
export const REF_ROLES = {
  /* ── Subject：可见内容的各个方面 ─────────────────────────── */
  "subject.character": {
    id: "subject.character",
    tag: "Subject",
    zh: "角色外观",
    hint: "这个人/动物长什么样。只定长相，不单独成帧。",
    kinds: ["image", "video"],
    source: "第 43 行 People, animals",
  },
  "subject.object": {
    id: "subject.object",
    tag: "Subject",
    zh: "物品/道具外观",
    hint: "物体、道具长什么样。",
    kinds: ["image", "video"],
    source: "第 45 行 props",
  },
  "subject.scene": {
    id: "subject.scene",
    tag: "Subject",
    zh: "场景/环境",
    hint: "空间、背景、环境是什么样。",
    kinds: ["image", "video"],
    source: "第 44 行 Scenes, backgrounds, environments",
  },
  "subject.costume": {
    id: "subject.costume",
    tag: "Subject",
    zh: "服装",
    hint: "衣服的款式与材质。",
    kinds: ["image"],
    source: "第 45 行 Clothing",
  },
  "subject.style": {
    id: "subject.style",
    tag: "Subject",
    zh: "画风/风格",
    hint: "整体的视觉风格，不指定具体主体。",
    kinds: ["image"],
    source: "第 46 行 Styles",
  },
  "subject.pose": {
    id: "subject.pose",
    tag: "Subject",
    zh: "姿势/骨骼图",
    hint: "骨骼图或姿势参考，定的是「怎么摆」，不是「长什么样」。",
    kinds: ["image"],
    source: "第 46 行 poses",
  },
  "subject.motion": {
    id: "subject.motion",
    tag: "Subject",
    zh: "动作/表情",
    hint: "从视频或图里取动作、表情。★ 官方第 88 行：这类仍属 Subject，不是 Video。",
    kinds: ["image", "video"],
    source: "第 46 行 actions, expressions + 第 88 行",
  },

  /* ── Picture：目标帧与分镜 ───────────────────────────────── */
  "picture.first": {
    id: "picture.first",
    tag: "Picture",
    zh: "首帧",
    hint: "这一镜从这张图开始。",
    kinds: ["image"],
    source: "第 62 行 first frame",
  },
  "picture.key": {
    id: "picture.key",
    tag: "Picture",
    zh: "关键帧",
    hint: "这一镜中间某个时刻的画面。",
    kinds: ["image"],
    source: "第 62 行 keyframe",
  },
  "picture.last": {
    id: "picture.last",
    tag: "Picture",
    zh: "尾帧",
    hint: "这一镜结束在这张图。",
    kinds: ["image"],
    source: "第 62 行 last frame",
  },
  "picture.storyboard": {
    id: "picture.storyboard",
    tag: "Picture",
    zh: "分镜图",
    hint: "多镜的规划参考，定的是机位、主体位置、镜头顺序。",
    kinds: ["image"],
    source: "第 72-73 行 storyboard reference",
  },
  "picture.anchor": {
    id: "picture.anchor",
    tag: "Picture",
    zh: "构图锚点",
    hint: "只定构图，不定具体是第几帧。",
    kinds: ["image"],
    source: "第 62 行 composition anchor",
  },

  /* ── Video：结构来源 ─────────────────────────────────────── */
  "video.source": {
    id: "video.source",
    tag: "Video",
    zh: "原视频（编辑/续接）",
    hint: "要编辑这条视频，或从它末尾接着往下拍。",
    kinds: ["video"],
    source: "第 78-80 行 editing source / continuation",
  },
  "video.structure": {
    id: "video.structure",
    tag: "Video",
    zh: "运镜/剪辑/节奏",
    hint: "只借它的运镜、剪辑节奏或整体时序，不借画面内容。",
    kinds: ["video"],
    source: "第 82 行 camera movement, cuts, rhythm, temporal structure",
  },

  /* ── Audio：音频 ─────────────────────────────────────────── */
  "audio.timbre": {
    id: "audio.timbre",
    tag: "Audio",
    zh: "音色",
    hint: "说话人的音色与表达方式。",
    kinds: ["audio"],
    source: "第 96 行 voice timbre and delivery",
  },
  "audio.dialogue": {
    id: "audio.dialogue",
    tag: "Audio",
    zh: "对白/歌词",
    hint: "要复用的对白、歌词或音效内容。",
    kinds: ["audio"],
    source: "第 97 行 dialogue, lyrics, sound effects",
  },
  "audio.music": {
    id: "audio.music",
    tag: "Audio",
    zh: "BGM 风格",
    hint: "背景音乐的风格参考。",
    kinds: ["audio"],
    source: "第 95 行 background-music style",
  },
  "audio.sfx": {
    id: "audio.sfx",
    tag: "Audio",
    zh: "音效",
    hint: "具体音效的复制。",
    kinds: ["audio"],
    source: "第 97 行 sound effects",
  },
  "audio.rhythm": {
    id: "audio.rhythm",
    tag: "Audio",
    zh: "节拍/节奏",
    hint: "只借节拍与节奏，不借音色。",
    kinds: ["audio"],
    source: "第 98 行 beat, rhythm, audio continuity",
  },
};

/** 默认角色（按素材类型给最保守的那个）。 */
const DEFAULT_BY_KIND = {
  image: "subject.character",   // 图片默认只定长相，不抢占 Picture 编号
  video: "subject.motion",      // 视频默认只取动作，不抢占 Video 编号
  audio: "audio.timbre",
};

/**
 * 按素材 kind 给出可选角色（不让用户选不可能的）。
 * @param {string} kind image | video | audio
 * @returns {Array} REF_ROLES 的子集
 */
export function rolesForKind(kind) {
  const k = String(kind ?? "image");
  return Object.values(REF_ROLES).filter((r) => r.kinds.includes(k));
}

/** 取某个 kind 的默认角色 id。 */
export function defaultRoleFor(kind) {
  return DEFAULT_BY_KIND[String(kind ?? "image")] ?? "subject.character";
}

/** 由角色 id 取标签（Subject/Picture/Video/Audio）。 */
export function tagOfRole(roleId) {
  return REF_ROLES[roleId]?.tag ?? "Subject";
}

/** 兼容旧数据：把旧的 4 个 role 映射到新的细分。 */
export function migrateLegacyRole(legacy, kind) {
  switch (legacy) {
    case "frame": return "picture.first";
    case "appearance": return String(kind) === "video" ? "subject.motion" : "subject.character";
    case "motion": return "subject.motion";
    case "sound": return "audio.timbre";
    default: return defaultRoleFor(kind);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   三 · 生成 subject_definitions（六节里的第一节）
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 按官方规则生成 subject_definitions 的骨架。
 *
 * @param {Array<{slot:string, name:string, kind:string, role:string, note?:string}>} refs
 * @returns {{lines:string[], warnings:string[], counters:object, bySlot:object}}
 */
export function buildSubjectDefinitions(refs) {
  const warnings = [];
  const counters = { Subject: 0, Picture: 0, Video: 0, Audio: 0 };
  const lines = [];
  const bySlot = {};

  // 按标签分组
  const groups = { Subject: [], Picture: [], Video: [], Audio: [] };
  for (const r of refs) {
    // 旧数据兜底
    const role = REF_ROLES[r.role] ? r.role : migrateLegacyRole(r.role, r.kind);
    const tag = tagOfRole(role);
    groups[tag].push({ ...r, __role: role });
  }

  // ── ① Subject：一个主体一条，多个资产可并进同一条 ──
  //
  // 官方第 48 行：一个 subject 可由多个资产定义，一个资产可提供多个 subject。
  // 当前没有「主体 id」的概念，所以先按「一个角色 = 一条」处理：
  //   同一 subjectId 的多张图合并成一条；没有 subjectId 的各自成条。
  const subjectByKey = new Map();
  for (const s of groups.Subject) {
    const roleMeta = REF_ROLES[s.__role];
    const key = s.subjectId || `__${s.slot}`;
    if (!subjectByKey.has(key)) subjectByKey.set(key, []);
    subjectByKey.get(key).push({ ...s, __roleMeta: roleMeta });
  }
  for (const [, list] of subjectByKey) {
    counters.Subject += 1;
    const n = counters.Subject;
    const tag = `<Subject ${n}>`;
    for (const it of list) {
      it.__tag = tag;
      bySlot[it.slot] = tag;
    }
    // 合并描述：外观来自 A，动作来自 B ...
    const first = list[0];
    const facets = list.map((it) => {
      const m = it.__roleMeta;
      const src = it.note ? `${it.note}` : (it.name || it.slot);
      return `${m.zh}来自 ${src}`;
    });
    lines.push(`${tag} is the subject whose ${facets.join("；")}.`);
  }

  // ── ② Picture：单独占编号（必须是帧/分镜/锚点）──
  for (const p of groups.Picture) {
    counters.Picture += 1;
    const n = counters.Picture;
    const tag = `<Picture ${n}>`;
    p.__tag = tag;
    bySlot[p.slot] = tag;
    const meta = REF_ROLES[p.__role];
    const src = p.note || p.name || p.slot;

    if (p.__role === "picture.storyboard") {
      // 官方的分镜写法（第 72-73 行）
      lines.push(
        `${tag} is a storyboard reference for [Shot 1], showing ${src}, ` +
        `defining its viewpoint, subject placement, and shot order.`
      );
    } else {
      lines.push(`${tag} is the ${meta.zh} of [Shot 1], showing ${src}.`);
    }
  }

  // ── ③ Video：编号独立（官方第 110 行）──
  for (const v of groups.Video) {
    counters.Video += 1;
    const n = counters.Video;
    const tag = `<Video ${n}>`;
    v.__tag = tag;
    bySlot[v.slot] = tag;
    const src = v.note || v.name || v.slot;
    if (v.__role === "video.source") {
      lines.push(`${tag} is the source video for the target video edit (${src}).`);
    } else {
      lines.push(
        `${tag} provides the camera movement, cuts, rhythm and temporal structure reference (${src}).`
      );
    }
  }

  // ── ④ Audio：编号独立于 Video ──
  for (const a of groups.Audio) {
    counters.Audio += 1;
    const n = counters.Audio;
    const tag = `<Audio ${n}>`;
    a.__tag = tag;
    bySlot[a.slot] = tag;
    const meta = REF_ROLES[a.__role];
    const src = a.note || a.name || a.slot;

    if (a.__role === "audio.timbre") {
      // 官方第 103 行的写法：<Audio 1> is the voice-timbre reference for <Subject 1> (S1).
      // 只有明确对应某个说话人时才带 (Sx)，这里没有说话人数据，先不带。
      lines.push(`${tag} is the voice-timbre reference for <Subject 1> (${src}).`);
    } else {
      lines.push(`${tag} provides the ${meta.zh} reference (${src}).`);
    }
  }

  // ── ⑤ 警告（按新分类重写）──
  const picCount = groups.Picture.length;
  const subjCount = groups.Subject.length;
  const vidCount = groups.Video.length;
  const audCount = groups.Audio.length;

  if (picCount === 0 && subjCount > 0) {
    // 旧实现的警告是「所有图片都被标成外观」，措辞会误导 ——
    // 官方规则下「只定外观」是【完全合法】的用法，不是错误。
    // 真正该提示的是：如果你想让它当帧，得改用途。
    /**
     * ★ 2026-10-21 重写：说人话。
     *   旧文案开头就抛 <Picture>，用户不知道那是什么；
     *   而且「不会成为某一镜的首帧或关键帧」是双重否定。
     */
    warnings.push(
      "现在引用的图只用来定「长什么样」，没有哪张被指定成某一镜的开头画面。" +
      "想让某一镜从某张图开始，把那张图的用途改成「首帧」。"
    );
  }
  if (picCount > 0 && subjCount === 0 && vidCount === 0) {
    warnings.push(
      "只指定了画面，没有指定人物或场景长什么样。" +
      "多个镜头之间可能对不上，每个镜头都长得不一样。"
    );
  }
  if (groups.Subject.some((s) => REF_ROLES[s.__role]?.id === "subject.motion") && subjCount === 1) {
    warnings.push(
      "给了动作参考，但没给人物长相 —— 动作能对上，人物会变成另一个人。" +
      "建议再引一张用途为「角色外观」的图。"
    );
  }
  // 官方没写数量上限；这条只是「合并建议」，不是规则。
  if (subjCount > 3) {
    warnings.push(
      `已经有 ${subjCount} 个主体。官方规则是一个主体一条，` +
      "超过 3 个时多半是同一个人/物件的不同角度，应该合并成一条。"
    );
  }
  // ★ 官方第 112 行：带音轨的视频不自动产生 <Audio N>
  if (vidCount > 0 && audCount === 0) {
    const vidsWithAudio = groups.Video.filter((v) => v.hasAudio);
    if (vidsWithAudio.length) {
      warnings.push(
        `有 ${vidsWithAudio.length} 段参考视频自带声音，但参考视频不会自动带上音轨。` +
        "要用这些声音，请另外引一段音频并标上用途。"
      );
    }
  }

  return { lines, warnings, counters, bySlot };
}

/**
 * 给每个素材打上标签（不修改入参，返回新表）。
 * @returns {{bySlot: Record<string,string>, lines: string[], warnings: string[]}}
 */
export function tagReferences(refs) {
  const { lines, warnings, bySlot } = buildSubjectDefinitions(
    (refs ?? []).map((r) => ({ ...r }))
  );
  return { bySlot, lines, warnings };
}
