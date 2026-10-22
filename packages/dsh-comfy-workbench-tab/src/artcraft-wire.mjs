/**
 * 把 DSH 的资产库/工程存取，接成 ArtCraft 的 adapter。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这个文件解决什么
 *
 *   ArtCraft 的 7 个 adapter 里，4 个依赖我们的数据：
 *     assetGallery   → 用我们的资产库当「Browse gallery」
 *     mediaSource    → 把我们的资产 id 解析成可播放 URL
 *     projectStorage → 工程存进我们的 timeline-state.json
 *
 *   后端逻辑已经写好并验过（143 项断言）：
 *     src/artcraft-adapter.mjs   assetToSelection / handleToResolved / filterByKinds
 *     src/artcraft-storage.mjs   createProjectStorage
 *     src/timeline-projection.mjs toArtCraft / fromArtCraft
 *
 *   这里只做【接线】：把纯函数包成 ArtCraft 要的异步接口形状。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人定的顺序与原则（逐字）
 *
 *   「先做后端，再匹配前端 ui」
 *   「工作流是作为一个可替换的模块接入我们的插件的，你的所有东西
 *     都应该让工作流对号入座，而不是为工作流服务」
 *
 *   ⇒ 这个文件就是「对号入座」的那一层：
 *     ArtCraft 要什么形状，我们给它什么形状，不改它的代码。
 */

import { handleToResolved, filterByKinds } from "./artcraft-adapter.mjs";
import { createProjectStorage } from "./artcraft-storage.mjs";
import { toArtCraft } from "./timeline-projection.mjs";

/**
 * 造一串 adapter，交给 ArtCraft 的 mount(el, { adapters })。
 *
 * @param {object} deps
 * @param {object} deps.lib           资产库 hook 的返回值（要有 items / reload）
 * @param {(kinds:string[])=>Promise<object[]>} deps.openPicker
 *        弹出我们的选择器，返回用户选中的【完整 item】数组。
 *        UI 由调用方提供（useAssetPicker 的 open）。
 * @param {object} deps.store         host-store（timeline 的真源）
 * @param {object} deps.persister     createPersister 的返回值
 * @param {(s:object)=>void} deps.replaceState  把合并后的 state 写回 store
 * @param {object} [deps.log]
 * @returns {object} 可直接传给 ArtCraft 的 adapters（只含我们要覆盖的那几个）
 */
export function buildArtCraftAdapters({
  lib, openPicker, store, persister, replaceState, log = console,
}) {
  const itemsNow = () => (lib && Array.isArray(lib.items) ? lib.items : []);

  /* ── ① assetGallery：用我们的资产库 ─────────────────────── */
  const assetGallery = {
    /**
     * ArtCraft 点「Browse gallery」时调。
     * @param {{kinds:string[]}} p
     * @returns {Promise<{handle:{id:string,kind:string}, name:string}[]>}
     */
    async openPicker({ kinds }) {
      try {
        /**
         * ★ 两个阶段：
         *   ① 先按 kinds 过滤出「可选集合」，让选择器只显示能用的
         *      （ArtCraft 的 MediaKind 只有 image/video/audio 三种，
         *       我们的资产库还有 text/other，塞进去会变成拖不进轨道的幽灵条目）
         *   ② 用户选完，返回 ArtCraft 要的形状
         *
         *   ★ 这里不自己再转一次 selection ——
         *     后端 artcraft-adapter 的 filterByKinds 已经做过了，
         *     重复实现会造成两份要同步的逻辑。
         */
        const all = itemsNow();
        const usable = filterByKinds(all, kinds);
        if (!usable.length) {
          log.warn?.("[artcraft] 没有可用素材（kinds=" + (kinds || []).join(",") + "）");
          return [];
        }

        // 让用户选（UI 由 DSH 侧提供）
        const chosen = await openPicker(kinds || []);
        return (chosen || [])
          .map((it) => {
            // 用户可能选到 kinds 之外的（选择器没拦住时兜底）
            const kind = it.kind === "image" ? "image"
              : it.kind === "video" ? "video"
              : it.kind === "audio" ? "audio" : null;
            if (!kind) return null;
            return {
              handle: { id: String(it.id), kind },
              name: String(it.displayName || it.name || it.id),
            };
          })
          .filter(Boolean);
      } catch (e) {
        log.warn?.("[artcraft] openPicker 失败（返回空）:", e?.message ?? e);
        return [];       // ★ 绝不 reject —— ArtCraft 会以为整个编辑器挂了
      }
    },
  };

  /* ── ② mediaSource：我们的资产 id → 可播放 URL ───────────── */
  const mediaSource = {
    async resolveMedia(handle) {
      const all = itemsNow();
      try {
        return handleToResolved(handle, all);
      } catch (e) {
        /**
         * ★ 这里有意的选择：resolveMedia 失败时【抛错】而不是返回假 URL。
         *   返回一个空 url 会让 ArtCraft 显示一个黑块，用户以为素材坏了；
         *   抛错它会显示「素材加载失败」，看得出是缺素材。
         */
        throw new Error(
          "找不到素材 " + String(handle?.id) + "（" + (e?.message ?? e) + "）"
        );
      }
    },

    /**
     * 用户往 ArtCraft 里拖本地文件时调。
     * ★ 走我们的 /upload 路由，落进 ComfyUI 的 input 目录，
     *   然后拿回一个资产 id —— 这样它就和 @ 引用里的素材是同一套。
     *
     * ★★ 2026-10-21 修（主人：「这两个还是导入不了本地的视频」）
     *   原来这里发 multipart/form-data，而服务端（lib/index.js:1288-1304）
     *   只接受 JSON：
     *     body = JSON.parse(...)
     *     catch { return json(res, 400, { error: "请求体不是合法 JSON" }) }
     *   ⇒ FormData 直接被当成「不合法 JSON」打回 400。
     *   实测：multipart 打这个端点 → 400 {"error":"请求体不是合法 JSON"}
     *        JSON+base64 打这个端点 → 200 {"ok":true,"id":"input:wb_xxx.png",...}
     *
     *   ★ 响应是【扁平结构】：id / absPath / filename / sizeBytes 都在顶层，
     *     没有嵌套的 item。第一版按 j.item.id 取会报「没返回资产 id」。
     *
     *   ⚠ 同一个协议错误在 dsh-artcraft-tab/src/adapters.js 里也有一份，
     *     两处必须同时修（本项目老坑 §6.43：一个字段有 N 条构造路径）。
     */
    async uploadLocalFile(file) {
      const MAX_BYTES = 48 * 1024 * 1024;
      if (file.size > MAX_BYTES) {
        throw new Error(
          `文件太大：${(file.size / 1048576).toFixed(1)}MB，` +
          `上限约 ${Math.round(MAX_BYTES / 1048576)}MB（base64 传输会再膨胀 1/3）`,
        );
      }

      const buf = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
      }

      const res = await fetch("/comfy-assets/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name || "upload.bin",
          base64: btoa(binary),
        }),
      });

      let j = null;
      try { j = await res.json(); } catch { /* 非 JSON */ }
      if (!res.ok) {
        throw new Error("上传失败：HTTP " + res.status + (j?.error ? " · " + j.error : ""));
      }
      if (!j || !j.ok) throw new Error("上传失败：" + (j?.error ?? "未知"));

      const id = j.id ?? j.item?.id;
      if (!id) throw new Error("上传成功但没返回资产 id（实际响应：" + JSON.stringify(j).slice(0, 160) + "）");

      // 让资产库重新扫一遍，这样新素材立刻能在 @ 里搜到
      try { await lib?.reload?.(); } catch { /* ignore */ }

      // kind 由扩展名判（服务端不返回 kind）
      const ext = String(j.filename ?? file.name ?? "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
      const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"]);
      const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"]);
      const kind = VIDEO_EXT.has(ext) ? "video" : AUDIO_EXT.has(ext) ? "audio" : "image";
      return { id: String(id), kind };
    },

    /**
     * 元数据探测交给 ArtCraft 自己做（它内置 MediaBunny）。
     * ★ 不实现 probe 的理由：我们的资产库没有可靠的 durationMs / fps 字段，
     *   返回不准确的元数据比让它自己解码更糟。
     *   （接口里 probe 是可选的 —— 见 media-source.ts 的 `probe?`）
     */
  };

  /* ── ③ projectStorage：工程存进我们的 timeline-state ────── */
  const projectStorage = createProjectStorage({
    store, persister, replaceState, log,
  });

  return { assetGallery, mediaSource, projectStorage };
}

/**
 * 给 ArtCraft 的 mount() 准备工程投影。
 *
 * ★ 为什么单独一个函数：
 *   mount(el, { project }) 需要的是 TProject，
 *   而我们的真相是 timeline-state。投影必须走 toArtCraft ——
 *   直接传 timeline-state 进去 ArtCraft 认不出。
 */
export function projectFor(state) {
  return toArtCraft(state, { projectId: "wb_timeline" });
}
