/**
 * progress-bus.mjs · ComfyUI 实时进度总线（2026-10-22）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 主人：「是不是需要有一个任务队列，或者任务状态？实时显示预计完成时间/进度之类的？」
 *       → 选了「只做进度 + 位次」
 *
 * ── 为什么需要这个模块
 *   `/queue` 只给「排队位次」，`/history` 只在任务【结束】时才有数据。
 *   中间的实时进度（第 15/30 步）ComfyUI 只通过 **WebSocket 推**，不落任何 HTTP 接口。
 *   ⇒ 想显示进度，只能自己连 WS。
 *
 * ── 协议（源码实证，不是凭记忆）
 *   本机 ComfyUI：D:\Comfy-Desktop\ComfyUI-Installs\My_Comfy_UI\ComfyUI\main.py:450-464
 *
 *     def hook(value, total, preview_image, prompt_id=None, node_id=None):
 *         progress = {"value": value, "max": total, "prompt_id": prompt_id, "node": node_id}
 *         server_instance.send_sync("progress", progress, server_instance.client_id)
 *
 *   服务端 send_sync 的封装格式是 {type, data}，所以客户端收到的是：
 *     {"type":"progress","data":{"value":15,"max":30,"prompt_id":"abc","node":"12"}}
 *
 *   其它关心的事件：
 *     {"type":"executing","data":{"node":"12","prompt_id":"abc"}}   节点开始
 *     {"type":"executing","data":{"node":null,"prompt_id":"abc"}}   整个任务结束
 *     {"type":"execution_error","data":{...}}                        出错
 *     {"type":"status","data":{"status":{"exec_info":{"queue_remaining":N}}}}
 *
 * ★ 为什么用 Node 内建 WebSocket 而不是 ws 包
 *   Node v24.20.0 已内建（实测 `typeof WebSocket === 'function'`）。
 *   本项目 bridge 包【零依赖】，加一个 ws 包会破坏这个约束。
 *
 * ★ 为什么是「订阅式总线」而不是「每个请求各连一条 WS」
 *   WS 连接有握手成本，而前端 1 秒轮询一次 —— 每次连一条会打爆 ComfyUI。
 *   ⇒ 全局一条连接，按 promptId 分发；没有订阅者时自动断开。
 *
 * ★ 断线重连
 *   ComfyUI 重启 / 网络抖动时会断。用指数退避重连（1s → 2s → 4s，上限 10s），
 *   但【只在有人订阅时】重连 —— 没人看的时候不该持续占资源。
 */

/**
 * 一条到 ComfyUI 的 WS 连接。
 *
 * @param {object} o
 * @param {string} o.base          http://127.0.0.1:8188
 * @param {(msg:object)=>void} [o.log]
 */
/**
 * @param {object} opts
 * @param {string} opts.base         ComfyUI 的 http 地址（如 http://127.0.0.1:8188）
 * @param {string} [opts.clientId]   ★ 必须与提交任务时用的 client_id 一致，
 *                                    否则服务端 targeted 的 progress 消息收不到
 *                                    （详见下面 wsUrl 的注释）
 * @param {object} [opts.log]
 */
export function createProgressBus({ base, clientId, log = console } = {}) {
  /** @type {WebSocket|null} */
  let ws = null;
  let connecting = false;
  let closed = false;
  let retryMs = 1000;
  let retryTimer = null;

  /**
   * promptId → 最新进度
   * { value, max, pct, node, updatedAt }
   */
  const progress = new Map();
  /** 最近一次 status 事件里的 queue_remaining */
  let queueRemaining = null;
  /** 最近一次连接的建立时间（用于判断「连上了但没消息」） */
  let connectedAt = 0;
  let lastError = null;

  /** 订阅者（只是让「有人看时才连」这件事成立，不需要回调） */
  let watchers = 0;

  /**
   * ★★ 2026-10-23 关键修复：WS 必须带上和提交任务相同的 client_id
   *
   * ── 实测现象（ComfyUI 0.40.0，任务在跑）
   *   直连 ws://127.0.0.1:8188/ws 只收到一条 status，
   *   【一条 progress 都没有】⇒ 前端进度永远为 null。
   *
   * ── 根因（读源码确认，不是猜）
   *   main.py:464
   *     server_instance.send_sync("progress", progress, server_instance.client_id)
   *                                                            ^^^^^^^^^^^^^^^^^^^
   *   第三个参数是 target sid ⇒ 这条消息【只发给那一个 socket】。
   *
   *   server.py:337
   *     sid = request.rel_url.query.get('clientId', '')
   *   ⇒ 建连时可以用 ?clientId=xxx 指定自己的 sid。
   *
   *   我们提交任务时用的是 config.clientId ?? "dsh-comfy-bridge"（index.js:485），
   *   而 WS 连的是裸 /ws ⇒ 服务端随机 uuid 当 sid ⇒ 与 client_id 不匹配
   *   ⇒ server_instance.client_id(void) != 我们的 sid，progress 全被丢掉。
   *
   * ── 修法
   *   建连时把同一个 clientId 放进 query。
   *   这样 sid == client_id，服务端 targeted 发送就命中我们。
   *
   *   ★ 必须与 index.js 提交时用的值【完全一致】，否则还是不匹配。
   *     所以这个值由调用方传进来（createProgressBus 的 clientId 选项），
   *     不在两处各写一份字面量 —— 写两份迟早会漂移。
   */
  const wsUrl = () => {
    const u = String(base || "").replace(/\/+$/, "");
    const ws = u.replace(/^http/, "ws") + "/ws";
    if (!clientId) return ws;
    return `${ws}?clientId=${encodeURIComponent(clientId)}`;
  };

  const handleMessage = (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;   // 非 JSON（二进制预览图等）忽略
    }
    if (!msg || typeof msg !== "object") return;

    const type = msg.type;
    const data = msg.data ?? {};

    if (type === "progress") {
      const pid = data.prompt_id;
      if (!pid) return;
      const value = Number(data.value);
      const max = Number(data.max);
      progress.set(pid, {
        value: Number.isFinite(value) ? value : null,
        max: Number.isFinite(max) ? max : null,
        /* ★ 除零保护：max 可能是 0（某些节点不报总步数） */
        pct: Number.isFinite(value) && Number.isFinite(max) && max > 0
          ? Math.min(100, Math.round((value / max) * 100))
          : null,
        node: data.node ?? null,
        updatedAt: Date.now(),
      });
      return;
    }

    if (type === "executing") {
      const pid = data.prompt_id;
      if (!pid) return;
      /* node === null ⇒ 整个 prompt 执行完了 */
      if (data.node === null) {
        const cur = progress.get(pid);
        progress.set(pid, {
          value: cur?.max ?? null,
          max: cur?.max ?? null,
          pct: 100,
          node: null,
          updatedAt: Date.now(),
          done: true,
        });
      }
      return;
    }

    if (type === "status") {
      const n = data?.status?.exec_info?.queue_remaining;
      if (Number.isFinite(Number(n))) queueRemaining = Number(n);
      return;
    }

    if (type === "execution_error") {
      /* 出错也要记一下，前端据此停止显示进度 */
      const pid = data?.prompt_id;
      if (pid) {
        const cur = progress.get(pid);
        progress.set(pid, { ...(cur || {}), error: true, updatedAt: Date.now() });
      }
      return;
    }
  };

  const connect = () => {
    if (closed) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (connecting) return;
    connecting = true;

    let sock;
    try {
      sock = new WebSocket(wsUrl());
    } catch (e) {
      connecting = false;
      lastError = String(e?.message ?? e);
      scheduleRetry();
      return;
    }
    ws = sock;

    sock.addEventListener("open", () => {
      connecting = false;
      connectedAt = Date.now();
      retryMs = 1000;          // 连上就重置退避
      lastError = null;
      log.info?.("[comfy-bridge] WS 已连接，进度可用");
    });

    sock.addEventListener("message", (ev) => {
      try { handleMessage(ev.data); } catch { /* 单条消息坏了不影响后续 */ }
    });

    sock.addEventListener("error", (ev) => {
      lastError = ev?.message || "WebSocket error";
      /**
       * ★★ 2026-10-22 修：连接被拒时 `close` 事件可能不来
       *
       *   实测（19499，ComfyUI 未运行）：
       *     调 /progress/status 后 stats() 一直是
       *       { connected: false, readyState: 0, connecting: true, lastError: "WebSocket error" }
       *     等 5 秒、10 秒都不变 —— 卡死了。
       *
       *   根因：Node 的内建 WebSocket 在「连接被拒」时只发 error，
       *   不发 close（或者 close 来得极晚）。而 connecting 只在 close 里复位
       *   ⇒ 永远是 true ⇒ 后面的重连全被 `if (connecting) return` 挡住
       *   ⇒ 即使 ComfyUI 后来起来了也不会重连。
       *
       *   ⇒ 在 error 里也复位 connecting 并安排重连。
       *     ★ 必须判一下「是不是已经 close 过了」——
       *       readyState 为 CLOSED 时不要再 scheduleRetry（close 那边会做）。
       */
      connecting = false;
      const alreadyClosed = !ws || ws.readyState === WebSocket.CLOSED;
      if (alreadyClosed) ws = null;
      if (!closed && watchers > 0) scheduleRetry();
    });

    sock.addEventListener("close", () => {
      connecting = false;
      ws = null;
      if (closed) return;
      /* ★ 只在有人看的时候重连 —— 没人看就不占资源 */
      if (watchers > 0) scheduleRetry();
    });
  };

  const scheduleRetry = () => {
    if (closed || retryTimer) return;
    const wait = retryMs;
    retryMs = Math.min(10000, Math.round(retryMs * 2));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!closed && watchers > 0) connect();
    }, wait);
    /* ★ unref —— 这个定时器不该阻止进程退出 */
    try { retryTimer.unref?.(); } catch { /* browser/bun 无此 API */ }
  };

  const close = () => {
    closed = true;
    watchers = 0;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (ws) {
      try { ws.close(); } catch { /* ignore */ }
      ws = null;
    }
  };

  /**
   * 取某个 prompt 的进度。
   *
   * ★ 冷却是关键：如果 WS 没连上（ComfyUI 离线 / 还在握手），
   *   progress 里什么都没有。返回 null 让调用方【不显示】进度，
   *   而不是显示 0% —— 0% 会让人以为卡住了。
   */
  const get = (promptId) => {
    if (!promptId) return null;
    const p = progress.get(promptId);
    if (!p) return null;
    /**
     * ★ 过期判定：10 秒没更新就别再报了。
     *   实测场景：任务被 interrupt 后 ComfyUI 不再发 progress，
     *   但 Map 里的旧值还在 ⇒ 前端会一直显示「45%」，像卡住。
     */
    if (!p.done && !p.error && Date.now() - (p.updatedAt || 0) > 10000) return null;
    return p;
  };

  /** 订阅计数 +1（有 HTTP 请求来查进度时就调）。 */
  const watch = () => {
    watchers += 1;
    connect();
    return () => {
      watchers = Math.max(0, watchers - 1);
      /* ★ 没人看了就断开，不留空连接 */
      if (watchers === 0 && ws) {
        try { ws.close(); } catch { /* ignore */ }
        ws = null;
      }
    };
  };

  /** 诊断信息（/progress/status 用）。 */
  const stats = () => ({
    connected: !!ws && ws.readyState === WebSocket.OPEN,
    readyState: ws?.readyState ?? null,
    connecting,
    watchers,
    trackedPrompts: progress.size,
    queueRemaining,
    connectedAt: connectedAt || null,
    lastError,
    wsUrl: wsUrl(),
  });

  /** 清掉某个 prompt 的记录（任务结束 / 取消后调）。 */
  const forget = (promptId) => { progress.delete(promptId); };

  return { watch, get, stats, forget, close, _internal: { handleMessage, connect } };
}
