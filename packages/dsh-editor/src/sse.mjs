
/**
 * 注册 SSE 路由。
 * @param {object} ctx            cordis ctx（需要 ctx.webServer）
 * @param {object} store          createTimelineStore() 的返回值
 * @param {object} [opts]
 * @param {string} [opts.prefix]  路由前缀，默认 /timeline
 * @param {object} [opts.log]
 * @returns {Function} disposer
 */
export function registerSse(ctx, store, opts = {}) {
  const prefix = (opts.prefix ?? "/timeline").replace(/\/+$/, "");
  const log = opts.log ?? console;

  if (typeof ctx?.webServer?.register !== "function") {
    log.warn?.("[timeline-sse] ctx.webServer 不可用，SSE 未注册");
    return () => {};
  }

  const clients = new Set();

/** /** 往一个客户端写一条 SSE 事件。 */
  function send(res, event, data) {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  }

  const unsubscribe = store.subscribe((evt) => {
    for (const res of [...clients]) {
      if (!send(res, "timeline", evt)) clients.delete(res);
    }
  });

  const disposers = [];

  disposers.push(
    ctx.webServer.register({
      kind: "exact",
      path: prefix + "/preview",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "method not allowed" }));
          return;
        }
        try {
          const { buildPreviewSequence, canPreviewAll } = await import("./preview.mjs");
          // ★ 必须传 assetPrefix —— 否则本地文件会退化成 file:///，
          //   MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check
          //   （实测踩到，2026-10-17）
          const seq = buildPreviewSequence(store.snapshot(), {
            comfyOrigin: opts.comfyOrigin,
            assetPrefix: prefix,
          });
          const can = canPreviewAll(seq);
          const body = JSON.stringify({ ...seq, canPreviewAll: can });
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(body),
            "Cache-Control": "no-store",
          });
          res.end(body);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      },
    })
  );

  // ★ 为什么需要这个
  //   成片存在本地磁盘（outputs/），浏览器不能直接读。
  disposers.push(
    ctx.webServer.register({
      kind: "exact",
      path: prefix + "/file",
      handler: async (req, res) => {
        if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
        const fs = await import("node:fs");
        const pathMod = await import("node:path");
        let p = null;
        try {
          const u = new URL(req.url ?? "/", "http://127.0.0.1");
          p = u.searchParams.get("path");
        } catch { /* ignore */ }
        if (!p) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "缺 path" }));
          return;
        }
        const norm = pathMod.normalize(p);

        // ★ 允许目录：
        //   否则只是「能读任意路径」的开放代理。
        const allowedRoots = [opts.outDir, opts.cacheDir, ...(opts.extraAllowedDirs ?? [])]
          .filter(Boolean).map((d) => pathMod.resolve(d));
        const target = pathMod.resolve(norm);

        let isAllowed = allowedRoots.some(
          (root) => target === root || target.startsWith(root + pathMod.sep)
        );

        if (!isAllowed && opts.assets) {
          try {
            const hit = opts.assets.list({ limit: 100000 }).some(
              (a) => pathMod.resolve(a.path) === target
            );
            if (hit) isAllowed = true;
          } catch { /* 素材库不可用就跳过 */ }
        }

        if (!isAllowed) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "该路径不在允许范围内（outputs / .cache / 素材库）" }));
          return;
        }
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "文件不存在" }));
          return;
        }

        const st = fs.statSync(target);
        const ext = pathMod.extname(target).toLowerCase();
        const mime = {
          ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
          ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac",
          ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
        }[ext] ?? "application/octet-stream";

        // ★ Range 支持 —— <video> 拖动进度条必须靠它，否则只能从头播
        const range = req.headers?.range;
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(String(range));
          if (m) {
            const start = m[1] ? Number(m[1]) : 0;
            const end = m[2] ? Number(m[2]) : st.size - 1;
            const len = end - start + 1;
            res.writeHead(206, {
              "Content-Type": mime,
              "Content-Length": len,
              "Content-Range": `bytes ${start}-${end}/${st.size}`,
              "Accept-Ranges": "bytes",
              "Cache-Control": "no-store",
            });
            fs.createReadStream(target, { start, end }).pipe(res);
            return;
          }
        }

        res.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": st.size,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        });
        fs.createReadStream(target).pipe(res);
      },
    })
  );

  if (opts.assets) {
    const assets = opts.assets;
    disposers.push(
      ctx.webServer.register({
        kind: "exact",
        path: prefix + "/assets",
        handler: async (req, res) => {
          if (req.method !== "GET") {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "method not allowed" }));
            return;
          }
          try {
            let url;
            try { url = new URL(req.url ?? "/", "http://127.0.0.1"); } catch { url = new URL("http://127.0.0.1/"); }
            const q = url.searchParams;
            const items = assets.list({
              kind: q.get("kind") || null,
              group: q.get("group") || null,
              tag: q.get("tag") || null,
              q: q.get("q") || null,
              limit: Number(q.get("limit") ?? 500),
            }).map((a) => ({
              id: a.id, name: a.name, path: a.path, kind: a.kind,
              sizeMB: Math.round((a.sizeBytes / 1024 / 1024) * 10) / 10,
              group: a.group, tags: a.tags, source: a.source,
            }));
            const body = JSON.stringify({ items, stats: assets.stats() });
            res.writeHead(200, {
              "Content-Type": "application/json; charset=utf-8",
              "Content-Length": Buffer.byteLength(body),
              "Cache-Control": "no-store",
            });
            res.end(body);
          } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
        },
      })
    );
  }

  disposers.push(
    ctx.webServer.register({
      kind: "exact",
      path: prefix + "/align",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "method not allowed" }));
          return;
        }
        try {
          const { checkAvAlignment } = await import("./audio-split.mjs");
          const body = JSON.stringify(checkAvAlignment(store.snapshot()));
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(body),
            "Cache-Control": "no-store",
          });
          res.end(body);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      },
    })
  );

  disposers.push(
    ctx.webServer.register({
      kind: "exact",
      path: prefix + "/snapshot",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          res.writeHead(405, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "method not allowed" }));
          return;
        }
        const body = JSON.stringify({
          state: store.snapshot(),
          summary: store.summary(),
          version: store.snapshot().version,
        });
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          "Cache-Control": "no-store",
        });
        res.end(body);
      },
    })
  );

  // ── GET /timeline/events —— SSE 长连接 ──
  disposers.push(
    ctx.webServer.register({
      kind: "exact",
      path: prefix + "/events",
      handler: async (req, res) => {
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        // SSE 惯例：先发一个 retry 参数告诉浏览器重连间隔
        res.write("retry: 3000\n\n");

        clients.add(res);

        send(res, "snapshot", {
          state: store.snapshot(),
          summary: store.summary(),
          version: store.snapshot().version,
        });

        // ★ unref() —— 心跳不应该阻止进程退出。
        //   不加的话 Node 测试跑完会一直挂着（实测卡死过一次）。
        const hb = setInterval(() => {
          try { res.write(": ping\n\n"); } catch { /* 下面统一清理 */ }
        }, 15000);
        if (typeof hb.unref === "function") hb.unref();

        const cleanup = () => {
          clearInterval(hb);
          clients.delete(res);
        };
        req.on("close", cleanup);
        req.on("error", cleanup);
        res.on("error", cleanup);
      },
    })
  );

  log.info?.(`[timeline-sse] 已注册 ${prefix}/snapshot 与 ${prefix}/events`);

  return () => {
    unsubscribe();
    for (const res of clients) {
      try { res.end(); } catch { /* ignore */ }
    }
    clients.clear();
    for (const d of disposers) d?.();
  };
}

/**
 * 前端侧的订阅器（浏览器用）。
 * ★ 断线重连的关键：每条事件带 version。
 * 发现 version 跳号 ⇒ 说明中间漏了事件 ⇒ 重新拉 /snapshot 兜底。
 * @param {object} opts
 * @param {string} [opts.prefix]  /timeline
 * @param {(snapshot) => void} opts.onSnapshot  收到全量
 * @param {(evt) => void} opts.onChange         收到增量
 * @param {(err) => void} [opts.onError]
 * @returns {{ close: () => void }}
 */
export function subscribeTimeline({ prefix = "/timeline", onSnapshot, onChange, onError } = {}) {
  const root = String(prefix).replace(/\/+$/, "");
  let lastVersion = -1;
  let es = null;
  let closed = false;

  async function pullSnapshot() {
    try {
      const res = await fetch(root + "/snapshot", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      lastVersion = j.version ?? -1;
      onSnapshot?.(j);
    } catch (err) {
      onError?.(err.message);
    }
  }

  function open() {
    if (closed) return;
    try {
      es = new EventSource(root + "/events");
    } catch (err) {
      onError?.(String(err));
      return;
    }

    es.addEventListener("snapshot", (e) => {
      try {
        const j = JSON.parse(e.data);
        lastVersion = j.version ?? -1;
        onSnapshot?.(j);
      } catch (err) {
        onError?.("快照解析失败：" + err.message);
      }
    });

    es.addEventListener("timeline", (e) => {
      try {
        const evt = JSON.parse(e.data);
        // ★ 版本跳号 = 中间漏了事件 → 重新拉全量
        if (lastVersion >= 0 && evt.version > lastVersion + 1) {
          pullSnapshot();
          return;
        }
        lastVersion = evt.version;
        onChange?.(evt);
      } catch (err) {
        onError?.("事件解析失败：" + err.message);
      }
    });

    es.addEventListener("error", () => {
      // EventSource 自己会重连；这里只报告
      onError?.("SSE 连接中断，正在重连…");
    });
  }

  open();

  return {
    close() {
      closed = true;
      try { es?.close(); } catch { /* ignore */ }
    },
    refresh: pullSnapshot,
  };
}
