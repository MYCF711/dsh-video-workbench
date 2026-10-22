/**
 * dsh-editor client bundle — 由 build.mjs 生成，勿手改。
 *
 * 客户端很薄：订阅 host 的 SSE 状态 + 发命令回 host。
 * 所有业务逻辑（时间轴模型、分镜状态机、ffmpeg 渲染）都在 host 侧。
 */
window.__ModuleLoader__.load({
  id: "dsh-editor",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var __platformReact = require("react");

    var __impl = (function (React) {
return (() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // .build/entry.js
  var entry_exports = {};
  __export(entry_exports, {
    apply: () => apply,
    inject: () => inject
  });
  var import_react = __toESM(__require("react"), 1);

  // src/styles.mjs
  var btn = {
    padding: "3px 9px",
    borderRadius: 5,
    border: "1px solid rgba(128,128,128,.35)",
    background: "transparent",
    color: "inherit",
    fontSize: 11,
    cursor: "pointer",
    fontFamily: "inherit"
  };
  var input = {
    width: "100%",
    boxSizing: "border-box",
    padding: "4px 6px",
    borderRadius: 4,
    border: "1px solid rgba(128,128,128,.35)",
    background: "rgba(0,0,0,.25)",
    color: "inherit",
    fontSize: 11,
    fontFamily: "inherit"
  };

  // src/ClipEditor.mjs
  var { useState, useCallback, useEffect } = React;
  var h = React.createElement;
  var pill = {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    padding: "1px 7px",
    borderRadius: 999,
    border: "1px solid rgba(128,128,128,.3)",
    background: "transparent",
    color: "inherit",
    fontSize: 9,
    lineHeight: "16px",
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap"
  };
  var pillOn = {
    ...pill,
    borderColor: "#58a6ff",
    color: "#58a6ff",
    background: "rgba(88,166,255,.12)"
  };
  var pillGroup = { display: "flex", flexWrap: "wrap", gap: 3, alignItems: "center" };
  var rowLabel = { fontSize: 9, opacity: 0.45, marginRight: 4, flex: "0 0 auto" };
  var row = { display: "flex", alignItems: "center", marginBottom: 3 };
  var numPill = {
    width: 44,
    padding: "1px 6px",
    borderRadius: 999,
    fontSize: 9,
    border: "1px solid rgba(128,128,128,.3)",
    background: "rgba(0,0,0,.2)",
    color: "inherit",
    fontFamily: "inherit"
  };
  function PillRow({ label, value, options, onPick, allowCustom, onCustom, unit = "", eq }) {
    const [custom, setCustom] = useState("");
    const same = (a, b) => eq ? eq(a, b) : a === b;
    return h(
      "div",
      { style: row },
      label ? h("span", { style: rowLabel }, label) : null,
      h(
        "div",
        { style: pillGroup },
        options.map((o, i) => {
          const v = typeof o === "object" && "v" in o ? o.v : o;
          const text = typeof o === "object" && "t" in o ? o.t : String(o) + unit;
          return h("button", {
            key: typeof v === "object" ? `obj-${i}` : String(v),
            onClick: () => onPick(v),
            style: same(value, v) ? pillOn : pill
          }, text);
        }),
        allowCustom ? h("input", {
          type: "number",
          step: "1",
          min: 1,
          value: custom,
          placeholder: "\u2026",
          onChange: (e) => setCustom(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter" && custom) {
              onCustom(Number(custom));
              setCustom("");
            }
          },
          onBlur: () => {
            if (custom) {
              onCustom(Number(custom));
              setCustom("");
            }
          },
          style: { ...numPill, width: 36 }
        }) : null
      )
    );
  }
  function ClipEditor({ prefix, clip, onClose }) {
    const [draft, setDraft] = useState("");
    const [saving, setSaving] = useState(false);
    const [running, setRunning] = useState(false);
    const [err, setErr] = useState(null);
    const [dirty, setDirty] = useState(false);
    const [showMore, setShowMore] = useState(false);
    const [chaining, setChaining] = useState(false);
    const [chainOk, setChainOk] = useState(false);
    const [chainErr, setChainErr] = useState(null);
    const [handoff, setHandoff] = useState(null);
    useEffect(() => {
      let alive = true;
      (async () => {
        try {
          const r = await fetch("/timeline/cmd/handoff", { method: "POST" });
          if (!r.ok) return;
          const j = await r.json();
          if (!alive) return;
          const mine = (j.reports ?? []).find((x) => x.clipId === clip?.id);
          setHandoff(mine ?? null);
        } catch {
        }
      })();
      return () => {
        alive = false;
      };
    }, [clip?.id]);
    async function unlockField(field) {
      try {
        await fetch("/timeline/cmd/handoff-unlock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clipId: clip.id, field })
        });
        setHandoff((h3) => {
          if (!h3) return h3;
          const owned = { ...h3.owned };
          delete owned[field];
          return { ...h3, owned };
        });
      } catch {
      }
    }
    async function chainPrev() {
      if (chaining) return;
      setChainErr(null);
      setChainOk(false);
      setChaining(true);
      try {
        const root = prefix.replace(/\/+$/, "");
        const snapRes = await fetch(root + "/snapshot", { cache: "no-store" });
        if (!snapRes.ok) {
          setChainErr(`\u62FF\u5FEB\u7167\u5931\u8D25 HTTP ${snapRes.status}`);
          return;
        }
        const snap = await snapRes.json();
        const track = (snap?.state?.tracks ?? []).find(
          (t) => t.kind === "video" && (t.clips ?? []).some((c) => c.id === clip.id)
        );
        if (!track) {
          setChainErr("\u627E\u4E0D\u5230\u8FD9\u955C\u6240\u5728\u7684\u89C6\u9891\u8F68");
          return;
        }
        const idx = track.clips.findIndex((c) => c.id === clip.id);
        if (idx <= 0) {
          setChainErr("\u8FD9\u662F\u7B2C\u4E00\u955C\uFF0C\u6CA1\u6709\u4E0A\u4E00\u955C");
          return;
        }
        const prevPath = track.clips[idx - 1]?.rendered?.path;
        if (!prevPath) {
          setChainErr("\u4E0A\u4E00\u955C\u8FD8\u6CA1\u751F\u6210");
          return;
        }
        const BRIDGE = "/comfy-bridge";
        const res = await fetch(BRIDGE + "/chain", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prevVideo: prevPath, slot: "ref_image_0" })
        });
        const j = await res.json();
        if (!j.ok) {
          setChainErr(j.error ?? "\u53D6\u5E27\u5931\u8D25");
          return;
        }
        try {
          await fetch(root + "/cmd/update-shot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              clipId: clip.id,
              patch: { media: { ...clip.shot?.media ?? {}, [j.slot]: j.media } }
            })
          });
        } catch (e) {
          setChainErr(`\u5E27\u5DF2\u62BD\u51FA\u4F46\u5199\u56DE\u5931\u8D25\uFF1A${String(e?.message ?? e).slice(0, 26)}`);
          return;
        }
        setChainOk(true);
        window.dispatchEvent(new CustomEvent("dsh-timeline-changed"));
      } catch (e) {
        setChainErr(`\u53D6\u5E27\u5F02\u5E38\uFF1A${String(e?.message ?? e).slice(0, 30)}`);
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
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clipId, patch })
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        setErr(null);
      } catch (e) {
        setErr(e.message);
      }
    }, [prefix, clipId]);
    const savePrompt = useCallback(async () => {
      if (!clipId || !dirty) return;
      setSaving(true);
      try {
        const res = await fetch(`${prefix}/cmd/update-shot`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clipId, patch: { prompt: draft } })
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        setDirty(false);
        setErr(null);
      } catch (e) {
        setErr(e.message);
      } finally {
        setSaving(false);
      }
    }, [prefix, clipId, draft, dirty]);
    const regenerate = useCallback(async () => {
      if (!clipId) return;
      if (dirty) {
        try {
          const res = await fetch(`${prefix}/cmd/update-shot`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clipId, patch: { prompt: draft } })
          });
          const j = await res.json();
          if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
          setDirty(false);
        } catch (e) {
          setErr("\u4FDD\u5B58\u5931\u8D25\uFF1A" + e.message);
          return;
        }
      }
      setRunning(true);
      setErr(null);
      try {
        const res = await fetch(`${prefix}/cmd/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clipIds: [clipId] })
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        const r = j.results?.[0];
        if (!r?.ok) throw new Error(r?.reason ?? "\u63D0\u4EA4\u5931\u8D25");
        let n = 0;
        const timer = setInterval(async () => {
          n += 1;
          if (n > 300) {
            clearInterval(timer);
            setRunning(false);
            return;
          }
          try {
            const s = await fetch(`${prefix}/snapshot`, { cache: "no-store" }).then((x) => x.json());
            let cur = null;
            for (const tr of s.state?.tracks ?? []) {
              const c = tr.clips.find((x) => x.id === clipId);
              if (c) {
                cur = c;
                break;
              }
            }
            if (cur && cur.status !== "running" && cur.status !== "queued") {
              clearInterval(timer);
              setRunning(false);
              if (cur.status === "failed") setErr(cur.regenError ?? "\u751F\u6210\u5931\u8D25\uFF08\u539F\u6210\u7247\u5DF2\u4FDD\u7559\uFF09");
            }
          } catch {
          }
        }, 2e3);
      } catch (e) {
        setErr(e.message);
        setRunning(false);
      }
    }, [prefix, clipId, draft, dirty]);
    const stop = useCallback(async () => {
      if (!clipId) return;
      try {
        const res = await fetch(`${prefix}/cmd/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clipId })
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        setRunning(false);
        setErr(null);
      } catch (e) {
        setErr(e.message);
      }
    }, [prefix, clipId]);
    const edit = useCallback(async (op, extra) => {
      if (!clipId) return;
      try {
        const res = await fetch(`${prefix}/cmd/edit-clip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clipId, op, ...extra })
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        setErr(null);
      } catch (e) {
        setErr(e.message);
      }
    }, [prefix, clipId]);
    if (!clip) {
      return h("div", {
        style: {
          width: 240,
          flex: "0 0 240px",
          borderLeft: "1px solid rgba(128,128,128,.2)",
          padding: 12,
          fontSize: 10,
          opacity: 0.3,
          display: "flex",
          alignItems: "center",
          justifyContent: "center"
        }
      }, "\u9009\u62E9\u7247\u6BB5");
    }
    const base = (clip.out - clip.in) / (clip.speed || 1);
    const dur = clip.trim ? Math.max(0, Math.min(clip.trim.endSec, base) - Math.min(clip.trim.startSec, base)) : base;
    const st = clip.status ?? "idle";
    const isRunning = running || st === "running" || st === "queued";
    const canRegen = !!clip.shot?.modeId && String(draft).trim().length > 0 && !isRunning;
    const dot = { done: "#238636", failed: "#da3633", running: "#1f6feb", queued: "#9e6a03" }[st] ?? "#6e7681";
    const CROPS = [
      { v: null, t: "\u5168" },
      { v: { x: 0.125, y: 0, w: 0.75, h: 1 }, t: "1:1" },
      { v: { x: 0.3125, y: 0, w: 0.375, h: 1 }, t: "9:16" },
      { v: { x: 0.125, y: 0, w: 0.75, h: 0.75 }, t: "4:3" }
    ];
    const cropEq = (a, b) => {
      if (a == null && b == null) return true;
      if (a == null || b == null) return false;
      return Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4 && Math.abs(a.w - b.w) < 1e-4 && Math.abs(a.h - b.h) < 1e-4;
    };
    const curCrop = CROPS.find((p) => cropEq(p.v, clip.crop ?? null))?.v ?? "__custom";
    const trimOptions = [1, 2, 3].filter((n) => n <= base + 1e-6);
    return h(
      "div",
      {
        style: {
          width: 240,
          flex: "0 0 240px",
          borderLeft: "1px solid rgba(128,128,128,.2)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden"
        }
      },
      h(
        "div",
        {
          style: {
            padding: "5px 8px",
            borderBottom: "1px solid rgba(128,128,128,.15)",
            display: "flex",
            alignItems: "center",
            gap: 4,
            flex: "0 0 auto"
          }
        },
        h("span", { style: { width: 5, height: 5, borderRadius: "50%", background: dot, flex: "0 0 5px" } }),
        h("span", {
          style: {
            fontSize: 10,
            fontWeight: 600,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap"
          }
        }, clip.name ?? "\u7247\u6BB5"),
        h("span", { style: { fontSize: 9, opacity: 0.4 } }, `${dur.toFixed(1)}s`),
        h("button", {
          onClick: onClose,
          style: { ...btn, padding: "0 3px", border: "none", opacity: 0.4, fontSize: 10 }
        }, "\xD7")
      ),
      h(
        "div",
        { style: { flex: 1, overflowY: "auto", padding: "6px 8px", fontSize: 10, display: "flex", flexDirection: "column" } },
        h("textarea", {
          value: draft,
          onChange: (e) => {
            setDraft(e.target.value);
            setDirty(true);
          },
          onBlur: savePrompt,
          rows: 5,
          style: {
            ...input,
            resize: "vertical",
            lineHeight: 1.4,
            fontFamily: "inherit",
            fontSize: 10,
            padding: "4px 6px",
            marginBottom: dirty ? 3 : 6,
            flex: "0 0 auto"
          },
          placeholder: clip.shot?.modeId ? "\u63CF\u8FF0\u8FD9\u4E00\u955C" : "\u5916\u90E8\u7D20\u6750",
          disabled: !clip.shot?.modeId
        }),
        dirty ? h("button", {
          onClick: savePrompt,
          disabled: saving,
          style: { ...pill, justifyContent: "center", marginBottom: 6, width: "100%" }
        }, saving ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58") : null,
        clip.shot?.modeId ? h(
          "div",
          { style: { flex: "0 0 auto" } },
          // ★ 2026-10-18（学 YUH 的 chain_from）：一键接上一镜的尾帧。
          //   用户手动点，而不是自动跑 —— 因为「哪一镜接哪一镜」是创作判断。
          //   后端：POST /comfy-bridge/chain（ffmpeg 抽帧 + 返回 media 对象）
          h(
            "div",
            { style: row },
            h("span", { style: rowLabel }, "\u8854\u63A5"),
            h(
              "div",
              { style: pillGroup },
              h("button", {
                disabled: chaining,
                title: "\u53D6\u4E0A\u4E00\u955C\u7684\u6700\u540E\u4E00\u5E27\uFF0C\u63A5\u5230\u8FD9\u4E00\u955C\u7684\u53C2\u8003\u56FE1",
                onClick: chainPrev,
                style: chainOk ? pillOn : pill
              }, chaining ? "\u53D6\u5E27\u4E2D\u2026" : chainOk ? "\u5DF2\u63A5\u4E0A\u4E00\u955C" : "\u63A5\u4E0A\u4E00\u955C"),
              chainErr ? h("span", { style: { fontSize: 9, color: "rgb(207,34,46)", marginLeft: 4 } }, chainErr) : null
            )
          ),
          // ★ F6：这一段的「谁定了什么」
          handoff && Object.keys(handoff.owned ?? {}).length ? h(
            "div",
            { style: row },
            h("span", { style: rowLabel }, "\u4EA4\u63A5"),
            h(
              "div",
              { style: { ...pillGroup, flexWrap: "wrap", gap: 3 } },
              ...Object.entries(handoff.owned).map(
                ([field, by]) => h("button", {
                  key: field,
                  title: by === "user" ? field + " \u662F\u4F60\u5B9A\u7684\uFF0CAgent \u6539\u4F1A\u88AB\u62D2\u3002\u70B9\u4E00\u4E0B\u89E3\u9501" : field + " \u662F Agent \u8C03\u7684\uFF0C\u4F60\u53EF\u4EE5\u76F4\u63A5\u6539",
                  onClick: () => by === "user" && unlockField(field),
                  style: {
                    ...by === "user" ? pillOn : pill,
                    fontSize: 9,
                    padding: "1px 6px",
                    cursor: by === "user" ? "pointer" : "default"
                  }
                }, (by === "user" ? "\u{1F512} " : "") + field)
              )
            )
          ) : null,
          h(PillRow, {
            label: "\u65F6\u957F",
            value: clip.shot.durationSec,
            options: [5, 10, 15],
            unit: "s",
            onPick: (v) => updateShot({ durationSec: v }),
            allowCustom: true,
            onCustom: (v) => v > 0 && updateShot({ durationSec: v })
          }),
          h(PillRow, {
            label: "\u53D8\u901F",
            value: clip.speed,
            options: [0.5, 1, 1.5, 2, 4],
            unit: "\xD7",
            onPick: (v) => edit("speed", { speed: v })
          }),
          h(PillRow, {
            label: "\u753B\u9762",
            value: curCrop,
            options: CROPS,
            onPick: (v) => edit("crop", { crop: v }),
            eq: cropEq
          }),
          h(PillRow, {
            label: "\u88C1\u526A",
            value: clip.trim ? Math.abs(clip.trim.startSec) < 1e-6 && trimOptions.includes(clip.trim.endSec) ? clip.trim.endSec : "__c" : null,
            options: [{ v: null, t: "\u5B8C\u6574" }, ...trimOptions.map((n) => ({ v: n, t: `\u524D${n}s` }))],
            onPick: (v) => edit("trim", { trim: v == null ? null : { startSec: 0, endSec: v } })
          }),
          h(
            "div",
            { style: row },
            h("span", { style: rowLabel }, "\u79CD\u5B50"),
            h(
              "div",
              { style: pillGroup },
              h("button", {
                onClick: () => updateShot({ seed: null }),
                style: clip.shot.seed == null ? pillOn : pill
              }, "\u968F\u673A"),
              h("input", {
                type: "number",
                value: clip.shot.seed ?? "",
                placeholder: "\u56FA\u5B9A",
                onChange: (e) => updateShot({ seed: e.target.value === "" ? null : Number(e.target.value) }),
                style: { ...numPill, width: 62 }
              })
            )
          )
        ) : null,
        h("button", {
          onClick: () => setShowMore(!showMore),
          style: { ...pill, marginTop: 4, width: "100%", justifyContent: "center", border: "none" }
        }, showMore ? "\u25BE \u6536\u8D77" : "\u25B8 \u66F4\u591A"),
        showMore ? h(
          "div",
          { style: { marginTop: 4 } },
          h(
            "div",
            { style: row },
            h("span", { style: rowLabel }, "\u7CBE\u7EC6"),
            ["x", "y", "w", "h"].map(
              (k) => h("input", {
                key: k,
                type: "number",
                step: "0.05",
                min: 0,
                max: 1,
                title: k,
                placeholder: k,
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
                style: { ...numPill, width: 32, fontSize: 8 }
              })
            )
          ),
          clip.shot?.history?.length ? h(
            "div",
            { style: { fontSize: 8, opacity: 0.45, marginTop: 4 } },
            clip.shot.history.slice().reverse().slice(0, 4).map(
              (e, i) => h(
                "div",
                { key: i },
                `${new Date(e.at).toLocaleTimeString("zh-CN")} \xB7 ${e.elapsedMs ? Math.round(e.elapsedMs / 1e3) + "s" : "?"}`
              )
            )
          ) : null
        ) : null,
        err ? h("div", {
          style: {
            marginTop: 4,
            padding: 5,
            borderRadius: 4,
            flex: "0 0 auto",
            background: "rgba(248,81,73,.12)",
            color: "#f85149",
            fontSize: 9,
            whiteSpace: "pre-wrap",
            lineHeight: 1.35
          }
        }, err) : null
      ),
      h(
        "div",
        {
          style: {
            padding: "5px 8px",
            borderTop: "1px solid rgba(128,128,128,.15)",
            display: "flex",
            gap: 4,
            flex: "0 0 auto"
          }
        },
        h("button", {
          onClick: regenerate,
          disabled: !canRegen,
          title: canRegen ? "\u7528\u5F53\u524D\u63D0\u793A\u8BCD\u91CD\u65B0\u751F\u6210" : !clip.shot?.modeId ? "\u65E0\u751F\u6210\u53C2\u6570" : isRunning ? "\u751F\u6210\u4E2D" : "\u63D0\u793A\u8BCD\u4E3A\u7A7A",
          style: {
            ...pill,
            flex: 1,
            justifyContent: "center",
            padding: "3px 8px",
            fontWeight: 600,
            fontSize: 10,
            background: canRegen ? "#238636" : "rgba(128,128,128,.10)",
            color: canRegen ? "#fff" : "#8b949e",
            borderColor: "transparent",
            cursor: canRegen ? "pointer" : "not-allowed"
          }
        }, isRunning ? "\u751F\u6210\u4E2D\u2026" : "\u27F3 \u751F\u6210"),
        isRunning ? h("button", {
          onClick: stop,
          style: { ...pill, padding: "3px 8px", color: "#f85149", borderColor: "#da363366" }
        }, "\u25A0") : null
      )
    );
  }

  // src/WorkbenchView.mjs
  var { useState: useState2, useMemo, useCallback: useCallback2, useEffect: useEffect2, useRef } = React;
  var h2 = React.createElement;
  var PANEL_TABS = [
    { id: "preview", label: "\u9884\u89C8", icon: "\u25B6" },
    { id: "timeline", label: "\u65F6\u95F4\u8F74", icon: "\u25A4" },
    { id: "assets", label: "\u7D20\u6750\u5E93", icon: "\u25A6" },
    { id: "audio", label: "\u97F3\u9891", icon: "\u266A" }
  ];
  function PreviewPlayer({ prefix, sequence, current, onTimeChange, onSelectClip }) {
    const videoRef = useRef(null);
    const [playing, setPlaying] = useState2(false);
    const [t, setT] = useState2(0);
    const [idx, setIdx] = useState2(0);
    const [err, setErr] = useState2(null);
    const [mode, setMode] = useState2("single");
    const segs = sequence?.segments ?? [];
    const seg = mode === "single" ? current ? segs.find((s) => s.clipId === current.id) : null : segs[idx];
    const total = sequence?.totalSec ?? 0;
    useEffect2(() => {
      const v = videoRef.current;
      if (!v || !seg?.url) return;
      try {
        v.currentTime = seg.seekTo ?? 0;
        v.playbackRate = seg.playbackRate ?? 1;
      } catch {
      }
    }, [seg?.clipId, seg?.url]);
    useEffect2(() => {
      if (!playing) return;
      const id = setInterval(() => {
        const v = videoRef.current;
        if (!v) return;
        const inSeg = Math.max(0, v.currentTime - (seg?.seekTo ?? 0)) / (seg?.playbackRate ?? 1);
        const globalT = mode === "single" ? (seg?.start ?? 0) + Math.min(inSeg, seg?.duration ?? 0) : (seg?.start ?? 0) + Math.min(inSeg, seg?.duration ?? 0);
        setT(globalT);
        onTimeChange?.(globalT);
        if (mode === "sequence" && inSeg >= (seg?.duration ?? 0) - 0.08) {
          if (idx + 1 < segs.length) {
            setIdx((i) => i + 1);
            setTimeout(() => {
              videoRef.current?.play().catch(() => {
              });
            }, 30);
          } else {
            setPlaying(false);
          }
        }
      }, 100);
      return () => clearInterval(id);
    }, [playing, seg?.clipId, seg?.start, seg?.duration, seg?.seekTo, seg?.playbackRate, mode, idx, segs.length, onTimeChange]);
    const toggle = useCallback2(() => {
      const v = videoRef.current;
      if (!seg?.url) {
        setErr(seg?.reason ?? "\u8FD9\u6BB5\u8FD8\u4E0D\u80FD\u9884\u89C8");
        return;
      }
      setErr(null);
      if (playing) {
        v?.pause();
        setPlaying(false);
      } else {
        v?.play().then(() => setPlaying(true)).catch((e) => setErr(e.message));
      }
    }, [playing, seg]);
    const seek = useCallback2((globalT) => {
      const target = segmentAt(sequence, globalT);
      if (!target?.url) return;
      if (mode === "sequence") {
        const i = segs.findIndex((s) => s.clipId === target.clipId);
        if (i >= 0 && i !== idx) {
          setIdx(i);
        }
      }
      setT(globalT);
      onTimeChange?.(globalT);
      const v = videoRef.current;
      if (v) {
        const local = (target.seekTo ?? 0) + target.offsetInSegment * (target.playbackRate ?? 1);
        try {
          v.currentTime = local;
        } catch {
        }
      }
    }, [sequence, mode, idx, segs, onTimeChange]);
    return h2(
      "div",
      { style: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" } },
      h2(
        "div",
        { style: { flex: 1, position: "relative", background: "#000", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0 } },
        seg?.url ? seg.kind === "video" ? h2("video", {
          ref: videoRef,
          src: seg.url,
          style: { maxWidth: "100%", maxHeight: "100%" },
          onEnded: () => setPlaying(false),
          onError: () => setErr("\u89C6\u9891\u52A0\u8F7D\u5931\u8D25\uFF08\u68C0\u67E5\u6587\u4EF6\u662F\u5426\u8FD8\u5728\uFF09"),
          playsInline: true
        }) : seg.kind === "image" ? h2("img", { src: seg.url, style: { maxWidth: "100%", maxHeight: "100%" }, alt: seg.name }) : h2("audio", { ref: videoRef, src: seg.url, controls: true, style: { width: "70%" } }) : h2(
          "div",
          { style: { color: "rgba(139,148,158,.5)", fontSize: 12, textAlign: "center", padding: 20 } },
          seg ? `\u300C${seg.name}\u300D\u8FD8\u4E0D\u80FD\u9884\u89C8\uFF1A${seg.reason ?? "\u65E0\u6587\u4EF6"}` : "\u70B9\u4E00\u4E2A\u7247\u6BB5\u5F00\u59CB\u9884\u89C8"
        ),
        err ? h2("div", { style: { position: "absolute", bottom: 8, left: 8, right: 8, padding: "5px 8px", borderRadius: 4, background: "rgba(248,81,73,.9)", color: "#fff", fontSize: 10 } }, err) : null
      ),
      h2(
        "div",
        { style: { padding: "6px 10px", borderTop: "1px solid rgba(128,128,128,.2)", display: "flex", gap: 8, alignItems: "center", fontSize: 11, flexWrap: "wrap", flex: "0 0 auto" } },
        h2(
          "button",
          { onClick: toggle, style: { ...btn, padding: "2px 12px", background: playing ? "#da3633" : "#238636", color: "#fff", borderColor: "transparent" } },
          playing ? "\u25A0 \u505C" : "\u25B6 \u64AD"
        ),
        h2("button", {
          onClick: (e) => {
            const r = e.currentTarget.parentElement.querySelector("input[type=range]");
            const b = r.getBoundingClientRect();
            seek((e.clientX - b.left) / b.width * total);
          },
          style: { ...btn, padding: "2px 6px" },
          title: "\u56DE\u5230\u5F00\u5934"
        }, "\u23EE"),
        h2("input", {
          type: "range",
          min: 0,
          max: Math.max(total, 0.1),
          step: 0.05,
          value: t,
          onChange: (e) => seek(Number(e.target.value)),
          style: { flex: 1, minWidth: 100 }
        }),
        h2(
          "span",
          { style: { fontSize: 10, opacity: 0.6, minWidth: 76 } },
          `${fmt(t)} / ${fmt(total)}`
        ),
        h2("button", {
          onClick: () => {
            setMode(mode === "single" ? "sequence" : "single");
            setPlaying(false);
          },
          title: mode === "single" ? "\u5207\u5230\u6574\u6761\u8FDE\u64AD" : "\u5207\u5230\u5355\u6BB5\u9884\u89C8",
          style: { ...btn, padding: "2px 8px", borderColor: mode === "sequence" ? "#58a6ff" : void 0, color: mode === "sequence" ? "#58a6ff" : void 0 }
        }, mode === "single" ? "\u5355\u6BB5" : "\u8FDE\u64AD"),
        seg?.playbackRate && seg.playbackRate !== 1 ? h2("span", { style: { fontSize: 10, color: "#d29922" } }, `${seg.playbackRate}x`) : null
      ),
      h2(
        "div",
        { style: { maxHeight: 90, overflowY: "auto", padding: "4px 8px", borderTop: "1px solid rgba(128,128,128,.15)", flex: "0 0 auto" } },
        segs.length === 0 ? h2("div", { style: { fontSize: 10, opacity: 0.35, padding: 6 } }, "\uFF08\u6CA1\u6709\u53EF\u9884\u89C8\u7684\u6BB5\uFF09") : segs.map(
          (s, i) => h2("button", {
            key: s.clipId,
            onClick: () => {
              onSelectClip?.(s.clipId);
              seek(s.start);
            },
            style: {
              ...btn,
              padding: "1px 7px",
              marginRight: 4,
              marginBottom: 3,
              fontSize: 10,
              opacity: s.playable ? 1 : 0.45,
              borderColor: seg?.clipId === s.clipId ? "#58a6ff" : void 0,
              color: seg?.clipId === s.clipId ? "#58a6ff" : void 0
            },
            title: s.playable ? s.name : `${s.name}\uFF08${s.reason ?? "\u4E0D\u53EF\u64AD"}\uFF09`
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
    const [items, setItems] = useState2([]);
    const [stats, setStats] = useState2(null);
    const [q, setQ] = useState2("");
    const [kind, setKind] = useState2("");
    const [loading, setLoading] = useState2(false);
    const [err, setErr] = useState2(null);
    const load = useCallback2(async () => {
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
    useEffect2(() => {
      load();
    }, [load]);
    const markCharacter = useCallback2(async (a) => {
      const cur = (a.tags ?? []).find((t) => String(t).startsWith("char:"));
      const isChar = (a.tags ?? []).includes("role:character");
      const ans = window.prompt(
        isChar ? "\u6539\u89D2\u8272\u540D\uFF08\u7559\u7A7A=\u53D6\u6D88\u89D2\u8272\u6807\u8BB0\uFF09\uFF1A" : "\u8FD9\u6761\u7D20\u6750\u5C5E\u4E8E\u54EA\u4E2A\u89D2\u8272\uFF1F\uFF08\u7559\u7A7A=\u53D6\u6D88\uFF09\uFF1A",
        cur ? String(cur).slice(5) : ""
      );
      if (ans === null) return;
      const name = String(ans).trim();
      const on = name.length > 0;
      try {
        const res = await fetch(prefix + "/cmd/character-tag", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: a.id, name, view: null, on })
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? "HTTP " + res.status);
        await load();
      } catch (e) {
        setErr(String(e?.message ?? e).slice(0, 60));
      }
    }, [prefix, load]);
    const scan = useCallback2(async () => {
      const dir = window.prompt("\u8981\u626B\u63CF\u7684\u76EE\u5F55\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF09\uFF1A", "");
      if (!dir) return;
      setLoading(true);
      try {
        const res = await fetch(`${prefix}/cmd/assets-scan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir })
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        await load();
      } catch (e) {
        setErr(e.message);
      } finally {
        setLoading(false);
      }
    }, [prefix, load]);
    return h2(
      "div",
      { style: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" } },
      h2(
        "div",
        { style: { padding: "8px 12px", borderBottom: "1px solid rgba(128,128,128,.2)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", flex: "0 0 auto" } },
        h2("button", { onClick: scan, style: { ...btn, background: "#238636", color: "#fff", borderColor: "transparent", fontWeight: 600 } }, "\uFF0B \u626B\u63CF\u76EE\u5F55"),
        h2("input", {
          placeholder: "\u641C\u7D22\u540D\u5B57/\u8DEF\u5F84/\u6807\u7B7E",
          value: q,
          onChange: (e) => setQ(e.target.value),
          style: { ...input, width: 180 }
        }),
        h2(
          "select",
          { value: kind, onChange: (e) => setKind(e.target.value), style: { ...input, width: 90 } },
          h2("option", { value: "" }, "\u5168\u90E8"),
          ["image", "video", "audio", "text", "other"].map((k) => h2("option", { key: k, value: k }, k))
        ),
        h2("button", { onClick: load, style: btn }, loading ? "\u2026" : "\u5237\u65B0"),
        h2("div", { style: { flex: 1 } }),
        stats ? h2(
          "span",
          { style: { fontSize: 11, opacity: 0.55 } },
          `${stats.total} \u9879 \xB7 ${stats.totalMB} MB` + (stats.missing ? ` \xB7 ${stats.missing} \u7F3A\u5931` : "")
        ) : null
      ),
      err ? h2("div", { style: { padding: "6px 12px", background: "rgba(248,81,73,.12)", color: "#f85149", fontSize: 11 } }, err) : null,
      h2(
        "div",
        { style: { flex: 1, overflowY: "auto", padding: 8 } },
        items.length === 0 ? h2(
          "div",
          { style: { padding: 40, textAlign: "center", opacity: 0.4, fontSize: 12 } },
          loading ? "\u52A0\u8F7D\u4E2D\u2026" : "\u8FD8\u6CA1\u6709\u7D20\u6750\u3002\u70B9\u300C\u626B\u63CF\u76EE\u5F55\u300D\u628A outputs \u6536\u8FDB\u6765\u3002"
        ) : items.map(
          (a) => h2(
            "div",
            {
              key: a.id,
              style: {
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 6,
                marginBottom: 4,
                fontSize: 11,
                background: "rgba(128,128,128,.06)",
                border: "1px solid rgba(128,128,128,.12)"
              }
            },
            h2("span", { style: { fontSize: 9, padding: "1px 5px", borderRadius: 4, background: "rgba(88,166,255,.15)", color: "#58a6ff" } }, a.kind),
            h2(
              "div",
              { style: { flex: 1, minWidth: 0 } },
              h2("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, a.name),
              h2(
                "div",
                { style: { opacity: 0.45, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                `${a.sizeMB} MB${a.group ? " \xB7 " + a.group : ""}${a.tags?.length ? " \xB7 " + a.tags.join(",") : ""}`
              )
            ),
            // ★ F1：角色标记（有标记的显示名字，一点就能改）
            h2("button", {
              onClick: () => markCharacter(a),
              title: (a.tags ?? []).includes("role:character") ? "\u5DF2\u6807\u4E3A\u89D2\u8272\uFF1A" + ((a.tags ?? []).find((t) => String(t).startsWith("char:")) ?? "\u672A\u547D\u540D").slice(5) + "\uFF08\u70B9\u51FB\u4FEE\u6539\uFF09" : "\u6807\u4E3A\u67D0\u4E2A\u89D2\u8272\u7684\u5B9A\u5986\u56FE\uFF08\u4F1A\u88AB\u81EA\u52A8\u586B\u8FDB\u53C2\u8003\u56FE\u69FD\uFF09",
              style: {
                ...btn,
                padding: "2px 6px",
                fontSize: 10,
                background: (a.tags ?? []).includes("role:character") ? "rgba(163,106,3,.18)" : "transparent",
                color: (a.tags ?? []).includes("role:character") ? "rgb(210,153,34)" : "inherit",
                border: "none"
              }
            }, (a.tags ?? []).includes("role:character") ? "\u{1F464}" : "\uFF0B"),
            selectedClip ? h2("button", {
              onClick: () => onUse(a, selectedClip),
              title: `\u6302\u5230\u300C${selectedClip.name}\u300D`,
              style: { ...btn, padding: "2px 8px" }
            }, "\u7528") : null
          )
        )
      ),
      selectedClip ? h2(
        "div",
        { style: { padding: "6px 12px", borderTop: "1px solid rgba(128,128,128,.2)", fontSize: 10, opacity: 0.6 } },
        `\u5F53\u524D\u9009\u4E2D\u7247\u6BB5\uFF1A${selectedClip.name}\uFF08\u70B9\u7D20\u6750\u53F3\u4FA7\u300C\u7528\u300D\u66FF\u6362\u5B83\uFF09`
      ) : h2(
        "div",
        { style: { padding: "6px 12px", borderTop: "1px solid rgba(128,128,128,.2)", fontSize: 10, opacity: 0.4 } },
        "\u5148\u5728\u65F6\u95F4\u8F74\u91CC\u70B9\u4E00\u4E2A\u7247\u6BB5\uFF0C\u518D\u56DE\u6765\u9009\u7D20\u6750"
      )
    );
  }
  function AudioPanel({ prefix, tracks, selectedClip, onSelect }) {
    const [err, setErr] = useState2(null);
    const [audit, setAudit] = useState2(null);
    const audioClips = useMemo(
      () => tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips),
      [tracks]
    );
    const [subsState, setSubsState] = useState2(null);
    const [subsMsg, setSubsMsg] = useState2("");
    const [subsErr, setSubsErr] = useState2(false);
    const [subsDone, setSubsDone] = useState2(0);
    const [subsTotal, setSubsTotal] = useState2(0);
    const genSubtitles = useCallback2(async () => {
      if (subsState === "running") return;
      const videoClips = tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips).filter((c) => c?.rendered?.path);
      if (!videoClips.length) {
        setSubsState("done");
        setSubsErr(true);
        setSubsMsg("\u6CA1\u6709\u5DF2\u6E32\u67D3\u7684\u7247\u6BB5");
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
          const r = await fetch(`/comfy-bridge/subtitle/transcribe`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ file: c.rendered.path })
          });
          const j = await r.json();
          if (j.ok) {
            okCount++;
            segTotal += j.count ?? 0;
          } else if (j.noAudio) {
            noAudioCount++;
          } else {
            errors.push(j.error ?? "\u672A\u77E5\u9519\u8BEF");
          }
        } catch (e) {
          errors.push(String(e?.message ?? e).slice(0, 40));
        }
        setSubsDone(i + 1);
      }
      setSubsState("done");
      const parts = [`${okCount} \u6BB5 \xB7 ${segTotal} \u6761\u5B57\u5E55`];
      if (noAudioCount) parts.push(`${noAudioCount} \u6BB5\u65E0\u97F3\u8F68`);
      if (errors.length) {
        setSubsErr(true);
        parts.push(errors[0]);
      } else {
        setSubsErr(false);
      }
      setSubsMsg(parts.join(" \xB7 "));
    }, [prefix, tracks, subsState]);
    const cutRef = useRef({ busy: false, msg: "", err: false, seams: [], defects: [] });
    const runCutAudit = async () => {
      const st = cutRef.current;
      if (st.busy) return;
      Object.assign(st, { busy: true, msg: "\u8D28\u68C0\u4E2D\u2026", err: false });
      setAudit((a) => a);
      try {
        const clips = tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips).filter((c) => c?.rendered?.path);
        if (clips.length < 2) {
          Object.assign(st, { busy: false, msg: "\u5C11\u4E8E\u4E24\u6BB5\uFF0C\u65E0\u9700\u67E5\u63A5\u7F1D", err: false });
          setAudit((a) => a);
          return;
        }
        const res = await fetch("/comfy-bridge/audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clips })
        });
        const j = await res.json();
        if (!res.ok || j.error) {
          Object.assign(st, { busy: false, msg: j.error ?? "HTTP " + res.status, err: true });
        } else {
          Object.assign(st, {
            busy: false,
            err: false,
            msg: j.summary ?? "\u8D28\u68C0\u5B8C\u6210",
            seams: j.seams ?? [],
            defects: j.defects ?? []
          });
        }
      } catch (e) {
        Object.assign(st, { busy: false, msg: String(e?.message ?? e).slice(0, 50), err: true });
      }
      setAudit((a) => a);
    };
    const refreshAudit = useCallback2(async () => {
      try {
        const r = await fetch(`${prefix}/align`, { cache: "no-store" });
        setAudit(await r.json());
      } catch (e) {
      }
    }, [prefix]);
    useEffect2(() => {
      refreshAudit();
    }, [refreshAudit, tracks]);
    const apply2 = useCallback2(async (clipId, patch) => {
      try {
        const res = await fetch(`${prefix}/cmd/edit-audio`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clipId, ...patch })
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
        setErr(null);
      } catch (e) {
        setErr(e.message);
      }
    }, [prefix]);
    return h2(
      "div",
      { style: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" } },
      h2(
        "div",
        { style: { padding: "8px 12px", borderBottom: "1px solid rgba(128,128,128,.2)", display: "flex", gap: 10, alignItems: "center", fontSize: 11, flex: "0 0 auto", flexWrap: "wrap" } },
        h2("span", { style: { fontWeight: 600 } }, `\u97F3\u9891\u8F68 \xB7 ${audioClips.length} \u6BB5`),
        audit ? h2(
          "span",
          { style: { color: audit.ok ? "#3fb950" : "#f85149" } },
          audit.ok ? "\u97F3\u753B\u5BF9\u9F50 \u2713" : `\u26A0 ${audit.problems?.[0] ?? "\u6709\u95EE\u9898"}`
        ) : null,
        audit?.warnings?.length ? h2("span", { style: { color: "#d29922", fontSize: 10 } }, audit.warnings[0]) : null,
        h2("div", { style: { flex: 1 } }),
        // ★ 2026-10-18（F9 字幕）：本机 whisper 转写，零云端。
        //   点了之后：转写视频轨每一段 → 出 SRT →（可选）烧一份硬字幕副本。
        //   默认只出 SRT，不烧 —— 烧字幕要重编码，几十秒，别让手滑付出代价。
        subsState === "running" ? h2("span", { style: { fontSize: 10, opacity: 0.7 } }, `\u8F6C\u5199\u4E2D\u2026\uFF08${subsDone}/${subsTotal}\uFF09`) : null,
        subsState === "done" && subsMsg ? h2("span", { style: { fontSize: 10, color: subsErr ? "#f85149" : "#3fb950" } }, subsMsg) : null,
        h2("button", {
          disabled: subsState === "running",
          title: "\u7ED9\u89C6\u9891\u8F68\u6BCF\u4E00\u6BB5\u751F\u6210\u5B57\u5E55\uFF08\u672C\u673A whisper\uFF0C\u4E0D\u8054\u7F51\uFF09",
          onClick: genSubtitles,
          style: { ...btn, opacity: subsState === "running" ? 0.5 : 1 }
        }, subsState === "running" ? "\u8F6C\u5199\u4E2D\u2026" : "\u751F\u6210\u5B57\u5E55"),
        cutRef.current.msg ? h2("span", {
          title: cutRef.current.seams.map(
            (s) => (s.fromName ?? s.from) + "\u2192" + (s.toName ?? s.to) + " ssim=" + (s.ssim ?? 0).toFixed(2) + (s.ok ? " \u63A5\u5F97\u4E0A" : " \u63A5\u4E0D\u4E0A")
          ).join("\n"),
          style: {
            fontSize: 10,
            maxWidth: 240,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: cutRef.current.err ? "#f85149" : "#3fb950"
          }
        }, cutRef.current.msg) : null,
        h2("button", {
          disabled: cutRef.current.busy,
          title: "\u753B\u9762\u8D28\u68C0\uFF1A\u67E5\u76F8\u90BB\u4E24\u6BB5\u63A5\u4E0D\u63A5\u5F97\u4E0A\u3001\u6BB5\u5185\u6709\u6CA1\u6709\u5361\u5E27\u9ED1\u573A",
          onClick: runCutAudit,
          style: { ...btn, opacity: cutRef.current.busy ? 0.5 : 1 }
        }, cutRef.current.busy ? "\u8D28\u68C0\u4E2D\u2026" : "\u753B\u9762\u8D28\u68C0"),
        h2("button", { onClick: refreshAudit, style: btn }, "\u91CD\u65B0\u68C0\u67E5")
      ),
      err ? h2("div", { style: { padding: "6px 12px", background: "rgba(248,81,73,.12)", color: "#f85149", fontSize: 11 } }, err) : null,
      h2(
        "div",
        { style: { flex: 1, overflowY: "auto", padding: 8 } },
        audioClips.length === 0 ? h2(
          "div",
          { style: { padding: 40, textAlign: "center", opacity: 0.4, fontSize: 12 } },
          "\u97F3\u9891\u8F68\u662F\u7A7A\u7684\u3002H3 \u751F\u6210\u89C6\u9891\u540E\u4F1A\u81EA\u52A8\u5206\u79BB\u51FA\u539F\u58F0\u3002"
        ) : audioClips.map((c, i) => {
          const e = c.audioEdit ?? { gain: 1, fadeInSec: 0, fadeOutSec: 0, muted: false };
          const isSel = selectedClip?.id === c.id;
          return h2(
            "div",
            {
              key: c.id,
              onClick: () => onSelect(c),
              style: {
                padding: "8px 10px",
                marginBottom: 6,
                borderRadius: 6,
                fontSize: 11,
                cursor: "pointer",
                background: isSel ? "rgba(88,166,255,.10)" : "rgba(210,153,34,.06)",
                border: `1px solid ${isSel ? "#58a6ff" : "rgba(210,153,34,.25)"}`
              }
            },
            h2(
              "div",
              { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
              h2("span", { style: { flex: 1, fontWeight: 600 } }, `${i + 1}. ${c.name}`),
              h2("span", { style: { opacity: 0.5, fontSize: 10 } }, `${(c.out - c.in).toFixed(1)}s`),
              e.muted ? h2("span", { style: { fontSize: 9, padding: "0 4px", borderRadius: 3, background: "#da363333", color: "#f85149" } }, "\u9759\u97F3") : null
            ),
            h2(
              "div",
              { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
              h2("span", { style: { opacity: 0.5, fontSize: 10, width: 32 } }, "\u97F3\u91CF"),
              h2("input", {
                type: "range",
                min: 0,
                max: 4,
                step: 0.1,
                value: e.gain,
                onChange: (ev) => apply2(c.id, { gain: Number(ev.target.value) }),
                onClick: (ev) => ev.stopPropagation(),
                style: { width: 100 }
              }),
              h2(
                "span",
                { style: { fontSize: 10, opacity: 0.7, width: 42 } },
                e.gain === 1 ? "1x" : `${e.gain}x/${(20 * Math.log10(e.gain || 1e-3)).toFixed(0)}dB`
              ),
              h2("span", { style: { opacity: 0.5, fontSize: 10, marginLeft: 6 } }, "\u6DE1\u5165"),
              h2("input", {
                type: "number",
                step: "0.1",
                min: 0,
                value: e.fadeInSec,
                onChange: (ev) => apply2(c.id, { fadeInSec: Number(ev.target.value) }),
                onClick: (ev) => ev.stopPropagation(),
                style: { ...input, width: 52 }
              }),
              h2("span", { style: { opacity: 0.5, fontSize: 10 } }, "\u6DE1\u51FA"),
              h2("input", {
                type: "number",
                step: "0.1",
                min: 0,
                value: e.fadeOutSec,
                onChange: (ev) => apply2(c.id, { fadeOutSec: Number(ev.target.value) }),
                onClick: (ev) => ev.stopPropagation(),
                style: { ...input, width: 52 }
              }),
              h2("button", {
                onClick: (ev) => {
                  ev.stopPropagation();
                  apply2(c.id, { muted: !e.muted });
                },
                style: { ...btn, padding: "1px 7px", color: e.muted ? "#f85149" : void 0 }
              }, e.muted ? "\u53D6\u6D88\u9759\u97F3" : "\u9759\u97F3")
            )
          );
        })
      )
    );
  }
  var TRANSITION_OPTIONS = [
    { v: "", t: "\u786C\u5207" },
    { v: "fade", t: "\u6DE1\u5165\u6DE1\u51FA" },
    { v: "dissolve", t: "\u6EB6\u89E3" },
    { v: "slideleft", t: "\u5DE6\u6ED1\u5165" },
    { v: "circleopen", t: "\u5706\u5F62\u5C55\u5F00" },
    { v: "fadeblack", t: "\u8FC7\u9ED1" }
  ];
  function createWorkbenchView(react) {
    function WorkbenchInner(props) {
      const prefix = props.prefix ?? "/timeline";
      const [panel, setPanel] = useState2("preview");
      const [state, setState] = useState2(null);
      const [summary, setSummary] = useState2(null);
      const [conn, setConn] = useState2("connecting");
      const [selectedClipId, setSelectedClipId] = useState2(null);
      const [err, setErr] = useState2(null);
      const [sequence, setSequence] = useState2(null);
      const [playheadT, setPlayheadT] = useState2(0);
      const xfRef = useRef({ type: "", busy: false, msg: "", err: false });
      const xfTick = (patch) => {
        Object.assign(xfRef.current, patch);
        setPlayheadT((t) => t);
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
            body: JSON.stringify(body)
          });
          const j = await res.json();
          if (!res.ok || j.error) {
            xfTick({ busy: false, err: true, msg: j.error ?? "HTTP " + res.status });
            return;
          }
          const nm = String(j.path ?? "").split(/[\/\\]/).pop();
          const cut = j.xfade ? " \xB7 \u8F6C\u573A " + j.xfade.applied + " \u5904\uFF0C\u65F6\u957F\u51CF\u5C11 " + ((j.timelineDuration ?? 0) - (j.durationSec ?? 0)).toFixed(1) + "s" : "";
          xfTick({ busy: false, err: false, msg: "\u5DF2\u5BFC\u51FA " + nm + cut });
        } catch (e) {
          xfTick({ busy: false, err: true, msg: String(e?.message ?? e).slice(0, 60) });
        }
      };
      const loadPreview = useCallback2(async () => {
        try {
          const r = await fetch(prefix + "/preview", { cache: "no-store" });
          const j = await r.json();
          if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
          setSequence(j);
        } catch (e) {
        }
      }, [prefix]);
      useEffect2(() => {
        let es = null;
        let closed = false;
        try {
          es = new EventSource(prefix + "/events");
          es.addEventListener("snapshot", (e) => {
            try {
              const j = JSON.parse(e.data);
              setState(j.state);
              setSummary(j.summary);
              setConn("live");
              loadPreview();
            } catch {
            }
          });
          es.addEventListener("timeline", () => {
            fetch(prefix + "/snapshot", { cache: "no-store" }).then((r) => r.json()).then((j) => {
              if (!closed) {
                setState(j.state);
                setSummary(j.summary);
                loadPreview();
              }
            }).catch(() => {
            });
          });
          es.addEventListener("error", () => setConn("error"));
        } catch (e) {
          setErr(String(e));
        }
        return () => {
          closed = true;
          try {
            es?.close();
          } catch {
          }
        };
      }, [prefix]);
      const tracks = state?.tracks ?? [];
      const allClips = useMemo(() => tracks.flatMap((t) => t.clips), [tracks]);
      const selectedClip = useMemo(
        () => allClips.find((c) => c.id === selectedClipId) ?? null,
        [allClips, selectedClipId]
      );
      const useAsset = useCallback2(async (asset, clip) => {
        try {
          const res = await fetch(`${prefix}/cmd/replace-clip`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clipId: clip.id, path: asset.path, filename: asset.name })
          });
          const j = await res.json();
          if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
          setErr(null);
        } catch (e) {
          setErr(e.message);
        }
      }, [prefix]);
      return h2(
        "div",
        { style: { width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--dsw-canvas-bg, #0d1117)", overflow: "hidden" } },
        h2(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 2,
              padding: "6px 10px",
              borderBottom: "1px solid rgba(128,128,128,.2)",
              flex: "0 0 auto"
            }
          },
          h2("span", {
            title: conn === "live" ? "\u5DF2\u8FDE\u4E0A" : conn === "error" ? "\u8FDE\u63A5\u4E2D\u65AD" : "\u8FDE\u63A5\u4E2D",
            style: {
              width: 7,
              height: 7,
              borderRadius: "50%",
              marginRight: 6,
              display: "inline-block",
              background: conn === "live" ? "#3fb950" : conn === "error" ? "#f85149" : "#8b949e"
            }
          }),
          PANEL_TABS.map(
            (t) => h2("button", {
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
                fontWeight: panel === t.id ? 600 : 400
              }
            }, `${t.icon} ${t.label}`)
          ),
          h2("div", { style: { flex: 1 } }),
          // ★ 2026-10-18（F8）：导出按钮 + 转场选择。
          //   ⚠ 零新增 hook —— 状态在 xfRef（useRef）里，见本组件开头注释。
          h2("select", {
            value: xfRef.current.type,
            disabled: xfRef.current.busy,
            title: "\u6BB5\u95F4\u8F6C\u573A\u3002\u52A0\u4E86\u8F6C\u573A\u603B\u65F6\u957F\u4F1A\u53D8\u77ED\uFF08\u6BCF\u5904\u5403\u6389 0.4s\uFF09",
            onChange: (e) => {
              xfRef.current.type = e.target.value;
              xfTick({ msg: "" });
            },
            style: {
              height: 22,
              border: "none",
              borderRadius: 4,
              background: "transparent",
              color: "inherit",
              fontSize: 11,
              fontFamily: "inherit",
              cursor: "pointer",
              opacity: 0.75,
              maxWidth: 130,
              flex: "0 0 auto"
            }
          }, ...TRANSITION_OPTIONS.map((o) => h2("option", { key: o.v, value: o.v }, o.t))),
          h2("button", {
            disabled: xfRef.current.busy || !summary?.exportable,
            title: summary?.exportable ? "\u5408\u6210\u6210\u7247\uFF08ffmpeg \u4E00\u6B21\u6E32\u67D3\uFF09" : `\u8FD8\u4E0D\u80FD\u5BFC\u51FA\uFF1A${summary?.pending ?? 0} \u6BB5\u672A\u751F\u6210 / ${summary?.failed ?? 0} \u6BB5\u5931\u8D25`,
            onClick: runExport,
            style: {
              ...btn,
              padding: "2px 10px",
              flex: "0 0 auto",
              background: summary?.exportable && !xfRef.current.busy ? "#238636" : "rgba(128,128,128,.18)",
              color: summary?.exportable && !xfRef.current.busy ? "#fff" : "inherit",
              border: "none",
              borderRadius: 4,
              fontWeight: 600,
              fontSize: 10,
              opacity: xfRef.current.busy ? 0.6 : summary?.exportable ? 1 : 0.5,
              cursor: summary?.exportable && !xfRef.current.busy ? "pointer" : "not-allowed"
            }
          }, xfRef.current.busy ? "\u5BFC\u51FA\u4E2D\u2026" : "\u5BFC\u51FA\u6210\u7247"),
          xfRef.current.msg ? h2("span", {
            title: xfRef.current.msg,
            style: {
              fontSize: 10,
              flex: "0 1 auto",
              minWidth: 0,
              maxWidth: 240,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: xfRef.current.err ? "#f85149" : "#3fb950"
            }
          }, xfRef.current.msg) : null,
          summary ? h2(
            "span",
            { style: { fontSize: 10, opacity: 0.45, flex: "0 0 auto" } },
            `${summary.total} \u6BB5 \xB7 ${summary.durationSec ?? 0}s` + (summary.running ? ` \xB7 ${summary.running} \u751F\u6210\u4E2D` : "")
          ) : null
        ),
        err ? h2("div", { onClick: () => setErr(null), style: { padding: "5px 12px", background: "rgba(248,81,73,.12)", color: "#f85149", fontSize: 11, cursor: "pointer" } }, err) : null,
        h2(
          "div",
          { style: { flex: 1, overflow: "hidden" } },
          panel === "preview" ? h2(PreviewPlayer, {
            prefix,
            sequence,
            current: selectedClip,
            onTimeChange: setPlayheadT,
            onSelectClip: setSelectedClipId
          }) : panel === "assets" ? h2(AssetsPanel, { prefix, onUse: useAsset, selectedClip }) : panel === "audio" ? h2(AudioPanel, { prefix, tracks, selectedClip, onSelect: (c) => setSelectedClipId(c.id) }) : h2(TimelinePanelLazy, { prefix, tracks, state, summary, onSelectClip: setSelectedClipId, selectedClipId, playheadT })
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
      return h2(
        "div",
        { style: { display: "flex", height: "100%", overflow: "hidden" } },
        h2(
          "div",
          { style: { flex: 1, overflow: "auto", padding: "8px 0", minWidth: 0 } },
          tracks.map((track) => {
            return h2(
              "div",
              { key: track.id, style: { marginBottom: 8 } },
              h2(
                "div",
                { style: { fontSize: 10, opacity: 0.5, padding: "0 12px 4px" } },
                `${track.kind === "video" ? "\u25A3 \u89C6\u9891" : "\u266A \u97F3\u9891"} \xB7 ${track.name} \xB7 ${track.clips.length} \u6BB5`
              ),
              h2(
                "div",
                { style: { display: "flex", gap: 6, padding: "0 12px", overflowX: "auto" } },
                track.clips.map((c, i) => {
                  const base = (c.out - c.in) / (c.speed || 1);
                  const dur = c.trim ? Math.max(0, Math.min(c.trim.endSec, base) - Math.min(c.trim.startSec, base)) : base;
                  const isSel = selectedClipId === c.id;
                  const color = track.kind === "video" ? "#58a6ff" : "#d29922";
                  return h2(
                    "div",
                    {
                      key: c.id,
                      onClick: () => onSelectClip(c.id),
                      title: c.shot?.prompt?.slice(0, 150) ?? c.name,
                      style: {
                        flex: `0 0 ${Math.max(60, dur * 22)}px`,
                        height: 46,
                        borderRadius: 5,
                        padding: "4px 7px",
                        fontSize: 10,
                        cursor: "pointer",
                        background: color + "1a",
                        border: `1.5px solid ${isSel ? color : color + "55"}`,
                        overflow: "hidden"
                      }
                    },
                    h2(
                      "div",
                      { style: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                      `${i + 1}. ${c.name ?? "\u7247\u6BB5"}`
                    ),
                    h2(
                      "div",
                      { style: { opacity: 0.55, fontSize: 9 } },
                      [c.shot?.modeId, dur.toFixed(1) + "s", c.status === "done" ? "\u5C31\u7EEA" : c.status === "failed" ? "\u5931\u8D25" : "\u5F85\u751F\u6210"].filter(Boolean).join(" \xB7 ")
                    )
                  );
                }),
                track.clips.length === 0 ? h2("div", { style: { fontSize: 10, opacity: 0.3, padding: "14px 0" } }, "\uFF08\u7A7A\u8F68\u9053\uFF09") : null
              )
            );
          }),
          trackCountZero(tracks) ? h2(
            "div",
            { style: { padding: 40, textAlign: "center", opacity: 0.4, fontSize: 12 } },
            "\u65F6\u95F4\u8F74\u662F\u7A7A\u7684\u3002\u7528\u300C\uFF0B \u5206\u955C\u300D\u6216\u8BA9 Agent \u5EFA\u5206\u955C\u8868\u3002"
          ) : null
        ),
        h2(ClipEditor, {
          prefix,
          clip: sel,
          summary,
          onClose: () => onSelectClip(null)
        })
      );
    }
    function trackCountZero(tracks) {
      return tracks.every((t) => t.clips.length === 0);
    }
    return WorkbenchInner;
  }

  // src/locale.mjs
  var zh = {
    "view.label": "\u7C97\u526A",
    "toolbar.addShot": "\uFF0B \u5206\u955C",
    "toolbar.addVideoTrack": "\uFF0B\u89C6\u9891\u8F68",
    "toolbar.addAudioTrack": "\uFF0B\u97F3\u9891\u8F68",
    "inspector.prompt": "\u63D0\u793A\u8BCD",
    "inspector.regenerate": "\u27F3 \u91CD\u65B0\u751F\u6210",
    "inspector.stop": "\u25A0 \u505C\u6B62",
    "inspector.replace": "\u66FF\u6362",
    "inspector.remove": "\u79FB\u9664",
    "inspector.trim": "\u5355\u6BB5\u88C1\u526A\uFF08\u5728\u6210\u7247\u4E0A\u518D\u88C1\uFF09",
    "inspector.history": "\u751F\u6210\u5386\u53F2",
    "empty.title": "\u65F6\u95F4\u8F74\u662F\u7A7A\u7684",
    "empty.hint": "\u70B9\u300C\uFF0B \u5206\u955C\u300D\u52A0\u4E00\u6BB5\uFF0C\u586B\u63D0\u793A\u8BCD\u540E\u751F\u6210"
  };
  var en = {
    "view.label": "Rough Cut",
    "toolbar.addShot": "+ Shot",
    "toolbar.addVideoTrack": "+ Video",
    "toolbar.addAudioTrack": "+ Audio",
    "inspector.prompt": "Prompt",
    "inspector.regenerate": "\u27F3 Regenerate",
    "inspector.stop": "\u25A0 Stop",
    "inspector.replace": "Replace",
    "inspector.remove": "Remove",
    "inspector.trim": "Trim (on rendered clip)",
    "inspector.history": "History",
    "empty.title": "Timeline is empty",
    "empty.hint": "Press \u201C+ Shot\u201D, write a prompt, then generate"
  };

  // .build/entry.js
  var NS = "dsh-editor";
  var WorkbenchView = createWorkbenchView(import_react.default);
  function apply(ctx, config) {
    const t = ctx.locale.bind(NS);
    const prefix = config && config.routePrefix || "/timeline";
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-editor: dictionaries");
    ctx.slots.inject(
      "conversation.view",
      () => ctx.slots.register(
        {
          name: "conversation.view",
          id: "timeline",
          order: 25,
          locale: NS,
          label: () => t("view.label"),
          children: {},
          inject: () => ({ t, prefix })
        },
        WorkbenchView
      )
    );
  }
  var inject = ["slots", "locale"];
  return __toCommonJS(entry_exports);
})()
    })(__platformReact);

    exports.apply = __impl.apply;
    exports.inject = __impl.inject;
    return module.exports;
  }
});
