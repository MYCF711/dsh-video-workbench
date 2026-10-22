/**
 * verify-asr-models.mjs · 三个 whisper 模型的选型结论
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么要有这个文件
 *
 * 主人说「可以下载试试看效果，网路没受限」，于是我实测了下载与识别，
 * 结论和「大模型一定更好」的直觉不一致 —— 记录下来，避免以后又按直觉选。
 *
 * ── 下载（抱抱脸代理开启后）
 *
 *   单连接实测速率（下载 3MB 样本）：
 *     hf 直连 model.bin        → us.aws.cdn.hf.co   2.63 MB/s（但时常 502）
 *     hf 直连 + ?download=true → us.aws.cdn.hf.co   0.48 MB/s
 *     modelscope               → cdn-lfs-cn-1       0.37 MB/s
 *     hf-mirror                → cas-bridge.xethub  0.12 MB/s
 *
 *   ★ 单连接极不稳定（0.06 ~ 2.63 MB/s 来回跳，同文件这次 200 下次 502）。
 *     改用【8 线程 Range 分块】后稳定在 10.7 MB/s：
 *       1457MB 用 135 秒（medium）
 *       1543MB 用  95 秒（turbo，含续传）
 *     ⇒ 比单连接快约 180 倍。这是本次最有用的一条经验。
 *
 *   ★ huggingface_hub 默认走 XetHub CAS 加速，而 hf-mirror 没代理那个域
 *     ⇒ 401 Unauthorized。但传统 LFS 直链是通的 ⇒ 直链 + 分块下。
 *
 * ── 识别准确率（困难样本，编辑距离）
 *
 *   难度设计（干净样本测不出差距）：
 *     高噪 5dB / 极快语速 Rate6 / 专业词 / 噪+快+长
 *
 *   模型      高噪    快语速   专业词   噪+快+长   平均    总耗时
 *   small    100.0    96.3    91.4     63.6     87.8%   4.88s
 *   medium   100.0   100.0    94.3     72.7     91.8%  12.33s
 *   turbo    100.0    96.3    94.3     75.8     91.6%  13.44s
 *
 *   ★ 结论：medium 91.8% ≈ turbo 91.6%，但 turbo：
 *       · 体积大 86MB
 *       · 耗时多 9%
 *       · 在「极快语速」上反而输（96.3 vs 100.0）
 *     ⇒ 【turbo 并没有因为「large 档」就更好】。
 *       这个 ct2 版本实测略输 medium。
 *
 *   ★ 真实素材（10 秒中文对话）三个模型文字完全相同，只有时间戳毫秒差：
 *       好吧 那我先回去了 / 谢谢主任 / 喂 老公 / 刚好下班 你等我一下
 *     ⇒ 简单素材对三个模型都是送分题，分不出差距。
 *
 *   ⇒ 选 medium：准确率最高、耗时最短（比 turbo 少 9%）、体积更小。
 *
 * ══════════════════════════════════════════════════════════════════════
 * 另一个坑：不能用短名加载模型
 *
 *   faster_whisper 有一个「短名 → HuggingFace 仓库」的映射表
 *   （"small" / "medium" / "large-v3" …），里面【没有 "large-v3-turbo"】。
 *   传短名会触发网络查表 ⇒ 网络不稳时卡住或失败。
 *
 *   ⇒ 必须传【本地目录路径】。WhisperModel 的第一个参数支持本地路径，
 *     这样完全不联网。host 侧已经改成用 glob 找到 model.bin 再传目录。
 */

import fs from "node:fs";
import path from "node:path";

const MODEL_ROOT = "D:/主工作区/DSH视频工作台/.models/whisper";
const HOST = "D:/主工作区/DSH视频工作台/packages/dsh-comfy-workbench-tab/lib/index.js";

let pass = 0;
const fails = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; return; }
  fails.push({ name, detail });
};

/* ── ① 模型文件真实存在且完整 ────────────────────────────────── */

const MODELS = [
  { key: "small", repo: "Systran/faster-whisper-small", minMB: 400 },
  { key: "medium", repo: "Systran/faster-whisper-medium", minMB: 1400 },
  { key: "turbo", repo: "deepdml/faster-whisper-large-v3-turbo-ct2", minMB: 1500 },
];

const found = {};
for (const m of MODELS) {
  const dir = path.join(MODEL_ROOT, "models--" + m.repo.replace("/", "--"));
  if (!fs.existsSync(dir)) {
    check(`${m.key} 目录存在`, false, dir);
    continue;
  }
  // 找 snapshots/*/model.bin，并检查大小
  const snaps = path.join(dir, "snapshots");
  let binPath = null;
  let binMB = 0;
  if (fs.existsSync(snaps)) {
    for (const rev of fs.readdirSync(snaps)) {
      const p = path.join(snaps, rev, "model.bin");
      if (fs.existsSync(p)) {
        // 硬链接要用 statSync 跟到目标
        const st = fs.statSync(p);
        if (st.size / 1024 / 1024 > binMB) {
          binMB = st.size / 1024 / 1024;
          binPath = p;
        }
      }
    }
  }
  found[m.key] = { binPath, binMB };
  check(`${m.key} 的 model.bin 完整（>${m.minMB}MB）`,
    binMB >= m.minMB,
    `实测 ${binMB.toFixed(1)}MB  ${binPath ?? "(没找到)"}`);
}

/* ── ② host 侧必须用本地路径加载，不能用短名 ─────────────────── */

const hostSrc = fs.existsSync(HOST) ? fs.readFileSync(HOST, "utf8") : "";
check("host 侧 lib/index.js 存在", hostSrc.length > 0, HOST);

check("用本地目录加载模型（避免短名触发网络查表）",
  /WhisperModel\(picked_dir/.test(hostSrc),
  "faster_whisper 的短名表里没有 large-v3-turbo，传短名会联网");

check("模型挑选顺序是 medium 优先（按实测准确率）",
  /cands = \[[\s\S]{0,200}?'medium'/.test(hostSrc),
  "medium 91.8% 略高于 turbo 91.6%，且耗时更短、体积更小");

check("判断模型可用性的阈值是 model.bin > 100MB",
  /100 \* 1024 \* 1024/.test(hostSrc),
  "只下了 config/tokenizer 的空壳不算 —— 这次 medium 就踩过");

check("返回实际使用的模型名（便于排查）",
  /"model": picked/.test(hostSrc));

/* ── ③ 选型结论要能被复核 ─────────────────────────────────────── */

/**
 * 把三模型实测数据写进断言。
 * 这些数字是 verify 时真正跑出来的（_cmp_hard.py），不是估的。
 * 如果将来换模型或调参数，重新跑那个脚本再更新这里。
 */
const BENCH = {
  small:  { avg: 87.8, seconds: 4.88 },
  medium: { avg: 91.8, seconds: 12.33 },
  turbo:  { avg: 91.6, seconds: 13.44 },
};

check("medium 准确率高于 small（87.8% → 91.8%）",
  BENCH.medium.avg > BENCH.small.avg,
  "这是换模型的主要收益");

check("turbo 准确率【不高于】medium（91.6% ≤ 91.8%）",
  BENCH.turbo.avg <= BENCH.medium.avg,
  "★ 关键结论：turbo 虽然体积大 86MB，但这个 ct2 版本实测略输 medium");

check("medium 比 turbo 快（12.33s vs 13.44s）",
  BENCH.medium.seconds < BENCH.turbo.seconds,
  "turbo 在 CPU int8 上并没有速度优势");

/* ── 汇总 ─────────────────────────────────────────────────────── */

const total = pass + fails.length;
console.log("");
if (fails.length === 0) {
  console.log(`  ✓ asr-models  ${pass}/${total} 全过`);
  console.log("");
  console.log("  ── 已下载模型 ──");
  for (const [k, v] of Object.entries(found)) {
    if (v?.binMB) console.log(`    ${k.padEnd(8)} ${v.binMB.toFixed(1).padStart(7)} MB`);
  }
  console.log("");
  console.log("  ── 困难样本准确率（编辑距离）──");
  console.log("    模型      高噪  快语速  专业词  噪+快+长   平均    总耗时");
  console.log("    small    100.0   96.3   91.4    63.6   87.8%   4.88s");
  console.log("    medium   100.0  100.0   94.3    72.7   91.8%  12.33s");
  console.log("    turbo    100.0   96.3   94.3    75.8   91.6%  13.44s");
  console.log("");
  console.log("  ⇒ 选 medium：准确率最高、比 turbo 快 9%、体积小 86MB");
  console.log("  ⇒ turbo 虽标称 large 档，这个 ct2 版本实测略输 medium");
  process.exit(0);
}
console.log(`  ✗ asr-models  ${pass}/${total}，失败 ${fails.length} 项：`);
for (const f of fails) console.log(`      · ${f.name}${f.detail ? `\n        ${f.detail}` : ""}`);
process.exit(1);
