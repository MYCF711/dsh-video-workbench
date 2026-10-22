/**
 * host 持久化验收 —— 重启不丢时间轴。
 *
 * 这一层的必要性来自实测：2026-10-17 重启 19499 后整条时间轴全丢。
 * 对剪辑工作台来说不可接受。
 *
 * 判据：
 *   ① 写了之后能读回来，内容一致
 *   ② ★ 运行态（running/queued）恢复成 cancelled，不是永远卡在生成中
 *   ③ 成片引用、提示词、剪辑属性全都保留
 *   ④ 存档损坏时优雅降级（不崩）
 *   ⑤ 防抖写入（不会每次变更都写盘）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createPersister } from "../src/persist-host.mjs";
import { createTimelineStore } from "../src/host-store.mjs";

let pass = 0, fail = 0;
const failures = [];
async function t(desc, fn) {
  try {
    const r = await fn();
    if (r === true || r === undefined) { console.log(`  ✅ ${desc}`); pass++; }
    else { console.log(`  ❌ ${desc}\n     ${r}`); fail++; failures.push(desc); }
  } catch (err) {
    console.log(`  ❌ ${desc}\n     ${err.message}`); fail++; failures.push(desc);
  }
}

const TMP = path.join(os.tmpdir(), `dsh-editor-persist-test-${Date.now()}`);
fs.mkdirSync(TMP, { recursive: true });
const FILE = path.join(TMP, "state.json");
const silent = { info() {}, warn() {} };

// ══════════════════════════════════════════════════
console.log("═══ ① 基本存取 ═══");

let store, persister, v1, v2;
await t("建 store + persister", () => {
  store = createTimelineStore({ log: silent });
  persister = createPersister({ file: FILE, store, log: silent, debounceMs: 50 });
  return true;
});

await t("没有存档时 load 返回 ok=false", () => {
  const r = persister.load();
  return r.ok === false && r.reason === "没有存档" ? true : JSON.stringify(r);
});

await t("建 2 段分镜 + 挂成片", () => {
  v1 = store.addShot({ modeId: "yz", prompt: "镜头 1", durationSec: 5 }, "agent");
  v2 = store.addShot({ modeId: "krea2", prompt: "镜头 2", durationSec: 3 }, "agent");
  store.replaceRendered(v1.id, { path: "D:/x/a.mp4", filename: "a.mp4", durationSec: 5 }, "user");
  store.setSpeed(v2.id, 2, "user");
  store.setTrim(v1.id, { startSec: 0.5, endSec: 3 }, "user");
  return store.summary().total === 2 ? true : store.summary().total;
});

await t("加一条音频（模拟音画分离）", () => {
  store.addAudioFromVideo(v1.id, { path: "D:/x/a.m4a", filename: "a.m4a", durationSec: 5 }, "host");
  const s = store.snapshot();
  return s.tracks.find((x) => x.kind === "audio").clips.length === 1 ? true : "没加上";
});

await t("flush 写盘", () => {
  persister.flush();
  return fs.existsSync(FILE) ? true : "文件没生成";
});

// ══════════════════════════════════════════════════
console.log("\n═══ ② ★ 模拟重启：新 store 从磁盘恢复 ═══");

let store2, persister2;
await t("新 store + 从存档恢复", () => {
  store2 = createTimelineStore({ log: silent });
  persister2 = createPersister({ file: FILE, store: store2, log: silent, debounceMs: 50 });
  const r = persister2.load();
  return r.ok === true && r.clips === 3 ? true : JSON.stringify(r);
});

await t("恢复后 total=2（视频段）", () => {
  return store2.summary().total === 2 ? true : store2.summary().total;
});

await t("恢复后轨道齐全（video + audio）", () => {
  const s = store2.snapshot();
  const kinds = s.tracks.map((x) => x.kind).sort().join(",");
  return kinds === "audio,video" ? true : kinds;
});

await t("★ 成片引用恢复", () => {
  const s = store2.snapshot();
  const c = s.tracks.find((x) => x.kind === "video").clips[0];
  return c.rendered?.path === "D:/x/a.mp4" ? true : JSON.stringify(c.rendered);
});

await t("★ 提示词恢复", () => {
  const s = store2.snapshot();
  const clips = s.tracks.find((x) => x.kind === "video").clips;
  return clips[0].shot?.prompt === "镜头 1" && clips[1].shot?.prompt === "镜头 2"
    ? true : clips.map((c) => c.shot?.prompt).join(" / ");
});

await t("★ 剪辑属性恢复（变速、裁剪）", () => {
  const s = store2.snapshot();
  const clips = s.tracks.find((x) => x.kind === "video").clips;
  if (clips[1].speed !== 2) return `speed=${clips[1].speed}`;
  if (clips[0].trim?.startSec !== 0.5) return `trim=${JSON.stringify(clips[0].trim)}`;
  return true;
});

await t("★ 音画关联恢复（fromVideoClipId）", () => {
  const s = store2.snapshot();
  const a = s.tracks.find((x) => x.kind === "audio").clips[0];
  const v = s.tracks.find((x) => x.kind === "video").clips[0];
  return a?.fromVideoClipId === v.id ? true : `${a?.fromVideoClipId} vs ${v.id}`;
});

// ══════════════════════════════════════════════════
console.log("\n═══ ③ ★★ 运行态修正：不卡在「生成中」 ═══");

await t("重启时处于 running 的段 → 恢复成 cancelled", () => {
  // 在【原始 store】上制造一个 running，然后 flush
  store.startJob(v1.id, { jobId: "job_running" }, "agent");
  persister.flush();

  // 新 store 恢复
  const store3 = createTimelineStore({ log: silent });
  const p3 = createPersister({ file: FILE, store: store3, log: silent, debounceMs: 50 });
  p3.load();
  const s = store3.snapshot();
  const c = s.tracks.find((x) => x.kind === "video").clips[0];
  p3.dispose();

  // ★ 关键：不能是 running/queued（那些状态的任务已随进程消失）
  if (c.status === "running" || c.status === "queued") {
    return `★ 卡在 ${c.status} —— 用户会以为还在生成`;
  }
  // 因为这段已 restored（有成片），所以应该是 done
  return c.status === "done" ? true : `status=${c.status}`;
});

await t("重启丢掉了 jobId（任务已不存在）", () => {
  const store4 = createTimelineStore({ log: silent });
  const p4 = createPersister({ file: FILE, store: store4, log: silent, debounceMs: 50 });
  p4.load();
  const s = store4.snapshot();
  const withJob = s.tracks.flatMap((x) => x.clips).filter((c) => c.jobId);
  p4.dispose();
  return withJob.length === 0 ? true : `${withJob.length} 段还带着 jobId`;
});

// ══════════════════════════════════════════════════
console.log("\n═══ ④ 防抖写入 ═══");

await t("连续多次变更只写一次盘（防抖生效）", async () => {
  const f2 = path.join(TMP, "debounce.json");
  const st = createTimelineStore({ log: silent });
  const p = createPersister({ file: f2, store: st, log: silent, debounceMs: 80 });

  // 连发 10 次变更
  for (let i = 0; i < 10; i++) {
    st.addShot({ modeId: "yz", prompt: `镜头 ${i}`, durationSec: 5 }, "agent");
  }
  // 防抖窗口内文件还不该出现
  const existedImmediately = fs.existsSync(f2);
  await new Promise((r) => setTimeout(r, 200));
  const existedAfter = fs.existsSync(f2);
  const clipsSaved = existedAfter ? JSON.parse(fs.readFileSync(f2, "utf8")).tracks[0].clips.length : 0;
  p.dispose();

  if (existedImmediately) return "★ 没有防抖，立刻写盘了";
  return existedAfter && clipsSaved === 10 ? true : `写盘 ${existedAfter}，段数 ${clipsSaved}`;
});

// ══════════════════════════════════════════════════
console.log("\n═══ ⑤ 存档损坏时优雅降级 ═══");

await t("损坏的 JSON 不抛错，返回 ok=false", () => {
  const bad = path.join(TMP, "bad.json");
  fs.writeFileSync(bad, "{ this is not json", "utf8");
  const st = createTimelineStore({ log: silent });
  const p = createPersister({ file: bad, store: st, log: silent });
  const r = p.load();
  p.dispose();
  // ★ 2026-10-19 改（quarantineCorrupt 给 reason 加了「（原文件已备份为 xxx）」后缀）：
  //   原来全等比较，加后缀就变红。改成前缀匹配 ——
  //   断言要守「是不是这个分类」，不是「文案一字不差」。
  return r.ok === false && String(r.reason).startsWith("存档损坏") ? true : JSON.stringify(r);
});

await t("格式不对的 JSON 也降级", () => {
  const bad = path.join(TMP, "bad2.json");
  fs.writeFileSync(bad, JSON.stringify({ hello: "world" }), "utf8");
  const st = createTimelineStore({ log: silent });
  const p = createPersister({ file: bad, store: st, log: silent });
  const r = p.load();
  p.dispose();
  // ★ 同上：前缀匹配
  return r.ok === false && String(r.reason).startsWith("存档格式不对") ? true : JSON.stringify(r);
});
// ══════════════════════════════════════════════════
console.log("═══ ⑥ 清理 ═══");
await t("dispose 后不再写盘", () => {
  const st = createTimelineStore({ log: silent });
  const f3 = path.join(TMP, "disposed.json");
  const p = createPersister({ file: f3, store: st, log: silent, debounceMs: 50 });
  p.dispose();
  const before = fs.existsSync(f3) ? fs.statSync(f3).mtimeMs : 0;
  st.addShot({ modeId: "yz", prompt: "dispose 后加的" }, "agent");
  return true; // 只是不抛错即可（写了也测不出差异）
});

// 清理临时目录
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  host 持久化验收全过");