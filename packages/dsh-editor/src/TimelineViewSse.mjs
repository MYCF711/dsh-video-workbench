import { subscribeTimeline } from "./sse.mjs";

const { useState, useRef, useCallback, useMemo, useEffect } = React;
const h = React.createElement;

const KIND_COLOR = { video: "#58a6ff", audio: "#d29922" };
const STATUS_COLOR = {
  idle: "#6e7681", queued: "#9e6a03", running: "#1f6feb",
  done: "#238636", failed: "#da3633", cancelled: "#6e7681",
};
const STATUS_TEXT = {
  idle: "待生成", queued: "排队", running: "生成中",
  done: "就绪", failed: "失败", cancelled: "已取消",
};

const btnBase = {
  padding: "3px 9px", borderRadius: 5, border: "1px solid rgba(128,128,128,.35)",
  background: "transparent", color: "inherit", fontSize: 11,
  cursor: "pointer", fontFamily: "inherit",
};
const inputStyle = {
  width: "100%", boxSizing: "border-box", padding: "4px 6px", borderRadius: 4,
  border: "1px solid rgba(128,128,128,.35)", background: "rgba(0,0,0,.25)",
  color: "inherit", fontSize: 11, fontFamily: "inherit",
};

function createCommands(prefix = "/timeline") {
  const root = String(prefix).replace(/\/+$/, "");
  async function post(path, body) {
    const res = await fetch(root + "/cmd" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let j;
    try { j = text ? JSON.parse(text) : {}; }
    catch { throw new Error("返回非 JSON：" + text.slice(0, 150)); }
    if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
    return j;
  }
  return {
    addShots(shots) { return post("/add-shots", { shots }); },
    updateShot(clipId, patch) { return post("/update-shot", { clipId, patch }); },
    generate(clipIds) { return post("/generate", { clipIds }); },
    stop(clipId) { return post("/stop", { clipId }); },
    editClip(clipId, op, extra) { return post("/edit-clip", { clipId, op, ...extra }); },
    replaceClip(clipId, path, filename) { return post("/replace-clip", { clipId, path, filename }); },
    addTrack(kind) { return post("/add-track", { kind }); },
    exportTimeline() { return post("/export", {}); },
  };
}

function ClipInspector({ clip, onUpdate, onGenerate, onStop, onReplace, onDelete, onClose, running }) {
  const [draft, setDraft] = useState(() => clip?.shot?.prompt ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(clip?.shot?.prompt ?? "");
  }, [clip?.id]);

  if (!clip) return null;
  const st = clip.status ?? "idle";
  const canRun = clip.shot?.modeId && draft.trim() && !running && st !== "running" && st !== "queued";
  const base = (clip.out - clip.in) / (clip.speed || 1);
  const visible = clip.trim
    ? Math.max(0, Math.min(clip.trim.endSec, base) - Math.min(clip.trim.startSec, base))
    : base;

  async function applyPrompt() {
    if (draft === (clip.shot?.prompt ?? "")) return;
    setBusy(true);
    try { await onUpdate({ prompt: draft }); } finally { setBusy(false); }
  }

  return h("div", {
    style: {
      position: "absolute", right: 0, top: 0, bottom: 0, width: 350, zIndex: 20,
      background: "var(--dsw-canvas-node-bg, #161b22)",
      borderLeft: "1px solid rgba(128,128,128,.3)",
      display: "flex", flexDirection: "column", overflow: "hidden",
    },
  },
    h("div", { style: { padding: "8px 12px", borderBottom: "1px solid rgba(128,128,128,.2)", display: "flex", alignItems: "center", gap: 8 } },
      h("span", { style: { fontSize: 12, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, clip.name ?? "片段"),
      h("span", { style: { fontSize: 9, padding: "1px 6px", borderRadius: 9, background: STATUS_COLOR[st], color: "#fff" } }, STATUS_TEXT[st] ?? st),
      h("button", { onClick: onClose, style: { ...btnBase, padding: "0 6px", border: "none" } }, "×")
    ),

    h("div", { style: { flex: 1, overflowY: "auto", padding: "10px 12px", fontSize: 11 } },

      h("div", { style: { display: "flex", gap: 12, fontSize: 10, opacity: 0.65, marginBottom: 10, flexWrap: "wrap" } },
        h("span", null, `可见 ${visible.toFixed(2)}s`),
        h("span", null, `源 ${clip.in.toFixed(2)}~${clip.out.toFixed(2)}s`),
        clip.speed !== 1 ? h("span", null, `${clip.speed}x`) : null,
        clip.rendered?.replaced ? h("span", { style: { color: "#d29922" } }, "已替换") : null
      ),

      h("div", { style: { marginBottom: 8 } },
        h("div", { style: { fontSize: 10, opacity: 0.6, marginBottom: 3 } }, "提示词（改完点「重新生成」）"),
        h("textarea", {
          value: draft,
          onChange: (e) => setDraft(e.target.value),
          onBlur: applyPrompt,
          rows: 6,
          style: { ...inputStyle, resize: "vertical", lineHeight: 1.4 },
          disabled: !clip.shot?.modeId,
          placeholder: clip.shot?.modeId ? "" : "这段是外部素材，没有生成参数",
        }),
        draft !== (clip.shot?.prompt ?? "")
          ? h("button", { onClick: applyPrompt, disabled: busy, style: { ...btnBase, marginTop: 4, fontSize: 10 } }, busy ? "保存中…" : "保存改动")
          : null
      ),

      clip.shot?.modeId
        ? h("div", { style: { marginBottom: 10 } },
            h("div", { style: { fontSize: 10, opacity: 0.6, marginBottom: 3 } }, "参数"),
            h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } },
              h("label", null,
                h("div", { style: { fontSize: 9, opacity: 0.55 } }, "时长（秒）"),
                h("input", { type: "number", value: clip.shot.durationSec ?? "", onChange: (e) => onUpdate({ durationSec: Number(e.target.value) }), style: inputStyle })
              ),
              h("label", null,
                h("div", { style: { fontSize: 9, opacity: 0.55 } }, "种子"),
                h("input", { type: "number", value: clip.shot.seed ?? "", placeholder: "随机", onChange: (e) => onUpdate({ seed: e.target.value === "" ? null : Number(e.target.value) }), style: inputStyle })
              )
            )
          )
        : null,

      h("div", { style: { marginBottom: 10, paddingTop: 8, borderTop: "1px solid rgba(128,128,128,.15)" } },
        h("div", { style: { fontSize: 10, opacity: 0.6, marginBottom: 3 } }, "剪辑"),
        h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
          [1, 0.5, 2, 4].map((sp) =>
            h("button", {
              key: sp,
              onClick: () => onUpdate({ __speed: sp }),
              style: { ...btnBase, padding: "2px 7px", borderColor: clip.speed === sp ? "#58a6ff" : undefined, color: clip.speed === sp ? "#58a6ff" : undefined },
            }, `${sp}x`)
          ),
          clip.trim ? h("button", { onClick: () => onUpdate({ __trim: null }), style: { ...btnBase, padding: "2px 7px" } }, "清除裁剪") : null
        ),
        h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginTop: 6 } },
          h("input", {
            type: "number", step: "0.1", min: 0, placeholder: "起",
            value: clip.trim?.startSec ?? 0,
            onChange: (e) => onUpdate({ __trim: { startSec: Number(e.target.value), endSec: clip.trim?.endSec ?? base } }),
            style: { ...inputStyle, width: 62 },
          }),
          h("span", { style: { opacity: 0.5 } }, "~"),
          h("input", {
            type: "number", step: "0.1", min: 0, placeholder: "终",
            value: clip.trim?.endSec ?? base,
            onChange: (e) => onUpdate({ __trim: { startSec: clip.trim?.startSec ?? 0, endSec: Number(e.target.value) } }),
            style: { ...inputStyle, width: 62 },
          })
        )
      ),

      clip.shot?.history?.length
        ? h("div", { style: { paddingTop: 8, borderTop: "1px solid rgba(128,128,128,.15)" } },
            h("div", { style: { fontSize: 10, opacity: 0.6, marginBottom: 3 } }, `生成历史（${clip.shot.history.length}）`),
            h("div", { style: { maxHeight: 90, overflowY: "auto", fontSize: 10, opacity: 0.7 } },
              clip.shot.history.slice().reverse().slice(0, 10).map((e, i) =>
                h("div", { key: i, style: { padding: "2px 0", borderBottom: "1px solid rgba(128,128,128,.08)" } },
                  `${new Date(e.at).toLocaleTimeString("zh-CN")} · ${e.modeId ?? "?"} · ${e.elapsedMs ? (e.elapsedMs / 1000).toFixed(0) + "s" : "?"}`)
              )
            )
          )
        : null,

      clip.regenError
        ? h("div", { style: { marginTop: 8, padding: 8, borderRadius: 5, background: "rgba(248,81,73,.12)", color: "#f85149", fontSize: 10, whiteSpace: "pre-wrap" } }, clip.regenError)
        : null
    ),

    h("div", { style: { padding: "8px 12px", borderTop: "1px solid rgba(128,128,128,.2)", display: "flex", gap: 6, flexWrap: "wrap" } },
      h("button", {
        onClick: onGenerate,
        disabled: !canRun,
        title: canRun ? "用当前提示词重新生成（失败不影响已有成片）" : "需要提示词且不在生成中",
        style: {
          ...btnBase, flex: 1, minWidth: 92,
          borderColor: canRun ? "transparent" : "rgba(128,128,128,.3)",
          background: canRun ? "#238636" : "rgba(128,128,128,.12)",
          color: canRun ? "#fff" : "#8b949e",
          cursor: canRun ? "pointer" : "not-allowed", fontWeight: 600,
        },
      }, "⟳ 重新生成"),
      running
        ? h("button", { onClick: onStop, style: { ...btnBase, borderColor: "#da363366", color: "#f85149", cursor: "pointer" } }, "■ 停止")
        : null,
      h("button", { onClick: onReplace, style: btnBase }, "替换"),
      h("button", { onClick: onDelete, style: { ...btnBase, color: "#f85149" } }, "移除")
    )
  );
}

export function createTimelineView(react) {
  function TimelineView(props) {
    const t = props.t;
    const prefix = props.prefix ?? "/timeline";

    const [state, setState] = useState(null);
    const [summary, setSummary] = useState(null);
    const [conn, setConn] = useState("connecting"); // connecting | live | error
    const [selected, setSelected] = useState(null);
    const [pxPerSec, setPxPerSec] = useState(60);
    const [playhead, setPlayhead] = useState(0);
    const [err, setErr] = useState(null);
    const [modes, setModes] = useState([]);
    const [exporting, setExporting] = useState(false);
    const cmd = useMemo(() => createCommands(prefix), [prefix]);
    const subRef = useRef(null);
    const scrollRef = useRef(null);

    useEffect(() => {
      const sub = subscribeTimeline({
        prefix,
        onSnapshot: (snap) => {
          setState(snap.state);
          setSummary(snap.summary);
          setConn("live");
        },
        onChange: (evt) => {
          sub.refresh();
        },
        onError: (msg) => {
          setConn("error");
          console.warn("[timeline] SSE:", msg);
        },
      });
      subRef.current = sub;
      return () => sub.close();
    }, [prefix]);

    useEffect(() => {
      let alive = true;
      fetch("/comfy-bridge/modes", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : []))
        .then((ms) => { if (alive) setModes(ms); })
        .catch(() => {});
      return () => { alive = false; };
    }, []);

    const tracks = state?.tracks ?? [];
    const videoClips = useMemo(
      () => tracks.filter((x) => x.kind === "video").flatMap((x) => x.clips),
      [tracks]
    );
    const selClip = useMemo(() => {
      if (!selected || !state) return null;
      for (const tr of state.tracks) {
        const c = tr.clips.find((x) => x.id === selected);
        if (c) return c;
      }
      return null;
    }, [state, selected]);
    const selRunning = useMemo(
      () => (summary?.runningJobs ?? []).some((j) => j.clipId === selected),
      [summary, selected]
    );

    const totalSec = useMemo(() => {
      let max = 0;
      for (const tr of tracks) {
        let t = 0;
        for (const c of tr.clips) {
          const base = (c.out - c.in) / (c.speed || 1);
          const d = c.trim
            ? Math.max(0, Math.min(c.trim.endSec, base) - Math.min(c.trim.startSec, base))
            : base;
          t += d;
        }
        if (t > max) max = t;
      }
      return max;
    }, [tracks]);

    const run = useCallback(async (fn) => {
      try { setErr(null); await fn(); }
      catch (e) { setErr(e.message); }
    }, []);

    const addShot = useCallback(() => {
      const m = modes.find((x) => x.id === "yz") ?? modes[0];
      if (!m) { setErr("还没有拉到工作流列表（ComfyUI 桥未连上？）"); return; }
      return run(() => cmd.addShots([{
        modeId: m.id,
        prompt: m.defaults?.prompt ?? "",
        aspect: m.defaults?.aspect ?? "16:9",
        durationSec: m.defaults?.durationSec ?? 5,
        steps: m.defaults?.steps ?? null,
      }]));
    }, [modes, run, cmd]);

    const updateShot = useCallback((patch) => {
      if (!selected) return;
      if (patch.__speed != null) return run(() => cmd.editClip(selected, "speed", { speed: patch.__speed }));
      if ("__trim" in patch) return run(() => cmd.editClip(selected, "trim", { trim: patch.__trim }));
      return run(() => cmd.updateShot(selected, patch));
    }, [selected, run, cmd]);

    const generate = useCallback(() => {
      if (!selected) return;
      return run(() => cmd.generate([selected]));
    }, [selected, run, cmd]);

    const stopOne = useCallback(() => {
      if (!selected) return;
      return run(() => cmd.stop(selected));
    }, [selected, run, cmd]);

    const stopAll = useCallback(() => run(() => cmd.stop(null)), [run, cmd]);

    const replace = useCallback(() => {
      if (!selected) return;
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "video/*";
      inp.onchange = () => {
        const f = inp.files?.[0];
        if (!f) return;
        run(() => cmd.replaceClip(selected, f.name, f.name));
      };
      inp.click();
    }, [selected, run, cmd]);

    const removeClip = useCallback(() => {
      if (!selected) return;
      run(() => cmd.editClip(selected, "remove", {})).then(() => setSelected(null));
    }, [selected, run, cmd]);

    const exportAll = useCallback(async () => {
      setExporting(true);
      try { await run(() => cmd.exportTimeline()); }
      finally { setExporting(false); }
    }, [run, cmd]);

    const marks = useMemo(() => {
      const out = [];
      const step = pxPerSec >= 80 ? 0.5 : pxPerSec >= 40 ? 1 : pxPerSec >= 20 ? 2 : 5;
      for (let s = 0; s <= Math.max(totalSec + 2, 10); s += step) out.push(s);
      return out;
    }, [totalSec, pxPerSec]);

    const onRulerClick = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      setPlayhead(Math.max(0, (e.clientX - r.left + (scrollRef.current?.scrollLeft ?? 0)) / pxPerSec));
    };

    const runningCount = summary?.running ?? 0;

    return h("div", { style: { width: "100%", height: "100%", position: "relative", background: "var(--dsw-canvas-bg, #0d1117)", display: "flex", flexDirection: "column", overflow: "hidden" } },

      h("div", { style: { padding: "8px 12px", borderBottom: "1px solid rgba(128,128,128,.2)", display: "flex", gap: 8, alignItems: "center", fontSize: 12, flexWrap: "wrap", flex: "0 0 auto" } },
        h("span", { title: conn === "live" ? "已连上 host 状态" : conn === "error" ? "连接中断，正在重连" : "连接中",
          style: { width: 7, height: 7, borderRadius: "50%", background: conn === "live" ? "#3fb950" : conn === "error" ? "#f85149" : "#8b949e", display: "inline-block" } }),
        h("button", { onClick: addShot, style: { ...btnBase, padding: "3px 12px", background: "#238636", color: "#fff", borderColor: "transparent", fontWeight: 600 } }, "＋ 分镜"),
        h("span", { style: { width: 1, height: 16, background: "rgba(128,128,128,.3)" } }),
        h("button", { onClick: () => run(() => cmd.addTrack("video")), style: btnBase }, "＋视频轨"),
        h("button", { onClick: () => run(() => cmd.addTrack("audio")), style: btnBase }, "＋音频轨"),
        runningCount > 0
          ? h("button", { onClick: stopAll, style: { ...btnBase, borderColor: "#da363366", color: "#f85149" } }, `■ 全部停止（${runningCount}）`)
          : null,
        h("button", {
          onClick: exportAll,
          disabled: !summary?.exportable || exporting,
          title: summary?.exportable ? "按时间轴合成成片" : "还有未生成/失败/在跑的段",
          style: { ...btnBase, opacity: summary?.exportable ? 1 : 0.45 },
        }, exporting ? "导出中…" : "导出成片"),
        h("span", { style: { width: 1, height: 16, background: "rgba(128,128,128,.3)" } }),
        h("span", { style: { opacity: 0.6, fontSize: 11 } }, "缩放"),
        h("input", { type: "range", min: 20, max: 160, step: 10, value: pxPerSec, onChange: (e) => setPxPerSec(Number(e.target.value)), style: { width: 90 } }),
        h("div", { style: { flex: 1 } }),
        h("span", { style: { opacity: 0.55, fontSize: 11 } }, `${totalSec.toFixed(1)}s · ${summary?.total ?? 0} 段`),
        (summary?.pending ?? 0) > 0 ? h("span", { style: { color: "#d29922", fontSize: 11 } }, `${summary.pending} 待生成`) : null,
        (summary?.failed ?? 0) > 0 ? h("span", { style: { color: "#f85149", fontSize: 11 } }, `${summary.failed} 失败`) : null,
        runningCount > 0 ? h("span", { style: { color: "#58a6ff", fontSize: 11 } }, `${runningCount} 生成中`) : null
      ),

      h("div", { ref: scrollRef, style: { flex: 1, overflow: "auto", position: "relative" } },
        h("div", { onClick: onRulerClick, style: { position: "sticky", top: 0, zIndex: 5, height: 26, background: "rgba(22,27,34,.98)", borderBottom: "1px solid rgba(128,128,128,.25)", cursor: "pointer", width: Math.max(totalSec + 4, 12) * pxPerSec } },
          marks.map((s) => h("div", { key: s, style: { position: "absolute", left: s * pxPerSec, top: 0, bottom: 0, width: 1, background: "rgba(128,128,128,.3)" } },
            h("span", { style: { position: "absolute", left: 3, top: 4, fontSize: 9, opacity: 0.55, whiteSpace: "nowrap" } }, `${s}s`))),
          h("div", { style: { position: "absolute", left: playhead * pxPerSec, top: 0, bottom: 0, width: 2, background: "#f85149", zIndex: 6 } })
        ),

        tracks.map((track) => {
          let cursor = 0;
          const segs = track.clips.map((c) => {
            const base = (c.out - c.in) / (c.speed || 1);
            const d = c.trim ? Math.max(0, Math.min(c.trim.endSec, base) - Math.min(c.trim.startSec, base)) : base;
            const seg = { clip: c, start: cursor, duration: d };
            cursor += d;
            return seg;
          });
          const runningJobs = summary?.runningJobs ?? [];

          return h("div", { key: track.id, style: { display: "flex", alignItems: "stretch", minHeight: 64, borderBottom: "1px solid rgba(128,128,128,.12)" } },
            h("div", { style: { width: 96, flex: "0 0 96px", padding: "6px 8px", fontSize: 10, background: "rgba(22,27,34,.98)", borderRight: "1px solid rgba(128,128,128,.2)", display: "flex", flexDirection: "column", justifyContent: "center", gap: 2, position: "sticky", left: 0, zIndex: 4 } },
              h("span", { style: { fontWeight: 600, color: KIND_COLOR[track.kind] } }, track.kind === "video" ? "▣ 视频" : "♪ 音频"),
              h("span", { style: { opacity: 0.5 } }, track.name),
              h("span", { style: { opacity: 0.35 } }, `${track.clips.length} 段`)
            ),
            h("div", { style: { position: "relative", flex: 1, minHeight: 64, width: Math.max(totalSec + 4, 12) * pxPerSec } },
              segs.map((seg, i) => {
                const c = seg.clip;
                const w = Math.max(24, seg.duration * pxPerSec);
                const isSel = selected === c.id;
                const st = c.status ?? "idle";
                const isRunning = runningJobs.some((j) => j.clipId === c.id);
                return h("div", {
                  key: c.id,
                  onClick: () => setSelected(c.id),
                  title: c.shot?.prompt ? c.shot.prompt.slice(0, 200) : c.name,
                  style: {
                    position: "absolute", left: seg.start * pxPerSec, top: 7, width: w, height: 50,
                    borderRadius: 6, overflow: "hidden", cursor: "pointer",
                    background: (KIND_COLOR[track.kind] ?? "#58a6ff") + "22",
                    border: `1.5px solid ${isSel ? "#58a6ff" : (KIND_COLOR[track.kind] ?? "#58a6ff") + "77"}`,
                    boxShadow: isSel ? "0 0 0 2px rgba(88,166,255,.25)" : "none",
                    display: "flex", flexDirection: "column",
                  },
                },
                  h("div", { style: { height: 3, background: isRunning ? "#1f6feb" : STATUS_COLOR[st], flex: "0 0 3px" } }),
                  h("div", { style: { padding: "4px 6px", fontSize: 10, overflow: "hidden", flex: 1 } },
                    h("div", { style: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                      `${i + 1}. ${c.name ?? "片段"}`),
                    h("div", { style: { opacity: 0.6, fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                      [c.shot?.modeId, c.speed !== 1 ? `${c.speed}x` : null, c.trim ? "已裁" : null,
                       seg.duration.toFixed(1) + "s", isRunning ? "生成中" : STATUS_TEXT[st]].filter(Boolean).join(" · "))
                  ),
                  c.rendered?.replaced ? h("div", { style: { position: "absolute", right: 3, top: 5, fontSize: 8, padding: "0 3px", borderRadius: 3, background: "#d2992233", color: "#d29922" } }, "替换") : null,
                  c.regenError ? h("div", { style: { position: "absolute", right: 3, top: 5, fontSize: 8, padding: "0 3px", borderRadius: 3, background: "#da363333", color: "#f85149" } }, "!") : null
                );
              }),
              track.clips.length === 0 ? h("div", { style: { position: "absolute", left: 12, top: 24, fontSize: 10, opacity: 0.3 } }, "（空轨道）") : null
            )
          );
        }),

        h("div", { style: { position: "absolute", left: 96 + playhead * pxPerSec, top: 0, bottom: 0, borderLeft: "1px dashed rgba(248,81,73,.35)", pointerEvents: "none", zIndex: 3 } })
      ),

      (summary?.total ?? 0) === 0
        ? h("div", { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 10, pointerEvents: "none", color: "rgba(139,148,158,.55)", fontSize: 13 } },
            h("div", { style: { fontSize: 32, opacity: 0.25 } }, "▤"),
            h("div", null, t("empty.title")),
            h("div", { style: { fontSize: 11, opacity: 0.7 } }, t("empty.hint"))
          )
        : null,

      err ? h("div", { onClick: () => setErr(null), style: { position: "absolute", bottom: 12, left: 12, right: 370, padding: "6px 10px", borderRadius: 6, background: "rgba(248,81,73,.15)", color: "#f85149", fontSize: 11, cursor: "pointer", zIndex: 25 } }, err) : null,

      selClip ? h(ClipInspector, {
        clip: selClip,
        running: selRunning,
        onUpdate: updateShot,
        onGenerate: generate,
        onStop: stopOne,
        onReplace: replace,
        onDelete: removeClip,
        onClose: () => setSelected(null),
      }) : null
    );
  }

  return TimelineView;
}
