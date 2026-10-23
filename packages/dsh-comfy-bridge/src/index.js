/**
 * dsh-comfy-bridge —— DSH 插件入口（host 侧）
 *
 * 职责：把 ComfyUI 的能力包成 HTTP 路由，供浏览器侧的 M2 调用。
 *       不碰 UI（UI 在 dsh-comfy-workbench-tab）。
 *
 * ★ 架构事实（实测 2026-10-17）
 *   host 侧（Node / cordis）与 client 侧（浏览器 / cordis）是【两棵独立的树】。
 *   ctx.provide 只在各自的树内可见，跨不过进程边界。
 *   ⇒ M1 必须通过 HTTP 路由暴露能力，M2 用 fetch 调。
 *   依据：@deepseek-ai/dsh-host-webserver/README.zh.md
 *         "浏览器经由 dsh-host-webserver 通过 HTTP 访问 web GUI"
 *         "register(route) 添加具名的 exact/prefix HTTP route"
 *
 * 硬约束（继承自 D:\主工作区\本地H3视频工作站\AGENTS.md）：
 *   ① 不许重启 ComfyUI（主人在用）
 *   ② 改任何磁盘工作流前先备份 .bak
 *   ③ 代码里不许出现具体模型名或节点 id（工作流是运行时输入）
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createComfy } from "./comfy.mjs";
/**
 * 2026-10-22：ComfyUI 实时进度（WebSocket）。
 * 协议实证见 progress-bus.mjs 文件头。
 */
import { createProgressBus } from "./progress-bus.mjs";
import { loadModes, buildPrompt, mapOutputSources, WorkflowError } from "./workflows.mjs";
import { checkVisibleText, hasVisibleText } from "./text-guard.mjs";
import {
  snapLength,
  secondsToLength,
  aspectToSize,
  lengthToSeconds,
  LEGAL_LENGTHS,
} from "./length.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(HERE, "..", "workflows");

export const name = "dsh-comfy-bridge";

/**
 * ★ cordis 的服务依赖声明。写的是【服务名】。
 *   ctx.webServer 必须先在这里声明，否则 apply 里访问会抛
 *   `cannot get property "webServer" without inject`（实测 2026-10-17）。
 */
export const inject = ["webServer"];

/** 进行中的任务表：jobId -> 记录 */
const jobs = new Map();

function newJobId() {
  return `comfy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 统一 JSON 响应。 */
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

/** 读请求体（限制 64 MiB，素材上传够用）。 */
function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`请求体超过 ${limit} 字节`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * 插件装配。cordis 调用。
 */
export async function apply(ctx, config = {}) {
  const base = config.comfyBase ?? process.env.COMFY_BASE_URL ?? "http://127.0.0.1:8188";
  const comfy = createComfy({ base });
  const prefix = config.routePrefix ?? "/comfy-bridge";
  const log = ctx?.logger ?? console;

  /**
   * ★★ 2026-10-23 去敏：用户配置覆盖插件参数
   *
   *   硬编码路径全部移除后，路径来源变成：
   *     ① 用户在设置页填的（存到 config.json）
   *     ② 插件参数（cordis 配置）
   *     ③ 环境变量
   *     ④ 自动探测
   *
   *   顺序上【用户配置优先于插件参数】——
   *   因为用户在界面上填的比 yml 里写的更新，且他刚刚才填。
   */
  let userConfig = {};
  try {
    const { loadConfig } = await import("./user-config.mjs");
    userConfig = loadConfig(ctx, log);
    if (Object.keys(userConfig).length) {
      log.info?.(`[comfy-bridge] 已读取用户配置：${Object.keys(userConfig).join(", ")}`);
    }
  } catch (err) {
    log.warn?.(`[comfy-bridge] 用户配置加载失败（不影响启动）：${err?.message ?? err}`);
  }

  /** 合并后的路径配置（后续所有地方都读这个，不再读 config.xxx） */
  const paths = {
    comfyPath: userConfig.comfyPath ?? config.comfyPath,
    /**
     * ★★ 2026-10-23 补：模型放置目录
     *
     *   主人原话：「填模型放置目录，comfy ui目录，然后模型需求清单列出来」
     *   前两版只做了 comfyPath / outputDir / inputDir，把模型目录漏了。
     *
     *   它的用途：
     *     ① 模型清单的本地兜底 —— ComfyUI 没开时也能判断文件在不在
     *     ② 缺失时告诉用户「放到这个目录的哪个子目录」
     */
    modelsDir: userConfig.modelsDir ?? config.modelsDir,
    outputDir: userConfig.outputDir ?? config.outputDir,
    inputDir: userConfig.inputDir ?? config.inputDir,
  };

  /**
   * ★★ 2026-10-22 新增：实时进度总线（WebSocket）
   *
   *   主人：「是不是需要有一个任务队列，或者任务状态？实时显示预计完成时间/进度之类的？」
   *
   * ── 为什么非要有它
   *   · `/queue`      只给排队位次，没有进度
   *   · `/history`    只在任务【结束】时才有数据
   *   · 中间的「第 15/30 步」ComfyUI 只在 WebSocket 上推
   *   ⇒ 想显示进度，只能自己连 WS。
   *
   * ── 协议的实证来源（不是凭记忆）
   *   D:\Comfy-Desktop\ComfyUI-Installs\My_Comfy_UI\ComfyUI\main.py:450-464
   *     progress = {"value": value, "max": total, "prompt_id": prompt_id, "node": node_id}
   *     server_instance.send_sync("progress", progress, ...)
   *
   * ── 为什么这里不 await / 不阻塞
   *   WS 连不上（ComfyUI 没跑）不该阻止插件启动。
   *   总线是懒连接的：第一次有人 watch() 才连，失败退避重连。
   */
  /**
   * ★★ 2026-10-23 关键：提交任务与 WS 必须用【同一个】client_id
   *
   *   ComfyUI 的 progress 是 targeted 发送的：
   *     main.py:464  send_sync("progress", data, server_instance.client_id)
   *   ⇒ 只有 sid === client_id 的那个 socket 收得到。
   *
   *   而 sid 来自建连时的 ?clientId=（server.py:337）。
   *   所以这两个值必须一致，否则进度全丢 —— 实测就是这样：
   *     WS 只收到 status，trackedPrompts 永远是 0，前端进度永远 null。
   *
   *   ★ 为什么抽成一个常量：写两处字面量迟早会漂移。
   *     这里定义一次，提交（下面 queue）和订阅（progressBus）都用它。
   */
  const CLIENT_ID = config.clientId ?? "dsh-comfy-bridge";

  const progressBus = createProgressBus({ base, clientId: CLIENT_ID, log });
  /* 插件卸载时断开，不留悬挂连接 */
  try { ctx.effect(() => () => progressBus.close(), "comfy-bridge: progress bus"); }
  catch { /* 无 ctx.effect 时忽略 */ }


  const { modes, warnings } = await loadModes(WORKFLOWS_DIR);
  const modeById = new Map(modes.map((m) => [m.id, m]));

  log.info?.(
    `[${name}] ComfyUI=${base}  模式 ${modes.length} 个${warnings.length ? `  警告 ${warnings.length}` : ""}`
  );
  for (const w of warnings) log.warn?.(`[${name}] ${w}`);

  // ────────────────────────────────────────────────────────────
  // 处理函数
  // ────────────────────────────────────────────────────────────
  /**
   * 幂等的「任务级」进度订阅（2026-10-22）
   *
   * 为什么要这个：WS 是懒连接的，需要一个「有人在看」的理由才连。
   * 而 HTTP 轮询是一次性的 —— 每次请求都 watch 会让计数只增不减。
   *
   * ⇒ 按 jobId 记账：同一个 job 只 watch 一次，任务结束时 unwatch。
   *   计数跟着「有几个任务在跑」走。
   */
  const watchedJobs = new Map();   // jobId → unwatch
  function ensureWatched(jobId) {
    if (!jobId) return null;
    const existing = watchedJobs.get(jobId);
    if (existing) return null;      // 已经 watch 过
    try {
      const unwatch = progressBus.watch();
      watchedJobs.set(jobId, unwatch);
      return unwatch;
    } catch {
      return null;
    }
  }
  function releaseWatch(jobId) {
    const un = watchedJobs.get(jobId);
    if (!un) return;
    watchedJobs.delete(jobId);
    try { un(); } catch { /* ignore */ }
  }

  const handlers = {
    async health() {
      try {
        const p = await comfy.probe();
        return { ok: true, ...p, modes: modes.length, warnings };
      } catch (err) {
        return { ok: false, base, error: err.message, modes: modes.length, warnings };
      }
    },

    modes() {
      return modes.map((m) => ({
        id: m.id,
        label: m.label,
        tabSub: m.tabSub,
        description: m.description,
        order: m.order,
        primary: m.primary,
        state: m.state,
        defaults: m.defaults,
        media: m.media,
        toggles: m.toggles,
        // 2026-10-18 增量：能力声明，前端据此决定「时长 / 张数 / 二采步数」渲染哪些。
        // 纯新增字段 —— 老前端不读它，行为完全不变。
        caps: m.caps,
      }));
    },

    lengths() {
      return { legal: LEGAL_LENGTHS, fps: 24 };
    },

    async generate(params) {
      const mode = modeById.get(params.modeId);
      if (!mode) {
        throw new Error(`未知模式：${params.modeId}（可用：${[...modeById.keys()].join(", ")}）`);
      }

      // ★ 2026-10-19 加（主动测异常输入发现）：
      //   空提示词能一路提交到 CLIPTextEncode（实测节点 215 的 text = "   "），
      //   真的跑一遍生成，出一张「因为没提示词所以随机」的图。
      //
      //   前端也加了同样的校验，但 Agent 走工具路径（timeline_generate）时
      //   不经过前端 —— 所以后端必须也有一道。
      //
      //   实测其它异常输入都被挡住了：
      //     steps=0/-1/99999、batch=0/-5、megapixels=0/999、aspect="100:1"
      //       → ComfyUI schema 校验（prompt_outputs_failed_validation）
      //     未知 modeId → 上面那行
      //   只有空提示词没人管。
      //   ★★ 2026-10-19 收紧（独立复核 + 自测发现三种绕过）：
      //     原来写 String(params.prompt ?? "").trim()，被这三类穿透：
      //       prompt = {a:1}      → String() = "[object Object]"  非空 ⇒ 通过
      //       prompt = 0          → String() = "0"                 非空 ⇒ 通过
      //       prompt = "\u200b"   → trim() 不删零宽字符            非空 ⇒ 通过
      //     实测这三条都提交成功，且 workflows.mjs:453 用
      //       setInput(..., String(params.prompt))
      //   ★★ 2026-10-19 第三次修（独立复核打穿后）：改用 text-guard 的白名单判定。
      //     原来内联黑名单正则，被 U+2800（盲文空白）、U+00AD（软连字符）穿透，
      //     实测这两条都提交成功，CLIPTextEncode.text 码点是 [10240] / [173]。
      //     黑名单方法本身不可靠 —— 改用 checkVisibleText()。
      {
        const why = checkVisibleText(params.prompt, "提示词");
        if (why) throw new Error(why + " —— 会生成随机的图");
      }
      // ★★ 2026-10-19 加（独立复核第二轮发现）：提示词没有长度上限。
      //   实测 100000 字符和 1050000 字符都返回 promptId。
      //   后果：超长提示词会塞进工作流，ComfyUI 的 CLIP 要处理它，
      //   要么很慢，要么被截断到某个 token 上限 —— 用户不知道发生了什么。
      //
      //   上限取 20000 字符：H3 的结构化提示词（subject_definitions +
      //   integrated_multimodal_description + overall_soundscape + ...）
      //   实测最长 2000 字左右，Krea2 的提示词更短。
      //   20000 是「肯定够用」和「明显异常」之间的宽松界线。
      const MAX_PROMPT_CHARS = 20000;
      if (params.prompt.length > MAX_PROMPT_CHARS) {
        throw new Error(
          `提示词太长：${params.prompt.length} 字符，上限 ${MAX_PROMPT_CHARS}。` +
          `H3 的结构化提示词一般在 2000 字以内`
        );
      }
      // 素材：M2 传 base64
      //
      // ★★ 2026-10-19 加三道校验（主动测异常输入发现）：
      //   实测原来这三种都能提交成功：
      //     ① 伪装成图的文本 "hello world" → 传上去了
      //     ② 非法 base64 "!!!not-base64!!!" → 传上去了
      //     ③ 不存在的槽名 bogus_slot → 被静默忽略，不报错
      //     ④ 单图 50MB → 传上去了（没有大小限制）
      //
      //   ① ② 的根因：Buffer.from(x, "base64") 对非法输入【不报错】，
      //   会把非法字符丢掉、剩下的凑成垃圾字节，然后当成图片传上去。
      //   到 ComfyUI 那边才会失败，且报错信息指向 LoadImage，很难对上。
      //
      //   ⇒ 在入口先校验，让错误停在这里、说明白。
      const SIGNATURES = [
        { name: "PNG",  bytes: [0x89, 0x50, 0x4e, 0x47] },
        { name: "JPEG", bytes: [0xff, 0xd8, 0xff] },
        { name: "WEBP", bytes: [0x52, 0x49, 0x46, 0x46] },   // RIFF
        { name: "GIF",  bytes: [0x47, 0x49, 0x46] },
        { name: "BMP",  bytes: [0x42, 0x4d] },
        // 视频/音频（yz 的参考视频与音频槽也要走这里）
        { name: "MP4",  bytes: [0x00, 0x00, 0x00] },          // ftyp 在 offset 4，下方单独判
        { name: "WEBM", bytes: [0x1a, 0x45, 0xdf, 0xa3] },
        { name: "WAV",  bytes: [0x52, 0x49, 0x46, 0x46] },
        { name: "MP3",  bytes: [0x49, 0x44, 0x33] },
      ];
      /**
       * 媒体文件结构校验 —— 不只查魔数，要查完整结构。
       *
       * ★★ 2026-10-19 修（复核员打穿）：原来只看前 2~4 字节魔数，
       *   于是这些纯文本全部提交成功（nodes:27）：
       *     "BM plain text..."               ← BMP 的两字节魔数
       *     "RIFF this is plain text..."     ← WEBP/WAV 的四字节魔数
       *     "XXXXftyp this is plain text..." ← MP4 的 ftyp@4
       *     "ID3 this is plain text..."      ← MP3 的三字节魔数
       *   ⇒ 这道校验的唯一目的就是拦这个，只看魔数等于没做。
       *
       *   现在按格式查结构：
       *     PNG   89 50 4E 47 0D 0A 1A 0A（8 字节完整签名）+ 首块必须是 IHDR
       *     JPEG  FF D8 FF + 末尾必须有 FF D9
       *     WEBP  RIFF ???????? WEBP（4+4+4）
       *     WAV   RIFF ???????? WAVE
       *     GIF   GIF87a / GIF89a（6 字节）
       *     BMP   BM + 文件头声明的文件大小要与实际接近
       *     MP4   4 字节 box size（合理范围）+ offset 4 是 ftyp
       *     WEBM  1A 45 DF A3
       *     MP3   ID3 头带合法版本字节，或 MPEG 帧同步
       */
      const looksLikeMedia = (buf) => {
        const n = buf.length;
        if (n < 16) return false;

        // PNG：签名 + IHDR 块完整 + 必须有 IDAT（真实像素数据）
        //
        // ★★ 2026-10-19 第二次修（独立复核发现 16 字节垃圾也能过）：
        //   上一版只查到「首块是 IHDR」就返回 true。
        //   实测：8 字节签名 + "IHDR" + 4 个零字节 = 16 字节，提交成功（nodes:18），
        //   然后垃圾文件【先落盘】到 ComfyUI 的 input 目录，
        //   直到 /history 才报 EXEC_ERROR node=470 LoadImage cannot identify image file。
        //   ⇒ 「让错误停在入口」这个设计目的没达成。
        //
        //   ⇒ 必须再查两件事：
        //     ① IHDR 的宽高不能是 0（offset 16-24 是 width/height，大端 u32）
        //     ② 文件里必须存在 IDAT 块（真实压缩像素数据）
        const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        if (PNG_SIG.every((b, i) => buf[i] === b)) {
          if (buf.slice(12, 16).toString("ascii") !== "IHDR") return false;
          if (n < 33) return false;                       // 签名8 + IHDR块25 起步
          const w = buf.readUInt32BE(16);
          const h = buf.readUInt32BE(20);
          if (!w || !h || w > 100000 || h > 100000) return false;
          // 必须能找到 IDAT（真实图像数据）与 IEND（结束块）
          //
          // ★★ 2026-10-19 修（实测 32MB 边界时发现）：
          //   原来 IEND 只查【末尾 16 字节】——
          //   buf.slice(Math.max(0, n - 16)).includes("IEND")
          //   但 PNG 规范允许尾随数据（很多工具会追加元数据或填充），
          //   一旦有尾随，IEND 就不在末尾 16 字节内。
          //
          //   实测：一张 70 字节的真 PNG 填充到 1024 字节后，
          //   looksLikeMedia 返回 false，报「不是图片/视频/音频」，
          //   而前 8 字节明显是 PNG 签名 —— 用户会完全看不懂。
          //   （我造 32MB 边界测试时就被这条挡住了，白测一轮。）
          //
          //   ⇒ IEND 改成全文查找。IEND 只有 4 字节、后面跟 4 字节 CRC，
          //     在几十 MB 的二进制里偶然出现的概率极低；
          //     而 IDAT 已经保证了「有图像数据」，两条一起足够。
          const hasIdat = buf.includes("IDAT");
          const hasIend = buf.includes("IEND");
          return hasIdat && hasIend;
        }
        // JPEG：SOI + 末尾 EOI
        if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
          return buf[n - 2] === 0xff && buf[n - 1] === 0xd9;
        }

        // RIFF 家族：前 4 字节是 RIFF，且 offset 8 必须是 WEBP 或 WAVE
        if (buf.slice(0, 4).toString("ascii") === "RIFF") {
          const kind = buf.slice(8, 12).toString("ascii");
          return kind === "WEBP" || kind === "WAVE";
        }

        // GIF：6 字节头
        const g = buf.slice(0, 6).toString("ascii");
        if (g === "GIF87a" || g === "GIF89a") return true;

        // BMP：BM + 前 14 字节声明的文件大小要接近实际长度
        if (buf[0] === 0x42 && buf[1] === 0x4d) {
          const declared = buf.readUInt32LE(2);
          return declared > 0 && Math.abs(declared - n) <= 16;
        }

        // MP4：前 4 字节是 box size，必须落在 [8, n] 内
        if (buf.slice(4, 8).toString("ascii") === "ftyp") {
          const boxSize = buf.readUInt32BE(0);
          return boxSize >= 8 && boxSize <= n;
        }

        // WEBM / Matroska 的 EBML 头
        if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
          return true;
        }

        // MP3：ID3 头（带合法主版本号）或 MPEG 帧同步
        if (buf.slice(0, 3).toString("ascii") === "ID3") {
          return buf[3] === 2 || buf[3] === 3 || buf[3] === 4;
        }
        if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;

        return false;
      };

      const MAX_BYTES = 32 * 1024 * 1024;   // 32MB —— 单张参考图/单段参考视频的上限
      const knownSlots = Object.keys(mode.media ?? {});
      const files = {};
      for (const [slot, payload] of Object.entries(params.files ?? {})) {
        // ★★ 2026-10-19 修（复核员打穿）：槽名检查必须在 base64 判断【之前】。
        //   原来这行 `if (!payload?.base64) continue;` 在前面，
        //   于是 {"files":{"bogus_slot":{"base64":""}}} 整条被跳过、提交成功（nodes:26）。
        //   实测还能绕过的变体：base64 为 0 / null / false / 只有 filename / payload:null。
        //   ⇒ 先查槽名，任何带 files[slot] 的键都要过这一关。
        if (!knownSlots.includes(slot)) {
          throw new Error(
            knownSlots.length
              ? `未知素材槽：${slot}（${mode.id} 可用的槽：${knownSlots.join(", ")}）`
              : `${mode.id} 不接受素材（它没有 media 槽），却收到了 ${slot}`
          );
        }
        if (!payload?.base64) continue;


        let buf;
        try {
          buf = Buffer.from(payload.base64, "base64");
        } catch (e) {
          throw new Error(`素材 ${slot} 的 base64 解不开：${e.message}`);
        }
        // ② base64 长度必须与解出的字节数大致吻合 —— 非法字符会让长度对不上
        // ★★ 2026-10-19 修（复核员打穿）：容差从 ±4 收紧到 ±2。
        //   原来 `Math.abs(len*0.75 - buf.length) > 4` —— 实测 "iVBORw0KGgoAAAAA!!!!!"
        //   里含 5 个非法字符，解出字节差 3.75 < 4 ⇒ 放过，提交成功。
        //   base64 的合法长度差只来自末尾 padding（0/1/2 字节），
        //   超过 2 就说明中间有非法字符被丢弃了。
        //
        //   另：Node 的 Buffer.from(x, "base64") 对非法字符【静默忽略】，不报错 ——
        // ★ 2026-10-19 补：上一版修容差时把这一行删掉了，导致 b64clean is not defined。
        //   去掉所有空白后再算长度 —— base64 允许换行，但长度必须对得上。
        const b64clean = String(payload.base64).replace(/\s/g, "");
        const expectBytes = Math.floor((b64clean.length * 3) / 4)
          - (b64clean.endsWith("==") ? 2 : b64clean.endsWith("=") ? 1 : 0);
        if (buf.length === 0 || Math.abs(buf.length - expectBytes) > 0) {
          throw new Error(
            `素材 ${slot} 不是有效的 base64（解出 ${buf.length} 字节，按长度应为 ${expectBytes}）`
          );
        }

        // ③ 必须是媒体文件（看魔数），不能随便一段文本冒充
        if (!looksLikeMedia(buf)) {
          const head = [...buf.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
          throw new Error(
            `素材 ${slot} 不是图片/视频/音频（前 8 字节：${head}）。` +
            `若是文本或损坏文件，ComfyUI 的 LoadImage 会失败。`
          );
        }

        // ④ 大小上限
        if (buf.length > MAX_BYTES) {
          throw new Error(
            `素材 ${slot} 太大：${(buf.length / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_BYTES / 1024 / 1024}MB`
          );
        }

        // ★★ 2026-10-19 修（复核员发现）：
        //   原来 `payload.filename ?? `${slot}.png`` 原样透传给 ComfyUI 的 /upload/image。
        //   而 comfy.mjs 的 uploadImage 里写死了 form.append("overwrite", "true")
        //   ⇒ 实测后果：
        //     "filename":"a.png"                 → 覆盖了 input\a.png（别人的文件！）
        //     "filename":"evil.exe"              → 写出 input\evil.exe
        //     "filename":"../../../../Users/.../pwned.png" → ComfyUI 自己 HTTP 400 挡住（未逃逸）
        //
        //   ⇒ 两道修：
        //     ① 文件名只允许「字母数字下划线横线点」，且必须以允许的媒体扩展名结尾
        //     ② 一律加随机前缀，永不覆盖已有文件（哪怕同名）
        const ext = (payload.filename ?? "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
        const ALLOWED_EXT = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp",
                             ".mp4", ".webm", ".mov", ".wav", ".mp3", ".m4a"];
        if (!ALLOWED_EXT.includes(ext)) {
          throw new Error(
            `素材 ${slot} 的扩展名不被接受：${ext || "(无扩展名)"}。` +
            `允许：${ALLOWED_EXT.join(" ")}`
          );
        }
        // 用 slot + 随机串做前缀，保留用户原名的可见部分（便于在 ComfyUI 里认出来）
        const safeBase = String(payload.filename)
          .replace(/\.[a-z0-9]+$/i, "")          // 去掉原扩展名
          .replace(/[^A-Za-z0-9_-]/g, "_")       // 只留安全字符
          .slice(0, 40) || slot;
        const safeName = `wb_${slot}_${safeBase}_${Math.random().toString(36).slice(2, 8)}${ext}`;
        files[slot] = await comfy.uploadImage(buf, safeName);
      }

      // ★ 2026-10-18（学 YUH 的参考图分用途）：
      //   前端按「用途」算出 H3 的 subject_definitions 骨架，放 params.refLabels。
      //   这里把它拼在用户提示词【前面】—— H3 官方要求这个 section 排第一。
      //   用户写的 prompt 保持原样，不覆盖。
      const finalParams = { ...params, files };
      if (Array.isArray(params.refLabels) && params.refLabels.length) {
        const head = "subject_definitions:\n" + params.refLabels.join("\n");
        finalParams.prompt = params.prompt
          ? head + "\n\n" + params.prompt
          : head;
        log.info?.(`[${name}] 注入 ${params.refLabels.length} 条参考标签`);
      }

      const built = buildPrompt(
        mode,
        finalParams,
        { snapLength, secondsToLength, aspectToSize }
      );

      /* ★ 用与 progressBus 相同的 CLIENT_ID —— 两处必须一致，见上面那条注释 */
        const promptId = await comfy.queue(built.prompt, CLIENT_ID);
      const jobId = newJobId();
      jobs.set(jobId, {
        jobId,
        promptId,
        modeId: params.modeId,
        startedAt: Date.now(),
        nodes: Object.keys(built.prompt).length,
        length: built.length,
        toggles: built.toggles,
        pruned: built.pruned,
        // ★ 2026-10-18：把 bind.outputs 的语义 key 记下来，供 job() 给产物打 source。
        //   根因（架构师 E5 实测）：comfy.mjs 只返回 {nodeId, kind, filename...}，
        //   bind.outputs 的 {image→202, imageTwoPass→220, ...} 从来没传到前端，
        //   前端只能靠文件名正则猜（-2ST- / -USD- / -SVR-），
        //   而那些前缀是工作流数据不是契约，改个前缀四张角标就全错位。
        outputsMap: mode.outputs ?? {},
      });
      log.info?.(`[${name}] 提交 ${params.modeId} → ${promptId} (${jobId})`);
      return { jobId, promptId, nodes: Object.keys(built.prompt).length };
    },

    async job(jobId) {
      const job = jobs.get(jobId);
      if (!job) throw new Error(`未知任务：${jobId}`);
      const h = await comfy.history(job.promptId);
      if (!h) {
        const q = await comfy.queueState().catch(() => ({ running: 0, pending: 0 }));

        // ★ 2026-10-18 修（质检 P1-2「中断后永久轮询」）：
        //   任务被 interrupt 打断时，ComfyUI【不写 history】——
        //   /history/<promptId> 直接返回 {}，这里原来的 return completed:false
        //   会让前端永远轮询：实测连续 11 秒一字不变，生成按钮 disabled 锁死。
        //
        //   终态判据：队列里既没有它（pending 不含、running 不是它），
        //   又没有 history ⇒ 它已经不在了 ⇒ 判定为「已失去」（lost）。
        //   前端据此停止轮询并允许重试。
        // queueState 现在带 promptId（comfy.mjs 已补），可以精确判定：
        //   在 running 里 或 在 pending 里 ⇒ 还活着，继续等
        //   两个都没有 ⇒ 已失去（被 interrupt / 重启清掉）
        const isRunning = q?.runningPromptId === job.promptId;
        const isPending = (q?.pendingPromptIds ?? []).includes(job.promptId);
        const lost = !isRunning && !isPending;

        if (lost) {
          return {
            ...job,
            completed: false,
            statusStr: "lost",
            lost: true,
            reason: "任务已不在 ComfyUI 队列里，且没有 history —— 通常是被中断或重启清掉了",
            queue: q,
            elapsedMs: Date.now() - job.startedAt,
          };
        }

        /**
         * ★★ 2026-10-22 新增：带上实时进度
         *
         *   主人要「实时显示进度」。进度只在 WS 上有（见 progress-bus.mjs 文件头），
         *   这里把它并进 job 的返回值 —— 前端轮询 /job 就同时拿到了
         *   「排队位次（queue）」+「第几步（progress）」，不用再开一个接口。
         *
         *   ★ progress 可能是 null：
         *     WS 还没连上 / ComfyUI 离线 / 这个 prompt 还没开始跑。
         *     返回 null 而不是 {pct:0} —— 0% 会让人以为卡住了。
         *     前端据此「不显示进度」，这比显示一个假 0 诚实。
         *
         * ★★ 这里必须触发连接，否则 WS 永远连不上
         *
         *   第一版我不在这里 watch（怕 watchers 计数只增不减），
         *   结果没有任何地方真正驱动连接 ⇒ 进度永远是 null。
         *
         *   ⇒ 正确做法：用「任务级」的订阅，而且【幂等】：
         *     同一个 jobId 只 watch 一次，任务结束（completed）时 unwatch。
         *     这样计数跟着「有几个任务在跑」走，不会累积。
         */
        const unwatch = ensureWatched(job.jobId);
        /* unwatch 存在 job 记录上，供完成时调用（见下面 completed 分支） */
        if (unwatch) job._unwatch = unwatch;

        return {
          ...job,
          completed: false,
          queue: q,
          progress: progressBus.get(job.promptId),
        };
      }
      /**
       * ★ 2026-10-22：任务结束 ⇒ 释放进度订阅 + 清掉进度记录
       *
       *   不清理的话：
       *     · watchedJobs 会一直攒着，watchers 计数永不归零 ⇒ WS 连接永不关闭
       *     · progressBus 的 Map 里留着这个 prompt 的旧进度 ⇒ 内存缓慢增长
       */
      if (h.completed) {
        releaseWatch(jobId);
        progressBus.forget(job.promptId);
      }

      return {
        ...job,
        completed: h.completed,
        statusStr: h.statusStr,
        // ★ 2026-10-18：给每个产物打上 source（语义 key）。
        //   outputsMap 形如 { image: "202", imageTwoPass: "220", imageUsd: "186", imageSeedvr: "174" }
        //   反查 nodeId → key；不在表里的（如附带 JPG）→ null，由前端兜底。
        //   这是「只加字段」，不改任何现有行为。
        outputs: mapOutputSources(job.outputsMap, h.outputs),
        elapsedMs: Date.now() - job.startedAt,
      };
    },

    async cancel(jobId) {
      const job = jobs.get(jobId);
      if (!job) throw new Error(`未知任务：${jobId}`);

      // ★ 2026-10-18 修（质检 P1-1「取消是假的」）：
      //   原来两步都 .catch(()=>{}) 吞掉结果，最后无条件 return { ok: true }。
      //   实测：界面显示「已取消」，ComfyUI /queue 里任务照跑。
      //
      //   更要紧的一点：`POST /interrupt` 是【全局打断】—— ComfyUI 只有一个
      //   执行循环，它会停掉当前正在跑的那个 prompt，不管是不是我们的。
      //   ⇒ 只有在确认「正在跑的就是我这个 prompt」时才允许 interrupt。
      const result = { ok: false, removedFromQueue: false, interrupted: false, note: "" };

      // ① 先从队列里移除（还在 pending 的任务，这一步就够，不用 interrupt）
      let removed = false;
      try {
        const res = await fetch(`${comfy.base}/queue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ delete: [job.promptId] }),
        });
        removed = res.ok;
        if (!res.ok) result.note += `queue delete HTTP ${res.status}; `;
      } catch (err) {
        result.note += `queue delete 失败：${err?.message ?? err}; `;
      }
      result.removedFromQueue = removed;

      // ② 查队列现状：还在 pending 说明没删掉；在 running 才需要 interrupt
      let runningId = null;
      let stillQueued = false;
      try {
        const qs = await fetch(`${comfy.base}/queue`).then((r) => r.json());
        runningId = qs?.queue_running?.[0]?.[1] ?? null;
        stillQueued =
          (qs?.queue_pending ?? []).some((x) => x?.[1] === job.promptId) ||
          runningId === job.promptId;
      } catch { /* 查不到就按保守策略走 */ }

      // ③ 只有「正在跑的就是我」才 interrupt —— 不误杀别人的任务
      if (runningId === job.promptId) {
        try {
          const res = await fetch(`${comfy.base}/interrupt`, { method: "POST" });
          result.interrupted = res.ok;
          if (!res.ok) result.note += `interrupt HTTP ${res.status}; `;
        } catch (err) {
          result.note += `interrupt 失败：${err?.message ?? err}; `;
        }
      } else if (stillQueued && !removed) {
        result.note += "任务仍在队列且未在运行，queue delete 未生效； ";
      }

      // ④ 结果如实回报（不再无条件 ok）
      result.ok = !stillQueued || result.interrupted || result.removedFromQueue;
      if (!result.note) result.note = result.ok ? "已取消" : "取消失败";

      jobs.delete(jobId);
      /**
       * ★ 2026-10-22：取消也要释放进度订阅
       *   否则 watchedJobs 里留一条、progressBus 的 Map 里留一条旧进度，
       *   而且 watchers 计数不归零 ⇒ WS 连接永不关闭。
       */
      releaseWatch(jobId);
      progressBus.forget(job.promptId);
      log.info?.(`[${name}] cancel ${jobId}：${JSON.stringify(result)}`);
      return result;
    },
  };

  // ────────────────────────────────────────────────────────────
  // 注册 HTTP 路由
  // ────────────────────────────────────────────────────────────
  // ★ dsh-host-webserver 的 register(route) 支持 exact / prefix。
  //   这里用 prefix 一次覆盖全部端点：
  //     GET  {prefix}/health
  //     GET  {prefix}/modes
  //     GET  {prefix}/lengths
  //     POST {prefix}/generate
  //     GET  {prefix}/job/:id
  //     POST {prefix}/cancel/:id
  const routes = [
    ["GET", "/health", () => handlers.health()],
    ["GET", "/modes", () => handlers.modes()],
    ["GET", "/lengths", () => handlers.lengths()],
  ];

  if (typeof ctx?.webServer?.register === "function") {
    ctx.effect(() => {
      const disposers = [];

      // 三个只读端点用 exact
      for (const [method, path, fn] of routes) {
        disposers.push(
          ctx.webServer.register({
            kind: "exact",
            path: prefix + path,
            handler: async (req, res) => {
              if (req.method !== method) return json(res, 405, { error: "method not allowed" });
              try {
                json(res, 200, await fn());
              } catch (err) {
                json(res, 500, { error: err.message });
              }
            },
          })
        );
      }

      // ── 模型需求清单（2026-10-23 新增，设置页用）──
      /**
       * GET /models/required → { items: [{name, found, unknown, note}], unknown }
       *
       * ★ 从 workflows/*.json 里反推模型文件名，
       *   再用 ComfyUI 的 /object_info 判断「它认得吗」。
       *   不用扫磁盘 —— extra_model_paths.yaml 会让模型散落多处，扫必不全。
       *
       * ★ ComfyUI 不可用时 unknown=true，found 全为 null。
       *   前端必须区分「判断不了」和「缺失」，否则会把「没开 ComfyUI」误报成「缺模型」。
       */
      disposers.push(
        ctx.webServer.register({
          kind: "exact",
          path: prefix + "/models/required",
          handler: async (_req, res) => {
            try {
              const { buildModelManifest } = await import("./model-manifest.mjs");
              /**
               * ★ 2026-10-23：把模型目录传下去。
               *   优先级：用户填的 modelsDir > <ComfyUI>/models
               *   ComfyUI 没开时用它做本地兜底（否则 unknown=true 无从判断）。
               */
              let modelsDir = paths.modelsDir ?? null;
              if (!modelsDir) {
                try {
                  const { resolveComfyPaths } = await import("./comfy-launcher.mjs");
                  const rp = resolveComfyPaths({ comfyPath: paths.comfyPath });
                  if (rp) modelsDir = path.join(path.dirname(rp.mainPy), "models");
                } catch { /* 解析不到就不兜底，走 unknown 分支 */ }
              }
              const r = await buildModelManifest({ workflowsDir: WORKFLOWS_DIR, base, modelsDir });
              json(res, 200, { ok: true, ...r });
            } catch (err) {
              json(res, 200, { ok: false, items: [], unknown: true, error: String(err?.message ?? err) });
            }
          },
        })
      );

      // ── 设置页：读/写用户配置（2026-10-23 新增）──
      /**
       * ★★ 为什么需要这两个路由
       *   去敏之后插件不再硬编码本机路径，必须让用户填。
       *   填的地方就是设置页 —— 它需要能读当前值、能保存。
       *
       *   GET  /config → { comfyPath, outputDir, inputDir, _info:{path, exists} }
       *   POST /config { comfyPath?, outputDir?, inputDir? } → 保存后的完整配置
       *
       *   ★ 保存后要能【立即生效】：这里把结果写回上面那个 paths 变量，
       *     不需要重启实例。否则用户填完还得重启，体验断掉。
       */
      disposers.push(
        ctx.webServer.register({
          kind: "exact",
          path: prefix + "/config",
          handler: async (req, res) => {
            try {
              const { loadConfig, saveConfig, configInfo } = await import("./user-config.mjs");

              if (req.method === "GET") {
                return json(res, 200, {
                  ok: true,
                  ...loadConfig(ctx, log),
                  _info: configInfo(ctx),
                  /** 当前实际生效的值（含插件参数/环境变量回落） */
                  _effective: paths,
                });
              }

              if (req.method !== "POST") {
                return json(res, 405, { error: "method not allowed" });
              }

              /* 读 body */
              const body = await new Promise((resolve, reject) => {
                let raw = "";
                req.on("data", (c) => { raw += c; if (raw.length > 100_000) reject(new Error("body 过大")); });
                req.on("end", () => resolve(raw));
                req.on("error", reject);
              });
              let patch;
              try { patch = JSON.parse(body || "{}"); }
              catch { return json(res, 400, { error: "body 不是合法 JSON" }); }

              const saved = saveConfig(ctx, patch, log);

              /**
               * ★ 立即生效：更新闭包里的 paths。
               *   这样不用重启 —— 用户填完马上就能点那个状态点启动。
               */
              paths.comfyPath = saved.comfyPath;
              paths.outputDir = saved.outputDir;
              paths.inputDir = saved.inputDir;

              log.info?.(`[comfy-bridge] 配置已保存：${Object.keys(patch).join(", ") || "(无字段)"}`);
              json(res, 200, { ok: true, ...saved, _info: configInfo(ctx) });
            } catch (err) {
              /* ★ 保存失败必须让前端知道 —— 用户以为存上了但没存是最糟的 */
              json(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
          },
        })
      );

      // ── ComfyUI 开关（主人 2026-10-18）──
      //   「而且没有关闭能力，应该做成开关」
      //   ⇒ /ensure 启动，/stop 关闭。两个都由状态栏那个按钮触发。
      disposers.push(
        ctx.webServer.register({
          kind: "exact",
          path: prefix + "/ensure",
          handler: async (req, res) => {
            if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
            try {
              const { ensureComfy, launcherState } = await import("./comfy-launcher.mjs");
              /**
               * ★ 2026-10-23：把用户配置的路径传下去。
               *   不传时 comfy-launcher 走「环境变量 → 常见位置探测」，
               *   探测不到就返回 needSetup: true，前端据此引导去设置页。
               */
              const r = await ensureComfy({
                base, log,
                comfyPath: paths.comfyPath,
                outputDir: paths.outputDir,
                inputDir: paths.inputDir,
              });
              json(res, 200, { ...r, ...launcherState() });
            } catch (err) {
              json(res, 200, { ok: false, started: false, reason: String(err?.message ?? err) });
            }
          },
        })
      );

      // ── 字幕 F9（外部源调研 P0，本机 faster-whisper + 本地模型）──
      //   POST /subtitle/transcribe { file, language?, model? } → segments + srt
      //   POST /subtitle/burn       { video, srt }             → 烧硬字幕
      disposers.push(
        ctx.webServer.register({
          kind: "exact",
          path: prefix + "/subtitle/status",
          handler: async (_req, res) => {
            try {
              const { asrStatus } = await import("./subtitle.mjs");
              json(res, 200, await asrStatus());
            } catch (err) {
              json(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
          },
        })
      );

      disposers.push(
        ctx.webServer.register({
          kind: "exact",
          path: prefix + "/subtitle/transcribe",
          handler: async (req, res) => {
            if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
            try {
              const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
              const { transcribe } = await import("./subtitle.mjs");
              const r = await transcribe({
                file: body.file,
                language: body.language || undefined,
                model: body.model || undefined,
              });
              json(res, r.ok ? 200 : 400, r);
            } catch (err) {
              json(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
          },
        })
      );

      disposers.push(
        ctx.webServer.register({
          kind: "exact",
          path: prefix + "/subtitle/burn",
          handler: async (req, res) => {
            if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
            try {
              const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
              const { burnSubtitles } = await import("./subtitle.mjs");
              const r = await burnSubtitles({
                video: body.video,
                srt: body.srt,
                out: body.out,
                fontSize: body.fontSize,
                marginV: body.marginV,
              });
              json(res, r.ok ? 200 : 400, r);
            } catch (err) {
              json(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
          },
        })
      );

      // ── 衔接质检 F10（外部源调研 P0，纯 ffmpeg 零模型）──
      //   让「哪一段该重跑」是算出来的，不是猜的。
      //   阈值 0.65 是实测标定的（同源切开 0.823 / 无关视频 0.397）。
      disposers.push(
        ctx.webServer.register({
          kind: "exact",
          path: prefix + "/audit",
          handler: async (req, res) => {
            if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
            try {
              const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
              const { auditCuts } = await import("./quality.mjs");
              const r = await auditCuts(body.clips ?? [], {
                threshold: body.threshold,
              });
              json(res, 200, r);
            } catch (err) {
              json(res, 500, { ok: false, error: String(err?.message ?? err) });
            }
          },
        })
      );

      // ── 首尾帧衔接（学 YUH 的 canvas 节点 chain_from）──
      //   上一镜尾帧 → 下一镜参考图槽。多镜一致性的关键。
      disposers.push(
        ctx.webServer.register({
          kind: "exact",
          path: prefix + "/chain",
          handler: async (req, res) => {
            if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
            try {
              const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
              const { chainFromPrev, chainAll } = await import("./chain.mjs");
              const slot = body.slot ?? "ref_image_0";

              // 三种用法：
              //   单个：{ prevVideo, slot }
              //   批量：{ clips: [...], slot }
              //   从时间轴按 clipId 取（UI 用这个）：
              //     { clipId, slot, fromPrev:true } —— 自动找它在时间轴上的前一镜
              if (Array.isArray(body.clips)) {
                return json(res, 200, await chainAll(body.clips, slot));
              }
              // ★ 2026-10-18 修（自测发现）：原来写 if (body.prevVideo)，
              //   传空字符串 "" 时被当成「没传这个字段」，落到最后的兜底错误
              //   「要传 prevVideo / clips / clipId 之一」—— 明明传了，报的却是没传。
              //   改成：只要字段【存在】就走单个分支，让 chainFromPrev 报真正的原因。
              if (body.prevVideo !== undefined) {
                return json(res, 200, await chainFromPrev({ prevVideo: body.prevVideo, slot }));
              }
              if (body.clipId) {
                // UI 只给 clipId，需要去时间轴里找「同一视频轨上的前一镜」。
                // 时间轴状态在 dsh-editor 的 host-store 里，M1 拿不到 ——
                // 所以由前端把 prevVideo 一起传上来更省事；
                // 这里作为兜底：告诉前端该传什么。
                return json(res, 400, {
                  error: "从 UI 调用请传 prevVideo（上一镜产物路径）。" +
                         "或用 /timeline/snapshot 取到轨道后调 { clips, slot }。",
                  hint: { clipId: body.clipId, slot },
                });
              }
              json(res, 400, { error: "要传 prevVideo / clips / clipId 之一" });
            } catch (err) {
              json(res, 500, { error: String(err?.message ?? err) });
            }
          },
        })
      );

      // ── 视频抽帧（学 YUH 的 yuh_canvas_extract_frame）──
      //   首尾帧衔接是多镜一致性的关键：上一镜尾帧 → 下一镜首帧。
      //   我现在只有「整段替换」，缺这个原子操作。
      disposers.push(
        ctx.webServer.register({
          kind: "exact",
          path: prefix + "/frame",
          handler: async (req, res) => {
            if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
            try {
              const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
              const { extractFrame, ffmpegStatus } = await import("./frames.mjs");
              const st = await ffmpegStatus();
              if (!st.ok) return json(res, 500, { error: `ffmpeg 不可用：${st.error}` });
              const r = await extractFrame({
                file: body.file,
                position: body.position ?? "first",
                seconds: Number(body.seconds ?? 0),
              });
              json(res, r.ok ? 200 : 400, r);
            } catch (err) {
              json(res, 500, { error: String(err?.message ?? err) });
            }
          },
        })
      );

      // 抽帧能力探活
      disposers.push(
        ctx.webServer.register({
          kind: "exact",
          path: prefix + "/frame/status",
          handler: async (_req, res) => {
            try {
              const { ffmpegStatus } = await import("./frames.mjs");
              json(res, 200, await ffmpegStatus());
            } catch (err) {
              json(res, 500, { error: String(err?.message ?? err) });
            }
          },
        })
      );

      // ── 产物清理（主人 2026-10-18：「只保留最近的，资产库人工管理」）──
      //   ?dryRun=1 只报告不删（默认就是 dryRun，安全）。
      //   只清白名单前缀 + 超过保留天数的文件，主人的历史产出一个不碰。
      disposers.push(
        ctx.webServer.register({
          kind: "exact",
          path: prefix + "/clean",
          handler: async (req, res) => {
            if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
            try {
              const { cleanOutput, DEFAULT_KEEP_DAYS } = await import("./cleaner.mjs");
              const u = new URL(req.url ?? "/", "http://x");
              const dryRun = u.searchParams.get("dryRun") !== "0";   // 默认预演
              const keepDays = Number(u.searchParams.get("keepDays") ?? DEFAULT_KEEP_DAYS);
              /**
               * ★★ 2026-10-23 去敏：输出目录不再硬编码本机路径。
               *   顺序：用户配置 → 环境变量 → comfy-launcher 自动解析的 <comfy>/output
               *   （原来写死 "D:\\Comfy-Desktop\\ComfyUI-Shared\\output"，换机器就错）。
               */
              const { resolveComfyPaths } = await import("./comfy-launcher.mjs");
              const outDir = paths.outputDir
                ?? process.env.COMFYUI_OUTPUT
                ?? resolveComfyPaths({ comfyPath: paths.comfyPath })?.outputDir
                ?? null;
              if (!outDir) {
                return json(res, 400, {
                  error: "没配置输出目录。请在插件设置里填 ComfyUI 路径或输出目录。",
                });
              }
              json(res, 200, await cleanOutput(outDir, { keepDays, dryRun, log }));
            } catch (err) {
              json(res, 200, { error: String(err?.message ?? err) });
            }
          },
        })
      );

      disposers.push(
        ctx.webServer.register({
          kind: "exact",
          path: prefix + "/stop",
          handler: async (req, res) => {
            if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
            try {
              const { stopComfy } = await import("./comfy-launcher.mjs");
              json(res, 200, await stopComfy({ base, log }));
            } catch (err) {
              json(res, 200, { ok: false, stopped: false, reason: String(err?.message ?? err) });
            }
          },
        })
      );

      // POST /generate
      disposers.push(
        ctx.webServer.register({
          kind: "exact",
          path: prefix + "/generate",
          handler: async (req, res) => {
            if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
            try {
              const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
              json(res, 200, await handlers.generate(body));
            } catch (err) {
              json(res, 500, { error: err.message, name: err.name });
            }
          },
        })
      );

      // prefix：/job/:id 与 /cancel/:id
      //
      // ★★ 两个坑，都读过 host-webserver 源码确认（2026-10-17）：
      //
      //  坑 A · 注册的 prefix 不能带尾斜杠。
      //     lib/index.js 的 match() 逐字：
      //       if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
      //     它自己会拼 `${prefix}/`。注册 "/job/" 就要匹配 "/job//"，永不命中。
      //     ⇒ 注册 "/comfy-bridge/job"，请求 "/comfy-bridge/job/xxx"。
      //
      //  坑 B · handler 收到的 req.url 是【完整路径】，不是相对路径。
      //     lib/index.js 逐字：
      //       const rawPath = new URL(req.url ?? "/", "http://x").pathname;
      //       const route = this.match(rawPath);
      //       if (route !== void 0) { await route.handler(req, res); return; }
      //     ⇒ 它只把 rawPath 用于匹配，传下去的 req 是原始的，req.url 未被改写。
      //     （我先误判成"已剥离前缀"，写 slice(1) 切出 "omfy-bridge/job/abc"，
      //      于是 404 —— 这是第二次踩同一个点了。）
      const idAfter = (url, mount) => {
        const p = url.split("?")[0];
        const full = mount + "/";
        if (!p.startsWith(full)) return "";
        return decodeURIComponent(p.slice(full.length));
      };

      disposers.push(
        ctx.webServer.register({
          kind: "prefix",
          path: prefix + "/job",
          handler: async (req, res) => {
            const id = idAfter(req.url ?? "", prefix + "/job");
            if (!id) return json(res, 400, { error: "缺少 jobId" });
            try {
              json(res, 200, await handlers.job(id));
            } catch (err) {
              json(res, 404, { error: err.message });
            }
          },
        })
      );

      disposers.push(
        ctx.webServer.register({
          kind: "prefix",
          path: prefix + "/cancel",
          handler: async (req, res) => {
            const id = idAfter(req.url ?? "", prefix + "/cancel");
            if (!id) return json(res, 400, { error: "缺少 jobId" });
            try {
              json(res, 200, await handlers.cancel(id));
            } catch (err) {
              json(res, 404, { error: err.message });
            }
          },
        })
      );

      // ── 实时进度（2026-10-22）──
      /**
       * 两条配套路由：
       *
       *   GET /progress/status            连接诊断 + 【驱动连接】
       *   GET /progress/<promptId>        单个任务的进度
       *
       * ★ 为什么 status 那条要「驱动连接」：
       *   WS 是懒连接的（没人看就不连，省资源）。
       *   而懒连接需要一个「有人开始看了」的信号。
       *   前端轮询 /job 时不方便维持长连接计数，
       *   所以让 /progress/status 每条请求都 watch 一次再立刻 unwatch ——
       *   这在语义上等于「问一下顺便把连接叫醒」。
       *   ★ 但每条请求 watch+unwatch 会造成连接抖动。
       *     正确做法：status 每次调用时如果没连上就 connect()，不做计数。
       *     计数只用于「进程退出时清理」。
       */
      disposers.push(
        ctx.webServer.register({
          kind: "exact",
          path: prefix + "/progress/status",
          handler: async (_req, res) => {
            try {
              /**
               * ★★ 2026-10-22 修：诊断接口不该有副作用
               *
               *   第一版这里每次请求都调 progressBus._internal.connect()，
               *   想着「顺便把连接叫醒」。实测后果：
               *     每次调 /progress/status 都会新建一条 WS 连接，
               *     而那一刻它还没失败 ⇒ stats() 报 connecting: true, readyState: 0。
               *   于是「诊断」永远显示「正在连接中」，
               *   让我误以为是 connecting 卡死不复位 —— 查了半小时才发现是假象。
               *
               *   ⇒ 改法：诊断只【读】，不驱动。
               *     连接的建立由真正需要它的地方触发（前端首次轮询 /job 时）。
               */
              json(res, 200, { ok: true, ...progressBus.stats() });
            } catch (err) {
              json(res, 200, { ok: false, error: String(err?.message ?? err) });
            }
          },
        })
      );

      disposers.push(
        ctx.webServer.register({
          kind: "prefix",
          path: prefix + "/progress",
          handler: async (req, res) => {
            const id = idAfter(req.url ?? "", prefix + "/progress");
            /**
             * ★ 前缀路由会同时吃掉 /progress/status（如果 exact 那条没先命中）。
             *   这里显式挡掉，避免把 "status" 当成 promptId。
             *   （/progress/status 是 exact 路由，正常情况下先命中，但防御一下。）
             */
            if (!id || id === "status") {
              return json(res, 200, { ok: true, ...progressBus.stats() });
            }
            try {
              const p = progressBus.get(id);
              json(res, 200, { ok: true, promptId: id, progress: p });
            } catch (err) {
              json(res, 200, { ok: false, promptId: id, progress: null, error: String(err?.message ?? err) });
            }
          },
        })
      );

      // ── 设备监控（工作台 UI 的一个子模块；坏了只丢那块 UI）──
      //   挂在这里是因为工作台插件是纯浏览器侧，自己没有 webServer。
      disposers.push(
        ctx.webServer.register({
          kind: "exact",
          path: prefix + "/device",
          handler: async (_req, res) => {
            try {
              const { readDeviceSnapshot } = await import("./device.mjs");
              json(res, 200, await readDeviceSnapshot());
            } catch (err) {
              // 采集失败不影响任何其它路由
              json(res, 200, { at: Date.now(), gpu: null, cpu: null, mem: null, error: String(err?.message ?? err) });
            }
          },
        })
      );

      // ★ 2026-10-19 新增（主人：「krea2 的 lora 下拉栏里放所有可用 lora」）：
      //   前端需要一份 ComfyUI 认的 LoRA 名单。走它自己的 object_info，
      //   不扫磁盘 —— 理由见 comfy.mjs 的 listLoras()。
      //
      //   失败也返回 200 + loras:[]，前端据此把下拉降级成「不可用」，
      //   不许因为拿不到名单就把整个参数区拖垮。
      disposers.push(
        ctx.webServer.register({
          kind: "exact",
          path: prefix + "/loras",
          handler: async (_req, res) => {
            try {
              const loras = await comfy.listLoras?.();
              json(res, 200, { ok: true, loras: Array.isArray(loras) ? loras : [] });
            } catch (err) {
              json(res, 200, { ok: false, loras: [], error: String(err?.message ?? err) });
            }
          },
        })
      );

      log.info?.(`[${name}] 已注册路由 ${prefix}/*`);
      return () => disposers.forEach((d) => d?.());
    }, "comfy-bridge: routes");
  } else {
    log.warn?.(`[${name}] ctx.webServer 不可用 —— 路由未注册，M2 只能用降级桥`);
  }

  return undefined;
}

export {
  buildPrompt,
  loadModes,
  snapLength,
  secondsToLength,
  aspectToSize,
  LEGAL_LENGTHS,
  lengthToSeconds,
  WorkflowError,
};


