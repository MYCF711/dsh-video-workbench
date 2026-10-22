/**
 * 时间轴 → ffmpeg 命令生成器。纯函数，不执行、不碰文件系统。
 *
 * 四条硬性约束，违反会出错：
 * ① 帧率必须靠输出参数 -r 锁定，滤镜里的 fps= 管不住容器帧率（实测输出 25.04 而非 24）
 * ② 音频变速用 rubberband，不用 atempo（音质）
 * ③ concat 前每段必须 setpts=PTS-STARTPTS（否则插入静帧/黑场）
 * ④ concat 的输入必须视频音频交替 [v0][a0][v1][a1]（否则 Media type mismatch）
 */

import { layoutTrack, timelineDuration, clipDuration } from "./timeline.mjs";
import { buildXfadeChain, buildAudioTrimForXfade } from "./transition.mjs";

/** 把 0~1 归一化 crop 转成 ffmpeg 的像素表达式。 */
function cropExpr(crop) {
  if (!crop) return null;
  const { x, y, w, h } = crop;
  return (
    `crop=w=iw*${round(w)}:h=ih*${round(h)}:` +
    `x=iw*${round(x)}:y=ih*${round(y)}`
  );
}

function round(n) {
  return Number(n).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function num(n) {
  return Number(Number(n).toFixed(6));
}

/**
 * 生成渲染命令。
 * @param {object} tl  时间轴（timeline.mjs 的结构）
 * @param {object} opts
 * @param {string} opts.out        输出文件路径
 * @param {number} [opts.crf]      x264 质量（默认 20）
 * @param {string} [opts.preset]   x264 preset（默认 veryfast）
 * @param {boolean} [opts.muteAudio] 静音
 * @returns {{args: string[], filter: string, warn: string[]}}
 */
export function buildRenderCommand(tl, opts = {}) {
  const fps = tl.fps ?? 24;
  const crf = opts.crf ?? 20;
  const preset = opts.preset ?? "veryfast";
  const warn = [];

  //    第一版只支持单视频轨做 concat；多视频轨时给出警告）
  const videoTracks = tl.tracks.filter((t) => t.kind === "video" && t.clips.length > 0);
  const audioTracks = tl.tracks.filter((t) => t.kind === "audio" && t.clips.length > 0);

  if (videoTracks.length === 0) throw new Error("没有视频片段可渲染");
  if (videoTracks.length > 1) {
    warn.push(
      `有 ${videoTracks.length} 条视频轨，第一版只渲染第一条（${videoTracks[0].name}）。` +
        `多轨叠加（画中画/混合模式）尚未实现。`
    );
  }

  const vTrack = videoTracks[0];
  const vSegs = layoutTrack(vTrack);

  // ★ F8 预判：是否真的会用 xfade（决定下面每段的链里能不能加 setpts）
  //   实测铁律（2026-10-18）：xfade 的两路输入【不能】带 setpts=PTS-STARTPTS，
  //   否则报 "The inputs needs to be a constant frame rate; current rate of 1/0 is invalid"。
  //   而 concat 恰恰要求每段必须 setpts（否则插静帧/黑场）。
  //   ⇒ 两条路的要求相反，必须按「用不用转场」分叉。
  const willXfade =
    !!(opts.transition && opts.transition.type) &&
    vSegs.length >= 2;

  const args = [];
  const inputs = []; // 记录每个输入对应的文件与序号

  const vInputIdx = [];
  for (let i = 0; i < vSegs.length; i++) {
    const c = vSegs[i].clip;
    args.push("-ss", String(num(c.in)), "-t", String(num(c.out - c.in)), "-i", c.src);
    vInputIdx.push(inputs.length);
    inputs.push({ kind: "video", clip: c });
  }

  const aSegs = audioTracks.length ? layoutTrack(audioTracks[0]) : [];
  const aInputIdx = [];
  for (let i = 0; i < aSegs.length; i++) {
    const c = aSegs[i].clip;
    // ★ 补位的静音段没有源文件，不分配输入索引（用 -1 标记）
    if (c.silent || c.src == null) {
      aInputIdx.push(-1);
      continue;
    }
    args.push("-ss", String(num(c.in)), "-t", String(num(c.out - c.in)), "-i", c.src);
    aInputIdx.push(inputs.length);
    inputs.push({ kind: "audio", clip: c });
  }

  const parts = [];
  const vOutLabels = [];

  // ★ 所有片段必须同尺寸才能 concat
  //
  // 实测（2026-10-17）：1664x928 与 928x928 混拼报
  //   "Input link in0:v0 parameters (size 928x928, SAR 0:1) do not match ..."
  //   —— 单段画面裁剪后尺寸会变，拼之前必须统一。
  //
  // 调用方通过 opts.targetSize = { w, h } 指定统一尺寸；
  // 不指定则保持原样（单段渲染时不需要）。
  const ts = opts.targetSize;
  const fitExpr = ts && ts.w > 1 && ts.h > 1
    ? `scale=${ts.w}:${ts.h}:force_original_aspect_ratio=decrease,` +
      `pad=${ts.w}:${ts.h}:(ow-iw)/2:(oh-ih)/2:color=black,`
    : "";

  for (let i = 0; i < vSegs.length; i++) {
    const c = vSegs[i].clip;
    const idx = vInputIdx[i];
    const chain = [];

    // ① 统一帧率与像素格式（concat 的前置条件）
    chain.push(`fps=${fps}`);
    chain.push("format=yuv420p");

    const ce = cropExpr(c.crop);
    if (ce) chain.push(ce);

    // ②b 统一尺寸（多段拼接必需，否则 concat 报 size do not match）
    if (fitExpr) chain.push(fitExpr.replace(/,$/, ""));

    // ③ 变速（★ 必须带 fps，见文件头规则①）
    if (Math.abs(c.speed - 1) > 1e-6) {
      chain.push(`setpts=${num(1 / c.speed)}*PTS`);
      chain.push(`fps=${fps}`);
    }

    // ④ ★ 单段裁剪（clip.trim）—— 在「取源 + 变速」之后的成片上再裁一刀
    //    注意：trim 的时间是【成片时间轴上的秒】，不是源素材时间。
    //    因为 -ss/-t 已经在输入端取了源片段，setpts 又改了速度，
    //    所以这里的裁剪要作用在 setpts 之后。
    if (c.trim) {
      const t0 = Math.max(0, Number(c.trim.startSec) || 0);
      const t1 = Number(c.trim.endSec);
      if (Number.isFinite(t1) && t1 > t0) {
        chain.push(`trim=start=${num(t0)}:end=${num(t1)}`);
      }
    }

    // ⑤ 归零时间戳
    //   ★ concat 必须加（规则③）；xfade 必须【不加】（见上面 willXfade 的注释）。
    //     这是两条相反的要求，只能分叉。
    if (!willXfade) chain.push("setpts=PTS-STARTPTS");

    const label = `v${i}`;
    parts.push(`[${idx}:v]${chain.join(",")}[${label}]`);
    vOutLabels.push(label);
  }

  // ── 视频拼接：硬切 concat 或 xfade 转场
  //
  // ★ 2026-10-18（F8 段间转场）：默认仍是硬切（行为不变），
  //   传 opts.transition = { type, sec } 才启用 xfade。
  //   为什么不默认开：转场会【缩短总时长】（每处吃掉 sec 秒），
  //   开了之后时间轴上的对齐全变，属于会改变语义的开关，必须显式要。
  const xfadeWanted = opts.transition && vOutLabels.length >= 2;
  let xfadeInfo = null;

  if (xfadeWanted) {
    // 每段在最终画面里的时长（变速/裁剪后）
    const segDurations = vSegs.map((s) => {
      const base = (s.clip.out - s.clip.in) / (s.clip.speed > 0 ? s.clip.speed : 1);
      if (s.clip.trim) {
        const t0 = Math.max(0, Number(s.clip.trim.startSec) || 0);
        const t1 = Number(s.clip.trim.endSec);
        if (Number.isFinite(t1) && t1 > t0) return Math.max(0.01, t1 - t0);
      }
      return Math.max(0.01, base);
    });

    const chain = buildXfadeChain({
      labels: vOutLabels,
      durations: segDurations,
      type: opts.transition.type,
      sec: opts.transition.sec,
      out: "vout",
    });

    if (chain.applied > 0) {
      parts.push(...chain.parts);
      xfadeInfo = {
        type: chain.type, sec: chain.sec, applied: chain.applied,
        expectedDuration: chain.expectedDuration, note: chain.note,
      };
      warn.push(chain.note);
      // ★ 把 xfade 的信息挂到外面，音频那一段要用 sec 来同步裁短
      parts.__xfadeSec = chain.sec;
    } else {
      // 退化硬切
      const vConcatIn = vOutLabels.map((l) => `[${l}]`).join("");
      parts.push(`${vConcatIn}concat=n=${vOutLabels.length}:v=1:a=0[vout]`);
      if (chain.note) warn.push(chain.note);
    }
  } else {
    const vConcatIn = vOutLabels.map((l) => `[${l}]`).join("");
    parts.push(`${vConcatIn}concat=n=${vOutLabels.length}:v=1:a=0[vout]`);
  }
  const xfadeSec = xfadeInfo?.sec ?? 0;

  let audioLabel = null;
  if (!opts.muteAudio) {
    if (aSegs.length > 0) {
      const aOutLabels = [];
      for (let i = 0; i < aSegs.length; i++) {
        const c = aSegs[i].clip;
        const idx = aInputIdx[i];
        const label = `a${i}`;

        // ★ 补位用的静音段（无源文件）—— 直接 anullsrc
        if (c.silent || c.src == null) {
          const dur = Math.max(0.01, (c.out - c.in) / (c.speed > 0 ? c.speed : 1));
          parts.push(
            `anullsrc=channel_layout=stereo:sample_rate=48000,` +
            `atrim=start=0:end=${num(dur)},asetpts=PTS-STARTPTS[${label}]`
          );
          aOutLabels.push(label);
          continue;
        }

        const chain = ["aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"];

        // ★ 音频变速用 rubberband（规则②）
        if (Math.abs(c.speed - 1) > 1e-6) {
          chain.push(`rubberband=tempo=${num(c.speed)}`);
        }
        if (Math.abs((c.gain ?? 1) - 1) > 1e-6) {
          chain.push(`volume=${num(c.gain)}`);
        }
        // ★ 单段裁剪（与视频同步，否则音画会错位）
        if (c.trim) {
          const t0 = Math.max(0, Number(c.trim.startSec) || 0);
          const t1 = Number(c.trim.endSec);
          if (Number.isFinite(t1) && t1 > t0) {
            chain.push(`atrim=start=${num(t0)}:end=${num(t1)}`);
          }
        }
        // ★ 音频编辑（M8）：淡入淡出必须在 volume 之前，
        //   否则淡出时音量被再放大，听感是「渐弱到很大声」再消失。
        if (Array.isArray(c.audioFilters) && c.audioFilters.length) {
          for (const f of c.audioFilters) chain.push(f);
        }
        // 归零（音频也要，否则 concat 有静音间隙）
        chain.push("asetpts=PTS-STARTPTS");

        parts.push(`[${idx}:a]${chain.join(",")}[${label}]`);
        aOutLabels.push(label);
      }
      // ★ F8：启用转场时，音频要同步裁短，否则音画越往后越飘
      if (xfadeSec > 0 && aOutLabels.length >= 2) {
        const aDurs = aSegs.map((s) => {
          const c2 = s.clip;
          if (c2.silent || c2.src == null) return Math.max(0.01, (c2.out - c2.in) / (c2.speed > 0 ? c2.speed : 1));
          const base = (c2.out - c2.in) / (c2.speed > 0 ? c2.speed : 1);
          if (c2.trim) {
            const t0 = Math.max(0, Number(c2.trim.startSec) || 0);
            const t1 = Number(c2.trim.endSec);
            if (Number.isFinite(t1) && t1 > t0) return Math.max(0.01, t1 - t0);
          }
          return Math.max(0.01, base);
        });
        const at = buildAudioTrimForXfade({ labels: aOutLabels, durations: aDurs, sec: xfadeSec, out: "aout" });
        parts.push(...at.parts);
      } else {
        const aConcatIn = aOutLabels.map((l) => `[${l}]`).join("");
        parts.push(`${aConcatIn}concat=n=${aOutLabels.length}:v=0:a=1[aout]`);
      }
      audioLabel = "aout";
    } else {
      // ★★ 但不是每个视频都有音轨（实测踩过，2026-10-17 e2e）
      //   图片转出来的视频只有视频流，此时写 [0:a] 会报
      //     Stream specifier ':a' in filtergraph description ... matches no streams
      //   ⇒ 逐段检查 clip.hasAudio；没有的用 anullsrc 补静音，
      //     这样 concat 的音频输入数才与视频一致。
      const vAudioLabels = [];
      for (let i = 0; i < vSegs.length; i++) {
        const c = vSegs[i].clip;
        const idx = vInputIdx[i];
        const label = `va${i}`;
        const dur = (c.out - c.in) / (c.speed > 0 ? c.speed : 1);

        if (c.hasAudio === false) {
          const trimClause = c.trim
            ? `,atrim=start=${num(Math.max(0, Number(c.trim.startSec) || 0))}:end=${num(Number(c.trim.endSec))}`
            : "";
          parts.push(
            `anullsrc=channel_layout=stereo:sample_rate=48000,` +
            `atrim=start=0:end=${num(Math.max(0.01, dur))}${trimClause},` +
            `asetpts=PTS-STARTPTS[${label}]`
          );
        } else {
          const chain = ["aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"];
          if (Math.abs(c.speed - 1) > 1e-6) chain.push(`rubberband=tempo=${num(c.speed)}`);
          // 单段裁剪（视频用了 trim，原始音轨必须同样裁，否则音画错位）
          if (c.trim) {
            const t0 = Math.max(0, Number(c.trim.startSec) || 0);
            const t1 = Number(c.trim.endSec);
            if (Number.isFinite(t1) && t1 > t0) chain.push(`atrim=start=${num(t0)}:end=${num(t1)}`);
          }
          chain.push("asetpts=PTS-STARTPTS");
          parts.push(`[${idx}:a]${chain.join(",")}[${label}]`);
        }
        vAudioLabels.push(label);
      }
      // ★ F8：同上，转场时音频同步裁短
      if (xfadeSec > 0 && vAudioLabels.length >= 2) {
        const vDurs = vSegs.map((s) => {
          const c2 = s.clip;
          const base = (c2.out - c2.in) / (c2.speed > 0 ? c2.speed : 1);
          if (c2.trim) {
            const t0 = Math.max(0, Number(c2.trim.startSec) || 0);
            const t1 = Number(c2.trim.endSec);
            if (Number.isFinite(t1) && t1 > t0) return Math.max(0.01, t1 - t0);
          }
          return Math.max(0.01, base);
        });
        const at = buildAudioTrimForXfade({ labels: vAudioLabels, durations: vDurs, sec: xfadeSec, out: "aout" });
        parts.push(...at.parts);
      } else {
        const inl = vAudioLabels.map((l) => `[${l}]`).join("");
        parts.push(`${inl}concat=n=${vAudioLabels.length}:v=0:a=1[aout]`);
      }
      audioLabel = "aout";
    }
  }

  const filter = parts.join(";");

  args.push("-filter_complex", filter);
  args.push("-map", "[vout]");
  if (audioLabel) args.push("-map", `[${audioLabel}]`);
  else args.push("-an");

  args.push("-c:v", "libx264", "-preset", preset, "-crf", String(crf), "-pix_fmt", "yuv420p");
  // ★ 帧率必须靠输出参数 -r 锁定（滤镜里的 fps= 管不住容器帧率）
  //   实测：不加 -r 时输出 25.04 fps，加了才回到 24。
  args.push("-r", String(fps));
  if (audioLabel) args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-movflags", "+faststart");
  args.push("-y", opts.out);

  const expected = timelineDuration(tl);
  if (vSegs.length === 0) warn.push("视频轨为空");

  return {
    args, filter, warn,
    // 启用转场时，实际时长比时间轴名义时长短（每处吃掉 sec 秒）
    expectedDuration: xfadeInfo ? xfadeInfo.expectedDuration : expected,
    timelineDuration: expected,
    xfade: xfadeInfo,
    videoSegments: vSegs.length,
    audioSegments: aSegs.length,
  };
}

export function buildClipPreviewCommand(clip, opts = {}) {
  const fps = opts.fps ?? 24;
  const chain = [`fps=${fps}`, "format=yuv420p"];
  const ce = cropExpr(clip.crop);
  if (ce) chain.push(ce);
  if (Math.abs(clip.speed - 1) > 1e-6) {
    chain.push(`setpts=${num(1 / clip.speed)}*PTS`, `fps=${fps}`);
  }
  chain.push("setpts=PTS-STARTPTS");

  const aChain = ["aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"];
  if (Math.abs(clip.speed - 1) > 1e-6) aChain.push(`rubberband=tempo=${num(clip.speed)}`);
  aChain.push("asetpts=PTS-STARTPTS");

  const args = [
    "-ss", String(num(clip.in)), "-t", String(num(clip.out - clip.in)), "-i", clip.src,
    "-filter_complex", `[0:v]${chain.join(",")}[v];[0:a]${aChain.join(",")}[a]`,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(opts.crf ?? 20), "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-y", opts.out,
  ];
  return { args, filter: `[0:v]${chain.join(",")}[v];[0:a]${aChain.join(",")}[a]` };
}

export function commandLine(ffmpegPath, args) {
  const q = (s) => (/[\s;,'"[\]]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return `${q(ffmpegPath)} ${args.map(q).join(" ")}`;
}
