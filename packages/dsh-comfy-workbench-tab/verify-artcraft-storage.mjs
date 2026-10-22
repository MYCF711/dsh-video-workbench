/**
 * projectStorage 后端验收（2026-10-20）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这份验收的核心只有一条
 *
 *   ★★ saveProject 拿到的是 ArtCraft 改完的 TProject。
 *      如果直接把它当新真相写盘，我们的 shot / handoff / rendered
 *      会全部消失，而且【不报错】。
 *
 *   所以 70% 的断言都在验：走一遍完整保存流程后，
 *   那些 ArtCraft 模型里不存在的字段还在不在。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么用假的 store / persister
 *
 *   真实 store 在 dsh-editor 里，跨插件引用会把验收搞成集成测试，
 *   失败时也看不出是 storage 的问题还是 store 的问题。
 *   ⇒ 用最小假件，只实现被调用的方法，行为可控、失败可定位。
 */

import { createProjectStorage, SINGLE_PROJECT_ID } from "./src/artcraft-storage.mjs";

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else {
    fail++; failures.push(name);
    console.log(`  ❌ ${name}${extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 240) : ""}`);
  }
}

console.log("═".repeat(66));
console.log("  projectStorage 后端（ArtCraft 存工程 → 我们的 timeline-state）");
console.log("═".repeat(66));

/* ─── 最小假件 ──────────────────────────────────────────── */
function makeStore(initial) {
  let state = JSON.parse(JSON.stringify(initial));
  return {
    snapshot: () => JSON.parse(JSON.stringify(state)),
    _replace: (s) => { state = s; },
    _peek: () => state,
  };
}

function makePersister() {
  const calls = { flush: 0, load: 0 };
  return {
    flush: () => { calls.flush++; },
    load: async () => { calls.load++; return { ok: true }; },
    file: "fake.json",
    isPending: () => false,
    _calls: calls,
  };
}

/* 真实存档形状（含 shot / handoff / rendered） */
const CLIP = {
  id: "c_1", kind: "video", name: "分镜 1",
  src: "Krea2-USD-20261018_00008_.png",
  in: 0, out: 5, speed: 1, crop: null, gain: 1,
  trim: { startSec: 1, endSec: 3 },
  shot: {
    modeId: "yz", prompt: "人定的提示词", aspect: "16:9",
    durationSec: 5, steps: null, seed: null, toggles: {}, media: {}, history: [],
  },
  rendered: {
    path: "D:\\x\\yz-result.mp4", url: null, filename: "yz-result.mp4",
    durationSec: null, generatedAt: 1792248820967, replaced: true,
  },
  regenError: null,
  fromVideoClipId: null,
  handoff: {
    locks: { prompt: { by: "user", at: 1792328783069, fp: "316869238" } },
    log: [{ at: 1792328783069, by: "user", field: "prompt", fp: "316869238" }],
  },
};

const STATE = {
  version: 1, savedAt: 1792000000000, fps: 24,
  name: "未命名粗剪", nextShotIndex: 2,
  tracks: [
    { id: "t_v", kind: "video", name: "视频 1", clips: [JSON.parse(JSON.stringify(CLIP))] },
    { id: "t_a", kind: "audio", name: "音频 1", clips: [] },
  ],
};

/* ─── ① 接口完整性 ──────────────────────────────────────── */
console.log("\n① 接口完整性（ArtCraft 的 5 个方法一个不能少）");
let storage, store, persister;
{
  store = makeStore(STATE);
  persister = makePersister();
  storage = createProjectStorage({
    store, persister,
    log: { info() {}, warn() {} },
    replaceState: (s) => store._replace(s),
  });
  for (const m of ["loadProject", "saveProject", "deleteProject", "listProjects", "createProject"]) {
    t(`有 ${m}()`, typeof storage[m] === "function", typeof storage[m]);
  }
  t("缺 store 时构造就报错（不静默）", (() => {
    try { createProjectStorage({ persister }); return false; } catch { return true; }
  })());
}

/* ─── ② loadProject ─────────────────────────────────────── */
console.log("\n② loadProject");
{
  const p = await storage.loadProject(SINGLE_PROJECT_ID);
  t("返回 EditorProject", !!p);
  t("id 是单工程 id", p?.id === SINGLE_PROJECT_ID);
  t("name 来自 state.name", p?.name === "未命名粗剪", p?.name);
  t("updatedAt 是数字", typeof p?.updatedAt === "number");
  t("data 是 TProject（有 scenes）", Array.isArray(p?.data?.scenes), p?.data?.scenes?.length);
  t("data.settings.fps 是分数", p?.data?.settings?.fps?.numerator === 24);

  const el = p?.data?.scenes?.[0]?.tracks?.main?.elements?.[0];
  t("clip 投影成了 element", !!el);
  t("element.mediaId = 我们的资产 id",
    el?.mediaId === "output:Krea2-USD-20261018_00008_.png", el?.mediaId);

  // 不存在的 id 要返回 null，不能编一个
  t("未知 id 返回 null", (await storage.loadProject("nope")) === null);
}

/* ─── ③ ★★ 最危险的一条：saveProject 不许丢我们的字段 ── */
console.log("\n③ ★★ saveProject：shot / handoff / rendered 必须全部保住");
{
  const before = store._peek();
  const origClip = before.tracks[0].clips[0];

  // 模拟 ArtCraft 改了裁切
  const p = await storage.loadProject(SINGLE_PROJECT_ID);
  const el = p.data.scenes[0].tracks.main.elements[0];
  /**
   * ★★ 2026-10-20：MediaTime 是整数 tick（120000/秒），不是 {numerator,denominator}
   *   0.5 秒 = 60000 tick，2.25 秒 = 270000 tick
   */
  el.trimStart = 60000;
  el.trimEnd = 270000;

  const flushBefore = persister._calls.flush;
  await storage.saveProject(p);

  const after = store._peek();
  const c = after.tracks[0].clips[0];

  t("trim.startSec 更新成 0.5", c.trim.startSec === 0.5, c.trim.startSec);
  t("trim.endSec 更新成 2.25", c.trim.endSec === 2.25, c.trim.endSec);
  t("保存后调了 flush（显式保存要立刻落盘）",
    persister._calls.flush === flushBefore + 1, persister._calls.flush);

  /**
   * ★★ 核心断言：三个「ArtCraft 不认识」的字段必须一字不差。
   */
  t("shot 完全保留", JSON.stringify(c.shot) === JSON.stringify(origClip.shot),
    { before: origClip.shot?.modeId, after: c.shot?.modeId });
  t("handoff 完全保留", JSON.stringify(c.handoff) === JSON.stringify(origClip.handoff),
    { before: !!origClip.handoff, after: !!c.handoff });
  t("rendered 完全保留", JSON.stringify(c.rendered) === JSON.stringify(origClip.rendered));
  t("shot.prompt 还是原来那句", c.shot?.prompt === "人定的提示词", c.shot?.prompt);
  t("handoff.locks.prompt.by 还是 user", c.handoff?.locks?.prompt?.by === "user");
  t("rendered.replaced 还是 true", c.rendered?.replaced === true);

  // 其余 clip 字段也不能变
  const untouched = ["id", "kind", "name", "src", "in", "out", "speed", "crop", "gain"];
  const diff = untouched.filter((k) => JSON.stringify(c[k]) !== JSON.stringify(origClip[k]));
  t("其余字段（id/src/in/out/…）不变", diff.length === 0, diff);
}

/* ─── ④ 无改动时不写盘 ──────────────────────────────────── */
console.log("\n④ 无改动时不写盘（避免无谓 IO 与 mtime 变化）");
{
  const p = await storage.loadProject(SINGLE_PROJECT_ID);
  const flushBefore = persister._calls.flush;
  const snapBefore = JSON.stringify(store._peek());
  await storage.saveProject(p);
  t("没有改动时不 flush", persister._calls.flush === flushBefore, persister._calls.flush);
  t("state 完全没变", JSON.stringify(store._peek()) === snapBefore);
}

/* ─── ⑤ 坏输入 ──────────────────────────────────────────── */
console.log("\n⑤ 坏输入要拒绝，不能把存档搞坏");
{
  const snapBefore = JSON.stringify(store._peek());
  await storage.saveProject({ id: "other", data: {} });
  t("非本工程的 id 被忽略", JSON.stringify(store._peek()) === snapBefore);

  await storage.saveProject({ id: SINGLE_PROJECT_ID, data: { scenes: "不是数组" } });
  t("data.scenes 不是数组时被忽略", JSON.stringify(store._peek()) === snapBefore);

  await storage.saveProject(null);
  t("null 不崩也不改 state", JSON.stringify(store._peek()) === snapBefore);
}

/* ─── ⑥ 没有 replaceState 时要诚实 warn，不许假装成功 ── */
console.log("\n⑥ 缺 replaceState 时必须 warn（不许假装保存成功）");
{
  const warns = [];
  const s2 = createProjectStorage({
    store: makeStore(STATE), persister: makePersister(),
    log: { info() {}, warn: (...a) => warns.push(a.join(" ")) },
    // 故意不给 replaceState
  });
  const p = await s2.loadProject(SINGLE_PROJECT_ID);
  const el = p.data.scenes[0].tracks.main.elements[0];
  el.trimStart = { numerator: 100, denominator: 1000 };
  await s2.saveProject(p);
  t("确实 warn 了", warns.length > 0, warns);
  t("warn 里说明了需要 replaceState",
    warns.some((w) => w.includes("replaceState")), warns);
}

/* ─── ⑦ listProjects 只报 1 个 ─────────────────────────── */
console.log("\n⑦ listProjects：只报一个工程（契约诚实，不假装支持多工程）");
{
  const list = await storage.listProjects();
  t("正好 1 个", list.length === 1, list.length);
  t("id 正确", list[0].id === SINGLE_PROJECT_ID);
  t("带 clipCount", typeof list[0].clipCount === "number", list[0].clipCount);
  t("clipCount 数得对（1 段）", list[0].clipCount === 1, list[0].clipCount);
}

/* ─── ⑧ createProject ──────────────────────────────────── */
console.log("\n⑧ createProject：重置当前存档，返回可编辑的空工程");
{
  const s3 = makeStore(STATE);
  const s3st = createProjectStorage({
    store: s3, persister: makePersister(),
    log: { info() {}, warn() {} },
    replaceState: (x) => s3._replace(x),
  });
  const p = await s3st.createProject("新片子");
  t("返回的工程 name 是新的", p.name === "新片子", p.name);
  t("返回的 data 有 scenes", Array.isArray(p.data?.scenes));
  t("新工程没有 elements", p.data.scenes[0].tracks.main.elements.length === 0);
  t("store 里的 clips 被清空", s3._peek().tracks[0].clips.length === 0);
  t("fps 沿用原来的", s3._peek().fps === 24);
}

/* ─── ⑨ deleteProject 不删文件 ─────────────────────────── */
console.log("\n⑨ deleteProject：只清 clips，不删存档（不可复原的操作要转成可复原）");
{
  const s4 = makeStore(STATE);
  const s4st = createProjectStorage({
    store: s4, persister: makePersister(),
    log: { info() {}, warn() {} },
    replaceState: (x) => s4._replace(x),
  });
  await s4st.deleteProject(SINGLE_PROJECT_ID);
  const after = s4._peek();
  t("clips 被清空", after.tracks[0].clips.length === 0);
  t("轨道结构还在（2 条）", after.tracks.length === 2, after.tracks.length);
  t("工程名还在（不是整个抹掉）", after.name === "未命名粗剪", after.name);
}

/* ─── 汇总 ─────────────────────────────────────────────── */
console.log("\n" + "═".repeat(66));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  projectStorage 后端全过（shot / handoff / rendered 一个都没丢）");
