
/**
 * @param {object} ctx    cordis ctx（需要 ctx.webServer）
 * @param {object} store  createTimelineStore()
 * @param {object} [opts] { prefix, log, bridge, onExport }
 * @returns {Function} disposer
 */
import * as _characters from "./characters.mjs";
import * as _handoff from "./handoff.mjs";
function require_characters() { return _characters; }
function require_handoff() { return _handoff; }

export function registerCommands(ctx, store, opts = {}) {
  const prefix = (opts.prefix ?? "/timeline").replace(/\/+$/, "");
  const log = opts.log ?? console;
  const bridge = opts.bridge ?? null;

  if (typeof ctx?.webServer?.register !== "function") {
    log.warn?.("[timeline-cmd] ctx.webServer 不可用，命令路由未注册");
    return () => {};
  }

  function json(res, code, body) {
    const s = JSON.stringify(body);
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(s),
      "Cache-Control": "no-store",
    });
    res.end(s);
  }

  function readJson(req, limit = 8 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      req.on("data", (c) => {
        n += c.length;
        if (n > limit) { reject(new Error(`请求体超过 ${limit} 字节`)); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        const t = Buffer.concat(chunks).toString("utf8");
        if (!t) return resolve({});
        try { resolve(JSON.parse(t)); } catch (e) { reject(new Error("请求体不是合法 JSON")); }
      });
      req.on("error", reject);
    });
  }

  const disposers = [];

  function cmd(path, handler, needBody = true) {
    disposers.push(
      ctx.webServer.register({
        kind: "exact",
        path: prefix + "/cmd" + path,
        handler: async (req, res) => {
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          try {
            const body = needBody ? await readJson(req) : {};
            const out = await handler(body);
            json(res, 200, out ?? { ok: true });
          } catch (err) {
            json(res, 400, { error: err.message });
          }
        },
      })
    );
  }

  cmd("/add-shots", ({ shots }) => {
    if (!Array.isArray(shots) || shots.length === 0) throw new Error("shots 必须是非空数组");
    const added = store.addShots(shots, "user");
    return { added: added.map((c) => ({ clipId: c.id, name: c.name })) };
  });

  cmd("/update-shot", ({ clipId, patch }) => {
    if (!clipId) throw new Error("缺 clipId");
    if (!patch || typeof patch !== "object") throw new Error("缺 patch");
    const c = store.updateShot(clipId, patch, "user");
    return { clipId: c.id, applied: Object.keys(patch) };
  });

  cmd("/add-track", ({ kind }) => {
    const tr = store.addTrack(kind ?? "video", null, "user");
    return { trackId: tr.id, kind: tr.kind };
  });

  cmd("/edit-clip", ({ clipId, op, speed, crop, trim, toIndex }) => {
    if (!clipId) throw new Error("缺 clipId");
    switch (op) {
      case "speed": {
        if (speed == null) throw new Error("op=speed 需要 speed");
        store.setSpeed(clipId, speed, "user");
        return { op, clipId, speed };
      }
      case "crop":
        store.setCrop(clipId, crop ?? null, "user");
        return { op, clipId, crop };
      case "trim":
        store.setTrim(clipId, trim ?? null, "user");
        return { op, clipId, trim };
      case "move": {
        if (toIndex == null) throw new Error("op=move 需要 toIndex");
        store.moveClip(clipId, toIndex, "user");
        return { op, clipId, toIndex };
      }
      case "remove":
        store.removeClip(clipId, "user");
        return { op, clipId };
      default:
        throw new Error(`不支持的 op：${op}`);
    }
  });

  cmd("/replace-clip", ({ clipId, path, filename, durationSec }) => {
    if (!clipId) throw new Error("缺 clipId");
    if (!path) throw new Error("缺 path");
    const c = store.replaceRendered(clipId, { path, filename: filename ?? path.split(/[/\\]/).pop(), durationSec }, "user");
    return { clipId: c.id, rendered: c.rendered };
  });

  cmd("/generate", async ({ clipIds }) => {
    if (!bridge) throw new Error("没有 ComfyUI 桥");
    if (!Array.isArray(clipIds) || clipIds.length === 0) throw new Error("clipIds 必须是非空数组");
    const out = [];
    for (const clipId of clipIds) {
      const gate = store.canRegenerate(clipId);
      if (!gate.ok) { out.push({ clipId, ok: false, reason: gate.reason }); continue; }
      try {
        const snap = store.snapshot();
        let clip = null;
        for (const tr of snap.tracks) {
          const c = tr.clips.find((x) => x.id === clipId);
          if (c) { clip = c; break; }
        }
        const sh = clip.shot;
        const payload = { modeId: sh.modeId, prompt: sh.prompt };
        if (sh.aspect) payload.aspect = sh.aspect;
        if (sh.durationSec && sh.modeId === "yz") payload.durationSec = sh.durationSec;
        if (sh.steps != null) payload.steps = sh.steps;
        if (sh.seed != null) payload.seed = sh.seed;
        if (Object.keys(sh.toggles ?? {}).length) payload.toggles = sh.toggles;
        const files = {};
        for (const [k, v] of Object.entries(sh.media ?? {})) {
          if (v?.base64) files[k] = { base64: v.base64, filename: v.filename ?? `${k}.png` };
        }
        if (Object.keys(files).length) payload.files = files;

        const r = await bridge.generate(sh.modeId, payload);
        store.startJob(clipId, { jobId: r.jobId, promptId: r.promptId }, "user");
        out.push({ clipId, ok: true, jobId: r.jobId });
      } catch (err) {
        out.push({ clipId, ok: false, reason: err.message });
      }
    }
    return { results: out };
  });

  cmd("/stop", async ({ clipId }) => {
    const rj = store.runningJobs();
    if (!clipId) {
      const r = store.cancelAll("user");
      if (bridge) for (const j of rj) await bridge.cancel(j.jobId).catch(() => {});
      return { stopped: r.cancelled, scope: "all" };
    }
    const job = rj.find((j) => j.clipId === clipId);
    if (!job) throw new Error(`片段 ${clipId} 当前没有在生成`);
    if (bridge) await bridge.cancel(job.jobId).catch(() => {});
    store.cancelJob(job.jobId, "user");
    return { stopped: 1, scope: "clip", clipId };
  });

  // ★ 缺口的补法（2026-10-17 实测发现）
  cmd("/split-audio", ({ videoClipId }) => {
    if (!videoClipId) throw new Error("缺 videoClipId");
    if (typeof opts.onSplitAudio !== "function") {
      throw new Error("分离音频未配置（需要 host 侧 onSplitAudio 回调）");
    }
    return opts.onSplitAudio(videoClipId, "user");
  });

  cmd("/add-audio", ({ path, filename, durationSec, afterVideoClipId }) => {
    if (!path) throw new Error("缺 path");
    const c = store.addAudioFromVideo(
      afterVideoClipId ?? null,
      { path, filename: filename ?? path.split(/[/\\]/).pop(), durationSec },
      "user"
    );
    return { clipId: c.id, name: c.name, durationSec: c.out };
  });

  cmd("/edit-audio", ({ clipId, gain, fadeInSec, fadeOutSec, muted }) => {
    if (!clipId) throw new Error("缺 clipId");
    const patch = {};
    if (gain !== undefined) patch.gain = gain;
    if (fadeInSec !== undefined) patch.fadeInSec = fadeInSec;
    if (fadeOutSec !== undefined) patch.fadeOutSec = fadeOutSec;
    if (muted !== undefined) patch.muted = muted;
    if (Object.keys(patch).length === 0) throw new Error("没有要改的参数");
    const c = store.setAudioEdit(clipId, patch, "user");
    return { clipId: c.id, audioEdit: c.audioEdit };
  });

  if (opts.assets) {
    const assets = opts.assets;
    cmd("/assets-scan", ({ dir, group, exts }) => {
      if (!dir) throw new Error("缺 dir");
      const added = assets.scanDir(dir, { group, exts, source: "import" });
      return { count: added.length, items: added.map((x) => ({ id: x.id, name: x.name, kind: x.kind })) };
    });

    // ★★ 2026-10-19 新增：按【资产库根目录 + 分类子目录】扫描。
    //   主人要求「资产库需要在一个可以指定的目录位置，这个目录做好分类，
    //   其他地方的不要弄进去」。
    //   ⇒ 这是推荐的入库方式；/assets-scan 保留给「临时收一批」，但它不设边界。
    cmd("/assets-scan-root", ({ root }) => {
      if (!root) throw new Error("缺 root（资产库根目录）");
      const r = assets.scanRoot(root);
      return {
        root: r.root,
        count: r.added.length,
        byKind: r.byKind,
        skipped: r.skipped,
        items: r.added.map((x) => ({ id: x.id, name: x.name, kind: x.kind, group: x.group })),
      };
    });

    // ★ 2026-10-18（F1 角色卡）：列出素材库里所有「角色 → 定妆图组」。
    cmd("/characters", () => {
      const { groupByCharacter } = require_characters();
      // ★ 2026-10-18 修：assets.list() 返回【数组】，不是 {items}。
      //   我按 /timeline/assets 的 HTTP 形状（{items:[...]}）写了 .items，
      //   拿到的永远是 undefined → 角色列表恒为 0。
      // ★ 2026-10-18：素材库现在有 540+ 条，必须显式给大 limit。
      //   默认 limit=500 会把后面打的角色标签截掉 —— 表现为「角色列表恒为 0」。
      const items = assets.list({ limit: 100000 });
      const grouped = groupByCharacter(items);
      return {
        ok: true,
        count: Object.keys(grouped).length,
        characters: Object.fromEntries(
          Object.entries(grouped).map(([k, v]) => [k, v.map((x) => ({
            id: x.id, name: x.name, view: x.view, hasPath: !!x.path,
          }))])
        ),
      };
    });

    // ★ 给某条素材打/去角色标签
    cmd("/character-tag", ({ id, name, view, on }) => {
      if (!id) throw new Error("缺 id");
      const cur = assets.get(id);
      if (!cur) throw new Error("找不到这条素材：" + id);
      const { withCharacterTag } = require_characters();
      const tags = withCharacterTag(cur.tags, name, view, on !== false);
      assets.update(id, { tags });
      return { ok: true, id, tags };
    });
  }

  // ★ 2026-10-18（F6 人机分镜交接）：整条时间轴的交接概览 + 单段交接单。
  // ★ 注意：cmd() 只接受 POST（needBody=false 只是「不读 body」，不是「允许 GET」）。
  //   实测踩到：用 GET 请求 /handoff 得到 405。
  cmd("/handoff", () => {
    const { handoffOverview, handoffReport } = require_handoff();
    const snap = store.snapshot();
    const all = [];
    for (const t of snap.tracks ?? []) for (const c of t.clips ?? []) all.push(c);
    const ov = handoffOverview(all);
    return Object.assign({}, ov, {
      reports: all.map((c) => handoffReport(c))
        .filter((r) => r.changes.length || Object.keys(r.owned).length),
    });
  }, false);

  // ★ 解锁某个字段（人点 UI 用）
  cmd("/handoff-unlock", ({ clipId, field }) => {
    if (!clipId) throw new Error("缺 clipId");
    const { unlock } = require_handoff();
    const snap = store.snapshot();
    let clip = null;
    for (const t of snap.tracks ?? []) {
      const f2 = (t.clips ?? []).find((c) => c.id === clipId);
      if (f2) { clip = f2; break; }
    }
    if (!clip) throw new Error("找不到片段：" + clipId);
    const r = unlock(clip, field || "*", "user");
    return { ok: r.ok, locks: r.locks, reason: r.reason };
  });

  // ★ 2026-10-18（F8 段间转场）：export 现在接受 transition 参数。

  //   { transition: { type, sec } } 或 { transition: null }（硬切）
  //   不传 = 硬切，保持老行为不变。
  cmd("/export", async ({ transition } = {}) => {
    if (typeof opts.onExport !== "function") {
      throw new Error("导出未配置（需要 host 侧 onExport 回调）");
    }
    const r = await opts.onExport(store.snapshot(), store.summary(), {
      transition: transition ?? null,
    });
    return r ?? { ok: true };
  });

  log.info?.(`[timeline-cmd] 已注册 ${disposers.length} 条命令路由`);

  return () => { for (const d of disposers) d?.(); };
}
