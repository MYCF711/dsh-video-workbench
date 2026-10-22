/**
 * M7 时间轴模型验收 —— 纯逻辑，不需要浏览器、不需要 ffmpeg。
 *
 * 判据对应主人 2026-10-17 的原话：
 *   「做好视频和音频分轨，然后可以增加轨道，做一个粗剪就好了
 *     弄一个最基本的波纹删除能把分段删掉后自动把前后分段接在一起没有空挡黑屏即可
 *     然后再要一个变速（音频不失真）
 *     还有裁剪画面」
 *
 * 八组：
 *   ① 分轨（video + audio 各一条）
 *   ② 加轨道
 *   ③ ★ 波纹删除 —— 删段后前后接上，时间轴不留空档
 *   ④ ★ 变速 —— 只改可见时长，不改源出入点
 *   ⑤ 裁剪
 *   ⑥ 时间轴位置 ↔ 源时间的换算（变速时最容易错）
 *   ⑦ 序列化
 *   ⑧ 校验
 */
import {
  createTimeline, addTrack, removeTrack, addClip, removeClip, removeClipRipple,
  moveClip, updateClip, clipDuration, layoutTrack, timelineDuration,
  clipAt, sourceTimeAt, validate, serialize, deserialize, stats,
  TRACK_KINDS,
} from "../src/timeline.mjs";

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

const SRC = "D:/test/a.mp4";
const mkClip = (tl, opts = {}) => addClip(tl, tl.tracks[0].id, { src: SRC, in: 0, out: 2, ...opts });

// ══════════════════════════════════════════════════════════
console.log("═══ ① 分轨 ═══");

let tl;
t("建时间轴默认有 1 视频 + 1 音频轨", () => {
  tl = createTimeline(24);
  const v = tl.tracks.filter((x) => x.kind === "video");
  const a = tl.tracks.filter((x) => x.kind === "audio");
  return v.length === 1 && a.length === 1 ? true : `video=${v.length} audio=${a.length}`;
});

t("fps 存下来了", () => (tl.fps === 24 ? true : tl.fps));

t("只支持 video / audio 两种轨道", () => {
  try { addTrack(tl, "subtitle"); } catch { return true; }
  return "非法类型没被拒";
});

// ══════════════════════════════════════════════════════════
console.log("\n═══ ② 加轨道 ═══");

t("加一条视频轨", () => {
  const before = tl.tracks.length;
  const t2 = addTrack(tl, "video");
  return tl.tracks.length === before + 1 && t2.kind === "video" ? true : "没加上";
});

// ★ 编号是按「当前已有几条同类轨道 + 1」算的，所以断言要相对而非绝对值
//   （上一组测试已经加过一条视频轨，写死「视频 2」会误报 —— 实测踩到）
t("新轨道名字按当前数量自动编号", () => {
  const before = tl.tracks.filter((x) => x.kind === "video").length;
  const t2 = addTrack(tl, "video");
  return t2.name === `视频 ${before + 1}` ? true : `${t2.name}，期望 视频 ${before + 1}`;
});

t("删轨道", () => {
  const t2 = addTrack(tl, "audio");
  const before = tl.tracks.length;
  removeTrack(tl, t2.id);
  return tl.tracks.length === before - 1 ? true : "没删掉";
});

// 重置，后面的测试用干净的时间轴
tl = createTimeline(24);

// ══════════════════════════════════════════════════════════
console.log("\n═══ ③ ★ 波纹删除（删段后不留空档）═══");

t("加 3 个 2 秒片段，总时长 6 秒", () => {
  mkClip(tl, { in: 0, out: 2 });
  mkClip(tl, { in: 10, out: 12 });
  mkClip(tl, { in: 20, out: 22 });
  return timelineDuration(tl) === 6 ? true : timelineDuration(tl);
});

t("删中间那个后，总时长变 4 秒", () => {
  const vTrack = tl.tracks[0];
  removeClipRipple(tl, vTrack.id, vTrack.clips[1].id);
  return timelineDuration(tl) === 4 ? true : timelineDuration(tl);
});

t("★ 波纹删除后没有空档（第 2 个片段紧接着第 1 个）", () => {
  const segs = layoutTrack(tl.tracks[0]);
  if (segs.length !== 2) return `剩 ${segs.length} 段`;
  return segs[0].end === segs[1].start ? true : `gap: ${segs[0].end} → ${segs[1].start}（有空档！）`;
});

t("所有片段首尾相接，无空档", () => {
  const segs = layoutTrack(tl.tracks[0]);
  for (let i = 1; i < segs.length; i++) {
    if (Math.abs(segs[i].start - segs[i - 1].end) > 1e-9) {
      return `第 ${i} 段有空档：${segs[i - 1].end} → ${segs[i].start}`;
    }
  }
  return true;
});

t("删除首段后，剩余片段从 0 开始", () => {
  const t2 = createTimeline();
  const a = addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 1 });
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 5, out: 8 });
  removeClipRipple(t2, t2.tracks[0].id, a.id);
  const segs = layoutTrack(t2.tracks[0]);
  return segs[0].start === 0 ? true : `从 ${segs[0].start} 开始`;
});

t("普通 removeClip 与波纹删除行为一致（因为不存 start）", () => {
  const t2 = createTimeline();
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 1 });
  const mid = addClip(t2, t2.tracks[0].id, { src: SRC, in: 2, out: 3 });
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 4, out: 5 });
  removeClip(t2, t2.tracks[0].id, mid.id);
  const segs = layoutTrack(t2.tracks[0]);
  return segs[1].start === segs[0].end ? true : "普通删除留了空档（设计上不该留）";
});

// ══════════════════════════════════════════════════════════
console.log("\n═══ ④ ★ 变速 ═══");

t("2 倍速后可见时长减半（2s → 1s）", () => {
  const t2 = createTimeline();
  const c = addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2, speed: 2 });
  return clipDuration(c) === 1 ? true : clipDuration(c);
});

t("★ 变速不改源出入点（in/out 保持 0/2）", () => {
  const t2 = createTimeline();
  const c = addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2, speed: 2 });
  return c.in === 0 && c.out === 2 ? true : `in=${c.in} out=${c.out}`;
});

t("0.5 倍速后时长翻倍（2s → 4s）", () => {
  const t2 = createTimeline();
  const c = addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2, speed: 0.5 });
  return clipDuration(c) === 4 ? true : clipDuration(c);
});

t("speed <= 0 被拒", () => {
  const t2 = createTimeline();
  try { addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2, speed: 0 }); } catch { return true; }
  return "speed=0 竟然被接受";
});

t("updateClip 改 speed 生效", () => {
  const t2 = createTimeline();
  const c = addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 4 });
  updateClip(t2, t2.tracks[0].id, c.id, { speed: 4 });
  return clipDuration(t2.tracks[0].clips[0]) === 1 ? true : clipDuration(t2.tracks[0].clips[0]);
});

t("变速后时间轴总时长跟着变", () => {
  const t2 = createTimeline();
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2, speed: 2 });
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2, speed: 1 });
  return timelineDuration(t2) === 3 ? true : timelineDuration(t2);
});

// ══════════════════════════════════════════════════════════
console.log("\n═══ ⑤ 裁剪 ═══");

t("crop 归一化坐标可设", () => {
  const t2 = createTimeline();
  const c = addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } });
  return c.crop.w === 0.8 ? true : JSON.stringify(c.crop);
});

t("crop 超出 0~1 被拒", () => {
  const t2 = createTimeline();
  const c = addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2 });
  try { updateClip(t2, t2.tracks[0].id, c.id, { crop: { x: 0.5, y: 0, w: 0.8, h: 1 } }); } catch { return true; }
  return "x+w=1.3 竟然被接受";
});

t("crop 宽高为 0 被拒", () => {
  const t2 = createTimeline();
  const c = addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2 });
  try { updateClip(t2, t2.tracks[0].id, c.id, { crop: { x: 0, y: 0, w: 0, h: 1 } }); } catch { return true; }
  return "w=0 竟然被接受";
});

t("不支持的字段被拒", () => {
  const t2 = createTimeline();
  const c = addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2 });
  try { updateClip(t2, t2.tracks[0].id, c.id, { bogus: 1 }); } catch { return true; }
  return "非法字段竟然被接受";
});

// ══════════════════════════════════════════════════════════
console.log("\n═══ ⑥ ★ 时间轴时间 → 源时间（变速时最易错）═══");

t("1 倍速：时间轴 1.5s → 源 1.5s", () => {
  const t2 = createTimeline();
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 4, speed: 1 });
  const st = sourceTimeAt(t2, t2.tracks[0].id, 1.5);
  return Math.abs(st - 1.5) < 1e-9 ? true : st;
});

t("★ 2 倍速：时间轴 1s → 源 2s（乘 speed）", () => {
  const t2 = createTimeline();
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 4, speed: 2 });
  const st = sourceTimeAt(t2, t2.tracks[0].id, 1);
  return Math.abs(st - 2) < 1e-9 ? true : `得 ${st}，应为 2`;
});

t("★ 有 in 偏移 + 变速：in=10, speed=2, 时间轴 1s → 源 12s", () => {
  const t2 = createTimeline();
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 10, out: 14, speed: 2 });
  const st = sourceTimeAt(t2, t2.tracks[0].id, 1);
  return Math.abs(st - 12) < 1e-9 ? true : `得 ${st}，应为 12`;
});

t("第二段的时间轴时间换算正确", () => {
  const t2 = createTimeline();
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2, speed: 1 }); // 占 0~2
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 10, out: 14, speed: 2 }); // 占 2~4
  const st = sourceTimeAt(t2, t2.tracks[0].id, 3); // 第二段内 1s → 源 10 + 1*2 = 12
  return Math.abs(st - 12) < 1e-9 ? true : `得 ${st}，应为 12`;
});

t("超出范围返回 null", () => {
  const t2 = createTimeline();
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2 });
  return sourceTimeAt(t2, t2.tracks[0].id, 99) === null ? true : "超范围没返回 null";
});

t("clipAt 返回正确的片段与偏移", () => {
  const t2 = createTimeline();
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 1 });
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 5, out: 8 });
  const hit = clipAt(t2, t2.tracks[0].id, 1.5);
  return hit && hit.index === 1 && Math.abs(hit.offsetInClip - 0.5) < 1e-9
    ? true : JSON.stringify(hit && { i: hit.index, o: hit.offsetInClip });
});

// ══════════════════════════════════════════════════════════
console.log("\n═══ ⑦ 序列化 ═══");

t("往返一致", () => {
  const t2 = createTimeline("测试");
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2, speed: 2, crop: { x: 0, y: 0, w: 1, h: 1 } });
  const back = deserialize(serialize(t2));
  return back.tracks[0].clips.length === 1 && back.tracks[0].clips[0].speed === 2 ? true : "丢了";
});

t("坏片段在反序列化时被清理", () => {
  const t2 = createTimeline();
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2 });
  const j = JSON.parse(serialize(t2));
  j.tracks[0].clips.push({ id: "bad", src: "x", in: 5, out: 1, speed: 1 }); // out < in
  j.tracks[0].clips.push({ id: "bad2", src: "x", in: 0, out: 1, speed: 0 }); // speed 0
  const back = deserialize(j);
  return back.tracks[0].clips.length === 1 ? true : `剩 ${back.tracks[0].clips.length} 个（坏片段没清掉）`;
});

t("坏数据报错不静默", () => {
  try { deserialize("{}"); } catch { return true; }
  return "没抛错";
});

// ══════════════════════════════════════════════════════════
console.log("\n═══ ⑧ 校验与统计 ═══");

t("正常时间轴校验通过", () => {
  const t2 = createTimeline();
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2 });
  return validate(t2).ok === true ? true : validate(t2).problems.join("; ");
});

t("没有视频轨被查出", () => {
  const t2 = createTimeline();
  t2.tracks = t2.tracks.filter((x) => x.kind === "audio");
  const v = validate(t2);
  return v.ok === false && v.problems.some((p) => p.includes("视频轨")) ? true : JSON.stringify(v);
});

t("stats 统计正确", () => {
  const t2 = createTimeline();
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2 });
  addClip(t2, t2.tracks[1].id, { src: "a.m4a", in: 0, out: 3 });
  const s = stats(t2);
  return s.tracks === 2 && s.videoClips === 1 && s.audioClips === 1 && s.durationSec === 3
    ? true : JSON.stringify(s);
});

t("多轨取最长的那条作为总时长", () => {
  const t2 = createTimeline();
  addClip(t2, t2.tracks[0].id, { src: SRC, in: 0, out: 2 });
  addClip(t2, t2.tracks[1].id, { src: "a.m4a", in: 0, out: 5 });
  return timelineDuration(t2) === 5 ? true : timelineDuration(t2);
});

// ══════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(58));
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) {
  console.log(`  失败：${failures.join(" · ")}`);
  process.exit(1);
}
console.log("  M7 时间轴模型验收全过");
