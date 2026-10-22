#!/usr/bin/env node
/**
 * PNG 标签写入 / 读取的验收
 *
 * 为什么有这个脚本：
 *   任务书一-3 主人原话：「默认保存到图片本体，毕竟只是改一个 tag，不动内容」
 *   在此之前所有 tag 只存 .state/asset-library.json，从没验证过写本体。
 *
 *   核心判据（三条，缺一不可）：
 *     ① 写完能读回来 —— 值一致，中文不乱码
 *     ② 像素数据完全不变 —— IDAT 的 SHA256 必须相同
 *     ③ 幂等 —— 同 key 重复写不产生多个 chunk
 *
 * 用法：node verify-png-tags.mjs [样本PNG路径]
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { parseChunks, readTextTags, writeTextTags, clearTextTags } from "./dsh-comfy-workbench-tab/lib/png-tags.mjs";

const SRC = process.argv[2] ?? "D:/Comfy-Desktop/ComfyUI-Shared/output/Krea2-USD-20261018_00008_.png";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`    ✅ ${name}${detail ? "  " + detail : ""}`); }
  else { fail++; console.log(`    ❌ ${name}${detail ? "  " + detail : ""}`); }
}

function idatHash(buf) {
  const idat = Buffer.concat(parseChunks(buf).filter((c) => c.type === "IDAT").map((c) => c.data));
  return crypto.createHash("sha256").update(idat).digest("hex");
}

console.log(`\n  PNG 标签验收（样本：${path.basename(SRC)}）`);

if (!fs.existsSync(SRC)) {
  console.log(`  ⚠ 样本不存在，跳过`);
  process.exit(0);
}

// 用副本测，绝不碰原文件
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "png-tag-"));
const work = path.join(tmpDir, "sample.png");
fs.copyFileSync(SRC, work);

try {
  // ── ① 前置：先把工作台标签清干净，得到真正的干净基线 ──
  //
  // ★ 为什么必须先清：
  //   样本可能是业务用过的真实文件（实测踩到：它已带 workbench_role），
  //   不清就会拿「已带标签的文件」当基线，后面两条断言必然误报。
  clearTextTags(work);

  const orig = fs.readFileSync(work);
  const h0 = idatHash(orig);
  const size0 = orig.length;
  const tags0 = readTextTags(orig);
  console.log(`\n  基线：${(size0 / 1024 / 1024).toFixed(2)}MB，已有 tEXt/iTXt ${Object.keys(tags0).length} 个`);
  ok("原文件的 ComfyUI prompt 存在", typeof tags0.prompt === "string" && tags0.prompt.length > 100);

  // ── ② 写中文标签 ───────────────────────────────────────
  const role = "subject.character";
  const alias = "藤蔓木门逆光";     // 中文，验证 iTXt 的 UTF-8
  writeTextTags(work, { workbench_role: role, workbench_alias: alias });

  const after = fs.readFileSync(work);
  const tags1 = readTextTags(after);
  const h1 = idatHash(after);
  const size1 = after.length;

  ok("写后 role 读回一致", tags1.workbench_role === role, `=${tags1.workbench_role}`);
  ok("写后 alias 中文不乱码", tags1.workbench_alias === alias, `=${tags1.workbench_alias}`);
  ok("ComfyUI 的 prompt 未被破坏", tags1.prompt === tags0.prompt);
  ok("像素数据完全不变（IDAT SHA256）", h0 === h1, `${h0.slice(0, 16)}…`);
  ok("只增加元数据字节", size1 > size0 && size1 - size0 < 200, `+${size1 - size0} 字节`);

  // ── ③ 幂等：同 key 再写一次，不该出现两个 iTXt ─────────
  writeTextTags(work, { workbench_role: "picture.first", workbench_alias: alias });
  const after2 = fs.readFileSync(work);
  const roleChunks = parseChunks(after2).filter((c) => {
    if (c.type !== "iTXt") return false;
    return c.data.toString("latin1", 0, c.data.indexOf(0)) === "workbench_role";
  });
  const tags2 = readTextTags(after2);
  ok("同 key 重复写不产生重复 chunk", roleChunks.length === 1, `${roleChunks.length} 个`);
  ok("重复写后值被覆盖", tags2.workbench_role === "picture.first", `=${tags2.workbench_role}`);
  ok("重复写后像素仍不变", idatHash(after2) === h0);

  // ── ④ 清理：只删工作台 key，不碰 prompt ────────────────
  clearTextTags(work);
  const after3 = fs.readFileSync(work);
  const tags3 = readTextTags(after3);
  ok("清理后 workbench_* 已删", tags3.workbench_role === undefined && tags3.workbench_alias === undefined);
  ok("清理后 ComfyUI prompt 仍在", tags3.prompt === tags0.prompt);
  ok("清理后像素仍不变", idatHash(after3) === h0);
  ok("清理后文件大小回到基线", after3.length === size0, `${after3.length} vs ${size0}`);

} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n  通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
