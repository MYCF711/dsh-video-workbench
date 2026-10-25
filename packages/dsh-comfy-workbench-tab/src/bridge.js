/**
 * 桥：优先走 M1 暴露的 HTTP 路由（/comfy-bridge/*）。
 *
 * 只有 M1 才有 modes / generate / job / cancel —— 直连 ComfyUI 只能探活。
 * 所以默认前缀就是 /comfy-bridge（同源，浏览器自带 origin）。
 */

export function createBridgeOn(prefix, kind = "m1") {
  const root = String(prefix).replace(/\/+$/, "");
  let base = "";

  /**
   * 请求超时（毫秒）。
   *
   * ★★ 2026-10-23 新增（主人截图：卡在「加载模式...」和「正在载入剪辑台...」）
   *
   *   原来这里没有超时 —— fetch 会一直挂着。
   *   ComfyUI 离线时，`/modes` 要先读磁盘上的工作流 JSON，
   *   若后端那侧也在等 ComfyUI，前端就永远转圈，用户看不到任何错误。
   *
   *   ⇒ 给每个请求加超时。超时后抛错，UI 才能显示「加载失败」而不是无限等。
   *
   *   ★ 为什么 12 秒：
   *     · /modes 要读多个工作流 JSON，正常在 1 秒内
   *     · /generate 提交要打包 prompt（本地计算），正常 2-3 秒
   *     · 给 12 秒留足余量，又不至于让用户觉得卡死
   */
  const DEFAULT_TIMEOUT_MS = 12000;

  const j = async (p, init = {}) => {
    const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    /* 合并 caller 的 signal 与超时 signal */
    let signal = init.signal;
    try {
      if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        const t = AbortSignal.timeout(timeoutMs);
        signal = signal && typeof AbortSignal.any === "function"
          ? AbortSignal.any([signal, t])
          : t;
      }
    } catch { /* 保持原 signal */ }

    const { timeoutMs: _drop, ...rest } = init;
    let res;
    try {
      res = await fetch(root + p, { ...rest, signal });
    } catch (err) {
      /**
       * ★ 超时要给出可辨认的错误，不能只是 "The operation was aborted"。
       *   判据：用户看到错误必须能判断「是网络慢还是服务挂了」。
       */
      if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        throw new Error(`请求超时（${timeoutMs}ms）：${p}`);
      }
      throw err;
    }
    /**
     * ★★ 2026-10-25 修：后端明明返回了人话，前端只显示「HTTP 500 @ /generate」。
     *
     *   实测（ComfyUI 未运行时点生成）：
     *     后端响应体 {"error":"ComfyUI 未运行或不可达：http://127.0.0.1:8188（fetch failed）",
     *                 "name":"ComfyUnreachable"}
     *     界面显示 "HTTP 500 @ /generate"   ← 用户看不出该干什么
     *
     *   判据：凡是后端已经写了「给用户看的错误」的路由，前端必须把它透出来。
     *        只有后端没给可读信息时，才退回状态码。
     */
    if (!res.ok) {
      let detail = "";
      try {
        const text = await res.text();
        if (text) {
          try {
            const j2 = JSON.parse(text);
            detail = String(j2?.error ?? j2?.message ?? "").trim();
          } catch {
            detail = text.trim().slice(0, 300);
          }
        }
      } catch { /* 读不到就只报状态码 */ }
      const err = new Error(
        detail ? `${detail}（HTTP ${res.status}）` : `HTTP ${res.status} @ ${p}`
      );
      err.status = res.status;
      err.detail = detail;
      err.path = p;
      throw err;
    }
    return res.json();
  };

  return {
    __kind: kind,
    get __base() { return base; },

    async health() {
      try {
        const h = await j("/health");
        if (h?.base) base = String(h.base).replace(/\/+$/, "");
        return { ...h, base: h.base ?? root };
      } catch (err) {
        return { ok: false, base: root, error: err.message };
      }
    },

    /**
     * ★ 不吞异常 —— 实测坑：catch 返回 [] 会让「桥挂了」伪装成「没有工作流」，
     *   界面提示用户去改 workflows/ 目录，把排障方向带偏。
     *   让调用方拿到真实错误，由 UI 决定显示什么。
     */
    async modes() {
      return j("/modes");
    },

    async lengths() {
      try { return await j("/lengths"); } catch { return null; }
    },

    /**
     * ★ 2026-10-19 新增：ComfyUI 认的 LoRA 名单。
     *
     * ★ 不吞异常 —— 和 modes 同一条纪律：
     *   返回 [] 会让「ComfyUI 没起」伪装成「本机没装 LoRA」，
     *   用户会去翻 loras 目录，排障方向被带偏。
     *   ⇒ 抛给调用方，由 UI 显示「不可用」并保留真实原因。
     */
    async loras() {
      return j("/loras");
    },

    async generate(modeId, params) {
      return j("/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...params, modeId }),
      });
    },

    async job(jobId) { return j("/job/" + encodeURIComponent(jobId)); },
    async cancel(jobId) { return j("/cancel/" + encodeURIComponent(jobId), { method: "POST" }); },

    viewUrl(u) {
      if (!u) return u;
      if (/^https?:\/\//.test(u)) return u;
      return base + u;
    },
  };
}

export function createHttpBridge(base) {
  if (!base) return createBridgeOn("/comfy-bridge", "m1");
  return createBridgeOn(base, "direct");
}
