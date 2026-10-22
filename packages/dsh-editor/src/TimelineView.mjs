import { layoutTrack, timelineDuration, clipDuration } from "./timeline.mjs";
import {
  canRegenerate, canStopClip, clipLabel, clipVisibleDuration,
  clipSummary, setClipTrim,
} from "./shot.mjs";

const { useState, useRef, useCallback, useMemo, useEffect } = React;
const h = React.createElement;

const KIND_COLOR = { video: "#58a6ff", audio: "#d29922" };
const STATUS_COLOR = {
  idle: "#6e7681",
  queued: "#9e6a03",
  running: "#1f6feb",
  done: "#238636",
  failed: "#da3633",
  cancelled: "#6e7681",
};
const STATUS_TEXT = {
  idle: "待生成", queued: "排队", running: "生成中",
  done: "就绪", failed: "失败", cancelled: "已取消",
};

const btnBase = {
  padding: "3px 9px",
  borderRadius: 5,
  border: "1px solid rgba(128,128,128,.35)",
  background: "transparent",
  color: "inherit",
  fontSize: 11,
  cursor: "pointer",
  fontFamily: "inherit",
};

const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  padding: "4px 6px",
  borderRadius: 4,
  border: "1px solid rgba(128,128,128,.35)",
  background: "rgba(0,0,0,.25)",
  color: "inherit",
  fontSize: 11,
  fontFamily: "inherit",
};

function ClipInspector({ tl, trackId, clip, onUpdate, onRegen, onStop, onReplace, onDelete, onClose, t }) {
  if (!clip) return null;
  const gate = canRegenerate(clip);
  const stopOk = canStopClip(clip);
  const st = clip.status ?? "idle";
  const visible = clipVisibleDuration(clip);

  const setShot = (patch) => onUpdate({ shot: { ...clip.shot, ...patch } });
  const setTrim = (patch) => {
    const cur = clip.trim ?? { startSec: 0, endSec: clipDuration(clip) };
    const next = { ...cur, ...patch };
    try {
      onUpdate({ trim: setClipTrim(clip, next).trim });
    } catch (err) {
      onUpdate({ __error: err.message });
    }
  };

  return h("div", {
    style: {
      position: "absolute", right: 0, top: 0, bottom: 0, width: 340, zIndex: 20,
      background: "var(--dsw-canvas-node-bg, #161b22)",
      borderLeft: "1px solid rgba(128,128,128,.3)",
      display: "flex", flexDirection: "column", overflow: "hidden",
    },
  },
    h("div", {
      style: {
        padding: "8px 12px", borderBottom: "1px solid rgba(128,128,128,.2)",
        display: "flex", alignItems: "center", gap: 8,
      },
    },
      h("span", { style: { fontSize: 12, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
        clip.name ?? "片段"),
      h("span", {
        style: { fontSize: 9, padding: "1px 6px", borderRadius: 9, background: STATUS_COLOR[st], color: "#fff", whiteSpace: "nowrap" },
      }, STATUS_TEXT[st] ?? st),
      h("button", { onClick: onClose, style: { ...btnBase, padding: "0 6px", border: "none" } }, "×")
    ),

    h("div", { style: { flex: 1, overflowY: "auto", padding: "10px 12px", fontSize: 11 } },

      h("div", { style: { display: "flex", gap: 12, fontSize: 10, opacity: 0.65, marginBottom: 10, flexWrap: "wrap" } },
        h("span", null, `可见时长 ${visible.toFixed(2)}s`),
        h("span", null, `源 ${clip.in.toFixed(2)}~${clip.out.toFixed(2)}s`),
        clip.speed !== 1 ? h("span", null, `${clip.speed}x`) : null,
        clip.rendered?.replaced ? h("span", { style: { color: "#d29922" } }, "已替换") : null
      ),

      // 提示词（★ 保留原提示词，可实时改）
      h("div", { style: { marginBottom: 10 } },
        h("div", { style: { fontSize: 10, opacity: 0.6, marginBottom: 3 } }, "提示词"),
        h("textarea", {
          value: clip.shot?.prompt ?? "",
          onChange: (e) => setShot({ prompt: e.target.value }),
          rows: 6,
          style: { ...inputStyle, resize: "vertical", lineHeight: 1.4 },
          placeholder: clip.shot?.modeId ? "改完点「重新生成」" : "这段是外部素材，没有生成参数",
          disabled: !clip.shot?.modeId,
        })
      ),

      clip.shot?.modeId
        ? h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 } },
            h("label", null,
              h("div", { style: { fontSize: 10, opacity: 0.6, marginBottom: 2 } }, "工作流"),
              h("input", { value: clip.shot.modeId, readOnly: true, style: { ...inputStyle, opacity: 0.7 } })
            ),
            h("label", null,
              h("div", { style: { fontSize: 10, opacity: 0.6, marginBottom: 2 } }, "时长（秒）"),
              h("input", {
                type: "number", value: clip.shot.durationSec ?? "",
                onChange: (e) => setShot({ durationSec: Number(e.target.value) }),
                style: inputStyle,
              })
            ),
            h("label", null,
              h("div", { style: { fontSize: 10, opacity: 0.6, marginBottom: 2 } }, "种子"),
              h("input", {
                type: "number", value: clip.shot.seed ?? "",
                placeholder: "随机",
                onChange: (e) => setShot({ seed: e.target.value === "" ? null : Number(e.target.value) }),
                style: inputStyle,
              })
            ),
            h("label", null,
              h("div", { style: { fontSize: 10, opacity: 0.6, marginBottom: 2 } }, "步数"),
              h("input", {
                type: "number", value: clip.shot.steps ?? "",
                onChange: (e) => setShot({ steps: e.target.value === "" ? null : Number(e.target.value) }),
                style: inputStyle,
              })
            )
          )
        : null,

      h("div", { style: { marginBottom: 10, paddingTop: 8, borderTop: "1px solid rgba(128,128,128,.15)" } },
        h("div", { style: { fontSize: 10, opacity: 0.6, marginBottom: 3 } }, "单段裁剪（在成片上再裁）"),
        h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
          h("input", {
            type: "number", step: "0.1", min: 0,
            value: clip.trim?.startSec ?? 0,
            onChange: (e) => setTrim({ startSec: Number(e.target.value) }),
            style: { ...inputStyle, width: 70 },
          }),
          h("span", { style: { opacity: 0.5 } }, "~"),
          h("input", {
            type: "number", step: "0.1", min: 0,
            value: clip.trim?.endSec ?? clipDuration(clip),
            onChange: (e) => setTrim({ endSec: Number(e.target.value) }),
            style: { ...inputStyle, width: 70 },
          }),
          clip.trim
            ? h("button", { onClick: () => onUpdate({ trim: null }), style: { ...btnBase, padding: "0 6px" } }, "清除")
            : null
        )
      ),

      clip.shot?.history?.length
        ? h("div", { style: { marginBottom: 10, paddingTop: 8, borderTop: "1px solid rgba(128,128,128,.15)" } },
            h("div", { style: { fontSize: 10, opacity: 0.6, marginBottom: 3 } }, `生成历史（${clip.shot.history.length}）`),
            h("div", { style: { maxHeight: 100, overflowY: "auto", fontSize: 10, opacity: 0.7 } },
              clip.shot.history.slice().reverse().map((e, i) =>
                h("div", { key: i, style: { padding: "2px 0", borderBottom: "1px solid rgba(128,128,128,.1)" } },
                  `${new Date(e.at).toLocaleTimeString("zh-CN")} · ${e.modeId} · ${e.elapsedMs ? (e.elapsedMs / 1000).toFixed(0) + "s" : "?"}`
                )
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
        onClick: onRegen,
        disabled: !gate.ok,
        title: gate.ok ? "用当前提示词重新生成这一段（失败不影响已有成片）" : gate.reason,
        style: {
          ...btnBase, flex: 1, minWidth: 90,
          borderColor: gate.ok ? "transparent" : "rgba(128,128,128,.3)",
          background: gate.ok ? "#238636" : "rgba(128,128,128,.12)",
          color: gate.ok ? "#fff" : "#8b949e",
          cursor: gate.ok ? "pointer" : "not-allowed",
          fontWeight: 600,
        },
      }, "⟳ 重新生成"),
      h("button", {
        onClick: onStop,
        disabled: !stopOk,
        style: {
          ...btnBase,
          borderColor: stopOk ? "#da363366" : "rgba(128,128,128,.3)",
          color: stopOk ? "#f85149" : "#8b949e",
          cursor: stopOk ? "pointer" : "not-allowed",
        },
      }, "■ 停止"),
      h("button", { onClick: onReplace, style: btnBase, title: "挂一个已有文件替换这一段" }, "替换"),
      h("button", { onClick: onDelete, style: { ...btnBase, color: "#f85149" }, title: "从时间轴移除（不删文件）" }, "移除")
    )
  );
}

export function createTimelineView(react, Model, bridge, Render) {
  function TimelineView(props) {
    const t = props.t;
    const [tl, setTl] = useState(() => Model.createTimeline(24));
    const [selected, setSelected] = useState(null); // { trackId, clipId }
    const [pxPerSec, setPxPerSec] = useState(60);
    const [playhead, setPlayhead] = useState(0);
    const [err, setErr] = useState(null);
    const [modes, setModes] = useState([]);
    const scrollerRef = useRef(null);
    const timers = useRef(new Map());

    const totalSec = useMemo(() => Model.timelineDuration(tl), [tl]);
    const summary = useMemo(() => {
      const vids = tl.tracks.filter((x) => x.kind === "video").flatMap((x) => x.clips);
      return Model.clipSummary(vids);
    }, [tl]);

    useEffect(() => {
      if (!bridge) return;
      let alive = true;
      bridge.modes().then((ms) => { if (alive) setModes(ms); }).catch(() => {});
      return () => { alive = false; };
    }, [bridge]);

    useEffect(() => () => { for (const id of timers.current.values()) clearInterval(id); }, []);

    const sel = useMemo(() => {
      if (!selected) return null;
      const track = tl.tracks.find((x) => x.id === selected.trackId);
      const clip = track?.clips.find((c) => c.id === selected.clipId);
      return clip ? { track, clip } : null;
    }, [tl, selected]);

    const updateClip = useCallback((patch) => {
      if (!selected) return;
      setTl((prev) => {
        const next = { ...prev, tracks: prev.tracks.map((tr) => {
          if (tr.id !== selected.trackId) return tr;
          return { ...tr, clips: tr.clips.map((c) => c.id === selected.clipId ? { ...c, ...patch } : c) };
        }) };
        next.version = (prev.version ?? 1) + 1;
        return next;
      });
      if (patch.__error) setErr(patch.__error);
    }, [selected]);

    const pollRegen = useCallback((trackId, clipId, jobId) => {
      const key = clipId;
      const old = timers.current.get(key);
      if (old) clearInterval(old);
      const id = setInterval(async () => {
        try {
          const j = await bridge.job(jobId);
          setTl((prev) => {
            const next = { ...prev, tracks: prev.tracks.map((tr) => {
              if (tr.id !== trackId) return tr;
              return { ...tr, clips: tr.clips.map((c) => {
                if (c.id !== clipId) return c;
                if (j.completed) {
                  return Model.applyRegenDone(c, { outputs: j.outputs ?? [], jobId, elapsedMs: j.elapsedMs });
                }
                return Model.applyRegenProgress(c);
              }) };
            }) };
            next.version = (prev.version ?? 1) + 1;
            return next;
          });
          if (j.completed) { clearInterval(id); timers.current.delete(key); }
        } catch (e) {
          clearInterval(id); timers.current.delete(key);
          setTl((prev) => {
            const next = { ...prev, tracks: prev.tracks.map((tr) => {
              if (tr.id !== trackId) return tr;
              return { ...tr, clips: tr.clips.map((c) => c.id === clipId ? Model.applyRegenFailed(c, e.message) : c) };
            }) };
            next.version = (prev.version ?? 1) + 1;
            return next;
          });
        }
      }, 1500);
      timers.current.set(key, id);
    }, [bridge]);

    const regen = useCallback(async () => {
      if (!sel) return;
      const gate = Model.canRegenerate(sel.clip);
      if (!gate.ok) { setErr(gate.reason); return; }
      setErr(null);
      try {
        const payload = Model.shotToPayload(sel.clip);
        const r = await bridge.generate(payload.modeId, payload);
        setTl((prev) => {
          const next = { ...prev, tracks: prev.tracks.map((tr) => {
            if (tr.id !== sel.track.id) return tr;
            return { ...tr, clips: tr.clips.map((c) => c.id === sel.clip.id ? Model.applyRegenStart(c, { jobId: r.jobId, promptId: r.promptId }) : c) };
          }) };
          next.version = (prev.version ?? 1) + 1;
          return next;
        });
        pollRegen(sel.track.id, sel.clip.id, r.jobId);
      } catch (e) {
        setErr(e.message);
      }
    }, [sel, bridge, pollRegen]);

    const stop = useCallback(async () => {
      if (!sel || !Model.canStopClip(sel.clip)) return;
      try {
        await bridge.cancel(sel.clip.jobId);
        const tm = timers.current.get(sel.clip.id);
        if (tm) { clearInterval(tm); timers.current.delete(sel.clip.id); }
        updateClip(Model.applyRegenCancelled(sel.clip));
      } catch (e) { setErr(e.message); }
    }, [sel, bridge, updateClip]);

    const replace = useCallback(() => {
      if (!sel) return;
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "video/*";
      inp.onchange = () => {
        const f = inp.files?.[0];
        if (!f) return;
        updateClip(Model.replaceRendered(sel.clip, {
          path: f.name, url: URL.createObjectURL(f), filename: f.name, durationSec: null,
        }));
      };
      inp.click();
    }, [sel, updateClip]);

    const removeClip = useCallback(() => {
      if (!sel) return;
      setTl((prev) => {
        const next = { ...prev, tracks: prev.tracks.map((tr) => {
          if (tr.id !== sel.track.id) return tr;
          return { ...tr, clips: tr.clips.filter((c) => c.id !== sel.clip.id) };
        }) };
        next.version = (prev.version ?? 1) + 1;
        return next;
      });
      setSelected(null);
    }, [sel]);

    const addTrack = useCallback((kind) => {
      setTl((prev) => {
        const next = { ...prev, tracks: [...prev.tracks] };
        Model.addTrack(next, kind);
        return next;
      });
    }, []);

    const addShotSlot = useCallback(() => {
      if (!modes.length) { setErr("还没有拉到工作流列表"); return; }
      const m = modes.find((x) => x.id === "yz") ?? modes[0];
      setTl((prev) => {
        const vTrack = prev.tracks.find((x) => x.kind === "video");
        const next = { ...prev, tracks: prev.tracks.map((tr) => ({ ...tr, clips: [...tr.clips] })) };
        const target = next.tracks.find((x) => x.id === vTrack.id);
        Model.addClip(next, target.id, {
          src: "（待生成）",
          in: 0, out: m.defaults?.durationSec ?? 5,
          name: `分镜 ${target.clips.length + 1}`,
          shot: Model.createShot({
            modeId: m.id,
            prompt: m.defaults?.prompt ?? "",
            aspect: m.defaults?.aspect ?? "16:9",
            durationSec: m.defaults?.durationSec ?? 5,
            steps: m.defaults?.steps ?? null,
          }),
          status: "idle",
        });
        return next;
      });
    }, [modes]);

    const rulerMarks = useMemo(() => {
      const out = [];
      const step = pxPerSec >= 80 ? 0.5 : pxPerSec >= 40 ? 1 : pxPerSec >= 20 ? 2 : 5;
      const max = Math.max(totalSec + 2, 10);
      for (let s = 0; s <= max; s += step) out.push(s);
      return out;
    }, [totalSec, pxPerSec]);

    const onRulerClick = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - r.left + (scrollerRef.current?.scrollLeft ?? 0);
      setPlayhead(Math.max(0, x / pxPerSec));
    };

    return h("div", { style: { width: "100%", height: "100%", position: "relative", background: "var(--dsw-canvas-bg, #0d1117)", display: "flex", flexDirection: "column", overflow: "hidden" } },

      h("div", {
        style: {
          padding: "8px 12px", borderBottom: "1px solid rgba(128,128,128,.2)",
          display: "flex", gap: 8, alignItems: "center", fontSize: 12, flexWrap: "wrap", flex: "0 0 auto",
        },
      },
        h("button", { onClick: addShotSlot, style: { ...btnBase, padding: "3px 12px", background: "#238636", color: "#fff", borderColor: "transparent", fontWeight: 600 } }, "＋ 分镜"),
        h("span", { style: { width: 1, height: 16, background: "rgba(128,128,128,.3)" } }),
        h("button", { onClick: () => addTrack("video"), style: btnBase }, "＋视频轨"),
        h("button", { onClick: () => addTrack("audio"), style: btnBase }, "＋音频轨"),
        h("span", { style: { width: 1, height: 16, background: "rgba(128,128,128,.3)" } }),
        h("span", { style: { opacity: 0.6, fontSize: 11 } }, "缩放"),
        h("input", {
          type: "range", min: 20, max: 160, step: 10, value: pxPerSec,
          onChange: (e) => setPxPerSec(Number(e.target.value)),
          style: { width: 100 },
        }),
        h("span", { style: { width: 1, height: 16, background: "rgba(128,128,128,.3)" } }),
        h("span", { style: { opacity: 0.6, fontSize: 11 } },
          `${totalSec.toFixed(1)}s · ${summary.total} 段`
        ),
        summary.pending > 0 ? h("span", { style: { color: "#d29922", fontSize: 11 } }, `${summary.pending} 待生成`) : null,
        summary.failed > 0 ? h("span", { style: { color: "#f85149", fontSize: 11 } }, `${summary.failed} 失败`) : null,
        summary.running > 0 ? h("span", { style: { color: "#58a6ff", fontSize: 11 } }, `${summary.running} 生成中`) : null,
        h("div", { style: { flex: 1 } }),
        h("span", { style: { opacity: 0.4, fontSize: 10 } }, `播放头 ${playhead.toFixed(2)}s`)
      ),

      h("div", { style: { flex: 1, overflow: "auto", position: "relative" }, ref: scrollerRef },

        h("div", {
          onClick: onRulerClick,
          style: {
            position: "sticky", top: 0, zIndex: 5, height: 26,
            background: "rgba(22,27,34,.98)", borderBottom: "1px solid rgba(128,128,128,.25)",
            cursor: "pointer", width: Math.max(totalSec + 4, 12) * pxPerSec,
          },
        },
          rulerMarks.map((s) =>
            h("div", {
              key: s,
              style: { position: "absolute", left: s * pxPerSec, top: 0, bottom: 0, width: 1, background: "rgba(128,128,128,.3)" },
            },
              h("span", { style: { position: "absolute", left: 3, top: 4, fontSize: 9, opacity: 0.55, whiteSpace: "nowrap" } }, `${s}s`)
            )
          ),
          h("div", {
            style: { position: "absolute", left: playhead * pxPerSec, top: 0, bottom: 0, width: 2, background: "#f85149", zIndex: 6 },
          })
        ),

        tl.tracks.map((track) => {
          const segs = Model.layoutTrack(track);
          return h("div", { key: track.id, style: { display: "flex", alignItems: "stretch", minHeight: 62, borderBottom: "1px solid rgba(128,128,128,.12)" } },
            h("div", {
              style: {
                width: 96, flex: "0 0 96px", padding: "6px 8px", fontSize: 10,
                background: "rgba(22,27,34,.98)", borderRight: "1px solid rgba(128,128,128,.2)",
                display: "flex", flexDirection: "column", justifyContent: "center", gap: 2,
                position: "sticky", left: 0, zIndex: 4,
              },
            },
              h("span", { style: { fontWeight: 600, color: KIND_COLOR[track.kind] } }, track.kind === "video" ? "▣ 视频" : "♪ 音频"),
              h("span", { style: { opacity: 0.5 } }, track.name),
              h("span", { style: { opacity: 0.35 } }, `${track.clips.length} 段`)
            ),

            h("div", {
              style: {
                position: "relative", flex: 1, minHeight: 62,
                width: Math.max(totalSec + 4, 12) * pxPerSec,
                backgroundImage: "repeating-linear-gradient(90deg, rgba(128,128,128,.06) 0 1px, transparent 1px " + pxPerSec + "px)",
              },
            },
              segs.map((seg, i) => {
                const c = seg.clip;
                const w = Math.max(24, clipVisibleDuration(c) * pxPerSec);
                const left = seg.start * pxPerSec;
                const isSel = selected?.clipId === c.id;
                const st = c.status ?? "idle";
                return h("div", {
                  key: c.id,
                  onClick: () => setSelected({ trackId: track.id, clipId: c.id }),
                  title: `${clipLabel(c, i)}\n点击查看参数`,
                  style: {
                    position: "absolute", left, top: 6, width: w, height: 50,
                    borderRadius: 6, overflow: "hidden", cursor: "pointer",
                    background: (KIND_COLOR[track.kind] ?? "#58a6ff") + "22",
                    border: `1.5px solid ${isSel ? "#58a6ff" : (KIND_COLOR[track.kind] ?? "#58a6ff") + "77"}`,
                    boxShadow: isSel ? "0 0 0 2px rgba(88,166,255,.25)" : "none",
                    display: "flex", flexDirection: "column",
                  },
                },
                  h("div", { style: { height: 3, background: STATUS_COLOR[st], flex: "0 0 3px" } }),
                  h("div", { style: { padding: "4px 6px", fontSize: 10, overflow: "hidden", flex: 1 } },
                    h("div", { style: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                      `${i + 1}. ${c.name ?? c.rendered?.filename ?? "片段"}`),
                    h("div", { style: { opacity: 0.6, fontSize: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                      [
                        c.shot?.modeId,
                        c.speed !== 1 ? `${c.speed}x` : null,
                        c.trim ? "已裁" : null,
                        clipVisibleDuration(c).toFixed(1) + "s",
                        STATUS_TEXT[st],
                      ].filter(Boolean).join(" · "))
                  ),
                  st === "running"
                    ? h("div", { style: { height: 2, background: "#1f6feb", flex: "0 0 2px", animation: "none" } })
                    : null,
                  c.rendered?.replaced
                    ? h("div", { style: { position: "absolute", right: 3, top: 5, fontSize: 8, padding: "0 3px", borderRadius: 3, background: "#d2992233", color: "#d29922" } }, "替换")
                    : null,
                  c.regenError
                    ? h("div", { style: { position: "absolute", right: 3, top: 5, fontSize: 8, padding: "0 3px", borderRadius: 3, background: "#da363333", color: "#f85149" } }, "!")
                    : null
                );
              }),

              track.clips.length === 0
                ? h("div", { style: { position: "absolute", left: 12, top: 22, fontSize: 10, opacity: 0.3 } }, "（空轨道）")
                : null
            )
          );
        }),

        h("div", {
          style: { position: "absolute", left: 96 + playhead * pxPerSec, top: 0, bottom: 0, width: 0, borderLeft: "1px dashed rgba(248,81,73,.35)", pointerEvents: "none", zIndex: 3 },
        })
      ),

      err
        ? h("div", {
            onClick: () => setErr(null),
            style: { position: "absolute", bottom: 12, left: 12, right: 360, padding: "6px 10px", borderRadius: 6, background: "rgba(248,81,73,.15)", color: "#f85149", fontSize: 11, cursor: "pointer", zIndex: 25 },
          }, err)
        : null,

      sel
        ? h(ClipInspector, {
            tl, trackId: sel.track.id, clip: sel.clip, t,
            onUpdate: updateClip,
            onRegen: regen,
            onStop: stop,
            onReplace: replace,
            onDelete: removeClip,
            onClose: () => setSelected(null),
          })
        : null
    );
  }

  return TimelineView;
}
