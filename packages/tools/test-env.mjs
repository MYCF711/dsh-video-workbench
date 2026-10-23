/**
 * 测试实例的连接信息 —— 从环境变量或自动探测取，不写死本机路径。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要这个
 *
 *   2026-10-23 去敏检查（D3）发现：8 个验收脚本里硬编码了
 *
 *     const COOKIE_FILE = 'C:/Users/Administrator/dsh-tok.txt';
 *
 *   这条路径是本机专属的。
 *   ⇒ 别人 clone 下来跑验收，全部会失败（找不到文件），
 *     而且报错只会说「读不到 token」，看不出是「路径没配」。
 *
 *   ★ 这也是「可移植」的硬伤：README 说要能装到别的机器，代码却只认这一台。
 *
 * ── 取值顺序（前者优先）
 *   ① 环境变量 DSH_TEST_TOKEN      —— 直接给 token 值
 *   ② 环境变量 DSH_TEST_TOKEN_FILE —— 给 token 文件路径
 *   ③ 环境变量 DSH_HOME 下的 .test-token（约定位置）
 *   ④ 本机默认位置（仅便捷，找不到不报错）
 *
 *   ★ 全都找不到时返回 null，由调用方决定「跳过」还是「失败」。
 *     不要在这里 throw —— 有些验收在无 token 时应该走「跳过」而不是红。
 *
 * ── 同类：端口
 *   ① DSH_TEST_PORT    ② 默认 19499（本机测试实例的约定端口）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** 候选 token 文件，按优先级排。 */
function tokenFileCandidates() {
  const out = [];
  if (process.env.DSH_TEST_TOKEN_FILE) out.push(process.env.DSH_TEST_TOKEN_FILE);
  if (process.env.DSH_HOME) {
    out.push(path.join(process.env.DSH_HOME, ".test-token"));
    out.push(path.join(process.env.DSH_HOME, "test-token.txt"));
  }
  /* 本机便捷位置（不写死用户名：用 os.homedir()） */
  out.push(path.join(os.homedir(), "dsh-tok.txt"));
  /* 工作区内的临时位置 */
  out.push(path.join(process.cwd(), ".test-token"));
  return out;
}

/**
 * 读测试实例的 token。
 * @returns {string|null} 读不到返回 null（调用方自己决定跳过还是失败）
 */
export function readTestToken() {
  /* ① 直接给了值 */
  if (process.env.DSH_TEST_TOKEN) return process.env.DSH_TEST_TOKEN.trim();

  /* ②③④ 按候选列表找文件 */
  for (const f of tokenFileCandidates()) {
    try {
      if (!fs.existsSync(f)) continue;
      const t = fs.readFileSync(f, "utf8").trim();
      if (t) return t;
    } catch { /* 读不到就试下一个 */ }
  }
  return null;
}

/** 测试实例端口。 */
export function testPort() {
  return Number(process.env.DSH_TEST_PORT ?? 19499);
}

/** 测试实例的 base URL。 */
export function testBase() {
  return `http://127.0.0.1:${testPort()}`;
}

/**
 * DSH 认证 cookie。
 *
 * ★ cookie 名带一段随机串（实测 dsh-auth-CK36o8O6fn6VWHrnbEp0bsjzKPKRmilHp-TBfPBH65k），
 *   每台机器不同 ⇒ 不能写死。允许用环境变量整体覆盖；
 *   否则按本机已知名拼。
 */
export function authCookie(token) {
  const name = process.env.DSH_AUTH_COOKIE_NAME
    ?? "dsh-auth-CK36o8O6fn6VWHrnbEp0bsjzKPKRmilHp-TBfPBH65k";
  return `${name}=${token}`;
}

/** 一次性取好，便于各脚本 import 后直接用。 */
export const TOKEN = readTestToken();
export const BASE = testBase();
export const PORT = testPort();

/**
 * 给脚本用的「拿不到 token 怎么办」。
 *
 * ★ 跳过 ≠ 失败。
 *   跳过 = 这条验收今天不适用（没有测试实例）
 *   失败 = 功能坏了
 *   混在一起会让「没起测试实例」显示成「功能坏了」。
 */
export function skipWithoutToken(scriptName) {
  console.log("");
  console.log(`  – 跳过 ${scriptName}：没有测试实例的 token`);
  console.log("     设以下任一即可运行：");
  console.log("       DSH_TEST_TOKEN=<token 值>");
  console.log("       DSH_TEST_TOKEN_FILE=<token 文件路径>");
  console.log("       DSH_HOME=<DSH home>（读 $DSH_HOME/.test-token）");
  console.log("");
  console.log("  通过 0 / 0（跳过）");
  process.exit(0);
}
