/**
 * 用户配置的持久化（2026-10-23）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个
 *
 *   去敏改造把硬编码路径全部移除后，插件就「不知道该去哪找 ComfyUI」了。
 *   必须有一个地方存用户填的路径。
 *
 * ── 存哪
 *   DSH 插件的私有数据目录。用 ctx 提供的位置，不写死。
 *   实测宿主注入的可用位置：
 *     ctx.dataDir  —— 插件的私有可写目录（如果宿主提供）
 *   取不到时回落到 <os.tmpdir>/dsh-comfy-bridge/config.json
 *   （tmp 不理想但比崩掉好，且会在日志里明确警告）。
 *
 * ── 格式
 *   {
 *     comfyPath:  "D:\\path\\to\\ComfyUI-Installs\\My_Comfy_UI",
 *     outputDir:  "D:\\path\\to\\shared\\output",
 *     inputDir:   "D:\\path\\to\\shared\\input",
 *     version:    1
 *   }
 *
 *   ★ 只用绝对路径。相对路径会随 cwd 变化 —— 而 cwd 不可靠
 *     （AGENTS §6 记过：process.cwd() 重启后可能变）。
 *
 * ── 读写纪律
 *   · 读失败（文件不存在 / JSON 坏）⇒ 返回空对象，不抛
 *     （配置缺失是正常状态，不是错误）
 *   · 写失败 ⇒ 抛错。写不进去必须让用户知道，否则他填完以为存上了
 *   · 原子写：先写 .tmp 再 rename，避免写一半断电留下坏文件
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_VERSION = 1;

/**
 * 配置目录。四级回落，从「最确定」到「最不稳」：
 *
 *   ① COMFY_BRIDGE_CONFIG_DIR   显式环境变量（部署脚本 / 用户自设，最可靠）
 *   ② ctx.dataDir               宿主注入（本机 DSH 的 inject 里没有它）
 *   ③ DSH_PROFILE_DIR           实测【不可靠】—— 见下面 ★
 *   ④ os.tmpdir()               兜底，会被系统清理
 *
 * ★★ 2026-10-23 实测：DSH_PROFILE_DIR 不能用
 *   在 comfy-test（19499）里读到的却是 `profiles\desktop` ——
 *   因为那个环境变量是【启动 DSH 的父进程】的，不是当前 profile 的。
 *   同一个宿主进程起不同 profile，这个值不会跟着变。
 *   ⇒ 它看起来能用（路径合法、可写），实际指向错误的 profile。
 *     这种「错得不像错」最危险，必须标出来。
 *   ⇒ 保留它作为第 ③ 级（总比 tmp 好），但设置页要显示实际路径，
 *     让用户能一眼看出「存到别的 profile 去了」。
 *
 * ★ 为什么 ctx.dataDir 也会抛错
 *   未声明 inject 时访问它 = `cannot get property "dataDir" without inject`
 *   （AGENTS §3.1 同款），所以 `ctx?.dataDir` 挡不住 —— getter 本身就抛。
 *   必须 try/catch。
 */
function configDir(ctx) {
  /* ① 显式环境变量 */
  const explicit = process.env.COMFY_BRIDGE_CONFIG_DIR;
  if (explicit) return explicit;

  /* ② 宿主注入 */
  try {
    const fromCtx = ctx?.dataDir;
    if (typeof fromCtx === "string" && fromCtx) return fromCtx;
  } catch { /* 未 inject，继续回落 */ }

  /* ③ profile 目录（可能指向别的 profile，见上面 ★） */
  const profDir = process.env.DSH_PROFILE_DIR;
  if (profDir) return path.join(profDir, ".comfy-bridge");

  /* ④ 兜底 */
  return path.join(os.tmpdir(), "dsh-comfy-bridge");
}

export function configPath(ctx) {
  return path.join(configDir(ctx), "config.json");
}

/**
 * 读配置。
 * @returns {{comfyPath?:string, modelsDir?:string, outputDir?:string, inputDir?:string}}
 */
export function loadConfig(ctx, log = console) {
  const p = configPath(ctx);
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return {};
    /* 只取认识的字段，且必须是 string */
    const out = {};
    for (const k of ["comfyPath", "modelsDir", "outputDir", "inputDir"]) {
      if (typeof j[k] === "string" && j[k].trim()) out[k] = j[k].trim();
    }
    return out;
  } catch (err) {
    /**
     * 读失败不抛 —— 配置缺失/损坏是「还没配」，不是致命错误。
     * 但要说出来：静默用默认值会让用户以为配置生效了。
     */
    log.warn?.(`[comfy-bridge] 配置文件读取失败（将使用默认探测）：${err?.message ?? err}`);
    return {};
  }
}

/**
 * 写配置（原子）。
 * @throws 写不进去时抛 —— 用户以为存上了但没存是最糟的
 */
export function saveConfig(ctx, patch, log = console) {
  const dir = configDir(ctx);
  const p = configPath(ctx);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`配置目录创建失败（${dir}）：${err?.message ?? err}`);
  }

  const cur = loadConfig(ctx, log);
  const next = { ...cur, version: CONFIG_VERSION };
  for (const k of ["comfyPath", "modelsDir", "outputDir", "inputDir"]) {
    if (k in patch) {
      const v = patch[k];
      if (v === null || v === "") delete next[k];
      else if (typeof v === "string") next[k] = v.trim();
      else throw new Error(`配置项 ${k} 必须是字符串`);
    }
  }

  const tmp = `${p}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
    renameSync(tmp, p);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error(`配置写入失败（${p}）：${err?.message ?? err}`);
  }
  return next;
}

/**
 * 配置文件的存放位置说明（给设置页显示用）。
 * ★ 用户需要知道「我填的东西存哪了」——尤其是写不进去时要去哪看。
 */
export function configInfo(ctx) {
  const p = configPath(ctx);
  let dirFromCtx = false;
  try { dirFromCtx = typeof ctx?.dataDir === "string" && !!ctx.dataDir; } catch { /* 未 inject */ }

  const explicitDir = Boolean(process.env.COMFY_BRIDGE_CONFIG_DIR);
  const hasProfileDir = Boolean(process.env.DSH_PROFILE_DIR);
  const inTmp = p.toLowerCase().startsWith(os.tmpdir().toLowerCase());

  /**
   * ★ source 让设置页能说清「这个路径是怎么来的」：
   *   explicit → 环境变量指定的（最可靠）
   *   ctx      → 宿主注入的
   *   profile  → 从 DSH_PROFILE_DIR 推的（可能指向别的 profile，要提醒）
   *   tmp      → 临时目录（重启会丢）
   */
  const source = explicitDir ? "explicit" : dirFromCtx ? "ctx" : hasProfileDir ? "profile" : "tmp";

  return {
    path: p,
    exists: existsSync(p),
    dirFromCtx,
    hasProfileDir,
    source,
    /**
     * ★ true = 存到了系统临时目录 ⇒ 重启可能被清掉。
     *   设置页必须把这个说出来。
     */
    fallbackToTmp: inTmp,
    /**
     * ★ true = 路径来自 DSH_PROFILE_DIR，那个变量是【启动 DSH 的父进程】的，
     *   不等于当前 profile。实测在 comfy-test 里读到的却是 profiles\desktop。
     *   设置页要提示用户：如果不是他想要的 profile，用 COMFY_BRIDGE_CONFIG_DIR 指定。
     */
    mayBeWrongProfile: source === "profile",
  };
}


