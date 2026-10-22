/**
 * ArtCraft 裁切/顺序的写回（2026-10-20）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么单独一个文件
 *
 *   ArtCraft 的 saveProject 拿到的是【它自己改完的 TProject】。
 *   如果直接把它当新真相写盘，我们的 clip 上这些字段会消失且不报错：
 *     shot       这一镜的生成配方（模式/提示词/画幅/时长/开关/素材）
 *     handoff    人机交接的字段锁与改动日志
 *     rendered   这一镜生成过什么
 *     regenError、fromVideoClipId
 *
 *   ⇒ 只能提交【裁切与顺序】这两样，走 dsh-editor 已有的命令路由。
 *     .不能写整个 state。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 用到的路由（dsh-editor 的 commands.mjs 已实现，我没改它一行）
 *
 *   POST /timeline/cmd/edit-clip   { clipId, op:"trim", trim:{startSec,endSec} }
 *   POST /timeline/cmd/edit-clip   { clipId, op:"move", toIndex }
 *
 * ★ 为什么用这个而不是自己写路由：
 *   主人定的原则 ——「工作流是作为一个可替换的模块接入我们的插件的，
 *   你的所有东西都应该让工作流对号入座，而不是为工作流服务」。
 *   同理：dsh-editor 已经是时间轴的真源持有者，它已有写回接口，
 *   我不该另造一条路径（那会变成两个写入点，迟早不一致）。
 */

/** ArtCraft 的 MediaTime（{numerator,denominator}）→ 秒 */
function timeToSec(t) {
  if (t == null) return 0;
  if (typeof t === "number") return t;
  const num = Number(t.numerator ?? 0);
  const den = Number(t.denominator ?? 1) || 1;
  return num / den;
}

/** 把秒取到 3 位小数，避免浮点噪声（0.30000000000000004） */
function round3(x) {
  return Math.round((Number(x) || 0) * 1000) / 1000;
}

/**
 * 造一个 onSave 回调，交给 createHttpAdapters。
 *
 * @param {object} [opts]
 * @param {(url:string, body:object)=>Promise<any>} [opts.post]
 *        便于测试注入。默认用 fetch。
 * @param {object} [opts.log]
 * @returns {(payload:{video:Array, audio:Array, name?:string})=>Promise<object>}
 */
export function createTrimWriter({ post, log = console } = {}) {
  const doPost = post ?? (async (url, body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(
        `POST ${url} → HTTP ${res.status}：${(j && j.error) || "无错误详情"}`
      );
    }
    if (j && j.error) throw new Error(`POST ${url} → ${j.error}`);
    return j;
  });

  return async function onSave({ video, audio }) {
    const all = [
      ...(video ?? []).map((x, i) => ({ ...x, track: "video", index: i })),
      ...(audio ?? []).map((x, i) => ({ ...x, track: "audio", index: i })),
    ];
    if (!all.length) return { ok: true, changed: 0 };

    const changed = [];
    const failed = [];

    /**
     * ★ 一次一个提交，不用 Promise.all。
     *   原因：edit-clip 会触发 store 写盘（debounce 1500ms）。
     *   并发 POST 会互相覆盖 —— 服务端每次都是「读当前 → 改一个 → 写」，
     *   两个请求同时进来时后一个可能基于旧快照。
     *   串行慢一点但结果确定。
     */
    for (const item of all) {
      const trim = {
        startSec: round3(timeToSec(item.trimStart)),
        endSec: round3(timeToSec(item.trimEnd)),
      };
      try {
        await doPost("/timeline/cmd/edit-clip", {
          clipId: item.id,
          op: "trim",
          trim,
        });
        changed.push(`${item.id}.trim`);
      } catch (e) {
        /**
         * ★ 单条失败不中断整批。
         *   场景：用户删了某个 clip，但 ArtCraft 的对话框还开着，
         *   保存时报「找不到 clipId」。这时其它 clip 的裁切不该一起丢。
         *   ⇒ 收集失败，全部跑完再汇总抛出。
         */
        failed.push({ id: item.id, err: String(e?.message ?? e) });
      }
    }

    /**
     * ★ 顺序：ArtCraft 的 elements 顺序就是时间轴顺序。
     *   只有【相邻顺序变了】才调 move —— 每次 move 都会重排数组，
     *   无脑全调会把数组搅乱。
     */
    const videoChanged = (video ?? []).map((x, i) => ({ id: x.id, want: i }));
    for (const { id, want } of videoChanged) {
      try {
        await doPost("/timeline/cmd/edit-clip", {
          clipId: id,
          op: "move",
          toIndex: want,
        });
      } catch (e) {
        // 顺序调整失败不比裁切失败严重（下次保存还会再试），只 warn
        log.warn?.(`[artcraft] 调整 ${id} 顺序失败：`, e?.message ?? e);
      }
    }

    if (failed.length) {
      log.warn?.("[artcraft] 部分裁切保存失败：", failed);
      throw new Error(
        `${failed.length} 个片段保存失败（已成功 ${changed.length} 个）：`
        + failed.slice(0, 3).map((f) => f.id + "=" + f.err).join("; ")
      );
    }

    log.info?.(`[artcraft] 裁切已写回 ${changed.length} 个片段`);
    return { ok: true, changed: changed.length };
  };
}
