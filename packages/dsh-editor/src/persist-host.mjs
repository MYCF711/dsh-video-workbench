import fs from "node:fs";
import path from "node:path";

/**
 * 建一个持久化器。
 * @param {object} opts
 * @param {string} opts.file            存档文件路径
 * @param {object} opts.store           createTimelineStore() 的返回值
 * @param {object} [opts.log]
 * @param {number} [opts.debounceMs]    写盘防抖，默认 1500ms
 * @returns {{ flush, load, dispose, file }}
 */
export function createPersister({ file, store, log = console, debounceMs = 1500 }) {
  let timer = null;
  let pending = false;
  let disposed = false;

  function extract() {
    const s = store.snapshot();
    return {
      version: 1,
      savedAt: Date.now(),
      fps: s.fps,
      name: s.name,
      nextShotIndex: s.nextShotIndex,
      tracks: s.tracks.map((tr) => ({
        id: tr.id,
        kind: tr.kind,
        name: tr.name,
        clips: tr.clips.map((c) => ({
          id: c.id,
          kind: c.kind,
          name: c.name,
          src: c.src,
          in: c.in,
          out: c.out,
          speed: c.speed,
          crop: c.crop,
          gain: c.gain,
          trim: c.trim,
          // ★ 运行态不存，恢复时统一改 cancelled
          shot: c.shot,
          rendered: c.rendered,
          regenError: c.status === "failed" ? c.regenError : null,
          fromVideoClipId: c.fromVideoClipId,
          // ★ 2026-10-18（F6 人机交接）：锁与改动日志必须持久化，
          //   否则重启后「谁定了 prompt」全丢，Agent 又会覆盖用户改的东西。
          handoff: c.handoff ?? null,
        })),
      })),
    };
  }

  function writeNow() {
    if (disposed) return;
    try {
      const data = extract();
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, file);
      pending = false;
    } catch (err) {
      log.warn?.(`[timeline-persist] 写盘失败：${err.message}`);
    }
  }

  function schedule() {
    if (disposed) return;
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; writeNow(); }, debounceMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    writeNow();
  }

/**
 * /**
 * 从磁盘恢复。
 * ★ 状态修正：
 * running/queued → cancelled（任务已随进程消失）
 * idle 但有 rendered → done（这个不该出现，防御性修正）
 * @returns {{ok:boolean, clips?:number, reason?:string}}
 */
  /**
   * 把损坏的存档隔离成 `<原名>.corrupt-<时间戳>`，返回备份路径。
   *
   * ★ 为什么要这一步：load() 失败后服务照常运行，下一次写入会用空状态
   *   覆盖原文件。不隔离就等于把用户的最后一份证据也删了。
   *   隔离后至少能人工抢救（改几行 JSON 往往就能救回来）。
   *
   * ★ 为什么用 rename 而不是 copy：rename 是原子的，且不占双倍空间。
   *   隔离失败（比如权限问题）也不阻断启动 —— 只额外 warn。
   */
  function quarantineCorrupt(err) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = `${file}.corrupt-${stamp}`;
    try {
      fs.renameSync(file, dest);
      log.warn?.(
        `[timeline-persist] 存档损坏（${err.message}），已隔离为 ${path.basename(dest)}` +
        ` —— 原始内容还在，可人工修复后改回原名`
      );
      return path.basename(dest);
    } catch (e2) {
      log.warn?.(
        `[timeline-persist] 存档损坏（${err.message}），且隔离失败（${e2.message}）` +
        ` —— 下一次写入会覆盖它`
      );
      return "(隔离失败)";
    }
  }

  function load() {
    if (!fs.existsSync(file)) return { ok: false, reason: "没有存档" };
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      // ★★ 2026-10-19 修（复核员 2e3543a0 指出，我复跑确认）：
      //   原来只 log.warn 然后返回失败 —— 但服务照常运行，
      //   下一次 writeNow() 就会用空状态【覆盖掉】这个坏存档。
      //   用户看到的是「时间轴空了」，和「项目本来就是空的」无法区分，
      //   坏存档也没了，等于【静默销毁证据 + 数据】。
      //   ⇒ 损坏时先把原文件隔离一份，再往下走。
      const quarantine = quarantineCorrupt(err);
      return { ok: false, reason: `存档损坏（原文件已备份为 ${quarantine}）` };
    }
    if (!data || !Array.isArray(data.tracks)) {
      const quarantine = quarantineCorrupt(new Error("格式不对：缺 tracks 数组"));
      return { ok: false, reason: `存档格式不对（原文件已备份为 ${quarantine}）` };
    }

    store._reset(data.name ?? "恢复的粗剪");

    // ★★ 这里踩过一个坑（实测，2026-10-17）：
    //   ⇒ 必须用 store 的公开 API（addShot / addTrack / addAudioFromVideo）。
    let restoredClips = 0;
    let idx = 0;

    for (const tr of data.tracks) {
      idx = 0;
      for (const c of tr.clips) {
        idx += 1;
        if (c.kind === "audio" || tr.kind === "audio") {
          if (c.fromVideoClipId) {
            try {
              store.addAudioFromVideo(c.fromVideoClipId, {
                path: c.rendered?.path ?? null,
                url: c.rendered?.url ?? null,
                filename: c.rendered?.filename ?? null,
                durationSec: c.rendered?.durationSec ?? c.out,
              }, "restore");
              restoredClips += 1;
            } catch (err) {
              log.warn?.(`[timeline-persist] 恢复音频失败（源视频未恢复）：${err.message}`);
            }
          } else {
            try {
              const track = store.snapshot().tracks.find((t) => t.kind === "audio");
              if (track) {
                store.addClipRaw(track.id, {
                  id: c.id, kind: "audio", name: c.name, src: c.src,
                  in: c.in, out: c.out, speed: c.speed, gain: c.gain,
                  trim: c.trim, rendered: c.rendered, status: "done",
                }, "restore");
                restoredClips += 1;
              }
            } catch (err) {
              log.warn?.(`[timeline-persist] 恢复音频片段失败：${err.message}`);
            }
          }
        } else {
          // ★ 不能走 addShot —— 那会重新编号、丢 id、丢 shot.history
          try {
            let vTrack = store.snapshot().tracks.find((t) => t.kind === "video");
            if (!vTrack) vTrack = store.addTrack("video", tr.name, "restore");
            store.addClipRaw(vTrack.id, {
              id: c.id,
              kind: "video",
              name: c.name,
              src: c.src,
              in: c.in,
              out: c.out,
              speed: c.speed,
              crop: c.crop,
              gain: c.gain,
              trim: c.trim,
              shot: c.shot,
              rendered: c.rendered,
              // ★ 运行态修正：有成片就算 done，没成片但有错就是 failed，否则 idle
              status: c.rendered ? "done" : (c.regenError ? "failed" : "idle"),
              regenError: c.regenError ?? null,
              // ★ F6：交接记录一起恢复。addClipRaw 会原样挂到 clip 上。
              handoff: c.handoff ?? null,
            }, "restore");
            restoredClips += 1;
          } catch (err) {
            log.warn?.(`[timeline-persist] 恢复视频片段失败：${err.message}`);
          }
        }
      }
    }

    if (typeof data.nextShotIndex === "number") {
      const cur = store.snapshot();
      if (typeof store._restoreMeta === "function") {
        store._restoreMeta({ nextShotIndex: data.nextShotIndex });
      }
    }

    log.info?.(`[timeline-persist] 已恢复 ${restoredClips} 段（${data.savedAt ? new Date(data.savedAt).toLocaleString("zh-CN") : "?"}）`);
    return { ok: true, clips: restoredClips };
  }

  const unsubscribe = store.subscribe(() => schedule());

  const onExit = () => { try { flush(); } catch { /* ignore */ } };
  process.once("exit", onExit);
  process.once("SIGINT", onExit);
  process.once("SIGTERM", onExit);

  function dispose() {
    disposed = true;
    try { flush(); } catch { /* ignore */ }
    unsubscribe();
    process.off("exit", onExit);
    process.off("SIGINT", onExit);
    process.off("SIGTERM", onExit);
  }

  return { flush, load, dispose, file, isPending: () => pending };
}
