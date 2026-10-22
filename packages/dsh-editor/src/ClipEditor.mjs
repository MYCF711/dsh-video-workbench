/**
 * 片段编辑面板。提示词为主，参数全做成胶囊按钮。
 *
 * Hook 必须在任何 early return 之前，否则 React 会抛
 * "Rendered more hooks than during the previous render" 并卸载整棵树。
 */
import { btn, input } from "./styles.mjs";

const { useState, useCallback, useEffect } = React;
const h = React.createElement;

const pill = {
  display: "inline-flex", alignItems: "center", gap: 3,
  padding: "1px 7px", borderRadius: 999,
  border: "1px solid rgba(128,128,128,.3)",
  background: "transparent", color: "inherit",
  fontSize: 9, lineHeight: "16px", cursor: "pointer",
  fontFamily: "inherit", whiteSpace: "nowrap",
};
const pillOn = {
  ...pill,
  borderColor: "#58a6ff", color: "#58a6ff", background: "rgba(88,166,255,.12)",
};
const pillGroup = { display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center" };
const rowLabel = { fontSize: 9, opacity: 0.45, marginRight: 4, flex: "0 0 auto" };
const row = { display: "flex", alignItems: "center", marginBottom: 3 };
const numPill = {
  width: 44, padding: "1px 6px", borderRadius: 999, fontSize: 9,
  border: "1px solid rgba(128,128,128,.3)",
  background: "rgba(0,0,0,.2)", color: "inherit", fontFamily: "inherit",
};

/** 一排胶囊。value 支持原始值或对象；options 元素可为值或 {v,t}。 */
function PillRow({ label, value, options, onPick, allowCustom, onCustom, unit = "", eq }) {
  const [custom, setCustom] = useState("");
  const same = (a, b) => (eq ? eq(a, b) : a === b);
  return h("div", { style: row },
    label ? h("span", { style: rowLabel }, label) : null,
    h("div", { style: pillGroup },
      options.map((o, i) => {
        const v = typeof o === "object" && "v" in o ? o.v : o;
        const text = typeof o === "object" && "t" in o ? o.t : String(o) + unit;
        return h("button", {
          key: typeof v === "object" ? `obj-${i}` : String(v),
          onClick: () => onPick(v),
          style: same(value, v) ? pillOn : pill,
        }, text);
      }),
      allowCustom
        ? h("input", {
            type: "number", step: "1", min: 1,
            value: custom, placeholder: "…",
            onChange: (e) => setCustom(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter" && custom) { onCustom(Number(custom)); setCustom(""); } },
            onBlur: () => { if (custom) { onCustom(Number(custom)); setCustom(""); } },
            style: { ...numPill, width: 36 },
          })
        : null
    )
  );
}

export function ClipEditor({ prefix, clip, onClose }) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [showMore, setShowMore] = useState(false);
  // ★ 2026-10-18（学 YUH 的 chain_from）
  const [chaining, setChaining] = useState(false);
  const [chainOk, setChainOk] = useState(false);
  const [chainErr, setChainErr] = useState(null);

  // ★ 2026-10-18（F6 人机交接）：显示这一段谁定了什么字段。
  //   在 ClipEditor 里加是安全的 —— 这个组件本来就有一组 useState 正常工作，
  //   不像 WorkbenchInner 那样一加就整片崩（那个坑见 WorkbenchView 的注释）。
  const [handoff, setHandoff] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // ★ cmd() 只接受 POST（needBody=false 不等于允许 GET）
        const r = await fetch("/timeline/cmd/handoff", { method: "POST" });
        if (!r.ok) return;
        const j = await r.json();
        if (!alive) return;
        const mine = (j.reports ?? []).find((x) => x.clipId === clip?.id);
        setHandoff(mine ?? null);
      } catch { /* 拿不到就不显示，不影响编辑 */ }
    })();
    return () => { alive = false; };
  }, [clip?.id]);

  async function unlockField(field) {
    try {
      await fetch("/timeline/cmd/handoff-unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipId: clip.id, field }),
      });
      setHandoff((h) => {
        if (!h) return h;
        const owned = { ...h.owned };
        delete owned[field];
        return { ...h, owned };
      });
    } catch { /* 忽略 */ }
  }

  /**
   * 取上一镜的尾帧，接到这一镜的参考图1。
   *
   * ★ 为什么手动触发：哪一镜接哪一镜是创作判断，不能自动。
   * ★ 依赖 host 侧 ffmpeg（浏览器做不到抽帧），走 /comfy-bridge/chain。
   */
  async function chainPrev() {
    if (chaining) return;
    setChainErr(null);
    // ★ 开始新一次尝试时先清掉「已接上一镜」——
    //   否则上一次成功、这一次失败，按钮还显示「已接上一镜」，
    //   用户会以为接上了（状态与事实不符）。
    setChainOk(false);
    setChaining(true);
    try {
      // ① 先拿时间轴快照，找「同一视频轨上、排在我前面的那一镜」
      const root = prefix.replace(/\/+$/, "");
      const snapRes = await fetch(root + "/snapshot", { cache: "no-store" });
      if (!snapRes.ok) { setChainErr(`拿快照失败 HTTP ${snapRes.status}`); return; }
      const snap = await snapRes.json();
      const track = (snap?.state?.tracks ?? []).find(
        (t) => t.kind === "video" && (t.clips ?? []).some((c) => c.id === clip.id)
      );
      if (!track) { setChainErr("找不到这镜所在的视频轨"); return; }
      const idx = track.clips.findIndex((c) => c.id === clip.id);
      if (idx <= 0) { setChainErr("这是第一镜，没有上一镜"); return; }
      const prevPath = track.clips[idx - 1]?.rendered?.path;
      if (!prevPath) { setChainErr("上一镜还没生成"); return; }

      // ② 让 M1 抽它的尾帧
      // ★ 注意：抽帧是【M1（comfy-bridge）】的能力，不是 /timeline 的。
      //   root 是 ClipEditor 的 prefix（= /timeline），拿它拼 /chain 会 405。
      //   这里必须显式用 /comfy-bridge。
      const BRIDGE = "/comfy-bridge";
      const res = await fetch(BRIDGE + "/chain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prevVideo: prevPath, slot: "ref_image_0" }),
      });
      const j = await res.json();
      if (!j.ok) { setChainErr(j.error ?? "取帧失败"); return; }
      // ③ 把结果写回这一镜的 media
      try {
        // ★ 路由是 /timeline/cmd/update-shot（commands.mjs:52 是 prefix + "/cmd" + path）
        await fetch(root + "/cmd/update-shot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clipId: clip.id,
            patch: { media: { ...(clip.shot?.media ?? {}), [j.slot]: j.media } },
          }),
        });
      } catch (e) {
        // ★ 写回失败要和「抽帧失败」区分开：
        //   帧已经抽出来了（文件在磁盘上），只是没写进本镜的 media。
        //   这时说「已接上一镜」是假话 —— 下次生成用不到这个帧。
        setChainErr(`帧已抽出但写回失败：${String(e?.message ?? e).slice(0, 26)}`);
        return;
      }
      setChainOk(true);
      // 让外层重新拉一次快照（media 已由 host 写进 shot）
      window.dispatchEvent(new CustomEvent("dsh-timeline-changed"));
    } catch (e) {
      // 把原始异常压成一句人话 + 原错误
      setChainErr(`取帧异常：${String(e?.message ?? e).slice(0, 30)}`);
    } finally {
      setChaining(false);
    }
  }

  const clipId = clip?.id ?? null;

  useEffect(() => {
    setDraft(clip?.shot?.prompt ?? "");
    setDirty(false);
    setErr(null);
    setShowMore(false);
  }, [clipId]);

  const updateShot = useCallback(async (patch) => {
    if (!clipId) return;
    try {
      const res = await fetch(`${prefix}/cmd/update-shot`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipId, patch }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setErr(null);
    } catch (e) { setErr(e.message); }
  }, [prefix, clipId]);

  const savePrompt = useCallback(async () => {
    if (!clipId || !dirty) return;
    setSaving(true);
    try {
      const res = await fetch(`${prefix}/cmd/update-shot`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipId, patch: { prompt: draft } }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setDirty(false); setErr(null);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }, [prefix, clipId, draft, dirty]);

  const regenerate = useCallback(async () => {
    if (!clipId) return;
    if (dirty) {
      try {
        const res = await fetch(`${prefix}/cmd/update-shot`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clipId, patch: { prompt: draft } }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        setDirty(false);
      } catch (e) { setErr("保存失败：" + e.message); return; }
    }
    setRunning(true); setErr(null);
    try {
      const res = await fetch(`${prefix}/cmd/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipIds: [clipId] }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      const r = j.results?.[0];
      if (!r?.ok) throw new Error(r?.reason ?? "提交失败");

      let n = 0;
      const timer = setInterval(async () => {
        n += 1;
        if (n > 300) { clearInterval(timer); setRunning(false); return; }
        try {
          const s = await fetch(`${prefix}/snapshot`, { cache: "no-store" }).then((x) => x.json());
          let cur = null;
          for (const tr of s.state?.tracks ?? []) {
            const c = tr.clips.find((x) => x.id === clipId);
            if (c) { cur = c; break; }
          }
          if (cur && cur.status !== "running" && cur.status !== "queued") {
            clearInterval(timer);
            setRunning(false);
            if (cur.status === "failed") setErr(cur.regenError ?? "生成失败（原成片已保留）");
          }
        } catch { /* 下轮再试 */ }
      }, 2000);
    } catch (e) { setErr(e.message); setRunning(false); }
  }, [prefix, clipId, draft, dirty]);

  const stop = useCallback(async () => {
    if (!clipId) return;
    try {
      const res = await fetch(`${prefix}/cmd/stop`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipId }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setRunning(false); setErr(null);
    } catch (e) { setErr(e.message); }
  }, [prefix, clipId]);

  const edit = useCallback(async (op, extra) => {
    if (!clipId) return;
    try {
      const res = await fetch(`${prefix}/cmd/edit-clip`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clipId, op, ...extra }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      setErr(null);
    } catch (e) { setErr(e.message); }
  }, [prefix, clipId]);

  if (!clip) {
    return h("div", {
      style: {
        width: 240, flex: "0 0 240px", borderLeft: "1px solid rgba(128,128,128,.2)",
        padding: 12, fontSize: 10, opacity: 0.3,
        display: "flex", alignItems: "center", justifyContent: "center",
      },
    }, "选择片段");
  }

  const base = (clip.out - clip.in) / (clip.speed || 1);
  const dur = clip.trim ? Math.max(0, Math.min(clip.trim.endSec, base) - Math.min(clip.trim.startSec, base)) : base;
  const st = clip.status ?? "idle";
  const isRunning = running || st === "running" || st === "queued";
  const canRegen = !!clip.shot?.modeId && String(draft).trim().length > 0 && !isRunning;
  const dot = { done: "#238636", failed: "#da3633", running: "#1f6feb", queued: "#9e6a03" }[st] ?? "#6e7681";

  const CROPS = [
    { v: null, t: "全" },
    { v: { x: 0.125, y: 0, w: 0.75, h: 1 }, t: "1:1" },
    { v: { x: 0.3125, y: 0, w: 0.375, h: 1 }, t: "9:16" },
    { v: { x: 0.125, y: 0, w: 0.75, h: 0.75 }, t: "4:3" },
  ];
  const cropEq = (a, b) => {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4
      && Math.abs(a.w - b.w) < 1e-4 && Math.abs(a.h - b.h) < 1e-4;
  };
  const curCrop = CROPS.find((p) => cropEq(p.v, clip.crop ?? null))?.v ?? "__custom";
  const trimOptions = [1, 2, 3].filter((n) => n <= base + 1e-6);

  return h("div", {
    style: {
      width: 240, flex: "0 0 240px", borderLeft: "1px solid rgba(128,128,128,.2)",
      display: "flex", flexDirection: "column", overflow: "hidden",
    },
  },
    h("div", {
      style: {
        padding: "5px 8px", borderBottom: "1px solid rgba(128,128,128,.15)",
        display: "flex", alignItems: "center", gap: 4, flex: "0 0 auto",
      },
    },
      h("span", { style: { width: 5, height: 5, borderRadius: "50%", background: dot, flex: "0 0 5px" } }),
      h("span", {
        style: {
          fontSize: 10, fontWeight: 600, flex: 1, minWidth: 0,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        },
      }, clip.name ?? "片段"),
      h("span", { style: { fontSize: 9, opacity: 0.4 } }, `${dur.toFixed(1)}s`),
      h("button", {
        onClick: onClose,
        style: { ...btn, padding: "0 3px", border: "none", opacity: 0.4, fontSize: 10 },
      }, "×")
    ),

    h("div", { style: { flex: 1, overflowY: "auto", padding: "6px 8px", fontSize: 10, display: "flex", flexDirection: "column" } },

      h("textarea", {
        value: draft,
        onChange: (e) => { setDraft(e.target.value); setDirty(true); },
        onBlur: savePrompt,
        rows: 5,
        style: {
          ...input, resize: "vertical", lineHeight: 1.4, fontFamily: "inherit",
          fontSize: 10, padding: "4px 6px", marginBottom: dirty ? 3 : 6, flex: "0 0 auto",
        },
        placeholder: clip.shot?.modeId ? "描述这一镜" : "外部素材",
        disabled: !clip.shot?.modeId,
      }),
      dirty
        ? h("button", {
            onClick: savePrompt, disabled: saving,
            style: { ...pill, justifyContent: "center", marginBottom: 6, width: "100%" },
          }, saving ? "保存中…" : "保存")
        : null,

      clip.shot?.modeId
        ? h("div", { style: { flex: "0 0 auto" } },

            // ★ 2026-10-18（学 YUH 的 chain_from）：一键接上一镜的尾帧。
            //   用户手动点，而不是自动跑 —— 因为「哪一镜接哪一镜」是创作判断。
            //   后端：POST /comfy-bridge/chain（ffmpeg 抽帧 + 返回 media 对象）
            h("div", { style: row },
              h("span", { style: rowLabel }, "衔接"),
              h("div", { style: pillGroup },
                h("button", {
                  disabled: chaining,
                  title: "取上一镜的最后一帧，接到这一镜的参考图1",
                  onClick: chainPrev,
                  style: chainOk ? pillOn : pill,
                }, chaining ? "取帧中…" : (chainOk ? "已接上一镜" : "接上一镜")),
                chainErr
                  ? h("span", { style: { fontSize: 9, color: "rgb(207,34,46)", marginLeft: 4 } }, chainErr)
                  : null
              )
            ),


            // ★ F6：这一段的「谁定了什么」
            handoff && Object.keys(handoff.owned ?? {}).length
              ? h("div", { style: row },
                  h("span", { style: rowLabel }, "交接"),
                  h("div", { style: { ...pillGroup, flexWrap: "wrap", gap: 3 } },
                    ...Object.entries(handoff.owned).map(([field, by]) =>
                      h("button", {
                        key: field,
                        title: by === "user"
                          ? field + " 是你定的，Agent 改会被拒。点一下解锁"
                          : field + " 是 Agent 调的，你可以直接改",
                        onClick: () => by === "user" && unlockField(field),
                        style: {
                          ...(by === "user" ? pillOn : pill),
                          fontSize: 9, padding: "1px 6px",
                          cursor: by === "user" ? "pointer" : "default",
                        },
                      }, (by === "user" ? "🔒 " : "") + field)
                    )
                  )
                )
              : null,
            h(PillRow, {
              label: "时长",
              value: clip.shot.durationSec,
              options: [5, 10, 15],
              unit: "s",
              onPick: (v) => updateShot({ durationSec: v }),
              allowCustom: true,
              onCustom: (v) => v > 0 && updateShot({ durationSec: v }),
            }),
            h(PillRow, {
              label: "变速",
              value: clip.speed,
              options: [0.5, 1, 1.5, 2, 4],
              unit: "×",
              onPick: (v) => edit("speed", { speed: v }),
            }),
            h(PillRow, {
              label: "画面",
              value: curCrop,
              options: CROPS,
              onPick: (v) => edit("crop", { crop: v }),
              eq: cropEq,
            }),
            h(PillRow, {
              label: "裁剪",
              value: clip.trim
                ? (Math.abs(clip.trim.startSec) < 1e-6 && trimOptions.includes(clip.trim.endSec) ? clip.trim.endSec : "__c")
                : null,
              options: [{ v: null, t: "完整" }, ...trimOptions.map((n) => ({ v: n, t: `前${n}s` }))],
              onPick: (v) => edit("trim", { trim: v == null ? null : { startSec: 0, endSec: v } }),
            }),
            h("div", { style: row },
              h("span", { style: rowLabel }, "种子"),
              h("div", { style: pillGroup },
                h("button", {
                  onClick: () => updateShot({ seed: null }),
                  style: clip.shot.seed == null ? pillOn : pill,
                }, "随机"),
                h("input", {
                  type: "number",
                  value: clip.shot.seed ?? "",
                  placeholder: "固定",
                  onChange: (e) => updateShot({ seed: e.target.value === "" ? null : Number(e.target.value) }),
                  style: { ...numPill, width: 62 },
                })
              )
            )
          )
        : null,

      h("button", {
        onClick: () => setShowMore(!showMore),
        style: { ...pill, marginTop: 4, width: "100%", justifyContent: "center", border: "none" },
      }, showMore ? "▾ 收起" : "▸ 更多"),

      showMore
        ? h("div", { style: { marginTop: 4 } },
            h("div", { style: row },
              h("span", { style: rowLabel }, "精细"),
              ["x", "y", "w", "h"].map((k) =>
                h("input", {
                  key: k,
                  type: "number", step: "0.05", min: 0, max: 1, title: k, placeholder: k,
                  value: clip.crop?.[k] ?? (k === "w" || k === "h" ? 1 : 0),
                  onChange: (e) => {
                    const cur = clip.crop ?? { x: 0, y: 0, w: 1, h: 1 };
                    const next = { ...cur, [k]: Number(e.target.value) };
                    if (next.x + next.w > 1) {
                      if (k === "x") next.w = Math.max(0.01, 1 - next.x);
                      else next.x = Math.max(0, 1 - next.w);
                    }
                    if (next.y + next.h > 1) {
                      if (k === "y") next.h = Math.max(0.01, 1 - next.y);
                      else next.y = Math.max(0, 1 - next.h);
                    }
                    edit("crop", { crop: next });
                  },
                  style: { ...numPill, width: 32, fontSize: 8 },
                })
              )
            ),
            clip.shot?.history?.length
              ? h("div", { style: { fontSize: 8, opacity: 0.45, marginTop: 4 } },
                  clip.shot.history.slice().reverse().slice(0, 4).map((e, i) =>
                    h("div", { key: i },
                      `${new Date(e.at).toLocaleTimeString("zh-CN")} · ${e.elapsedMs ? Math.round(e.elapsedMs / 1000) + "s" : "?"}`)
                  )
                )
              : null
          )
        : null,

      err
        ? h("div", {
            style: {
              marginTop: 4, padding: 5, borderRadius: 4, flex: "0 0 auto",
              background: "rgba(248,81,73,.12)", color: "#f85149", fontSize: 9,
              whiteSpace: "pre-wrap", lineHeight: 1.35,
            },
          }, err)
        : null
    ),

    h("div", {
      style: {
        padding: "5px 8px", borderTop: "1px solid rgba(128,128,128,.15)",
        display: "flex", gap: 4, flex: "0 0 auto",
      },
    },
      h("button", {
        onClick: regenerate,
        disabled: !canRegen,
        title: canRegen ? "用当前提示词重新生成" : (!clip.shot?.modeId ? "无生成参数" : isRunning ? "生成中" : "提示词为空"),
        style: {
          ...pill, flex: 1, justifyContent: "center", padding: "3px 8px",
          fontWeight: 600, fontSize: 10,
          background: canRegen ? "#238636" : "rgba(128,128,128,.10)",
          color: canRegen ? "#fff" : "#8b949e",
          borderColor: "transparent",
          cursor: canRegen ? "pointer" : "not-allowed",
        },
      }, isRunning ? "生成中…" : "⟳ 生成"),
      isRunning
        ? h("button", {
            onClick: stop,
            style: { ...pill, padding: "3px 8px", color: "#f85149", borderColor: "#da363366" },
          }, "■")
        : null
    )
  );
}