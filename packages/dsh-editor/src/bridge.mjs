/**
 * M1 的 HTTP 桥 —— 时间轴的重跑走这里。
 * ★ host 与 client 两套环境，URL 解析规则不同（实测踩过）
 * 浏览器：相对路径 "/comfy-bridge" 可以用（有 origin 兜底）
 * Node ：没有 origin，fetch("/comfy-bridge/generate")
 * → TypeError: Failed to parse URL from /comfy-bridge/generate
 * ⇒ host 侧必须给绝对 URL。所以：
 * · 默认走 127.0.0.1:<当前端口>（host 自己就在这个端口上）
 * · 或显式给 baseUrl
 * 本文件的 createBridge 接受 baseUrl，不传时从 config 里拿。
 */
export function createBridge(prefix = "/comfy-bridge", baseUrl = null) {
  const root = String(prefix).replace(/\/+$/, "");
  let comfyOrigin = "http://127.0.0.1:8188";

  function abs(path) {
    if (/^https?:\/\//.test(root)) return root + path;
    if (baseUrl) return String(baseUrl).replace(/\/+$/, "") + root + path;
    const port = process.env.DSH_WEB_PORT ?? process.env.PORT ?? "19387";
    return `http://127.0.0.1:${port}${root}${path}`;
  }

  async function call(path, init) {
    const url = abs(path);
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw new Error(`请求 ${url} 失败：${err.message}`);
    }
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; }
    catch { throw new Error("桥返回了非 JSON：" + text.slice(0, 200)); }
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
  }

  return {
    prefix: root,
    get baseUrl() { return baseUrl; },
    get comfyOrigin() { return comfyOrigin; },
    setBaseUrl(u) { baseUrl = u; },

    async health() {
      const r = await call("/health");
      if (r?.base) comfyOrigin = String(r.base).replace(/\/+$/, "");
      return r;
    },
    modes() { return call("/modes"); },
    lengths() { return call("/lengths"); },
    generate(modeId, params) {
      return call("/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...params, modeId }),
      });
    },
    job(jobId) { return call("/job/" + encodeURIComponent(jobId)); },
    cancel(jobId) { return call("/cancel/" + encodeURIComponent(jobId), { method: "POST" }); },

    // ★ 2026-10-18（F9 字幕）：本机 faster-whisper，转写出 SRT 再烧进视频。
    subtitleTranscribe(payload) {
      return call("/subtitle/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      });
    },
    subtitleBurn(payload) {
      return call("/subtitle/burn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      });
    },

    // ★ 2026-10-18（F10 衔接质检）：纯 ffmpeg，让「该重跑哪段」是算出来的。
    audit(payload) {
      return call("/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      });
    },

    // ★ 2026-10-18（学 YUH 的 chain_from）：首尾帧衔接。
    //   抽帧要 ffmpeg，只能在 M1 侧做；这里只转发。
    chain(payload) {
      return call("/chain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      });
    },
/** /** ★ 产物 URL 必须拼到 ComfyUI 上 */
    viewUrl(p) {
      if (!p) return p;
      if (/^https?:\/\//.test(p)) return p;
      return comfyOrigin + p;
    },
  };
}
