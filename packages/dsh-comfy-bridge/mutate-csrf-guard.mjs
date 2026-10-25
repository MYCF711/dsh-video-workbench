/**
 * 变异测试：verify-csrf-guard.mjs 是否真的会变红
 *
 * 纪律：一个验收脚本「通过」不算证据，
 *   必须证明「把被测代码改坏 ⇒ 它真的报错」才算。
 *
 * 每个变异：备份 → 注入缺陷 → 跑验收 → 必须非 0 → 还原。
 * 锚点全部用不含中文、不含换行转义的短字符串。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "src", "index.js");
const BAK = SRC + ".mutant-bak";

const MUTANTS = [
  {
    name: "同源判定永远 false（跨站全放行）",
    from: "  return originHost !== reqHost;",
    to: "  return false;",
  },
  {
    name: "忽略 Sec-Fetch-Site 信号",
    from: 'if (site === "cross-site") return true;',
    to: 'if (site === "impossible") return true;',
  },
  {
    name: "Origin: null 放行",
    from: 'if (origin === "null") return true;',
    to: 'if (origin === "null") return false;',
  },
  {
    name: "写死 localhost 白名单（局域网被误挡）",
    from: "  return originHost !== reqHost;",
    to: '  return !/^(localhost|127\.0\.0\.1)(:|$)/.test(originHost);',
  },
  {
    name: "去掉 handler 里的跨站拦截",
    from: "if (rejectCrossSite(req, res)) return;",
    to: "/* guard removed */",
  },
  {
    name: "ws.register 里递归调自己",
    from: "        return ctx.webServer.register({",
    to: "        return ws.register({",
  },
  {
    name: "新增一条裸路由（绕过 guard）",
    from: "      const disposers = [];",
    to: '      ctx.webServer.register({ kind: "exact", path: prefix + "/oops", handler: async () => {} });\n      const disposers = [];',
  },
];

let caught = 0;
const total = MUTANTS.length;

console.log("\n=== 变异测试：verify-csrf-guard.mjs ===\n");

for (const m of MUTANTS) {
  fs.copyFileSync(SRC, BAK);
  try {
    const before = fs.readFileSync(SRC, "utf8");
    if (!before.includes(m.from)) {
      console.log(`  !! ${m.name}`);
      console.log("     锚点不存在（源码形状变了）—— 未验证");
      continue;
    }
    fs.writeFileSync(SRC, before.split(m.from).join(m.to), "utf8");

    let red = false;
    try {
      execFileSync(process.execPath, ["verify-csrf-guard.mjs"], {
        cwd: HERE, stdio: "pipe", timeout: 60_000,
      });
    } catch {
      red = true;
    }
    if (red) {
      caught++;
      console.log(`  OK 变红：${m.name}`);
    } else {
      console.log(`  NG 仍然绿：${m.name}   <- 验收有盲区`);
    }
  } finally {
    fs.copyFileSync(BAK, SRC);
    fs.unlinkSync(BAK);
  }
}

console.log(`\n${caught} / ${total} 个缺陷被抓住\n`);
process.exit(caught === total ? 0 : 1);
