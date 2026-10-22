/**
 * 视频预览验收 —— 粗剪的基本需求：能看画面。
 *
 * ★ 主人原话
 *   「实时更好一点？剪辑本来就要看剪辑效果的，不对就撤回重新剪辑了」
 *   ⇒ 看不到画面就无法判断哪段要重跑、哪段要裁。
 *
 * 判据：
 *   ① URL 解析正确（三种引用都要能转成浏览器可用 URL）
 *   ② 预览序列包含每段的起点、时长、seek 位置
 *   ③ ★ seek 位置要把「变速 + 裁剪」折算进去（否则播错地方）
 *   ④ 有不可播的段时提前告知
 */
import {
  resolvePreviewUrl, buildPreviewSequence, segmentAt,
  canPreviewAll, describePreviewState,
} from "../src/preview.mjs";

let pass = 0, fail = 0;
const failures = [];
function t(desc, fn) {
  try {
    const r = fn();
    if (r === true || r === undefined) { console.log(`  ✅ ${desc}`); pass++; }
    else { console.log(`  ❌ ${desc}\n     ${r}`); fail++; failures.push(desc); }
  } catch (err) {
    console.log(`  ❌ ${desc}\n     ${err.message}`); fail++; failures.push(desc);
  }
}

const COMFY = "http://127.0.0.1:8188";
const OPTS = { comfyOrigin: COMFY, assetPrefix: "/timeline", assetHostBase: "http://127.0.0.1:19499" };

// ══════════════════════════════════════════════════
console.log("═══ ① URL 解析 ═══");

t("★ ComfyUI 相对路径拼上 origin", () => {
  const r = resolvePreviewUrl({ rendered: { url: "/api/view?filename=a.mp4" } }, OPTS);
  return r.url === COMFY + "/api/view?filename=a.mp4" ? true : r.url;
});

t("已经是绝对 http URL 时原样保留", () => {
  const r = resolvePreviewUrl({ rendered: { url: "https://x.com/a.mp4" } }, OPTS);
  return r.url === "https://x.com/a.mp4" ? true : r.url;
});

t("★ Windows 绝对路径走宿主文件路由", () => {
  const r = resolvePreviewUrl({ rendered: { path: "D:\\主工作区\\outputs\\a.mp4" } }, OPTS);
  return r.url?.startsWith("/timeline/file?path=") ? true : r.url;
});

t("路径里的反斜杠被转成斜杠", () => {
  const r = resolvePreviewUrl({ rendered: { path: "D:\\x\\y\\a.mp4" } }, OPTS);
  const decoded = decodeURIComponent(r.url.split("path=")[1]);
  return !decoded.includes("\\") ? true : decoded;
});

t("kind 能识别 video/image/audio", () => {
  const cases = [
    [{ rendered: { path: "a.mp4" } }, "video"],
    [{ rendered: { path: "a.png" } }, "image"],
    [{ rendered: { path: "a.m4a" } }, "audio"],
  ];
  const bad = cases.filter(([c, want]) => resolvePreviewUrl(c, OPTS).kind !== want);
  return bad.length === 0 ? true : JSON.stringify(bad.map(([c]) => c.rendered.path));
});

t("没有成片时给出原因而不是崩", () => {
  const r = resolvePreviewUrl({ rendered: null, src: "（待生成）" }, OPTS);
  return r.url === null && r.reason ? true : JSON.stringify(r);
});

// ══════════════════════════════════════════════════
console.log("\n═══ ② 预览序列 ═══");

function mkState(clips) {
  return {
    tracks: [
      { id: "v", kind: "video", name: "视频 1", clips },
      { id: "a", kind: "audio", name: "音频 1", clips: [] },
    ],
  };
}

t("三段生成连续序列", () => {
  const st = mkState([
    { id: "c1", name: "A", in: 0, out: 5, speed: 1, rendered: { path: "D:\\o\\a.mp4" } },
    { id: "c2", name: "B", in: 0, out: 3, speed: 1, rendered: { path: "D:\\o\\b.mp4" } },
    { id: "c3", name: "C", in: 0, out: 2, speed: 1, rendered: { path: "D:\\o\\c.mp4" } },
  ]);
  const seq = buildPreviewSequence(st, OPTS);
  if (!seq.ok) return JSON.stringify(seq.problems);
  if (seq.segments.length !== 3) return `${seq.segments.length} 段`;
  if (seq.totalSec !== 10) return `总长 ${seq.totalSec}`;
  const starts = seq.segments.map((s) => s.start).join(",");
  return starts === "0,5,8" ? true : starts;
});

t("★ 变速后 seek 位置正确换算（5s 2x → 成片 2.5s，seek 起点不变）", () => {
  const st = mkState([
    { id: "c1", name: "A", in: 0, out: 5, speed: 2, rendered: { path: "D:\\o\\a.mp4" } },
  ]);
  const seq = buildPreviewSequence(st, OPTS);
  const s = seq.segments[0];
  if (s.duration !== 2.5) return `时长 ${s.duration}`;
  if (s.playbackRate !== 2) return `rate ${s.playbackRate}`;
  return s.seekTo === 0 ? true : `seek ${s.seekTo}`;
});

t("★ 裁剪 + 变速叠加：seek = in + 裁剪起点×倍速", () => {
  const st = mkState([
    {
      id: "c1", name: "A", in: 10, out: 15, speed: 2,
      trim: { startSec: 1, endSec: 2 },
      rendered: { path: "D:\\o\\a.mp4" },
    },
  ]);
  const seq = buildPreviewSequence(st, OPTS);
  const s = seq.segments[0];
  // 源 10~15s，2 倍速 → 成片 2.5s；trim 1~2 → 时长 1s
  // seek = 10 + 1×2 = 12
  if (s.duration !== 1) return `时长 ${s.duration}（应 1）`;
  return s.seekTo === 12 ? true : `seek ${s.seekTo}（应 12）`;
});

t("有未生成的段时标记 playable=false 但保留占位", () => {
  const st = mkState([
    { id: "c1", name: "A", in: 0, out: 5, speed: 1, rendered: { path: "D:\\o\\a.mp4" } },
    { id: "c2", name: "B", in: 0, out: 3, speed: 1, rendered: null, src: "（待生成）" },
  ]);
  const seq = buildPreviewSequence(st, OPTS);
  if (seq.segments.length !== 2) return `${seq.segments.length} 段（占位要保留）`;
  if (seq.segments[1].playable !== false) return "没标记不可播";
  if (seq.totalSec !== 8) return `总长 ${seq.totalSec}（占位要计入）`;
  return seq.ok === false ? true : "ok 应为 false";
});

t("空时间轴不崩", () => {
  const seq = buildPreviewSequence(mkState([]), OPTS);
  return seq.segments.length === 0 && seq.totalSec === 0 ? true : JSON.stringify(seq);
});

// ══════════════════════════════════════════════════
console.log("\n═══ ③ 按时间定位 ═══");

t("t=0 落在第一段", () => {
  const st = mkState([
    { id: "c1", name: "A", in: 0, out: 5, speed: 1, rendered: { path: "D:\\a.mp4" } },
    { id: "c2", name: "B", in: 0, out: 3, speed: 1, rendered: { path: "D:\\b.mp4" } },
  ]);
  const seq = buildPreviewSequence(st, OPTS);
  const s = segmentAt(seq, 0);
  return s?.clipId === "c1" && s.offsetInSegment === 0 ? true : JSON.stringify(s);
});

t("t=6 落在第二段，段内偏移 1", () => {
  const st = mkState([
    { id: "c1", name: "A", in: 0, out: 5, speed: 1, rendered: { path: "D:\\a.mp4" } },
    { id: "c2", name: "B", in: 0, out: 3, speed: 1, rendered: { path: "D:\\b.mp4" } },
  ]);
  const seq = buildPreviewSequence(st, OPTS);
  const s = segmentAt(seq, 6);
  return s?.clipId === "c2" && Math.abs(s.offsetInSegment - 1) < 1e-9 ? true : JSON.stringify(s);
});

t("超出末尾时夹到最后一段末", () => {
  const st = mkState([{ id: "c1", name: "A", in: 0, out: 5, speed: 1, rendered: { path: "D:\\a.mp4" } }]);
  const seq = buildPreviewSequence(st, OPTS);
  const s = segmentAt(seq, 999);
  return s?.clipId === "c1" ? true : JSON.stringify(s);
});

// ══════════════════════════════════════════════════
console.log("\n═══ ④ 连播可行性 ═══");

t("全部可播时 ok", () => {
  const st = mkState([
    { id: "c1", name: "A", in: 0, out: 5, speed: 1, rendered: { path: "D:\\a.mp4" } },
  ]);
  const seq = buildPreviewSequence(st, OPTS);
  const c = canPreviewAll(seq);
  return c.ok === true ? true : c.reason;
});

t("★ 有不可播段时说清是哪几段", () => {
  const st = mkState([
    { id: "c1", name: "第一镜", in: 0, out: 5, speed: 1, rendered: { path: "D:\\a.mp4" } },
    { id: "c2", name: "第二镜", in: 0, out: 3, speed: 1, rendered: null, src: "（待生成）" },
  ]);
  const seq = buildPreviewSequence(st, OPTS);
  const c = canPreviewAll(seq);
  return c.ok === false && c.reason.includes("第二镜") ? true : c.reason;
});

t("空时间轴给出明确原因", () => {
  const c = canPreviewAll({ segments: [] });
  return c.ok === false && c.reason.includes("空") ? true : c.reason;
});

// ══════════════════════════════════════════════════
console.log("\n═══ ⑤ 状态描述 ═══");

t("播放中显示时间与段名", () => {
  const s = describePreviewState({ playing: true, t: 75, totalSec: 120, segmentName: "第三镜" });
  return s.includes("1:15") && s.includes("第三镜") ? true : s;
});

t("暂停时显示已暂停", () => {
  const s = describePreviewState({ playing: false, t: 5, totalSec: 60 });
  return s.includes("已暂停") && s.includes("0:05") ? true : s;
});

console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  M9 视频预览验收全过");
