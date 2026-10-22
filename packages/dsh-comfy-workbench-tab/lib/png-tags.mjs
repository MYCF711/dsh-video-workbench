#!/usr/bin/env node
/**
 * 往 PNG 写 / 读工作台标签（iTXt，UTF-8，支持中文）
 *
 * 主人 2026-10-21 定：「1吧，不过 comfy ui 也不会生成重名文件吧？
 *                     然后音频和视频也没第二个tag吧？」
 *
 * 实测回答（都已验证）：
 *   ① ComfyUI 不会生成重名 —— 745 个文件 0 组同名，序号递增
 *      Krea2-2ST-20261018_00001_ → _00215_
 *  ② PNG 能安全写 tag —— 插入 tEXt/iTXt 后 IDAT SHA256 完全不变（+81 字节元数据）
 *  ③ 但 tEXt 只支持 Latin-1 ⇒ 中文必须用 iTXt
 *  ④ MP4/音频只能存标准 key（title/comment），自定义 key 被丢弃
 *     且 -metadata 会挤掉 ComfyUI 的 prompt 字段 ⇒ 视频仍以 json 为主
 *
 * 判据：PNG 写本体（tag 真跟着文件走），MP4/音频 存 json，两边都覆盖。
 *
 * PNG 规范要点：
 *   · iTXt chunk 结构：keyword\0 compressionFlag(1) compressionMethod(1)
 *     languageTag\0 translatedKeyword\0 text(UTF-8)
 *   · 必须插在第一个 IDAT 之前
 *   · chunk 格式：长度(4) + 类型(4) + 数据 + CRC32(4)
 */

import fs from "node:fs";
import fsSync from "node:fs";

/* ── CRC32（PNG 标准）──────────────────────────────────────── */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ── chunk 构造 ────────────────────────────────────────────── */
function makeChunk(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(type, 4, "latin1");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), payload])) >>> 0, 0);
  return Buffer.concat([head, payload, crcBuf]);
}

/** iTXt：中文安全（UTF-8） */
export function makeITxt(keyword, text) {
  const payload = Buffer.concat([
    Buffer.from(keyword, "latin1"),
    Buffer.from([0]),           // keyword 结束
    Buffer.from([0]),           // compressionFlag = 0（不压缩）
    Buffer.from([0]),           // compressionMethod = 0
    Buffer.from([0]),           // languageTag = "" （空）
    Buffer.from([0]),           // translatedKeyword = "" （空）
    Buffer.from(text, "utf8"),
  ]);
  return makeChunk("iTXt", payload);
}

/* ── 解析 ──────────────────────────────────────────────────── */
export function parseChunks(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG");
  const out = [];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    out.push({ type, len, data, raw: buf.subarray(pos, pos + 12 + len) });
    pos += 12 + len;
    if (type === "IEND") break;
  }
  return out;
}

/** 读出所有 iTXt / tEXt 的 {keyword: text} */
export function readTextTags(buf) {
  const out = {};
  for (const c of parseChunks(buf)) {
    if (c.type === "tEXt") {
      const s = c.data.toString("latin1");
      const i = s.indexOf("\0");
      if (i > 0) out[s.slice(0, i)] = s.slice(i + 1);
    } else if (c.type === "iTXt") {
      const kw = c.data.toString("latin1", 0, c.data.indexOf(0));
      // 跳过：keyword\0 flag(1) method(1) lang\0 translated\0 text
      const rest = c.data.subarray(kw.length + 3);
      const langEnd = rest.indexOf(0);
      const rest2 = rest.subarray(langEnd + 1);
      const transEnd = rest2.indexOf(0);
      const text = rest2.subarray(transEnd + 1).toString("utf8");
      out[kw] = text;
    }
  }
  return out;
}

/* ── 写：替换或追加 iTXt ───────────────────────────────────── */
/**
 * 往 PNG 写标签（覆盖式）。
 *
 * @param {string} filePath
 * @param {Record<string,string>} tags   要写入的 { keyword: value }
 * @param {string[]} [dropAlso]          即使没有新值也要【删掉】的 key 列表
 *                                       —— 用于「只删不写」的场景（如清别名）
 */
export function writeTextTags(filePath, tags, dropAlso = []) {
  const src = fs.readFileSync(filePath);
  const chunks = parseChunks(src);
  const firstIdat = chunks.findIndex((c) => c.type === "IDAT");
  if (firstIdat < 0) throw new Error("PNG 里没有 IDAT");

  /**
   * 要删掉的旧同名块（幂等：同 key 覆盖，不重复追加）
   *
   * ★ 2026-10-21 修：原来只有 Object.keys(tags)。
   *   实测 bug：clearTagsInImage 传 keep={role}（不含 alias）时，
   *   alias 不在 dropKeys ⇒ 旧 alias 被保留 ⇒ 清不掉。
   *   ⇒ 加 dropAlso 显式指定。
   */
  const dropKeys = new Set([...Object.keys(tags), ...dropAlso]);
  const keepHead = chunks.slice(0, firstIdat).filter((c) => {
    if (c.type !== "iTXt" && c.type !== "tEXt") return true;
    const kw = c.data.toString("latin1", 0, c.data.indexOf(0));
    return !dropKeys.has(kw);
  });

  const newChunks = Object.entries(tags)
    .filter(([, v]) => v != null && String(v).length > 0)
    .map(([k, v]) => makeITxt(k, String(v)));

  const rebuilt = Buffer.concat([
    src.subarray(0, 8),
    ...keepHead.map((c) => c.raw),
    ...newChunks,
    ...chunks.slice(firstIdat).map((c) => c.raw),
  ]);

  // 原子写：先写 .tmp 再 rename
  const tmp = filePath + ".tagtmp";
  fs.writeFileSync(tmp, rebuilt);
  fs.renameSync(tmp, filePath);
  return rebuilt.length;
}

/** 幂等清理：只删工作台自己的 key，不碰 ComfyUI 的 prompt */
export const WB_KEYS = ["workbench_role", "workbench_alias"];

export function clearTextTags(filePath) {
  const src = fs.readFileSync(filePath);
  const chunks = parseChunks(src);
  const firstIdat = chunks.findIndex((c) => c.type === "IDAT");
  const keep = chunks.slice(0, firstIdat).filter((c) => {
    if (c.type !== "iTXt" && c.type !== "tEXt") return true;
    const kw = c.data.toString("latin1", 0, c.data.indexOf(0));
    return !WB_KEYS.includes(kw);
  });
  const rebuilt = Buffer.concat([
    src.subarray(0, 8),
    ...keep.map((c) => c.raw),
    ...chunks.slice(firstIdat).map((c) => c.raw),
  ]);
  const tmp = filePath + ".tagtmp";
  fs.writeFileSync(tmp, rebuilt);
  fs.renameSync(tmp, filePath);
}
/**
 * 同步读一个 PNG 文件的标签（给扫描时用）。
 *
 * ★ 为什么只读 header 就够：
 *   iTXt/tEXt 一定在 IDAT 之前（PNG 规范），
 *   所以读到第一个 IDAT 就可以停 —— 不用把 6.83MB 的解压流读进来。
 *   实测一个 6.83MB 的 PNG，扫 header 约 1ms。
 */
export function readTextTagsSync(filePath) {
  const fd = fsSync.openSync(filePath, "r");
  try {
    const head = Buffer.alloc(8);
    fsSync.readSync(fd, head, 0, 8, 0);
    if (head.length < 8 || head.readUInt32BE(0) !== 0x89504e47) return null;

    const out = {};
    let pos = 8;
    const lenBuf = Buffer.alloc(8);
    for (let guard = 0; guard < 200; guard++) {
      const n = fsSync.readSync(fd, lenBuf, 0, 8, pos);
      if (n < 8) break;
      const len = lenBuf.readUInt32BE(0);
      const type = lenBuf.toString("ascii", 4, 8);
      if (type === "IDAT" || type === "IEND") break;   // 元数据都在 IDAT 之前
      if (type === "tEXt" || type === "iTXt") {
        const data = Buffer.alloc(len);
        fsSync.readSync(fd, data, 0, len, pos + 8);
        if (type === "tEXt") {
          const s = data.toString("latin1");
          const i = s.indexOf("\0");
          if (i > 0) out[s.slice(0, i)] = s.slice(i + 1);
        } else {
          const kwEnd = data.indexOf(0);
          const kw = data.toString("latin1", 0, kwEnd);
          const rest = data.subarray(kwEnd + 3);
          const langEnd = rest.indexOf(0);
          const rest2 = rest.subarray(langEnd + 1);
          const transEnd = rest2.indexOf(0);
          out[kw] = rest2.subarray(transEnd + 1).toString("utf8");
        }
      }
      pos += 12 + len;
    }
    return out;
  } finally {
    fsSync.closeSync(fd);
  }
}