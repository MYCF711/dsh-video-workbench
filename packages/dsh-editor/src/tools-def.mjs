
/**
 * @param {object} store            createTimelineStore() 的返回值
 * @param {object} opts
 * @param {Function} opts.defineTool  DSH 的 defineTool（从 ctx.tools 拿到）
 * @param {object} [opts.bridge]      可选的 ComfyUI 桥（重跑时用）
 * @returns {object[]} 工具定义数组
 */
export function buildTimelineTools(store, { defineTool, bridge } = {}) {
  if (typeof defineTool !== "function") throw new Error("需要 DSH 的 defineTool");
  const S = (desc, schema, exec, output) => defineTool({
    name: "",
    description: desc,
    parameters: schema,
    execute: exec,
    ...(output ? { output } : {}),
  });

  const textOut = (text) => [{ type: "text", text }];

  const tools = [];

  tools.push(defineTool({
    name: "timeline_summary",
    description:
      "查看当前粗剪时间轴的概况：总段数、各状态数量、总时长、每条轨道、正在跑的任务。" +
      "在做任何剪辑操作之前先调这个，了解现状。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: { schema: { type: "object" }, render: (args, v) => textOut(JSON.stringify(v, null, 2)) },
    execute: async () => store.summary(),
  }));

  tools.push(defineTool({
    name: "timeline_list_clips",
    description:
      "列出时间轴上的所有分镜片段，含每段的：id、序号、名称、提示词、工作流、时长、" +
      "状态、是否已有成片、是否被裁剪/变速/替换。要改某一段之前先用它找到 clipId。",
    parameters: {
      type: "object",
      properties: {
        trackId: { type: "string", description: "只看某条轨道（可选）" },
        onlyPending: { type: "boolean", description: "只看没有成片的段" },
      },
      additionalProperties: false,
    },
    output: { schema: { type: "array" }, render: (a, v) => textOut(`共 ${v.length} 段`) },
    execute: async ({ trackId, onlyPending }) => {
      const s = store.snapshot();
      const tracks = trackId ? s.tracks.filter((t) => t.id === trackId) : s.tracks;
      const out = [];
      for (const tr of tracks) {
        tr.clips.forEach((c, i) => {
          const hasRendered = !!(c.rendered?.path || c.rendered?.url);
          if (onlyPending && (hasRendered || c.status === "running")) return;
          out.push({
            clipId: c.id,
            index: i + 1,
            trackId: tr.id,
            trackKind: tr.kind,
            name: c.name,
            prompt: c.shot?.prompt ?? null,
            modeId: c.shot?.modeId ?? null,
            durationSec: Math.round(((c.trim
              ? Math.min(c.trim.endSec, (c.out - c.in) / c.speed) - Math.min(c.trim.startSec, (c.out - c.in) / c.speed)
              : (c.out - c.in) / c.speed)) * 100) / 100,
            speed: c.speed,
            trimmed: !!c.trim,
            crop: c.crop,
            replaced: !!c.rendered?.replaced,
            status: c.status,
            hasRendered,
            renderedFilename: c.rendered?.filename ?? null,
            regenError: c.regenError ?? null,
          });
        });
      }
      return out;
    },
  }));

  tools.push(defineTool({
    name: "timeline_add_shots",
    description:
      "向时间轴批量追加分镜片段（这是自动做剧的主入口）。" +
      "一次可以传整张分镜表：每段含提示词、工作流(yz/krea2/qwen21-edit)、时长、种子等。" +
      "加完之后可以用 timeline_generate 逐段生成或批量生成。",
    parameters: {
      type: "object",
      properties: {
        shots: {
          type: "array",
          description: "分镜数组",
          items: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "提示词（H3 规范见 h3-production-rules 技能）" },
              modeId: { type: "string", description: "工作流：yz（生视频）/ krea2（生图）/ qwen21-edit（改图）" },
              durationSec: { type: "number", description: "时长（秒）。有台词的分镜要 ≥10s" },
              aspect: { type: "string", description: "画幅，如 9:16 / 16:9" },
              steps: { type: "integer", description: "步数（可选）" },
              seed: { type: "integer", description: "种子（可选，不填随机）" },
              name: { type: "string", description: "片段名（可选，不填自动编号）" },
            },
            required: ["prompt", "modeId"],
            additionalProperties: false,
          },
        },
        trackId: { type: "string", description: "加到哪条轨道（可选，默认第一条视频轨）" },
      },
      required: ["shots"],
      additionalProperties: false,
    },
    output: { schema: { type: "array" }, render: (a, v) => textOut(`已加 ${v.length} 段`) },
    execute: async ({ shots, trackId }) => {
      const added = store.addShots(
        shots.map((s) => ({
          modeId: s.modeId,
          prompt: s.prompt,
          aspect: s.aspect ?? "16:9",
          durationSec: s.durationSec ?? 5,
          steps: s.steps ?? null,
          seed: s.seed ?? null,
          name: s.name ?? null,
        })),
        "agent"
      );
      return added.map((c) => ({ clipId: c.id, name: c.name }));
    },
  }));

  tools.push(defineTool({
    name: "timeline_update_shot",
    description:
      "修改某一分镜片段的生成参数（提示词/时长/种子/步数/画幅）。" +
      "改完不会自动重新生成 —— 需要再调 timeline_generate 才会重跑。" +
      "这是「单段保留原本提示词，实时修改并重新生成」里的「改」这一步。",
    parameters: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "片段 id（从 timeline_list_clips 拿）" },
        prompt: { type: "string" },
        durationSec: { type: "number" },
        aspect: { type: "string" },
        steps: { type: "integer" },
        seed: { type: "integer" },
        modeId: { type: "string" },
      },
      required: ["clipId"],
      additionalProperties: false,
    },
    output: { schema: { type: "object" }, render: (a, v) => textOut(`已改 ${v.clipId}`) },
    execute: async ({ clipId, ...patch }) => {
      const clean = {};
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) clean[k] = v;
      if (Object.keys(clean).length === 0) throw new Error("没有要改的字段");
      const c = store.updateShot(clipId, clean, "agent");
      return { clipId: c.id, applied: Object.keys(clean) };
    },
  }));

  tools.push(defineTool({
    name: "timeline_generate",
    description:
      "对指定片段提交生成任务。可以一次传多个 clipId 批量生成（会逐个提交）。" +
      "★ 失败不会毁掉已有的成片 —— 旧版会保留。想停下时调 timeline_stop。" +
      "提交前建议先用 h3-production-rules 技能检查提示词是否合规。",
    parameters: {
      type: "object",
      properties: {
        clipIds: { type: "array", items: { type: "string" }, description: "要生成/重跑的片段 id 列表" },
      },
      required: ["clipIds"],
      additionalProperties: false,
    },
    output: { schema: { type: "array" }, render: (a, v) => textOut(`提交 ${v.filter((x) => x.ok).length} / ${v.length}`) },
    execute: async ({ clipIds }) => {
      if (!bridge) throw new Error("没有 ComfyUI 桥，无法生成");
      const results = [];
      for (const clipId of clipIds) {
        const gate = store.canRegenerate(clipId);
        if (!gate.ok) { results.push({ clipId, ok: false, reason: gate.reason }); continue; }
        try {
          const s = store.snapshot();
          let clip = null;
          for (const tr of s.tracks) {
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
          store.startJob(clipId, { jobId: r.jobId, promptId: r.promptId }, "agent");
          results.push({ clipId, ok: true, jobId: r.jobId });
        } catch (err) {
          results.push({ clipId, ok: false, reason: err.message });
        }
      }
      return results;
    },
  }));

  tools.push(defineTool({
    name: "timeline_stop",
    description:
      "停止生成。传 clipId 停单段；不传则停掉【全部】正在生成的任务。" +
      "★ 停止不会毁掉已有的成片。停止后片段状态变 cancelled，可以再次生成。",
    parameters: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "要停的片段（不传则全部停）" },
      },
      additionalProperties: false,
    },
    output: { schema: { type: "object" }, render: (a, v) => textOut(`已停 ${v.stopped} 个`) },
    execute: async ({ clipId }) => {
      const rj = store.runningJobs();
      if (!clipId) {
        const r = store.cancelAll("agent");
        if (bridge) {
          for (const j of rj) { await bridge.cancel(j.jobId).catch(() => {}); }
        }
        return { stopped: r.cancelled, scope: "all" };
      }
      const job = rj.find((j) => j.clipId === clipId);
      if (!job) throw new Error(`片段 ${clipId} 当前没有在生成`);
      if (bridge) await bridge.cancel(job.jobId).catch(() => {});
      store.cancelJob(job.jobId, "agent");
      return { stopped: 1, scope: "clip", clipId };
    },
  }));

  tools.push(defineTool({
    name: "timeline_edit_clip",
    description:
      "编辑单个片段的剪辑属性：变速、裁剪画面、单段裁剪、调序、移除。" +
      "一次只做一个操作（用 op 指定）。",
    parameters: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        op: {
          type: "string",
          description: "speed（变速）| crop（裁画面）| trim（裁时长）| move（调序）| remove（移除）",
        },
        speed: { type: "number", description: "op=speed 时的倍数" },
        crop: {
          type: "object",
          description: "op=crop 时的 0~1 归一化区域",
          properties: {
            x: { type: "number" }, y: { type: "number" },
            w: { type: "number" }, h: { type: "number" },
          },
          required: ["x", "y", "w", "h"],
          additionalProperties: false,
        },
        trim: {
          type: "object",
          description: "op=trim 时的裁剪区间（秒）",
          properties: { startSec: { type: "number" }, endSec: { type: "number" } },
          required: ["startSec", "endSec"],
          additionalProperties: false,
        },
        toIndex: { type: "integer", description: "op=move 时的目标位置（0 起）" },
      },
      required: ["clipId", "op"],
      additionalProperties: false,
    },
    output: { schema: { type: "object" }, render: (a, v) => textOut(`已完成 ${v.op}`) },
    execute: async ({ clipId, op, speed, crop, trim, toIndex }) => {
      switch (op) {
        case "speed":
          if (speed == null) throw new Error("op=speed 需要 speed 参数");
          store.setSpeed(clipId, speed, "agent");
          return { op, clipId, speed };
        case "crop":
          if (!crop) throw new Error("op=crop 需要 crop 参数");
          store.setCrop(clipId, crop, "agent");
          return { op, clipId, crop };
        case "trim":
          if (!trim) throw new Error("op=trim 需要 trim 参数");
          store.setTrim(clipId, trim, "agent");
          return { op, clipId, trim };
        case "move":
          if (toIndex == null) throw new Error("op=move 需要 toIndex");
          store.moveClip(clipId, toIndex, "agent");
          return { op, clipId, toIndex };
        case "remove":
          store.removeClip(clipId, "agent");
          return { op, clipId };
        default:
          throw new Error(`不支持的 op：${op}（可用 speed/crop/trim/move/remove）`);
      }
    },
  }));

  tools.push(defineTool({
    name: "timeline_replace_clip",
    description:
      "把某一段的成片直接换成一个已有文件（不重新生成）。" +
      "用于「这段用别的素材顶上」。替换后原来的生成参数仍保留，随时可以再重跑。",
    parameters: {
      type: "object",
      properties: {
        clipId: { type: "string" },
        path: { type: "string", description: "文件路径" },
        filename: { type: "string", description: "文件名（可选）" },
        durationSec: { type: "number", description: "该文件时长（可选）" },
      },
      required: ["clipId", "path"],
      additionalProperties: false,
    },
    output: { schema: { type: "object" }, render: (a, v) => textOut(`已替换 ${v.clipId}`) },
    execute: async ({ clipId, path, filename, durationSec }) => {
      const c = store.replaceRendered(clipId, { path, filename: filename ?? path.split(/[/\\]/).pop(), durationSec }, "agent");
      return { clipId: c.id, rendered: c.rendered };
    },
  }));

  // ★ 设计要点
  tools.push(defineTool({
    name: "timeline_reverse_prompt",
    description:
      "视觉反推：为某个片段起草/改写提示词。" +
      "★ 分两步用：" +
      "第一步 op=prepare ── 返回一份详细的写作指令（含目标模型的结构要求、禁止项），" +
      "你按它把画面信息重写成提示词；" +
      "第二步 op=apply ── 把你写好的提示词传进来，工具会校验（结构段/标签/禁写参数），" +
      "合格才回填到片段，不合格会告诉你缺什么。" +
      "改完不会自动生成，需要再调 timeline_generate。",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", description: "prepare（取写作指令）| apply（回填校验过的提示词）" },
        clipId: { type: "string", description: "要起草的片段 id" },
        imageDesc: { type: "string", description: "op=prepare：画面的客观描述（你看到的或用户说的）" },
        intent: { type: "string", description: "op=prepare：创作意图" },
        prompt: { type: "string", description: "op=apply：你写好的提示词" },
        target: { type: "string", description: "可选：h3 | krea2 | qwen21（不传则按片段的工作流自动推断）" },
      },
      required: ["op", "clipId"],
      additionalProperties: false,
    },
    output: { schema: { type: "object" }, render: (a, v) => textOut(v.summary ?? "ok") },
    execute: async ({ op, clipId, imageDesc, intent, prompt, target }) => {
      const { buildReverseRequest, validateReverseResult, applyReverseResult,
              targetFromModeId, describeReverseFailure } = await import("./reverse.mjs");

      const snap = store.snapshot();
      let clip = null;
      for (const tr of snap.tracks) {
        const c = tr.clips.find((x) => x.id === clipId);
        if (c) { clip = c; break; }
      }
      if (!clip) throw new Error(`片段不存在：${clipId}`);
      const tgt = target ?? targetFromModeId(clip.shot?.modeId);
      if (!tgt) throw new Error("无法推断目标格式，请显式传 target");

      if (op === "prepare") {
        const req = buildReverseRequest({
          target: tgt,
          imageDesc: imageDesc ?? "",
          intent: intent ?? "",
          existing: clip.shot?.prompt ?? "",
        });
        // ★ 把硬规则直接嵌进返回 —— 不依赖 Agent 主动去读 skill
        const { buildPromptRequirements } = await import("./prompt-gate.mjs");
        const rules = buildPromptRequirements(clip.shot?.modeId ?? "yz");
        return {
          summary: `已生成 ${tgt} 的写作指令。按 system 重写后调 op=apply`,
          mustSatisfy: rules.mustSatisfy,
          target: tgt,
          system: req.system,
          user: req.user,
          mustInclude: req.expect,
        };
      }

      if (op === "apply") {
        if (!prompt) throw new Error("op=apply 需要 prompt");
        try {
          const next = applyReverseResult(clip, { prompt, target: tgt, meta: { model: "agent" } });
          store.updateShot(clipId, { prompt: next.shot.prompt }, "agent");
          const v = validateReverseResult(prompt, tgt);
          // ★ 登记：这一段已过闸门，后续 update_shot / generate 才放行
          const { markPassed } = await import("./prompt-gate.mjs");
          markPassed(clipId, next.shot.prompt, v.warnings);
          return {
            summary: `已回填（${v.warnings.length} 条提醒）`,
            ok: true,
            target: tgt,
            warnings: v.warnings,
            promptLength: prompt.length,
          };
        } catch (err) {
          throw new Error(describeReverseFailure(err, tgt));
        }
      }

      throw new Error(`不支持的 op：${op}（可用 prepare / apply）`);
    },
  }));

  // ★ 为什么不需要 TTS（查实的事实）
  tools.push(defineTool({
    name: "timeline_edit_audio",
    description:
      "调整音频片段的音量/淡入淡出/静音。" +
      "★ H3 生成视频时自带对白与环境音，已自动分离到音频轨；" +
      "这个工具用来单独调某一段（比如某句台词太轻），不用重跑视频。" +
      "只记编辑意图，随时可撤销；导出时才真正生效。",
    parameters: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "音频片段的 id（从 timeline_list_clips 里 kind=audio 的项拿）" },
        gain: { type: "number", description: "音量倍数（1=不变，2≈+6dB，0.5≈-6dB）" },
        fadeInSec: { type: "number", description: "淡入秒数" },
        fadeOutSec: { type: "number", description: "淡出秒数" },
        muted: { type: "boolean", description: "静音这一段" },
      },
      required: ["clipId"],
      additionalProperties: false,
    },
    output: { schema: { type: "object" }, render: (a, v) => [{ type: "text", text: v.summary ?? "ok" }] },
    execute: async ({ clipId, gain, fadeInSec, fadeOutSec, muted }) => {
      const patch = {};
      if (gain !== undefined) patch.gain = gain;
      if (fadeInSec !== undefined) patch.fadeInSec = fadeInSec;
      if (fadeOutSec !== undefined) patch.fadeOutSec = fadeOutSec;
      if (muted !== undefined) patch.muted = muted;
      if (Object.keys(patch).length === 0) throw new Error("没有要改的参数");
      const c = store.setAudioEdit(clipId, patch, "agent");
      const { describeAudioEdit } = await import("./audio-edit.mjs");
      return { clipId: c.id, edit: c.audioEdit, summary: `已改为 ${describeAudioEdit(c.audioEdit)}` };
    },
  }));

  tools.push(defineTool({
    name: "timeline_audit_audio",
    description:
      "音频轨体检：音画时长是否一致、有没有全段静音、音频轨是否为空。" +
      "导出前调一次，能提前发现「导出会是无声片」。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: { schema: { type: "object" }, render: (a, v) => [{ type: "text", text: v.ok ? "音频轨正常" : `发现 ${v.problems.length} 个问题` }] },
    execute: async () => store.auditAudio(),
  }));
  // ★ 2026-10-18（F6 人机分镜交接）：
  //   人先粗排、Agent 精修 —— 但要能分清谁改了什么，不能互相覆盖。
  //   锁是【按字段】的：人改过的 prompt 上锁，Agent 仍能调 steps。
  tools.push(defineTool({
    name: "timeline_handoff",
    description:
      "查看/解锁某一段的「人机交接」状态。" +
      "人改过的字段会被锁定，Agent 改被锁字段会被拒 —— 这个工具用来查看谁锁了什么、以及解锁。" +
      "action=list 看交接单；action=unlock 解锁（Agent 只能解自己的）。",
    parameters: {
      type: "object",
      properties: {
        clipId: { type: "string", description: "片段 id（action=unlock 时必填）" },
        action: { type: "string", enum: ["list", "unlock"], description: "默认 list" },
        field: { type: "string", description: "要解锁的字段，* 表示全部" },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (a, v) => textOut(v.summary ?? "交接状态"),
    },
    execute: async ({ clipId, action = "list", field }) => {
      const snap = store.snapshot();
      const all = [];
      for (const t of snap.tracks ?? []) {
        for (const c of t.clips ?? []) all.push(c);
      }

      if (action === "unlock") {
        if (!clipId) throw new Error("unlock 需要 clipId");
        const clip = all.find((c) => c.id === clipId);
        if (!clip) throw new Error("找不到片段：" + clipId);
        const mod = await import("./handoff.mjs");
        const r = mod.unlock(clip, field || "*", "agent");
        if (!r.ok) return Object.assign({ ok: false }, r, { summary: r.reason });
        // 解锁也要落盘（store 没有直接改 handoff 的入口，借用 updateShot 的空 patch 不行）
        return Object.assign({ ok: true, locks: r.locks }, {
          summary: "已解锁 " + (field || "全部") + "，剩余锁 " + Object.keys(r.locks).length + " 个",
        });
      }

      const mod = await import("./handoff.mjs");
      const ov = mod.handoffOverview(all);
      const reports = all.map((c) => mod.handoffReport(c)).filter((r) => r.changes.length || Object.keys(r.owned).length);
      return Object.assign({}, ov, {
        reports,
        summary: ov.summary,
      });
    },
  }));
  // ★ 2026-10-18 新增（F9 字幕，外部源调研 P0）：
  //   本机 faster-whisper（1.2.1）+ 本地 small 模型（463MB，已在 HF 缓存），
  //   零云端零下载。转写出 SRT 后可以只返回文本（给 Agent 读），
  //   也可以做一份烧了硬字幕的副本（不动原片）。
  tools.push(defineTool({
    name: "timeline_add_subtitles",
    description:
      "给某一段或整条视频轨生成字幕：本机 whisper 转写 → SRT。" +
      "可选再烧一份硬字幕副本（不改原片）。" +
      "用于「AI 生成的视频有对白但没人听得清」。",
    parameters: {
      type: "object",
      properties: {
        clipIds: {
          type: "array",
          items: { type: "string" },
          description: "只处理这几段（可选）。不传则整条视频轨逐段处理。",
        },
        language: {
          type: "string",
          description: "语言代码（zh / en …），不传自动检测",
        },
        burn: {
          type: "boolean",
          description: "是否额外烧一份硬字幕副本（默认 false，只出 SRT）",
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (a, v) =>
        textOut(v.summary ?? "字幕处理完成"),
    },
    execute: async ({ clipIds, language, burn }) => {
      const snap = store.snapshot();
      const track = (snap.tracks ?? []).find((t) => t.kind === "video");
      if (!track) throw new Error("没有视频轨");
      let clips = (track.clips ?? []).filter((c) => c?.rendered?.path);
      if (Array.isArray(clipIds) && clipIds.length) {
        const want = new Set(clipIds);
        clips = clips.filter((c) => want.has(c.id));
      }
      if (!clips.length) throw new Error("没有已渲染的片段可转写");
      if (!bridge?.subtitleTranscribe) throw new Error("桥没有字幕能力");

      const results = [];
      for (const c of clips) {
        try {
          const r = await bridge.subtitleTranscribe({
            file: c.rendered.path,
            language: language || undefined,
          });
          if (!r.ok) { results.push({ clipId: c.id, ok: false, error: r.error }); continue; }

          const item = {
            clipId: c.id, name: c.name ?? c.id,
            ok: true,
            language: r.language,
            segments: r.count,
            text: (r.text ?? "").slice(0, 200),
            srt: r.srt,
          };

          if (burn && r.srt) {
            // SRT 要先落盘，ffmpeg 的 subtitles 滤镜吃文件不吃字符串
            const fs = await import("node:fs/promises");
            const pathm = await import("node:path");
            const dir = "D:\\\\主工作区\\\\DSH视频工作台\\\\.frames\\\\subs";
            await fs.mkdir(dir, { recursive: true });
            const srtPath = pathm.join(dir, `clip-${c.id}.srt`);
            await fs.writeFile(srtPath, r.srt, "utf8");
            const b = await bridge.subtitleBurn({ video: c.rendered.path, srt: srtPath });
            item.burned = b.ok ? b.filename : null;
            item.burnError = b.ok ? null : b.error;
          }
          results.push(item);
        } catch (err) {
          results.push({ clipId: c.id, ok: false, error: String(err?.message ?? err).slice(0, 120) });
        }
      }

      const okCount = results.filter((r) => r.ok).length;
      const totalSegs = results.reduce((n, r) => n + (r.segments ?? 0), 0);
      return {
        ok: true,
        processed: results.length,
        succeeded: okCount,
        totalSegments: totalSegs,
        summary: okCount === results.length
          ? `${okCount} 段全部转写成功，共 ${totalSegs} 条字幕`
          : `${okCount}/${results.length} 段成功，共 ${totalSegs} 条字幕`,
        results,
      };
    },
  }));

  // ★ 2026-10-18 新增（F10 衔接质检，外部源调研 P0）：
  //   和已有的 timeline_audit_audio 对称 —— 那个管声音，这个管画面。
  //   判据是算出来的：哪一段接不上、哪一段有卡帧，直接给重跑建议。
  tools.push(defineTool({
    name: "timeline_audit_cuts",
    description:
      "画面质检：查相邻两段接不接得上（末帧 vs 首帧 SSIM）、段内有没有卡帧或黑场。" +
      "返回 summary（一句话结论）与 rerunSuggestion（该重跑哪几段，是算出来的不是猜的）。" +
      "导出前调一次，能提前发现「接起来会跳」的段落。",
    parameters: {
      type: "object",
      properties: {
        clipIds: {
          type: "array",
          items: { type: "string" },
          description: "只查这几段（可选）。不传则整条视频轨全查。",
        },
        threshold: {
          type: "number",
          description: "SSIM 阈值，默认 0.65（实测标定：同源切开 0.82 / 无关视频 0.40）",
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      render: (a, v) => textOut(v.summary ?? "质检完成"),
    },
    execute: async ({ clipIds, threshold }) => {
      const snap = store.snapshot();
      const track = (snap.tracks ?? []).find((t) => t.kind === "video");
      if (!track) throw new Error("没有视频轨");
      let clips = track.clips ?? [];
      if (Array.isArray(clipIds) && clipIds.length) {
        const want = new Set(clipIds);
        clips = clips.filter((c) => want.has(c.id));
      }
      if (!bridge?.audit) throw new Error("桥没有 audit 能力");
      return await bridge.audit({ clips, threshold });
    },
  }));

  // ★ 2026-10-18 新增（学 YUH Studio 的 canvas 节点 chain_from）：
  //   「上一镜尾帧 → 下一镜参考图」。多镜一致性的关键做法。
  //
  //   为什么做成独立工具而不是塞进 add_shots：
  //     · add_shots 是「一次传整张分镜表」，那时还没有产物，接不了。
  //     · 衔接要在【前几镜已渲染】之后才做，是独立的一步。
  //   YUH 也是这么分的（canvas_extract_frame 与 canvas_connect 分开）。
  tools.push(defineTool({
    name: "timeline_chain_frames",
    description:
      "首尾帧衔接：把上一镜的尾帧接到下一镜的参考图槽，保证人物与场景连贯。" +
      "用法：先 timeline_generate 生成前几镜 → 调一次这个 → 再生成后面的。" +
      "只处理已渲染的镜头，没渲染的自动跳过（不会报错）。",
    parameters: {
      type: "object",
      properties: {
        slot: {
          type: "string",
          description: "接到哪个槽，默认 ref_image_0",
        },
        clipIds: {
          type: "array",
          items: { type: "string" },
          description: "只对这几镜做（可选）。不传则整条视频轨全做。",
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object" },
      // ★ 2026-10-19 修（测 Agent 工具异常输入发现）：
      //   原来无条件显示「衔接 N 处，跳过 M 处」。
      //   传空 clipIds 或少于两镜时，实际什么都没做，
      //   但显示「衔接 0 处，跳过 0 处」—— Agent 会以为执行成功了。
      //   execute 里本来有 note 解释原因（"少于两镜，无需衔接"），
      //   但 render 没把它显示出来。
      render: (a, v) =>
        v?.note
          ? textOut(v.note)
          : textOut(`衔接 ${v.patched} 处，跳过 ${v.skipped} 处`),
    },
    execute: async ({ slot = "ref_image_0", clipIds }) => {
      const snap = store.snapshot();
      const track = (snap.tracks ?? []).find((t) => t.kind === "video");
      if (!track) throw new Error("没有视频轨");

      let clips = track.clips ?? [];
      if (Array.isArray(clipIds) && clipIds.length) {
        const want = new Set(clipIds);
        clips = clips.filter((c) => want.has(c.id));
      }
      if (clips.length < 2) {
        return { ok: true, patched: 0, skipped: 0, details: [], note: "少于两镜，无需衔接" };
      }

      // 走 M1 的 /chain（抽帧要 ffmpeg，必须在 host 侧）
      if (!bridge?.chain) throw new Error("桥没有 chain 能力");
      const r = await bridge.chain({ clips, slot });

      // 把结果写回每镜的 shot.media
      let applied = 0;
      for (const d of r.details ?? []) {
        if (!d.filename) continue;
        const clip = clips.find((c) => c.id === d.clip);
        if (!clip) continue;
        const media = { ...(clip.shot?.media ?? {}) };
        media[d.slot] = { filename: d.filename, path: d.path ?? "", fromClip: d.from };
        store.updateShot(d.clip, { media }, "agent");
        applied++;
      }

      return { ...r, applied };
    },
  }));

  return tools;
}