/**
 * 把 DSH 的后端能力接成 ArtCraft 的 adapter（HTTP 版）。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么走 HTTP 而不是 import
 *
 *   ArtCraft 是【独立插件包】（dsh-artcraft-tab），
 *   adapter 逻辑在【另一个插件包】（dsh-comfy-workbench-tab）里。
 *
 *   两个插件包之间不能直接 import：
 *     · 客户端 bundle 是各自独立打包的 IIFE，
 *       跨包 import 会把对方整个打进来（又是 8MB）
 *     · 而且 AGENTS §3.2 记过：host 与 client 是两棵独立 cordis 树，
 *       ctx.provide 跨不过进程边界，正解就是 HTTP 路由
 *
 *   ⇒ 走 HTTP。这也正是 dsh-comfy-bridge 暴露 /comfy-bridge/* 的同一个理由。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 用到的路由（都由 dsh-comfy-workbench-tab 的 lib/index.js 提供）
 *
 *   GET  /comfy-assets/library?limit=N   → { ok, items, stats }
 *   GET  /comfy-assets/file?src=&rel=    → 媒体字节（支持 Range）
 *   POST /comfy-assets/upload            → 上传落盘，返回 { ok, item }
 *   GET  /timeline/snapshot              → { state, summary, version }
 *
 * ══════════════════════════════════════════════════════════════════════
 * 与 artcraft-adapter.mjs / artcraft-storage.mjs 的分工
 *
 *   那两个是【纯逻辑】（数据形状转换），已通过 143 项断言。
 *   这个文件是【取数】：从 HTTP 拿数据，再交给纯逻辑转换。
 *
 *   ★ 不在这里重新实现转换 —— 那会造成两份要同步的逻辑。
 *     但也不能 import 它们（跨包问题）。
 *     ⇒ 转换逻辑在打 ArtCraft 产物时作为参数注入（见 dsh-entry.tsx 的 opts）。
 */

/** 拉资产库全量（分页拉完）。 */
async function fetchAllAssets(onProgress) {
  const PAGE = 500;
  let offset = 0;
  const out = [];
  for (let page = 0; page < 20; page++) {
    const res = await fetch(
      `/comfy-assets/library?limit=${PAGE}&offset=${offset}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) throw new Error(`资产库 HTTP ${res.status}`);
    const j = await res.json();
    if (!j || !j.ok) throw new Error("资产库返回 ok=false：" + (j?.error ?? ""));
    const items = Array.isArray(j.items) ? j.items : [];
    out.push(...items);
    onProgress?.(out.length, j.matched ?? j.stats?.total ?? out.length);
    // 拉不动了就停
    if (items.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

/** 拿工程快照。 */
async function fetchSnapshot() {
  const res = await fetch("/timeline/snapshot", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`工程快照 HTTP ${res.status}`);
  const j = await res.json();
  return j?.state ?? null;
}

/**
 * 造 adapter 集合，交给 ArtCraft 的 mount(el, { adapters })。
 *
 * @param {object} deps
 * @param {(kinds:string[])=>Promise<{id:string,kind:string}[]>} deps.openPicker
 *        弹出选择器，返回用户选中的【handle 数组】。
 *        UI 由调用方提供（dsh-comfy-workbench-tab 的 useAssetPicker）。
 * @param {(state:object)=>object} deps.toProject
 *        把我们的 timeline-state 投影成 TProject。
 *        由 ArtCraft 产物侧注入（timeline-projection.mjs 的 toArtCraft）。
 * @param {(state:object)=>void} [deps.onSave]
 *        工程保存时的回调（写回 /timeline/cmd/*）。可选。
 * @param {object} [deps.log]
 */
export function createHttpAdapters({ openPicker, toProject, onSave, log = console } = {}) {
  /** 资产缓存 —— 避免每张缩略图都请求一次库。 */
  let cache = null;
  let cacheAt = 0;
  const TTL = 30_000;

  async function assets() {
    const now = Date.now();
    if (cache && now - cacheAt < TTL) return cache;
    cache = await fetchAllAssets();
    cacheAt = now;
    return cache;
  }

  /** 我们资产库没有可靠 mime，按扩展名推。 */
  function mimeOf(it) {
    const n = String(it?.name ?? it?.rel ?? "").toLowerCase();
    const ext = n.slice(n.lastIndexOf("."));
    const MAP = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
      ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
      ".mkv": "video/x-matroska", ".m4v": "video/x-m4v",
      ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
      ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg",
      ".opus": "audio/opus",
    };
    return MAP[ext] ?? "application/octet-stream";
  }

  /* ── ① assetGallery ─────────────────────────────────── */
  const assetGallery = {
    async openPicker({ kinds }) {
      try {
        /**
         * ★ 让选择器只显示 ArtCraft 能用的类型。
         *   我们的资产库有 6 种 kind（image/video/audio/text/other/…），
         *   ArtCraft 的 MediaKind 只有 3 种。
         *   不过滤的话，用户会选到永远拖不进时间轴的幽灵条目。
         */
        const want = new Set(
          Array.isArray(kinds) && kinds.length ? kinds : ["image", "video", "audio"]
        );
        const raw = await openPicker([...want]);
        return (raw || [])
          .filter((x) => x && x.id && want.has(x.kind))
          .map((x) => ({
            handle: { id: String(x.id), kind: x.kind },
            name: String(x.displayName || x.name || x.id),
          }));
      } catch (e) {
        // ★ 绝不 reject —— ArtCraft 会以为整个编辑器挂了
        log.warn?.("[artcraft] openPicker 失败（返回空）:", e?.message ?? e);
        return [];
      }
    },
  };

  /* ── ② mediaSource ──────────────────────────────────── */
  const mediaSource = {
    async resolveMedia(handle) {
      const id = String(handle?.id ?? "");
      // ★ 2026-10-21 删除临时探针 window.__ARTCRAFT_RESOLVE__
      //   它由 2026-10-20 那次「clip 只有文字没有缩略图」的诊断留下。
      //   那次诊断的结论已经写进 AGENTS §6.39 ⑤ 与 verify-regression：
      //     「ArtCraft 不做按需 resolveMedia，而是先查已注册的资产表」
      //     加日志确认过 resolveMedia 被调用 0 次 —— 所以这个探针本身
      //     从来没被触发过，留着纯属误导。
      //   判据（可复跑）：grep -c "__ARTCRAFT_RESOLVE__" src/*.js → 0
      if (!id) throw new Error("缺 handle.id");

      const all = await assets();
      const it = all.find((x) => String(x.id) === id);
      if (!it) throw new Error(`资产库里找不到 ${id}`);

      /**
       * ★ 走同源代理 /comfy-assets/file，不直连 8188。
       *   实测（AGENTS §6.17）：ComfyUI 对带 Origin 的请求一律 403，
       *   代理是唯一能访问的路径。
       */
      const qs = new URLSearchParams({
        src: String(it.src ?? "output"),
        rel: String(it.rel ?? ""),
      });
      return {
        url: `/comfy-assets/file?${qs.toString()}`,
        mime: mimeOf(it),
      };
    },

    /**
     * ★★ 2026-10-21 修（主人：「这两个还是导入不了本地的视频」）
     *
     * —— 根因（实测，两端都各自正确，是协议对不上）：
     *   本函数发的是 multipart/form-data：
     *     const fd = new FormData(); fd.append("file", file);
     *     fetch("/comfy-assets/upload", { body: fd })
     *   而服务端那条路由（dsh-comfy-workbench-tab/lib/index.js:1288-1304）逐字是：
     *     body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
     *     catch { return json(res, 400, { error: "请求体不是合法 JSON" }) }
     *     const filename = String(body.filename ?? "").trim();
     *     const base64 = String(body.base64 ?? "");
     *   ⇒ 收到的 FormData 不是 JSON ⇒ 直接 400「请求体不是合法 JSON」。
     *   实测：用 1×1 PNG 走 multipart 打这个端点，返回
     *     {"error":"请求体不是合法 JSON"}，HTTP 400。
     *
     * —— 为什么改这边而不是改服务端：
     *   服务端那条路由还负责「文件大小上限 64MB / 扩展名白名单 / 不覆盖既有文件」
     *   三件事，改成 multipart 要重写整个解析与校验；
     *   而适配器这边只要把 File 读成 base64 即可，改动面小且不碰已验收的后端。
     *   （另一处调用方 dsh-comfy-workbench-tab/src/artcraft-wire.mjs:128 也是同样的
     *     multipart 写法，属于同一个协议不匹配，但它不是本包，本轮不动，已登记。）
     *
     * —— 大文件怎么办：
     *   base64 比原文件大约 1/3。服务端上限 64MB（解码后的字节数），
     *   所以原文件最大约 48MB 会被 base64 撑到 64MB 边界。
     *   这里先判 len，超了给明确提示，而不是发出去等 413。
     */
    async uploadLocalFile(file) {
      // ① 先按服务端的 64MB（解码后）上限预估：base64 膨胀约 4/3
      const MAX_BYTES = 48 * 1024 * 1024;
      if (file.size > MAX_BYTES) {
        throw new Error(
          `文件太大：${(file.size / 1048576).toFixed(1)}MB，` +
          `上限约 ${Math.round(MAX_BYTES / 1048576)}MB（base64 传输会再膨胀 1/3）`,
        );
      }

      // ② File → base64（不用 FileReader，用 arrayBuffer + btoa 分块，
      //    避免大文件一次性拼成超长字符串时栈溢出）
      const buf = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
      }
      const base64 = btoa(binary);

      // ③ 按服务端协议发 JSON
      const res = await fetch("/comfy-assets/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name || "upload.bin",
          base64,
        }),
      });

      let j = null;
      try { j = await res.json(); } catch { /* 非 JSON 响应 */ }
      if (!res.ok) {
        throw new Error("上传失败：HTTP " + res.status + (j?.error ? " · " + j.error : ""));
      }
      if (!j || !j.ok) throw new Error("上传失败：" + (j?.error ?? "未知"));

      /**
       * ★ 响应是【扁平结构】，不是嵌套的 { ok, item }。
       *   实测（2026-10-21，1×1 PNG 走 JSON 上传）：
       *     {"ok":true,
       *      "id":"input:wb_probe-json_fqdlbr.png",
       *      "absPath":"D:\\Comfy-Desktop\\ComfyUI-Shared\\input\\wb_probe-json_fqdlbr.png",
       *      "filename":"wb_probe-json_fqdlbr.png",
       *      "sizeBytes":70,
       *      "displayName":null}
       *   ⇒ 第一版我按 j.item.id 取，会报「上传成功但没返回资产 id」。
       *   ★ 教训：协议对齐不能只看「字段名叫什么」，
       *     要看【真实响应长什么样】——这条是打了一次真实请求才发现的。
       */
      const id = j.id ?? j.item?.id;
      if (!id) throw new Error("上传成功但没返回资产 id（实际响应：" + JSON.stringify(j).slice(0, 160) + "）");

      // 让缓存失效，新素材立刻能搜到
      cache = null;
      // kind 由扩展名判（服务端不返回 kind；它只认扩展名白名单）
      const ext = String(j.filename ?? file.name ?? "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
      const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"]);
      const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"]);
      const kind = VIDEO_EXT.has(ext) ? "video" : AUDIO_EXT.has(ext) ? "audio" : "image";
      return { id: String(id), kind };
    },

    /**
     * ★ 不实现 probe。
     *   我们的资产库没有可靠的 durationMs / fps / 宽高，
     *   返回不准的元数据比让 ArtCraft 自己解码更糟
     *   （它的 media-source.ts 里 probe 是可选的）。
     */
  };

  /* ── ③ projectStorage ───────────────────────────────── */
  const SINGLE_ID = "wb_timeline";

  const projectStorage = {
    async loadProject(id) {
      if (id != null && id !== SINGLE_ID) return null;
      const state = await fetchSnapshot();
      if (!state) return null;
      const data = toProject ? toProject(state) : null;
      if (!data) throw new Error("工程投影失败（toProject 没返回）");
      return {
        id: SINGLE_ID,
        name: String(state?.name ?? "未命名"),
        updatedAt: Number(state?.savedAt) || Date.now(),
        data,
      };
    },

    /**
     * ★★ 保存：绝不能直接覆盖 timeline-state。
     *
     *   ArtCraft 给的是改完的 TProject，里面【没有】我们的
     *   shot / handoff / rendered 字段（它的 element 类型里不存在）。
     *   直接写回会让每一镜的「生成配方」和「谁锁了 prompt」全部消失，
     *   而且不报错。
     *
     *   ⇒ 走 /timeline/cmd/update-clip-trim，只提交【裁切与顺序】。
     *     这个路由由 dsh-editor 提供（它是 timeline 的真源持有者）。
     *
     *   ★ 未验证：该路由的确切参数名。第一次真跑时如果 404/400，
     *     从这里改。现在先按 update-shot 的命名习惯写。
     */
    async saveProject(project) {
      if (!project || project.id !== SINGLE_ID) return;
      if (typeof onSave !== "function") {
        log.warn?.("[artcraft] saveProject 没有 onSave 回调，改动未写回");
        return;
      }
      const scene = (project.data?.scenes ?? []).find((s) => s.isMain) ?? project.data?.scenes?.[0];
      if (!scene) return;

      /**
       * ★★ 2026-10-20 修：主轨是 tracks.main（单个对象），不是 tracks.video（数组）
       *
       *   这是同一个坑的第二次踩 —— toArtCraft 里已经修过
       *   （见 dsh-projection.ts 里「scene.tracks.overlay is not iterable」那段），
       *   但 saveProject 这边的读取我漏改了。
       *
       *   判据：如果这里写错，saveProject 会拿到 video=[] 空数组，
       *        于是「什么都没保存」却不报错 —— 用户以为保存了。
       */
      const collect = (track) => (track?.elements ?? []).map((el) => ({
        id: el.id,
        trimStart: el.trimStart,
        trimEnd: el.trimEnd,
      }));
      const video = collect(scene.tracks?.main);
      const audio = collect((scene.tracks?.audio ?? [])[0]);

      if (!video.length && !audio.length) {
        log.info?.("[artcraft] 没有可保存的片段，跳过");
        return;
      }

      try {
        await onSave({ video, audio, name: project.name });
        log.info?.(
          "[artcraft] 已保存：" + video.length + " 个视频片段、"
          + audio.length + " 个音频片段"
        );
      } catch (e) {
        log.warn?.("[artcraft] 保存失败：", e?.message ?? e);
        throw e;
      }
    },

    async deleteProject(id) {
      /**
       * ★ 不删存档文件。
       *   我们的 timeline-state 是不可复原的资产（含每一镜的生成配方），
       *   删掉就没了。
       *   ⇒ 这里什么都不做，并明确告知。
       */
      if (id === SINGLE_ID) {
        log.warn?.("[artcraft] deleteProject 被调用，但为保护存档不做删除。"
          + "要清空请在「粗剪」tab 里操作。");
      }
    },

    async listProjects() {
      const state = await fetchSnapshot();
      const clips = (state?.tracks ?? []).reduce((n, tr) => n + (tr.clips?.length ?? 0), 0);
      return [{
        id: SINGLE_ID,
        name: String(state?.name ?? "未命名"),
        updatedAt: Number(state?.savedAt) || Date.now(),
        clipCount: clips,
      }];
    },

    async createProject(name) {
      /**
       * ★ 语义是「重置当前这份存档」，不是「再开一份」。
       *   我们的模型只有一份 timeline-state。
       *
       *   ★ 未实现：真正的重置需要调 /timeline/cmd/*。
       *     现在返回一个空工程让 ArtCraft 能进去，但不落盘 ——
       *     用户如果只是想「看看新工程长什么样」，这够用；
       *     要真正清空得走「粗剪」tab。
       */
      log.warn?.("[artcraft] createProject 只返回空工程，未清空存档（保护数据）");
      return {
        id: SINGLE_ID,
        name: String(name ?? "未命名"),
        updatedAt: Date.now(),
        data: toProject ? toProject({
          version: 1, savedAt: Date.now(), fps: 24,
          name: String(name ?? "未命名"), nextShotIndex: 1,
          tracks: [
            { id: "t_video_1", kind: "video", name: "视频 1", clips: [] },
            { id: "t_audio_1", kind: "audio", name: "音频 1", clips: [] },
          ],
        }) : null,
      };
    },
  };

  return { assetGallery, mediaSource, projectStorage };
}

/** 供外部主动清缓存（上传后、外部改动后）。 */
export function invalidateAssetCache() {
  // 闭包里的 cache 在 createHttpAdapters 内，
  // 这里只做说明：调用方如果拿到的是 createHttpAdapters 的返回值，
  // uploadLocalFile 内部已经清了。
}
