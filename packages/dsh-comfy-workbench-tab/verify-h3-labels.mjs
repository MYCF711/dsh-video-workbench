/**
 * H3 参考标签体系验收（2026-10-20 重写）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 被验收的对象：src/h3-labels.js
 * 唯一权威：<HOME>\.agents\skills\h3-prompt-writing\references\ref-en.txt
 *           （H3 官方 Full-Reference Mode 指南，341 行）
 * 推导记录：docs\H3-参考标签体系-20261020.md
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么重写
 *
 *   旧验收写死了「有 frame/appearance/motion/sound 四种」，
 *   而那四种本身是错的（见 docs 第二、三节）：
 *     · appearance 把角色/物品/场景/服装/风格/姿势混成一类
 *     · motion 被当成 <Video N>，但官方第 88 行说它仍属 <Subject N>
 *     · 缺 storyboard（分镜图），官方第 72 行专门有规则
 *
 *   ⇒ 旧验收不是「过期」，是「在验证一个错误的设计」。
 *     这类断言比没有断言更危险 —— 它给了虚假的绿色。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 检查项：
 *   ① 四个标签齐全且与官方定义一致
 *   ② 每个细分角色只映射到一个标签
 *   ③ 官方第 68 行：Subject 类不许单独开 <Picture N>
 *   ④ 官方第 88 行：从视频取动作 → Subject，不是 Video
 *   ⑤ 官方第 110/112 行：Video 与 Audio 编号独立；带音轨的视频不自动产生 Audio
 *   ⑥ 官方第 48 行：一个 Subject 可由多个资产定义
 *   ⑦ 分镜图走 <Picture N> 且用官方的 storyboard 句式
 *   ⑧ 旧 role 名能被迁移
 *   ⑨ 警告按新分类重写（「只定外观」是合法用法，不该报警）
 *
 * 用法：node verify-h3-labels.mjs
 */

import {
  H3_TAGS, REF_ROLES, rolesForKind, defaultRoleFor, tagOfRole,
  migrateLegacyRole, buildSubjectDefinitions, tagReferences,
} from "./src/h3-labels.js";

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  ❌ ${name}${extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 160) : ""}`);
  }
}

console.log("═".repeat(66));
console.log("  H3 参考标签体系验收（对齐官方 ref-en.txt）");
console.log("═".repeat(66));

/* ─── ① 四个标签 ─────────────────────────────────────────── */
console.log("\n① 四个标签（官方第 26-33 行）");
{
  const ids = Object.keys(H3_TAGS);
  t("恰好四个标签", ids.length === 4, ids);
  t("是 Subject/Picture/Video/Audio",
    ["Subject", "Picture", "Video", "Audio"].every((k) => ids.includes(k)), ids);
  t("每个标签都带官方英文定义",
    Object.values(H3_TAGS).every((x) => typeof x.official === "string" && x.official.length > 20));
  t("Subject 标记了 neverStandalonePicture", H3_TAGS.Subject.neverStandalonePicture === true);
  t("Picture 没有该标记", H3_TAGS.Picture.neverStandalonePicture === false);
}

/* ─── ② 每个细分只映射一个标签 ───────────────────────────── */
console.log("\n② 细分角色 → 唯一标签");
{
  const roles = Object.values(REF_ROLES);
  t("细分角色数量 ≥ 15", roles.length >= 15, roles.length);
  const badTag = roles.filter((r) => !H3_TAGS[r.tag]);
  t("每个角色的 tag 都在四标签内", badTag.length === 0, badTag.map((r) => `${r.id}→${r.tag}`));
  t("tag 是单个字符串而不是数组",
    roles.every((r) => typeof r.tag === "string" && !r.tag.includes(",")));
  const badPrefix = roles.filter((r) => !r.id.startsWith(r.tag.toLowerCase() + "."));
  t("id 前缀与 tag 对应（subject./picture./video./audio.）",
    badPrefix.length === 0, badPrefix.map((r) => r.id));
  const noSource = roles.filter((r) => !r.source);
  t("每个角色都注明了官方行号依据", noSource.length === 0, noSource.map((r) => r.id));
}

/* ─── ③ 官方第 68 行：Subject 不许单独开 Picture ─────────── */
console.log("\n③ Subject 类不占 Picture 编号（官方第 68 行）");
{
  const r = tagReferences([
    { slot: "a", name: "girl.png", kind: "image", role: "subject.character" },
    { slot: "b", name: "sword.png", kind: "image", role: "subject.object" },
    { slot: "c", name: "room.png", kind: "image", role: "subject.scene" },
  ]);
  t("三张外观图都拿到 <Subject N>",
    [r.bySlot.a, r.bySlot.b, r.bySlot.c].every((v) => v && v.startsWith("<Subject")), r.bySlot);
  t("没有任何 <Picture> 编号被占用",
    Object.values(r.bySlot).every((v) => !v.startsWith("<Picture")), r.bySlot);
  t("生成 3 条 Subject 定义", r.lines.filter((l) => l.includes("<Subject")).length === 3, r.lines.length);
}

/* ─── ④ 官方第 88 行：视频取动作仍是 Subject ─────────────── */
console.log("\n④ 视频取动作 → Subject，不是 Video（官方第 88 行）");
{
  t("subject.motion 的 tag 是 Subject", REF_ROLES["subject.motion"].tag === "Subject");
  const r = tagReferences([
    { slot: "v", name: "walk.mp4", kind: "video", role: "subject.motion" },
  ]);
  t("walk.mp4 拿到的是 <Subject 1> 而不是 <Video 1>", r.bySlot.v === "<Subject 1>", r.bySlot);
  const r2 = tagReferences([
    { slot: "v2", name: "src.mp4", kind: "video", role: "video.source" },
  ]);
  t("video.source 才拿 <Video 1>", r2.bySlot.v2 === "<Video 1>", r2.bySlot);
}

/* ─── ⑤ 官方第 110/112 行：编号独立 ──────────────────────── */
console.log("\n⑤ Video 与 Audio 编号独立（官方第 110/112 行）");
{
  const r = tagReferences([
    { slot: "v", name: "a.mp4", kind: "video", role: "video.source", hasAudio: true },
    { slot: "a", name: "b.wav", kind: "audio", role: "audio.timbre" },
  ]);
  t("Video 编号从 1 开始", r.bySlot.v === "<Video 1>", r.bySlot);
  t("Audio 编号也从 1 开始（不受 Video 影响）", r.bySlot.a === "<Audio 1>", r.bySlot);

  const r2 = buildSubjectDefinitions([
    { slot: "v", name: "a.mp4", kind: "video", role: "video.source", hasAudio: true },
  ]);
  t("带音轨的视频不自动产生 <Audio>",
    r2.lines.every((l) => !l.includes("<Audio")), r2.lines);
  t("但会给出「要不要用它的音轨」的提示",
    r2.warnings.some((w) => w.includes("音轨")), r2.warnings);
}

/* ─── ⑥ 官方第 48 行：一个 Subject 多个资产 ─────────────── */
console.log("\n⑥ 一个 Subject 可由多个资产定义（官方第 48 行）");
{
  const r = buildSubjectDefinitions([
    { slot: "a", name: "face.png", kind: "image", role: "subject.character", subjectId: "hanli" },
    { slot: "b", name: "walk.mp4", kind: "video", role: "subject.motion", subjectId: "hanli" },
  ]);
  t("两个资产合并成同一条 Subject",
    r.bySlot.a === r.bySlot.b && r.bySlot.a === "<Subject 1>", r.bySlot);
  t("只产生一条 Subject 定义",
    r.lines.filter((l) => l.includes("<Subject")).length === 1, r.lines);
  t("合并后的句子同时提到外观与动作",
    r.lines[0].includes("角色外观") && r.lines[0].includes("动作"), r.lines[0]);
}

/* ─── ⑦ 分镜图 ───────────────────────────────────────────── */
console.log("\n⑦ 分镜图走 <Picture N> 且用官方句式（第 72-73 行）");
{
  const r = tagReferences([
    { slot: "s", name: "board.png", kind: "image", role: "picture.storyboard" },
  ]);
  t("拿到 <Picture 1>", r.bySlot.s === "<Picture 1>", r.bySlot);
  t("句子含 storyboard reference", r.lines[0].includes("storyboard reference"), r.lines[0]);
  t("句子含 viewpoint / subject placement / shot order",
    r.lines[0].includes("viewpoint") && r.lines[0].includes("subject placement") &&
    r.lines[0].includes("shot order"), r.lines[0]);
}

/* ─── ⑧ 旧 role 迁移 ─────────────────────────────────────── */
console.log("\n⑧ 旧 role 名迁移");
{
  t("frame → picture.first", migrateLegacyRole("frame", "image") === "picture.first");
  t("appearance(image) → subject.character",
    migrateLegacyRole("appearance", "image") === "subject.character");
  t("appearance(video) → subject.motion",
    migrateLegacyRole("appearance", "video") === "subject.motion");
  t("motion → subject.motion", migrateLegacyRole("motion", "video") === "subject.motion");
  t("sound → audio.timbre", migrateLegacyRole("sound", "audio") === "audio.timbre");
  t("未知 role 有兜底", typeof migrateLegacyRole("bogus", "image") === "string");

  const r = buildSubjectDefinitions([
    { slot: "x", name: "p.png", kind: "image", role: "appearance" },
  ]);
  t("旧 role='appearance' 仍能生成 <Subject>", r.bySlot.x?.startsWith("<Subject"), r.bySlot);
}

/* ─── ⑨ 警告按新分类 ─────────────────────────────────────── */
console.log("\n⑨ 警告（按新分类重写）");
{
  const r1 = buildSubjectDefinitions([
    { slot: "a", name: "x.png", kind: "image", role: "subject.character" },
  ]);
  /**
   * ★★ 2026-10-21 重写（主人要求「中文」，不是翻译，是说人话）
   *
   *   旧文案：「没有 <Picture>：当前所有图片都只用于定义可见内容（角色/物品/场景等），
   *            不会成为某一镜的首帧或关键帧。若你希望某一镜从某张图开始，
   *            把那张图的用途改成「首帧」。」
   *   问题：① 开头就抛内部标签名 <Picture>
   *        ② 「不会成为…」是双重否定
   *        ③ 三条信息挤一句
   *
   *   ⇒ 断言从「包含某个词」改成「表达这个意思」，
   *     并新增一条硬约束：用户文案里不许出现内部标签名。
   */
  t("只定外观时提示「没有哪张被指定成开头画面」",
    r1.warnings.some((w) => w.includes("开头画面")), r1.warnings);
  t("并且告诉用户怎么改（改成「首帧」）",
    r1.warnings.some((w) => w.includes("首帧")), r1.warnings);
  t("不再出现旧文案「所有图片都被标成角色/物体外观」",
    !r1.warnings.some((w) => w.includes("所有图片都被标成")), r1.warnings);

  const r2 = buildSubjectDefinitions([
    { slot: "f", name: "s.png", kind: "image", role: "picture.first" },
  ]);
  t("只有画面时提示「没有指定人物或场景长什么样」",
    r2.warnings.some((w) => w.includes("没") && w.includes("长什么样")), r2.warnings);

  const r3 = buildSubjectDefinitions([
    { slot: "v", name: "m.mp4", kind: "video", role: "subject.motion" },
  ]);
  t("只有动作时提示「没给人物长相」",
    r3.warnings.some((w) => w.includes("没给人物长相")), r3.warnings);

  /**
   * ★★ 硬约束：用户可见文案里【不许出现内部标签名】。
   *   Subject / Picture / Video / Audio 是 H3 的语法标记，
   *   它们出现在「用途下拉的括号里」是给用户做对应用的，
   *   但出现在警告正文里就是术语泄漏。
   */
  const allWarnings = [...r1.warnings, ...r2.warnings, ...r3.warnings];
  const internalTags = ["<Subject", "<Picture", "<Video", "<Audio"];
  const leaked = allWarnings.filter((w) => internalTags.some((tag) => w.includes(tag)));
  t("警告正文里不出现内部标签名（<Subject>/<Picture>/…）",
    leaked.length === 0, leaked);

  /**
   * ★ 每条警告不超过 80 字 —— 超过就不是一句话了，用户读不下去。
   *   （旧那条 62 字但含三重信息，所以还要看句数：句号/问号不超过 2 个）
   */
  const tooLong = allWarnings.filter((w) => w.length > 80);
  t("每条警告 ≤ 80 字", tooLong.length === 0, tooLong);
  const tooManyClauses = allWarnings.filter((w) => (w.match(/[。？]/g) || []).length > 2);
  t("每条警告不超过 2 句", tooManyClauses.length === 0, tooManyClauses);
}

/* ─── ⑩ rolesForKind / 默认值 ────────────────────────────── */
console.log("\n⑩ 按素材类型给可选角色");
{
  const imgs = rolesForKind("image");
  const vids = rolesForKind("video");
  const auds = rolesForKind("audio");
  t("图片可选 ≥ 10 种", imgs.length >= 10, imgs.length);
  t("视频可选不含 Audio/Picture 类",
    vids.every((r) => r.tag !== "Audio" && r.tag !== "Picture"), vids.map((r) => r.id));
  t("音频可选全是 Audio 类",
    auds.length > 0 && auds.every((r) => r.tag === "Audio"), auds.map((r) => r.id));
  t("默认角色按 kind 区分", defaultRoleFor("image") !== defaultRoleFor("audio"));
  t("tagOfRole 对未知 id 兜底 Subject", tagOfRole("bogus") === "Subject");
}

/* ─── 汇总 ───────────────────────────────────────────────── */
console.log("\n" + "═".repeat(66));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  H3 参考标签体系验收全过");
