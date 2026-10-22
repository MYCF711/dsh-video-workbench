/**
 * 从 app.asar 里按路径读单个文件到 stdout 或磁盘。
 *
 * ★ 为什么要这个脚本（2026-10-21）：
 *   查「DSH 的 settings.section 怎么注册」时，Hindsight 没有、磁盘上没有源码，
 *   只能在 asar 里找。手工用 PowerShell 读字节又慢又容易算错 offset。
 *   这个脚本按 asar 规范算 offset：headerSize 之后是数据区，offset 是相对数据区起点。
 *
 * 用法：
 *   node read-asar.mjs <asar路径> <内部路径>            → 打印到 stdout
 *   node read-asar.mjs <asar路径> <内部路径> --out <文件> → 写到磁盘
 *   node read-asar.mjs <asar路径> --list                → 列出全部包名（含 client 的）
 */
import fs from "node:fs";
import path from "node:path";

const [, , asarPath, inner, ...rest] = process.argv;
if (!asarPath) {
  console.error("用法: node read-asar.mjs <asar> <inner/path> [--out file] | --list");
  process.exit(2);
}

const fd = fs.openSync(asarPath, "r");

/* ── 读 header ─────────────────────────────────────────── */
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
// uint32 @0 = 4（pickle 长度字段自身）
// uint32 @4 = header size pickle 长度
// uint32 @8 = header 内容长度
// uint32 @12 = json 长度
const jsonLen = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
const tree = JSON.parse(jsonBuf.toString("utf8"));
// 数据区起始 = 8 + 对齐后的 header 总长
// asar 规范：header 整体是 [4B size=4][4B size][4B size][json]，共 16 + jsonLen，
// 但 Chromium 的 pickle 会做 4 字节对齐 ⇒ 用 8 + head.readUInt32LE(4) + 4 更保险。
// 实测本机：jsonLen=3392048，8 + (8 + jsonLen) = 8 + 8 + jsonLen。
const dataStart = 8 + (head.readUInt32LE(4) + 8);

if (inner === "--list") {
  const out = [];
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${k}` : k;
      if (v.files) walk(v, p);
      else out.push(p);
    }
  };
  walk(tree, "");
  const names = new Set(out.map((p) => p.split("/").filter((s) => s.includes("dsh")).slice(0, 1)[0]));
  console.log(out.length + " 个文件");
  console.log([...names].slice(0, 200).join("\n"));
  fs.closeSync(fd);
  process.exit(0);
}

/* ── 定位内部路径 ──────────────────────────────────────── */
const segs = inner.split("/").filter(Boolean);
let cur = tree;
for (const s of segs) {
  if (!cur.files || !cur.files[s]) {
    console.error("找不到路径：" + inner + "\n已走到：" + segs.join("/"));
    fs.closeSync(fd);
    process.exit(1);
  }
  cur = cur.files[s];
}
if (!cur.offset) {
  console.error("这是目录，不是文件：" + inner);
  fs.closeSync(fd);
  process.exit(1);
}

const start = dataStart + Number(cur.offset);
const size = Number(cur.size);
const buf = Buffer.alloc(size);
fs.readSync(fd, buf, 0, size, start);
fs.closeSync(fd);

const outIdx = rest.indexOf("--out");
if (outIdx >= 0) {
  const dst = rest[outIdx + 1];
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, buf);
  console.error(`✓ ${size} 字节 → ${dst}`);
} else {
  process.stdout.write(buf);
}
