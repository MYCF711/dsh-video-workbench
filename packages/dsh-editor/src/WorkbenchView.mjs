import { btn, input } from './styles.mjs';
import { ClipEditor } from './ClipEditor.mjs';

const { useState, useMemo, useCallback, useEffect, useRef } = React;
const h = React.createElement;

const PANEL_TABS = [
  { id: "preview", label: "预览", icon: "▶" },
  { id: "timeline", label: "时间轴", icon: "▤" },
  { id: "assets", label: "素材库", icon: "▦" },
  { id: "audio", label: "音频", icon: "♪" },
];

function PreviewPlayer({ prefix, sequence, current, onTimeChange, onSelectClip }) {
  const videoRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [idx, setIdx] = useState(0);
  const [err, setErr] = useState(null);
  const [mode, setMode] = useState("single"); // single | sequence

  const segs = sequence?.segments ?? [];
  const seg = mode === "single" ? (current ? segs.find((s) => s.clipId === current.id) : null) : segs[idx];
  const total = sequence?.totalSec ?? 0;

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !seg?.url) return;
    try {
      v.currentTime = seg.seekTo ?? 0;
      v.playbackRate = seg.playbackRate ?? 1;
    } catch { /* ignore */ }
  }, [seg?.clipId, seg?.url]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const v = videoRef.current;
      if (!v) return;
      const inSeg = Math.max(0, v.currentTime - (seg?.seekTo ?? 0)) / (seg?.playbackRate ?? 1);
      const globalT = mode === "single"
        ? (seg?.start ?? 0) + Math.min(inSeg, seg?.duration ?? 0)
        : (seg?.start ?? 0) + Math.min(inSeg, seg?.duration ?? 0);
      setT(globalT);
      onTimeChange?.(globalT);

      if (mode === "sequence" && inSeg >= (seg?.duration ?? 0) - 0.08) {
        if (idx + 1 < segs.length) {
          setIdx((i) => i + 1);
          setTimeout(() => { videoRef.current?.play().catch(() => {}); }, 30);
        } else {
          setPlaying(false);
        }
      }
    }, 100);
    return () => clearInterval(id);
  }, [playing, seg?.clipId, seg?.start, seg?.duration, seg?.seekTo, seg?.playbackRate, mode, idx, segs.length, onTimeChange]);

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!seg?.url) { setErr(seg?.reason ?? "这段还不能预览"); return; }
    setErr(null);
    if (playing) { v?.pause(); setPlaying(false); }
    else { v?.play().then(() => setPlaying(true)).catch((e) => setErr(e.message)); }
  }, [playing, seg]);

  const seek = useCallback((globalT) => {
    const target = segmentAt(sequence, globalT);
    if (!target?.url) return;
    if (mode === "sequence") {
      const i = segs.findIndex((s) => s.clipId === target.clipId);
      if (i >= 0 && i !== idx) { setIdx(i); }
    }
    setT(globalT);
    onTimeChange?.(globalT);
    const v = videoRef.current;
    if (v) {
      const local = (target.seekTo ?? 0) + target.offsetInSegment * (target.playbackRate ?? 1);
      try { v.currentTime = local; } catch { /* ignore */ }
    }
  }, [sequence, mode, idx, segs, onTimeChange]);

  return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" } },
    h("div", { style: { flex: 1, position: "relative", background: "#000", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0 } },
      seg?.url
        ? (seg.kind === "video"
            ? h("video", {
                ref: videoRef,
                src: seg.url,
                style: { maxWidth: "100%", maxHeight: "100%" },
                onEnded: () => setPlaying(false),
                onError: () => setErr("视频加载失败（检查文件是否还在）"),
                playsInline: true,
              })
            : seg.kind === "image"
            ? h("img", { src: seg.url, style: { maxWidth: "100%", maxHeight: "100%" }, alt: seg.name })
            : h("audio", { ref: videoRef, src: seg.url, controls: true, style: { width: "70%" } }))
        : h("div", { style: { color: "rgba(139,148,158,.5)", fontSize: 12, textAlign: "center", padding: 20 } },
            seg ? `「${seg.name}」还不能预览：${seg.reason ?? "无文件"}` : "点一个片段开始预览"),
      err ? h("div", { style: { position: "absolute", bottom: 8, left: 8, right: 8, padding: "5px 8px", borderRadius: 4, background: "rgba(248,81,73,.9)", color: "#fff", fontSize: 10 } }, err) : null
    ),

    h("div", { style: { padding: "6px 10px", borderTop: "1px solid rgba(128,128,128,.2)", display: "flex", gap: 8, alignItems: "center", fontSize: 11, flexWrap: "wrap", flex: "0 0 auto" } },
      h("button", { onClick: toggle, style: { ...btn, padding: "2px 12px", background: playing ? "#da3633" : "#238636", color: "#fff", borderColor: "transparent" } },
        playing ? "■ 停" : "▶ 播"),
      h("button", {
        onClick: (e) => {
          const r = e.currentTarget.parentElement.querySelector("input[type=range]");
          const b = r.getBoundingClientRect();
          seek(((e.clientX - b.left) / b.width) * total);
        },
        style: { ...btn, padding: "2px 6px" },
        title: "回到开头",
      }, "⏮"),
      h("input", {
        type: "range", min: 0, max: Math.max(total, 0.1), step: 0.05, value: t,
        onChange: (e) => seek(Number(e.target.value)),
        style: { flex: 1, minWidth: 100 },
      }),
      h("span", { style: { fontSize: 10, opacity: 0.6, minWidth: 76 } },
        `${fmt(t)} / ${fmt(total)}`),
      h("button", {
        onClick: () => { setMode(mode === "single" ? "sequence" : "single"); setPlaying(false); },
        title: mode === "single" ? "切到整条连播" : "切到单段预览",
        style: { ...btn, padding: "2px 8px", borderColor: mode === "sequence" ? "#58a6ff" : undefined, color: mode === "sequence" ? "#58a6ff" : undefined },
      }, mode === "single" ? "单段" : "连播"),
      seg?.playbackRate && seg.playbackRate !== 1
        ? h("span", { style: { fontSize: 10, color: "#d29922" } }, `${seg.playbackRate}x`)
        : null
    ),

    h("div", { style: { maxHeight: 90, overflowY: "auto", padding: "4px 8px", borderTop: "1px solid rgba(128,128,128,.15)", flex: "0 0 auto" } },
      segs.length === 0
        ? h("div", { style: { fontSize: 10, opacity: 0.35, padding: 6 } }, "（没有可预览的段）")
        : segs.map((s, i) =>
            h("button", {
              key: s.clipId,
              onClick: () => { onSelectClip?.(s.clipId); seek(s.start); },
              style: {
                ...btn, padding: "1px 7px", marginRight: 4, marginBottom: 3, fontSize: 10,
                opacity: s.playable ? 1 : 0.45,
                borderColor: seg?.clipId === s.clipId ? "#58a6ff" : undefined,
                color: seg?.clipId === s.clipId ? "#58a6ff" : undefined,
              },
              title: s.playable ? s.name : `${s.name}（${s.reason ?? "不可播"}）`,
            }, `${i + 1}. ${s.name}`)
          )
    )
  );
}

function segmentAt(sequence, t) {
  const segs = sequence?.segments ?? [];
  if (!segs.length) return null;
  const time = Math.max(0, Math.min(t, sequence.totalSec));
  for (const s of segs) {
    if (time >= s.start && time < s.start + s.duration) {
      return { ...s, offsetInSegment: time - s.start };
    }
  }
  const last = segs[segs.length - 1];
  return { ...last, offsetInSegment: last.duration };
}

function fmt(s) {
  const v = Math.max(0, Number(s) || 0);
  const m = Math.floor(v / 60);
  return `${m}:${String(Math.floor(v % 60)).padStart(2, "0")}`;
}

function AssetsPanel({ prefix, onUse, selectedClip }) {
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (kind) params.set("kind", kind);
      const res = await fetch(`${prefix}/assets?${params}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setItems(j.items ?? []);
      setStats(j.stats ?? null);
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [prefix, q, kind]);

  useEffect(() => { load(); }, [load]);

  /**
   * F1 角色卡：给一条素材打/去「角色」标签。
   *
   * ★ 为什么用 prompt 而不是弹窗组件：
   *   这个面板里还没有任何弹窗，为一次命名再引一套 UI 状态不划算。
   *   角色名是用户自己起的短词，prompt 够用；要改就再点一次。
   *
   * ★ 为什么打完标签要 reload：
   *   标签存在素材库里，列表是从 /assets 拿的 —— 不重拉就看不到变化。
   */
  const markCharacter = useCallback(async (a) => {
    const cur = (a.tags ?? []).find((t) => String(t).startsWith("char:"));
    const isChar = (a.tags ?? []).includes("role:character");
    const ans = window.prompt(
      (isChar ? "改角色名（留空=取消角色标记）：" : "这条素材属于哪个角色？（留空=取消）："),
      cur ? String(cur).slice(5) : ""
    );
    if (ans === null) return;          // 用户点了取消
    const name = String(ans).trim();
    const on = name.length > 0;
    try {
      const res = await fetch(prefix + "/cmd/character-tag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: a.id, name, view: null, on }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? ("HTTP " + res.status));
      await load();
    } catch (e) {
      setErr(String(e?.message ?? e).slice(0, 60));
    }
  }, [prefix, load]);

  const scan = useCallback(async () => {
    const dir = window.prompt("要扫描的目录（绝对路径）：", "");
    if (!dir) return;
    setLoading(true);
    try {
      const res = await fetch(`${prefix}/cmd/assets-scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) { setErr(e.message); } finally { setLoading(false); }
  }, [prefix, load]);

  return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" } },
    h("div", { style: { padding: "8px 12px", borderBottom: "1px solid rgba(128,128,128,.2)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", flex: "0 0 auto" } },
      h("button", { onClick: scan, style: { ...btn, background: "#238636", color: "#fff", borderColor: "transparent", fontWeight: 600 } }, "＋ 扫描目录"),
      h("input", {
        placeholder: "搜索名字/路径/标签",
        value: q, onChange: (e) => setQ(e.target.value),
        style: { ...input, width: 180 },
      }),
      h("select", { value: kind, onChange: (e) => setKind(e.target.value), style: { ...input, width: 90 } },
        h("option", { value: "" }, "全部"),
        ["image", "video", "audio", "text", "other"].map((k) => h("option", { key: k, value: k }, k))
      ),
      h("button", { onClick: load, style: btn }, loading ? "…" : "刷新"),
      h("div", { style: { flex: 1 } }),
      stats ? h("span", { style: { fontSize: 11, opacity: 0.55 } },
        `${stats.total} 项 · ${stats.totalMB} MB` +
        (stats.missing ? ` · ${stats.missing} 缺失` : "")) : null
    ),

    err ? h("div", { style: { padding: "6px 12px", background: "rgba(248,81,73,.12)", color: "#f85149", fontSize: 11 } }, err) : null,

    h("div", { style: { flex: 1, overflowY: "auto", padding: 8 } },
      items.length === 0
        ? h("div", { style: { padding: 40, textAlign: "center", opacity: 0.4, fontSize: 12 } },
            loading ? "加载中…" : "还没有素材。点「扫描目录」把 outputs 收进来。")
        : items.map((a) =>
            h("div", {
              key: a.id,
              style: {
                display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                borderRadius: 6, marginBottom: 4, fontSize: 11,
                background: "rgba(128,128,128,.06)",
                border: "1px solid rgba(128,128,128,.12)",
              },
            },
              h("span", { style: { fontSize: 9, padding: "1px 5px", borderRadius: 4, background: "rgba(88,166,255,.15)", color: "#58a6ff" } }, a.kind),
              h("div", { style: { flex: 1, minWidth: 0 } },
                h("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, a.name),
                h("div", { style: { opacity: 0.45, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                  `${a.sizeMB} MB${a.group ? " · " + a.group : ""}${a.tags?.length ? " · " + a.tags.join(",") : ""}`)
              ),
              // ★ F1：角色标记（有标记的显示名字，一点就能改）
              h("button", {
                onClick: () => markCharacter(a),
                title: (a.tags ?? []).includes("role:character")
                  ? "已标为角色：" + ((a.tags ?? []).find((t) => String(t).startsWith("char:")) ?? "未命名").slice(5) + "（点击修改）"
                  : "标为某个角色的定妆图（会被自动填进参考图槽）",
                style: {
                  ...btn, padding: "2px 6px", fontSize: 10,
                  background: (a.tags ?? []).includes("role:character") ? "rgba(163,106,3,.18)" : "transparent",
                  color: (a.tags ?? []).includes("role:character") ? "rgb(210,153,34)" : "inherit",
                  border: "none",
                },
              }, (a.tags ?? []).includes("role:character") ? "👤" : "＋"),

              selectedClip
                ? h("button", {
                    onClick: () => onUse(a, selectedClip),
                    title: `挂到「${selectedClip.name}」`,
                    style: { ...btn, padding: "2px 8px" },
                  }, "用")
                : null
            )
          )
    ),

    selectedClip
      ? h("div", { style: { padding: "6px 12px", borderTop: "1px solid rgba(128,128,128,.2)", fontSize: 10, opacity: 0.6 } },
          `当前选中片段：${selectedClip.name}（点素材右侧「用」替换它）`)
      : h("div", { style: { padding: "6px 12px", borderTop: "1px solid rgba(128,128,128,.2)", fontSize: 10, opacity: 0.4 } },
          "先在时间轴里点一个片段，再回来选素材")
  );
}

function AudioPanel({ prefix, tracks, selectedClip, onSelect }) {
  const [err, setErr] = useState(null);
  const [audit, setAudit] = useState(null);

  const audioClips = useMemo(
    () => tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips),
    [tracks]
  );

  // ── F9 字幕状态 ──
  const [subsState, setSubsState] = useState(null);   // null | running | done
  const [subsMsg, setSubsMsg] = useState("");
  const [subsErr, setSubsErr] = useState(false);
  const [subsDone, setSubsDone] = useState(0);
  const [subsTotal, setSubsTotal] = useState(0);

  /**
   * 给视频轨每一段生成字幕。
   *
   * ★ 为什么逐段而不是整条时间轴：
   *   每段是独立生成的视频，音轨各自独立；整条拼完再转写会丢掉
   *   「哪句属于哪一段」的对应关系，而那是重跑某段时要用的。
   *
   * ★ 为什么不自动烧字幕：
   *   烧字幕要重编码（这机子上 1.6s 视频约 2s，长片会更久），
   *   而且烧过的画面不可逆。默认只出 SRT，用户自己要再点。
   */
  const genSubtitles = useCallback(async () => {
    if (subsState === "running") return;
    const videoClips = tracks
      .filter((t) => t.kind === "video")
      .flatMap((t) => t.clips)
      .filter((c) => c?.rendered?.path);
    if (!videoClips.length) {
      setSubsState("done");
      setSubsErr(true);
      setSubsMsg("没有已渲染的片段");
      return;
    }
    setSubsState("running");
    setSubsErr(false);
    setSubsDone(0);
    setSubsTotal(videoClips.length);
    setSubsMsg("");

    let okCount = 0;
    let segTotal = 0;
    const errors = [];
    let noAudioCount = 0;
    for (let i = 0; i < videoClips.length; i++) {
      const c = videoClips[i];
      try {
        // ★ 2026-10-18 修（和 ClipEditor 的 chain 同一个坑，第二次犯）：
        //   prefix 是 /timeline，字幕能力却在 /comfy-bridge 下。
        //   用 prefix 拼会打到 /timeline/subtitle/transcribe → 404，
        //   响应体空 → JSON.parse 抛 "Unexpected end of JSON input"。
        //   ⇒ 跨插件的能力必须用【绝对路径】。
        const r = await fetch(`/comfy-bridge/subtitle/transcribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file: c.rendered.path }),
        });
        const j = await r.json();
        if (j.ok) {
          okCount++;
          segTotal += j.count ?? 0;
        } else if (j.noAudio) {
          // 没音轨不是错误，是这段本来就没声音 —— 单独计数，不染红
          noAudioCount++;
        } else {
          errors.push(j.error ?? "未知错误");
        }
      } catch (e) {
        errors.push(String(e?.message ?? e).slice(0, 40));
      }
      setSubsDone(i + 1);
    }

    setSubsState("done");
    const parts = [`${okCount} 段 · ${segTotal} 条字幕`];
    if (noAudioCount) parts.push(`${noAudioCount} 段无音轨`);
    if (errors.length) {
      setSubsErr(true);
      parts.push(errors[0]);
    } else {
      setSubsErr(false);
    }
    setSubsMsg(parts.join(" · "));
  }, [prefix, tracks, subsState]);

  /**
   * F10 画面质检：查相邻段接不接得上 + 段内卡帧/黑场。
   *
   * ★ 与已有的「音画对齐」是两件事：
   *   refreshAudit 查的是「音频轨与视频轨时长对不对」；
   *   这个查的是「两段画面接得上吗、中间有没有糊住」。
   *
   * ★ 为什么用 useRef 存结果：
   *   AudioPanel 里已经有 6 个 useState，再加不是问题，
   *   但 F10 的结果只在点按钮后才需要，用 ref + 强制重绘更省。
   */
  const cutRef = useRef({ busy: false, msg: "", err: false, seams: [], defects: [] });
  const runCutAudit = async () => {
    const st = cutRef.current;
    if (st.busy) return;
    Object.assign(st, { busy: true, msg: "质检中…", err: false });
    setAudit((a) => a);          // 借已有的 setAudit 触发重绘
    try {
      const clips = tracks
        .filter((t) => t.kind === "video")
        .flatMap((t) => t.clips)
        .filter((c) => c?.rendered?.path);
      if (clips.length < 2) {
        Object.assign(st, { busy: false, msg: "少于两段，无需查接缝", err: false });
        setAudit((a) => a);
        return;
      }
      const res = await fetch("/comfy-bridge/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clips }),
      });
      const j = await res.json();
      if (!res.ok || j.error) {
        Object.assign(st, { busy: false, msg: j.error ?? ("HTTP " + res.status), err: true });
      } else {
        Object.assign(st, {
          busy: false, err: false,
          msg: j.summary ?? "质检完成",
          seams: j.seams ?? [],
          defects: j.defects ?? [],
        });
      }
    } catch (e) {
      Object.assign(st, { busy: false, msg: String(e?.message ?? e).slice(0, 50), err: true });
    }
    setAudit((a) => a);
  };

  const refreshAudit = useCallback(async () => {
    try {
      const r = await fetch(`${prefix}/align`, { cache: "no-store" });
      setAudit(await r.json());
    } catch (e) { /* 忽略 */ }
  }, [prefix]);

  useEffect(() => { refreshAudit(); }, [refreshAudit, tracks]);

  const apply = useCallback(async (clipId, patch) => {
    try {
      const res = await fetch(`${prefix}/cmd/edit-audio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipId, ...patch }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setErr(null);
    } catch (e) { setErr(e.message); }
  }, [prefix]);

  return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" } },
    h("div", { style: { padding: "8px 12px", borderBottom: "1px solid rgba(128,128,128,.2)", display: "flex", gap: 10, alignItems: "center", fontSize: 11, flex: "0 0 auto", flexWrap: "wrap" } },
      h("span", { style: { fontWeight: 600 } }, `音频轨 · ${audioClips.length} 段`),
      audit
        ? h("span", { style: { color: audit.ok ? "#3fb950" : "#f85149" } },
            audit.ok ? "音画对齐 ✓" : `⚠ ${audit.problems?.[0] ?? "有问题"}`)
        : null,
      audit?.warnings?.length
        ? h("span", { style: { color: "#d29922", fontSize: 10 } }, audit.warnings[0])
        : null,
      h("div", { style: { flex: 1 } }),

      // ★ 2026-10-18（F9 字幕）：本机 whisper 转写，零云端。
      //   点了之后：转写视频轨每一段 → 出 SRT →（可选）烧一份硬字幕副本。
      //   默认只出 SRT，不烧 —— 烧字幕要重编码，几十秒，别让手滑付出代价。
      subsState === "running"
        ? h("span", { style: { fontSize: 10, opacity: 0.7 } }, `转写中…（${subsDone}/${subsTotal}）`)
        : null,
      subsState === "done" && subsMsg
        ? h("span", { style: { fontSize: 10, color: subsErr ? "#f85149" : "#3fb950" } }, subsMsg)
        : null,
      h("button", {
        disabled: subsState === "running",
        title: "给视频轨每一段生成字幕（本机 whisper，不联网）",
        onClick: genSubtitles,
        style: { ...btn, opacity: subsState === "running" ? 0.5 : 1 },
      }, subsState === "running" ? "转写中…" : "生成字幕"),

      cutRef.current.msg
        ? h("span", {
            title: cutRef.current.seams.map((s) =>
              (s.fromName ?? s.from) + "→" + (s.toName ?? s.to) +
              " ssim=" + (s.ssim ?? 0).toFixed(2) + (s.ok ? " 接得上" : " 接不上")
            ).join("\n"),
            style: {
              fontSize: 10, maxWidth: 240, overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap",
              color: cutRef.current.err ? "#f85149" : "#3fb950",
            },
          }, cutRef.current.msg)
        : null,

      h("button", {
        disabled: cutRef.current.busy,
        title: "画面质检：查相邻两段接不接得上、段内有没有卡帧黑场",
        onClick: runCutAudit,
        style: { ...btn, opacity: cutRef.current.busy ? 0.5 : 1 },
      }, cutRef.current.busy ? "质检中…" : "画面质检"),

      h("button", { onClick: refreshAudit, style: btn }, "重新检查")
    ),

    err ? h("div", { style: { padding: "6px 12px", background: "rgba(248,81,73,.12)", color: "#f85149", fontSize: 11 } }, err) : null,

    h("div", { style: { flex: 1, overflowY: "auto", padding: 8 } },
      audioClips.length === 0
        ? h("div", { style: { padding: 40, textAlign: "center", opacity: 0.4, fontSize: 12 } },
            "音频轨是空的。H3 生成视频后会自动分离出原声。")
        : audioClips.map((c, i) => {
            const e = c.audioEdit ?? { gain: 1, fadeInSec: 0, fadeOutSec: 0, muted: false };
            const isSel = selectedClip?.id === c.id;
            return h("div", {
              key: c.id,
              onClick: () => onSelect(c),
              style: {
                padding: "8px 10px", marginBottom: 6, borderRadius: 6, fontSize: 11, cursor: "pointer",
                background: isSel ? "rgba(88,166,255,.10)" : "rgba(210,153,34,.06)",
                border: `1px solid ${isSel ? "#58a6ff" : "rgba(210,153,34,.25)"}`,
              },
            },
              h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
                h("span", { style: { flex: 1, fontWeight: 600 } }, `${i + 1}. ${c.name}`),
                h("span", { style: { opacity: 0.5, fontSize: 10 } }, `${(c.out - c.in).toFixed(1)}s`),
                e.muted ? h("span", { style: { fontSize: 9, padding: "0 4px", borderRadius: 3, background: "#da363333", color: "#f85149" } }, "静音") : null
              ),
              h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
                h("span", { style: { opacity: 0.5, fontSize: 10, width: 32 } }, "音量"),
                h("input", {
                  type: "range", min: 0, max: 4, step: 0.1, value: e.gain,
                  onChange: (ev) => apply(c.id, { gain: Number(ev.target.value) }),
                  onClick: (ev) => ev.stopPropagation(),
                  style: { width: 100 },
                }),
                h("span", { style: { fontSize: 10, opacity: 0.7, width: 42 } },
                  e.gain === 1 ? "1x" : `${e.gain}x/${(20 * Math.log10(e.gain || 0.001)).toFixed(0)}dB`),
                h("span", { style: { opacity: 0.5, fontSize: 10, marginLeft: 6 } }, "淡入"),
                h("input", {
                  type: "number", step: "0.1", min: 0, value: e.fadeInSec,
                  onChange: (ev) => apply(c.id, { fadeInSec: Number(ev.target.value) }),
                  onClick: (ev) => ev.stopPropagation(),
                  style: { ...input, width: 52 },
                }),
                h("span", { style: { opacity: 0.5, fontSize: 10 } }, "淡出"),
                h("input", {
                  type: "number", step: "0.1", min: 0, value: e.fadeOutSec,
                  onChange: (ev) => apply(c.id, { fadeOutSec: Number(ev.target.value) }),
                  onClick: (ev) => ev.stopPropagation(),
                  style: { ...input, width: 52 },
                }),
                h("button", {
                  onClick: (ev) => { ev.stopPropagation(); apply(c.id, { muted: !e.muted }); },
                  style: { ...btn, padding: "1px 7px", color: e.muted ? "#f85149" : undefined },
                }, e.muted ? "取消静音" : "静音")
              )
            );
          })
    )
  );
}

/** F8 转场选项（界面上只露常用的 6 个，共 58 种可选）。 */
const TRANSITION_OPTIONS = [
  { v: "", t: "硬切" },
  { v: "fade", t: "淡入淡出" },
  { v: "dissolve", t: "溶解" },
  { v: "slideleft", t: "左滑入" },
  { v: "circleopen", t: "圆形展开" },
  { v: "fadeblack", t: "过黑" },
];

export function createWorkbenchView(react) {
  function WorkbenchInner(props) {
    const prefix = props.prefix ?? "/timeline";
    const [panel, setPanel] = useState("preview");
    const [state, setState] = useState(null);
    const [summary, setSummary] = useState(null);
    const [conn, setConn] = useState("connecting");
    const [selectedClipId, setSelectedClipId] = useState(null);
    const [err, setErr] = useState(null);
    const [sequence, setSequence] = useState(null);
    const [playheadT, setPlayheadT] = useState(0);

    // ★ 2026-10-18（F8）最小侵入版：
    //   上一版我在这个组件里加了 4 个 useState，结果粗剪整页崩（slot 兜住渲染成空）。
    //   二分确认「只加 state 不加 UI」也会崩 ⇒ 不吃这个风险。
    //   ⇒ 改成：状态全部塞进一个 useRef 对象，【不新增任何 hook】。
    //     渲染时读 ref 需要一次强制重绘，用 setPlayheadT 复用（它本来就是控制播放头的）。
    const xfRef = useRef({ type: "", busy: false, msg: "", err: false });
    const xfTick = (patch) => {
      Object.assign(xfRef.current, patch);
      setPlayheadT((t) => t);   // 触发一次重绘，不改值
    };
    const runExport = async () => {
      const st = xfRef.current;
      if (st.busy) return;
      xfTick({ busy: true, err: false, msg: "" });
      try {
        const body = st.type ? { transition: { type: st.type, sec: 0.4 } } : {};
        const res = await fetch(prefix + "/cmd/export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await res.json();
        if (!res.ok || j.error) {
          xfTick({ busy: false, err: true, msg: j.error ?? ("HTTP " + res.status) });
          return;
        }
        const nm = String(j.path ?? "").split(/[\/\\]/).pop();
        const cut = j.xfade
          ? " · 转场 " + j.xfade.applied + " 处，时长减少 " +
            (((j.timelineDuration ?? 0) - (j.durationSec ?? 0)).toFixed(1)) + "s"
          : "";
        xfTick({ busy: false, err: false, msg: "已导出 " + nm + cut });
      } catch (e) {
        xfTick({ busy: false, err: true, msg: String(e?.message ?? e).slice(0, 60) });
      }
    };

    const loadPreview = useCallback(async () => {
      try {
        const r = await fetch(prefix + "/preview", { cache: "no-store" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        setSequence(j);
      } catch (e) { /* 预览拿不到不致命 */ }
    }, [prefix]);

    // SSE 订阅（与时间轴视图同一个数据源）
    useEffect(() => {
      let es = null;
      let closed = false;
      try {
        es = new EventSource(prefix + "/events");
        es.addEventListener("snapshot", (e) => {
          try {
            const j = JSON.parse(e.data);
            setState(j.state); setSummary(j.summary); setConn("live");
            loadPreview();
          } catch { /* ignore */ }
        });
        es.addEventListener("timeline", () => {
          fetch(prefix + "/snapshot", { cache: "no-store" })
            .then((r) => r.json())
            .then((j) => { if (!closed) { setState(j.state); setSummary(j.summary); loadPreview(); } })
            .catch(() => {});
        });
        es.addEventListener("error", () => setConn("error"));
      } catch (e) {
        setErr(String(e));
      }
      return () => { closed = true; try { es?.close(); } catch { /* ignore */ } };
    }, [prefix]);

    const tracks = state?.tracks ?? [];
    const allClips = useMemo(() => tracks.flatMap((t) => t.clips), [tracks]);
    const selectedClip = useMemo(
      () => allClips.find((c) => c.id === selectedClipId) ?? null,
      [allClips, selectedClipId]
    );

    const useAsset = useCallback(async (asset, clip) => {
      try {
        const res = await fetch(`${prefix}/cmd/replace-clip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clipId: clip.id, path: asset.path, filename: asset.name }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        setErr(null);
      } catch (e) { setErr(e.message); }
    }, [prefix]);

    return h("div", { style: { width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--dsw-canvas-bg, #0d1117)", overflow: "hidden" } },
      h("div", {
        style: {
          display: "flex", alignItems: "center", gap: 2, padding: "6px 10px",
          borderBottom: "1px solid rgba(128,128,128,.2)", flex: "0 0 auto",
        },
      },
        h("span", {
          title: conn === "live" ? "已连上" : conn === "error" ? "连接中断" : "连接中",
          style: { width: 7, height: 7, borderRadius: "50%", marginRight: 6, display: "inline-block",
            background: conn === "live" ? "#3fb950" : conn === "error" ? "#f85149" : "#8b949e" },
        }),
        PANEL_TABS.map((t) =>
          h("button", {
            key: t.id,
            onClick: () => setPanel(t.id),
            style: {
              ...btn,
              padding: "3px 12px",
              border: "none",
              borderBottom: panel === t.id ? "2px solid #58a6ff" : "2px solid transparent",
              borderRadius: 0,
              background: "transparent",
              color: panel === t.id ? "#58a6ff" : "inherit",
              opacity: panel === t.id ? 1 : 0.6,
              fontWeight: panel === t.id ? 600 : 400,
            },
          }, `${t.icon} ${t.label}`)
        ),
        h("div", { style: { flex: 1 } }),

        // ★ 2026-10-18（F8）：导出按钮 + 转场选择。
        //   ⚠ 零新增 hook —— 状态在 xfRef（useRef）里，见本组件开头注释。
        h("select", {
          value: xfRef.current.type,
          disabled: xfRef.current.busy,
          title: "段间转场。加了转场总时长会变短（每处吃掉 0.4s）",
          onChange: (e) => {
            xfRef.current.type = e.target.value;
            xfTick({ msg: "" });
          },
          style: {
            height: 22, border: "none", borderRadius: 4,
            background: "transparent", color: "inherit",
            fontSize: 11, fontFamily: "inherit", cursor: "pointer",
            opacity: 0.75, maxWidth: 130, flex: "0 0 auto",
          },
        }, ...TRANSITION_OPTIONS.map((o) => h("option", { key: o.v, value: o.v }, o.t))),

        h("button", {
          disabled: xfRef.current.busy || !summary?.exportable,
          title: summary?.exportable
            ? "合成成片（ffmpeg 一次渲染）"
            : `还不能导出：${summary?.pending ?? 0} 段未生成 / ${summary?.failed ?? 0} 段失败`,
          onClick: runExport,
          style: {
            ...btn,
            padding: "2px 10px", flex: "0 0 auto",
            background: summary?.exportable && !xfRef.current.busy ? "#238636" : "rgba(128,128,128,.18)",
            color: summary?.exportable && !xfRef.current.busy ? "#fff" : "inherit",
            border: "none", borderRadius: 4, fontWeight: 600, fontSize: 10,
            opacity: xfRef.current.busy ? 0.6 : (summary?.exportable ? 1 : 0.5),
            cursor: summary?.exportable && !xfRef.current.busy ? "pointer" : "not-allowed",
          },
        }, xfRef.current.busy ? "导出中…" : "导出成片"),

        xfRef.current.msg
          ? h("span", {
              title: xfRef.current.msg,
              style: {
                fontSize: 10, flex: "0 1 auto", minWidth: 0, maxWidth: 240,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                color: xfRef.current.err ? "#f85149" : "#3fb950",
              },
            }, xfRef.current.msg)
          : null,

        summary ? h("span", { style: { fontSize: 10, opacity: 0.45, flex: "0 0 auto" } },
          `${summary.total} 段 · ${summary.durationSec ?? 0}s` +
          (summary.running ? ` · ${summary.running} 生成中` : "")) : null
      ),

      err ? h("div", { onClick: () => setErr(null), style: { padding: "5px 12px", background: "rgba(248,81,73,.12)", color: "#f85149", fontSize: 11, cursor: "pointer" } }, err) : null,

      h("div", { style: { flex: 1, overflow: "hidden" } },
        panel === "preview"
          ? h(PreviewPlayer, {
              prefix,
              sequence,
              current: selectedClip,
              onTimeChange: setPlayheadT,
              onSelectClip: setSelectedClipId,
            })
          : panel === "assets"
          ? h(AssetsPanel, { prefix, onUse: useAsset, selectedClip })
          : panel === "audio"
          ? h(AudioPanel, { prefix, tracks, selectedClip, onSelect: (c) => setSelectedClipId(c.id) })
          : h(TimelinePanelLazy, { prefix, tracks, state, summary, onSelectClip: setSelectedClipId, selectedClipId, playheadT })
      )
    );
  }

  function TimelinePanelLazy({ prefix, tracks, state, summary, onSelectClip, selectedClipId, playheadT }) {
    const totalSec = useMemo(() => {
      let max = 0;
      for (const tr of tracks) {
        let t = 0;
        for (const c of tr.clips) {
          const base = (c.out - c.in) / (c.speed || 1);
          t += c.trim ? Math.max(0, Math.min(c.trim.endSec, base) - Math.min(c.trim.startSec, base)) : base;
        }
        if (t > max) max = t;
      }
      return max;
    }, [tracks]);

    const sel = useMemo(() => {
      if (!selectedClipId) return null;
      for (const tr of tracks) {
        const c = tr.clips.find((x) => x.id === selectedClipId);
        if (c) return c;
      }
      return null;
    }, [tracks, selectedClipId]);

    return h("div", { style: { display: "flex", height: "100%", overflow: "hidden" } },
      h("div", { style: { flex: 1, overflow: "auto", padding: "8px 0", minWidth: 0 } },
        tracks.map((track) => {
          return h("div", { key: track.id, style: { marginBottom: 8 } },
            h("div", { style: { fontSize: 10, opacity: 0.5, padding: "0 12px 4px" } },
              `${track.kind === "video" ? "▣ 视频" : "♪ 音频"} · ${track.name} · ${track.clips.length} 段`),
            h("div", { style: { display: "flex", gap: 6, padding: "0 12px", overflowX: "auto" } },
              track.clips.map((c, i) => {
              const base = (c.out - c.in) / (c.speed || 1);
              const dur = c.trim ? Math.max(0, Math.min(c.trim.endSec, base) - Math.min(c.trim.startSec, base)) : base;
              const isSel = selectedClipId === c.id;
              const color = track.kind === "video" ? "#58a6ff" : "#d29922";
              return h("div", {
                key: c.id,
                onClick: () => onSelectClip(c.id),
                title: c.shot?.prompt?.slice(0, 150) ?? c.name,
                style: {
                  flex: `0 0 ${Math.max(60, dur * 22)}px`, height: 46, borderRadius: 5,
                  padding: "4px 7px", fontSize: 10, cursor: "pointer",
                  background: color + "1a",
                  border: `1.5px solid ${isSel ? color : color + "55"}`,
                  overflow: "hidden",
                },
              },
                h("div", { style: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                  `${i + 1}. ${c.name ?? "片段"}`),
                h("div", { style: { opacity: 0.55, fontSize: 9 } },
                  [c.shot?.modeId, dur.toFixed(1) + "s", c.status === "done" ? "就绪" : c.status === "failed" ? "失败" : "待生成"]
                    .filter(Boolean).join(" · "))
              );
            }),
            track.clips.length === 0
              ? h("div", { style: { fontSize: 10, opacity: 0.3, padding: "14px 0" } }, "（空轨道）")
              : null
          )
        );
      }),
      trackCountZero(tracks)
        ? h("div", { style: { padding: 40, textAlign: "center", opacity: 0.4, fontSize: 12 } },
            "时间轴是空的。用「＋ 分镜」或让 Agent 建分镜表。")
        : null
      ),

      h(ClipEditor, {
        prefix,
        clip: sel,
        summary,
        onClose: () => onSelectClip(null),
      })
    );
  }

/** ClipEditor 已移到 ./ClipEditor.mjs（Hook 顺序修复） */
function trackCountZero(tracks) {
    return tracks.every((t) => t.clips.length === 0);
  }

  return WorkbenchInner;
}