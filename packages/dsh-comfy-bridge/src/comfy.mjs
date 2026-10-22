/**
 * ComfyUI 客户端 —— 只做四件事：探活、上传素材、提交、查结果。
 *
 * ★ 硬约束（来源 ComfyUI知识库\操作手册.md §零）：
 *   不许重启 ComfyUI（主人在用时重启会打断他）。
 *   本模块【只发请求，从不试图启动或重启任何东西】。
 */

/**
 * ★ 默认端口来自实测（2026-10-16）：
 *   主人**正在跑的**是 Comfy-Desktop 实例 → 127.0.0.1:8188
 *   （进程实测：standalone-env\python.exe … --port 8188，
 *     模型走 ComfyUI-Shared，H3 全套权重可见）
 *   而 D:\image\scripts\restart-comfy.py 起的是另一个实例、监听 18201，
 *   且它 --models-directory 指向 D:\image\models（实测为空目录）。
 *
 * ⇒ 默认打 8188。要换实例用环境变量 COMFY_BASE_URL，别改这里的常量。
 */
const DEFAULT_BASE = process.env.COMFY_BASE_URL || "http://127.0.0.1:8188";
const PROBE_TIMEOUT_MS = 3000;

export class ComfyUnreachable extends Error {
  constructor(base, cause) {
    super(`ComfyUI 未运行或不可达：${base}（${cause}）`);
    this.name = "ComfyUnreachable";
    this.base = base;
  }
}

export class ComfyError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "ComfyError";
    this.detail = detail;
  }
}

export function createComfy({ base = process.env.COMFY_BASE_URL || DEFAULT_BASE } = {}) {
  const url = (p) => `${base.replace(/\/+$/, "")}${p}`;

  /** 探活。连不上抛 ComfyUnreachable（带明确原因），不静默返回空。 */
  async function probe() {
    const started = Date.now();
    try {
      const res = await fetch(url("/system_stats"), {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return {
        ok: true,
        base,
        latencyMs: Date.now() - started,
        devices: (json.devices ?? []).map((d) => ({
          name: d.name,
          vramTotalMiB: Math.round((d.vram_total ?? 0) / 1048576),
          vramFreeMiB: Math.round((d.vram_free ?? 0) / 1048576),
        })),
        comfyuiVersion: json.system?.comfyui_version ?? null,
      };
    } catch (err) {
      const reason =
        err.name === "TimeoutError" || err.name === "AbortError"
          ? `探测超时 >${PROBE_TIMEOUT_MS}ms`
          : err.message;
      throw new ComfyUnreachable(base, reason);
    }
  }

  /** 把素材放进 ComfyUI 的 input/。返回可供 LoadImage 引用的文件名。 */
  async function uploadImage(fileBuffer, filename, subfolder = "") {
    const form = new FormData();
    form.append("image", new Blob([fileBuffer]), filename);
    form.append("overwrite", "true");
    if (subfolder) form.append("subfolder", subfolder);

    let res;
    try {
      res = await fetch(url("/upload/image"), {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(60000),
      });
    } catch (err) {
      throw new ComfyUnreachable(base, err.message);
    }
    if (!res.ok) {
      throw new ComfyError(`上传失败 HTTP ${res.status}`, await res.text().catch(() => ""));
    }
    const json = await res.json();
    // ComfyUI 返回 { name, subfolder, type }；LoadImage 要的是 subfolder 前缀 + name
    const prefix = json.subfolder ? `${json.subfolder}/` : "";
    return `${prefix}${json.name}`;
  }

  /** 提交。返回 prompt_id。 */
  async function queue(prompt, clientId) {
    let res;
    try {
      res = await fetch(url("/prompt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, client_id: clientId }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      throw new ComfyUnreachable(base, err.message);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      // ComfyUI 的节点校验错误在 json.error / json.node_errors 里，原文透传。
      // ★ 实测（2026-10-16）：某些失败返回的是【裸 HTTP 500，无 JSON body】
      //   （例：工作流顶层有非节点键时，execution.py:1152 抛 AttributeError）。
      //   那时 json 是 {}，必须把「无 body」这件事说清楚，否则调用方只能看到 "HTTP 500"
      //   而不知道去哪找原因 —— 这一条就是被它坑过才补的。
      const rawText = json.error ? null : await res.text().catch(() => "");
      const detail = json.error
        ? `${json.error.type}: ${json.error.message}${
            json.error.details ? ` — ${json.error.details}` : ""
          }`
        : rawText
        ? `${rawText.slice(0, 400)}`
        : `HTTP ${res.status}，且响应体为空。ComfyUI 在请求体校验阶段就抛了异常（常见于` +
          `工作流顶层混入非节点键）。去它的控制台日志找最后一次 traceback。`;
      const nodeErrors = json.node_errors
        ? Object.entries(json.node_errors)
            .map(([id, e]) => `node ${id}: ${e.errors?.map((x) => x.message).join("; ") ?? "?"}`)
            .join(" | ")
        : "";
      throw new ComfyError(detail + (nodeErrors ? ` [${nodeErrors}]` : ""), json);
    }
    return json.prompt_id;
  }

  /** 查历史。没跑完返回 null；跑完返回产物列表。 */
  async function history(promptId) {
    let res;
    try {
      res = await fetch(url(`/history/${encodeURIComponent(promptId)}`), {
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      throw new ComfyUnreachable(base, err.message);
    }
    if (!res.ok) throw new ComfyError(`查历史失败 HTTP ${res.status}`);
    const json = await res.json();
    const entry = json[promptId];
    if (!entry) return null;

    const status = entry.status ?? {};
    const outputs = [];
    for (const [nodeId, out] of Object.entries(entry.outputs ?? {})) {
      for (const key of ["images", "gifs", "videos", "audio"]) {
        for (const item of out[key] ?? []) {
          outputs.push({
            nodeId,
            kind: key,
            filename: item.filename,
            subfolder: item.subfolder ?? "",
            type: item.type ?? "output",
            url: `/api/view?filename=${encodeURIComponent(item.filename)}&subfolder=${encodeURIComponent(
              item.subfolder ?? ""
            )}&type=${encodeURIComponent(item.type ?? "output")}`,
          });
        }
      }
    }

    return {
      // ★★ 2026-10-19 修（实测 lost 场景时发现）：
      //   原来只认 completed 或 "success"。
      //   但 ComfyUI 对【失败】也会写 history，status_str = "error"。
      //   实测（用 interrupt 打断一个任务）：
      //     GET /comfy-bridge/job/<id> → { completed: false, statusStr: "error" }
      //   ⇒ dsh-editor 的轮询器只判 h.completed ⇒ 走 progressJob()
      //   ⇒ clip.status 停在 running
      //   ⇒ summary.running 永远 ≥1 ⇒ exportable 永远 false
      //   ⇒ 用户导不出片，界面显示「生成中」，无从判断。
      //
      //   error / failed / cancelled 都是【终态】，只是不是「成功」的终态。
      //   completed 的语义应该是「结束了吗」，不是「成功了吗」。
      completed:
        Boolean(status.completed) ||
        ["success", "error", "failed", "cancelled"].includes(status.status_str),
      statusStr: status.status_str ?? "unknown",
      messages: status.messages ?? [],
      outputs,
    };
  }

  /** 队列快照，用来给「前面还有几个」。 */
  async function queueState() {
    let res;
    try {
      res = await fetch(url("/queue"), { signal: AbortSignal.timeout(5000) });
    } catch (err) {
      throw new ComfyUnreachable(base, err.message);
    }
    if (!res.ok) throw new ComfyError(`查队列失败 HTTP ${res.status}`);
    const json = await res.json();
    // ★ 2026-10-18 补：同时给出 promptId，否则调用方无法判断
    //   「队列里那个任务到底是不是我」。ComfyUI 的 /queue 结构是
    //   queue_running / queue_pending = [[number, prompt_id, {...}, {...}], ...]
    //   ⇒ promptId 在下标 1。
    const runningIds = (json.queue_running ?? []).map((x) => x?.[1]).filter(Boolean);
    const pendingIds = (json.queue_pending ?? []).map((x) => x?.[1]).filter(Boolean);
    return {
      running: runningIds.length,
      pending: pendingIds.length,
      runningPromptId: runningIds[0] ?? null,
      pendingPromptIds: pendingIds,
    };
  }

  /**
   * 列出 ComfyUI 当前可用的 LoRA 文件名。
   *
   * ★ 2026-10-19 新增（主人要求「krea2 的 lora 下拉栏里放所有可用 lora」）。
   *
   * 为什么不自己扫磁盘：
   *   ComfyUI 的模型搜索路径由 extra_model_paths.yaml 决定，可能有多个根，
   *   而且它自己会做去重与排序。本地扫盘会与它看到的不一致 ——
   *   扫出来的名字一旦对不上，提交时才在 ComfyUI 侧报 value_not_in_list。
   *
   * 数据源：GET /object_info/LoraLoaderModelOnly
   *   它的 input.required.lora_name[0] 就是 ComfyUI 认的全部合法值。
   *   实测本机 24 个，路径形如 `Krea2-功能\xxx.safetensors`（反斜杠分隔）。
   */
  async function listLoras() {
    let res;
    try {
      res = await fetch(url("/object_info/LoraLoaderModelOnly"), {
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new ComfyUnreachable(base, err.message);
    }
    if (!res.ok) throw new ComfyError(`查 LoRA 列表失败 HTTP ${res.status}`);
    const json = await res.json();
    const node = json?.LoraLoaderModelOnly;
    const spec = node?.input?.required?.lora_name;
    // 结构是 ["lora_name", { ... }] 或 [[...可选值...], {...}]
    const raw = Array.isArray(spec) ? spec[0] : null;
    const list = Array.isArray(raw) ? raw : [];
    return list.map(String);
  }

  return { base, probe, uploadImage, queue, history, queueState, listLoras, viewUrl: (p) => url(p) };
}
