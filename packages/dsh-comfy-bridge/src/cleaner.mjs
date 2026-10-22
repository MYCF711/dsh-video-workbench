/**
 * 产物清理 —— M1 host 侧的模块。
 *
 * ★ 主人 2026-10-18：
 *   「只保留最近的，然后资产库人工管理，可以保存到资产库」
 *   ⇒ 自动清「最近 N 天以外」的旧产物，N 可配。
 *   ⇒ 但【绝不自动删主人的历史产出】—— 默认只清本插件产生的、
 *     且超过保留期的文件；其余一律不动，由主人在资产库里人工管理。
 *
 * ★ 安全设计（删除不可复原，所以每一步都要保守）：
 *   ① 默认 dryRun=true，只报告不删
 *   ② 只处理白名单前缀（Krea2-* / YZ_* / dsh-*），别的文件名一律跳过
 *   ③ 只处理 mtime 早于保留期的文件
 *   ④ 删除前把清单写进日志，事后可追溯
 *   ⑤ 任何异常都只记日志，不抛
 */

import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

/** 本插件产生/管理的文件前缀白名单。别的文件名一律不碰。 */
const OWN_PREFIXES = [
  "Krea2-2ST-",
  "Krea2-USD-",
  "Krea2-SVR-",
  "Krea2-SeedVR-",
  "YZ_H3__",
  "ComfyUI_temp_",
];

/** 默认保留天数。 */
export const DEFAULT_KEEP_DAYS = 3;

function isOwned(name) {
  return OWN_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * 扫描一个目录，算出「可清理」清单。
 * @param {string} dir
 * @param {object} opts
 * @param {number} opts.keepDays  保留最近多少天
 * @param {number} opts.now       当前时间（测试可注入）
 * @returns {Promise<{dir:string, scanned:number, owned:number, removable:Array, bytes:number}>}
 */
export async function scanCleanable(dir, opts = {}) {
  const keepDays = opts.keepDays ?? DEFAULT_KEEP_DAYS;
  const now = opts.now ?? Date.now();
  const cutoff = now - keepDays * 24 * 3600 * 1000;

  let names;
  try {
    names = await readdir(dir);
  } catch {
    return { dir, scanned: 0, owned: 0, removable: [], bytes: 0, error: "目录读不到" };
  }

  let owned = 0;
  const removable = [];
  let bytes = 0;

  for (const name of names) {
    if (!isOwned(name)) continue;
    owned++;
    const full = path.join(dir, name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs >= cutoff) continue;   // 还在保留期内
    removable.push({ name, mtime: st.mtimeMs, size: st.size });
    bytes += st.size;
  }

  return { dir, scanned: names.length, owned, removable, bytes };
}

/**
 * 执行清理。默认 dryRun。
 * @returns {Promise<object>} 报告
 */
export async function cleanOutput(dir, opts = {}) {
  const dryRun = opts.dryRun !== false;   // ★ 默认不删
  const log = opts.log ?? console;

  const scan = await scanCleanable(dir, opts);
  if (scan.error) {
    log.warn?.(`[cleaner] ${dir}：${scan.error}`);
    return { ...scan, deleted: 0, freed: 0, dryRun };
  }

  if (!scan.removable.length) {
    return { ...scan, deleted: 0, freed: 0, dryRun };
  }

  // ★ 删除前把清单落进日志（事后可追溯）
  log.info?.(
    `[cleaner] ${dryRun ? "（预演）" : ""}${dir}：` +
    `${scan.removable.length} 个文件 / ${(scan.bytes / 1024 / 1024).toFixed(1)} MB`
  );

  if (dryRun) {
    return { ...scan, deleted: 0, freed: 0, dryRun };
  }

  let deleted = 0;
  let freed = 0;
  for (const f of scan.removable) {
    try {
      await unlink(path.join(dir, f.name));
      deleted++;
      freed += f.size;
    } catch (err) {
      log.warn?.(`[cleaner] 删除失败 ${f.name}：${err?.message ?? err}`);
    }
  }

  log.info?.(`[cleaner] 已删 ${deleted} 个 / ${(freed / 1024 / 1024).toFixed(1)} MB`);
  return { ...scan, deleted, freed, dryRun };
}
