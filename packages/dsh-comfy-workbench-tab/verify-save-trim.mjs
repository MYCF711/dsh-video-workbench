/**
 * 裁切写回验收（2026-10-20）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这份验收的核心
 *
 *   ArtCraft 的 saveProject 拿到的是它自己改完的 TProject。
 *   如果直接覆盖 timeline-state：
 *     · shot（这一镜的生成配方）会消失
 *     · handoff（谁锁了 prompt）会消失
 *     · rendered 会消失
 *   而且【不报错】—— 下次打开时间轴，每一镜都变成空壳。
 *
 *   ⇒ 只提交裁切与顺序，走 /timeline/cmd/edit-clip。
 *   这份验收验的就是「提交的东西对不对、不多不少」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么用注入的 post 而不是真发请求
 *
 *   真发请求就把验收变成集成测试：失败时分不清是写回逻辑错了
 *   还是服务没起、路由没注册、参数名不对。
 *   ⇒ 用假的 post 抓请求体，纯验逻辑。
 *   真链路在浏览器里单独验（见 docs 里的实测记录）。
 */

import { createTrimWriter } from "./src/editor/saveTrim.js";

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
console.log("  裁切/顺序写回（ArtCraft → /timeline/cmd/edit-clip）");
console.log("═".repeat(66));

/** 造一个抓请求的假 post。 */
function makePost() {
  const calls = [];
  const post = async (url, body) => {
    calls.push({ url, body });
    return { ok: true };
  };
  return { post, calls };
}

const quietLog = { info() {}, warn() {} };

/* ─── ① 时间换算 ────────────────────────────────────────── */
console.log("\n① MediaTime → 秒（ArtCraft 用分数表示时间）");
{
  const { post, calls } = makePost();
  const save = createTrimWriter({ post, log: quietLog });
  await save({
    video: [{
      id: "c1",
      trimStart: { numerator: 500, denominator: 1000 },   // 0.5 秒
      trimEnd: { numerator: 2250, denominator: 1000 },    // 2.25 秒
    }],
    audio: [],
  });
  const trim = calls.find((c) => c.body.op === "trim");
  t("发出了一条 trim 请求", !!trim, calls.map((c) => c.body.op));
  t("startSec = 0.5", trim?.body.trim.startSec === 0.5, trim?.body.trim);
  t("endSec = 2.25", trim?.body.trim.endSec === 2.25, trim?.body.trim);
  t("URL 正确", trim?.url === "/timeline/cmd/edit-clip", trim?.url);
  t("带 clipId", trim?.body.clipId === "c1");
}

/* ─── ② ★ 只提交裁切与顺序，不夹带其它字段 ─────────────── */
console.log("\n② ★ 只提交裁切与顺序（不许夹带 shot / handoff）");
{
  const { post, calls } = makePost();
  const save = createTrimWriter({ post, log: quietLog });
  await save({
    video: [{
      id: "c1",
      trimStart: { numerator: 0, denominator: 1 },
      trimEnd: { numerator: 3, denominator: 1 },
      // 下面这些是 ArtCraft 的 element 字段，绝不能传
      mediaId: "output:xxx.png",
      type: "video",
      name: "分镜 1",
      duration: { numerator: 3, denominator: 1 },
      params: {},
    }],
    audio: [],
  });

  const trimCalls = calls.filter((c) => c.body.op === "trim");
  const body = trimCalls[0]?.body ?? {};
  const allowed = new Set(["clipId", "op", "trim"]);
  const extra = Object.keys(body).filter((k) => !allowed.has(k));
  t("trim 请求体只有 clipId / op / trim", extra.length === 0, extra);

  /**
   * ★★ 最关键：传给「trim」的 trim 对象里，只允许 startSec / endSec。
   *   如果我们把整个 element 塞进 trim，dsh-editor 的 store.setTrim
   *   会把 element 的字段当 trim 数据写进 timeline-state ——
   *   那等于把 ArtCraft 的模型泄漏进我们的真相。
   */
  const trimKeys = Object.keys(body.trim ?? {});
  t("trim 只有 startSec / endSec", trimKeys.sort().join(",") === "endSec,startSec", trimKeys);
}

/* ─── ③ 空数据不打扰后端 ────────────────────────────────── */
console.log("\n③ 空数据不发请求（避免无意义的写盘）");
{
  const { post, calls } = makePost();
  const save = createTrimWriter({ post, log: quietLog });
  const r = await save({ video: [], audio: [] });
  t("没有片段时不发请求", calls.length === 0, calls.length);
  t("返回 ok", r?.ok === true, r);
}

/* ─── ④ 音频轨 ──────────────────────────────────────────── */
console.log("\n④ 音频轨的裁切也要提交");
{
  const { post, calls } = makePost();
  const save = createTrimWriter({ post, log: quietLog });
  await save({
    video: [],
    audio: [{
      id: "a1",
      trimStart: { numerator: 1, denominator: 1 },
      trimEnd: { numerator: 4, denominator: 1 },
    }],
  });
  const trim = calls.find((c) => c.body.op === "trim");
  t("音频也发了 trim", !!trim, calls.map((c) => c.body.clipId));
  t("audio 的 clipId 对", trim?.body.clipId === "a1");
}

/* ─── ⑤ 单条失败不中断整批 ──────────────────────────────── */
console.log("\n⑤ 单条失败不中断整批（用户删了某个 clip 时不能全崩）");
{
  const calls = [];
  let n = 0;
  const post = async (url, body) => {
    calls.push({ url, body });
    n++;
    // 第二条失败
    if (body.clipId === "c2" && body.op === "trim") {
      throw new Error("找不到 clipId c2");
    }
    return { ok: true };
  };
  const save = createTrimWriter({ post, log: quietLog });

  let threw = null;
  try {
    await save({
      video: [
        { id: "c1", trimStart: { numerator: 0, denominator: 1 }, trimEnd: { numerator: 1, denominator: 1 } },
        { id: "c2", trimStart: { numerator: 0, denominator: 1 }, trimEnd: { numerator: 1, denominator: 1 } },
        { id: "c3", trimStart: { numerator: 0, denominator: 1 }, trimEnd: { numerator: 1, denominator: 1 } },
      ],
      audio: [],
    });
  } catch (e) { threw = String(e?.message ?? e); }

  const trimIds = calls.filter((c) => c.body.op === "trim").map((c) => c.body.clipId);
  t("c1 和 c3 仍然提交了（没被 c2 拖停）",
    trimIds.includes("c1") && trimIds.includes("c3"), trimIds);
  t("最终抛错（告知用户有失败）", !!threw, threw);
  t("错误信息里点了失败的 id", (threw ?? "").includes("c2"), threw);
}

/* ─── ⑥ 顺序写回 ────────────────────────────────────────── */
console.log("\n⑥ 顺序写回用 op=move + toIndex");
{
  const { post, calls } = makePost();
  const save = createTrimWriter({ post, log: quietLog });
  await save({
    video: [
      { id: "a", trimStart: { numerator: 0, denominator: 1 }, trimEnd: { numerator: 1, denominator: 1 } },
      { id: "b", trimStart: { numerator: 0, denominator: 1 }, trimEnd: { numerator: 1, denominator: 1 } },
    ],
    audio: [],
  });
  const moves = calls.filter((c) => c.body.op === "move");
  t("发了 move 请求", moves.length === 2, moves.length);
  t("a → toIndex 0", moves.find((m) => m.body.clipId === "a")?.body.toIndex === 0);
  t("b → toIndex 1", moves.find((m) => m.body.clipId === "b")?.body.toIndex === 1);
}

/* ─── ⑦ 浮点噪声 ────────────────────────────────────────── */
console.log("\n⑦ 浮点噪声要收掉（0.30000000000000004 → 0.3）");
{
  const { post, calls } = makePost();
  const save = createTrimWriter({ post, log: quietLog });
  await save({
    video: [{
      id: "x",
      trimStart: { numerator: 30000000000000004, denominator: 100000000000000000 },
      trimEnd: { numerator: 1, denominator: 3 },
    }],
    audio: [],
  });
  const trim = calls.find((c) => c.body.op === "trim")?.body.trim;
  t("startSec 是 3 位小数内的干净数",
    String(trim?.startSec ?? "").length <= 6, trim?.startSec);
  t("endSec 是 0.333", trim?.endSec === 0.333, trim?.endSec);
}

/* ─── ⑧ 坏输入 ──────────────────────────────────────────── */
console.log("\n⑧ 坏输入不崩");
{
  const { post, calls } = makePost();
  const save = createTrimWriter({ post, log: quietLog });
  const r1 = await save({ video: null, audio: undefined });
  t("null / undefined 不崩", r1?.ok === true, r1);
  t("也不发请求", calls.length === 0);

  const r2 = await save({});
  t("空对象不崩", r2?.ok === true);
}

/* ─── 汇总 ─────────────────────────────────────────────── */
console.log("\n" + "═".repeat(66));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  裁切写回全过（只提交 trim 与顺序，不夹带其它字段）");

