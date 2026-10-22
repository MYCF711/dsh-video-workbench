# v2026.10.21 · DSH 视频工作台

> 打包时间：2026-10-20 22:49（本机时间）
> 基线：资产库 875 项（`docs/基线-资产库-20261021.json`）
> 验收：**34 套全绿**（含 3 个真生成）

---

## 一 · 这个版本做完了什么

任务书五项（主人 2026-10-20 深夜定）全部落地：

| # | 任务 | 状态 | 关键证据 |
|---|---|---|---|
| 一 | H3 参考标签体系 | ✅ | 4 大 tag / 23 个用途 / 46 项映射测试 |
| 二 | @ 引用体验 | ✅ | 53 项逻辑 + 浏览器实测（@筛选/Tab/自动解绑） |
| 三 | 资产库项目文件夹 | ✅ | suggest-folder + 幽灵文件夹清理 + 浏览器实测 |
| 四 | 入库时改名 | ✅ | LLM 起名 + 规则降级 + 45 项资产库测试 |
| 五 | ArtCraft 融合 | ✅ | 42 项回归护栏 + 双流导出 ffprobe 验证 |

---

## 二 · 数得出来的量

```
源文件       81 个（4 个活跃包）
验收脚本     39 个（34 套登记进 verify-all）
文档         31 个（docs/）
AGENTS.md    62.9KB / 64KB 注入预算
```

### 代码包

| 包 | 职责 | 源文件 |
|---|---|---|
| `dsh-comfy-bridge` | host 侧：ComfyUI 桥 + bind 层 + HTTP 路由 | 27 |
| `dsh-comfy-workbench-tab` | 中栏 tab + 资产库 + @ 引用 | 32 |
| `dsh-artcraft-tab` | 时间轴 / 裁切 / 导出 | 12 |
| `dsh-comfy-preset` | Agent 预设 + 技能 | 2 |
| `dsh-device-monitor` | 已废弃（并入工作台） | 4 |

---

## 三 · 这一版新增的能力

### ① H3 标签跟着资产走（任务书一-3）

```
PNG 本体写 iTXt（UTF-8，中文不乱码）
  workbench_role / workbench_alias / workbench_folder
IDAT 字节级不变（实测 SHA256 前后一致）
读回优先级：json > PNG 本体
清空时两边一起清（dropAlso）
```

### ② 改用途即保存（任务书一-4）

```
编辑框改 chip 用途 → 立即写回资产库 → 下次 @ 它自动带上
三条路径都带 role：
  绑定槽位 / 持久化到 sessionStorage / 刷新后恢复
```

### ③ 判断项目归属（任务书三-1）

```
POST /comfy-assets/suggest-folder
  → LLM 从【已有候选】里选（不让它自由造名）
  → LLM 不可用 → 按文件名重合度做规则判断
  → 只建议，不自动写（主人的要求是「询问用户」）

前端：资产卡上的 ✨ 按钮 → 确认条「归到「X」[归入] [×]」
```

### ④ LLM 起名 + 降级（任务书四-1）

```
POST /comfy-assets/suggest-name
  → LLM 起中文名（≤12 字）
  → LLM 不可用 → 规则草稿，响应里带 llmError 说明原因

★ 流里的失败必须抛出来：
  {"type":"finish","reason":{"kind":"error","failure":{...}}}
  否则会把「认证失败」误报成「模型返回空文本」
```

---

## 四 · 验收基础设施（这一版补的）

之前只有「功能对不对」，这一版补上三个维度：

### ① 数据不被污染

`packages/verify-no-pollution.mjs` —— 元验收

```
跑 verify-all 前后各取一次资产库快照，比对 6 个字段：
  id + displayName + role + folder + fav + renamed
已有资产字段被改 = 污染（退出 1）
变异测试：手动改一个 displayName → 正确报 ❌
```

### ② 环境无残留

```
output/ 和 input/ 跑前跑后各记一次快照
跑完对比，删掉本次新增（只删新增，绝不碰已有文件）
实测：跑前 output 760/input 129 → 跑后 760/129
```

### ③ 幽灵数据清理

```
asset-library.json 的 folder 表原来有 8 条，其中 7 条指向已删文件
⇒ 项目归属的候选列表里全是幽灵
修：pruneFolderOrphans(aliveIds)，在 /library 里 5 分钟节流调用
实测：8 条 → 1 条（只留有活资产在用的）
```

---

## 五 · 已知限制（写清楚，别当成已修）

| 项 | 状态 |
|---|---|
| LLM 起名 / 项目归属的 AI 路径 | **不可用** —— 本机 DeepSeek API key 失效（`****G1hB` → 401 AUTH）。规则降级路径正常工作 |
| `pruneFolderOrphans` 的启动时清理 | 已定义，实际在 `/library` 路由里调用（5 分钟节流），非启动时 |
| 画布模块的 lightbox / 平移 / 缩放 | **未做浏览器自动化验证** —— 证据是截图 + console 读数，不要当成已验证 |
| ArtCraft 的 cloud fal/grok/sora | **明确不做**（主人定的范围） |

---

## 六 · 怎么跑起来

```powershell
# 起测试实例（不动主人的 19387）
pwsh -NoProfile -File C:\Users\Administrator\restart-test2.ps1

# 总验收（含真生成，约 5-8 分钟）
cd D:\主工作区\DSH视频工作台\packages
node verify-all.mjs

# 只跑离线检查（约 1 分钟）
node verify-all.mjs --static

# 元验收（验收本身不污染数据、不留残留）
node verify-no-pollution.mjs
```

---

## 七 · 踩坑记录

全部记在 `AGENTS.md`（62.9KB，46 节），细节按主题拆到 `docs/踩坑-*.md`：

```
踩坑-误判-20261021.md              9KB   「我没找到」≠「不存在」
踩坑-画布资产库-20261018.md        4.8KB 六个静默失效
踩坑-输入校验-20261019.md                 黑名单失效 → 白名单
踩坑-跨模块状态字段-20261019.md      3.2KB 生产方产出、消费方没接
踩坑-控件是摆设-20261019.md          2.9KB 控件启用 ≠ 数据会传
踩坑-ArtCraft融合-20261021.md               八个静默失效
```

### 最值钱的三条判据

```
① 「我没找到」是观测，「不存在」是推论 —— 中间必须换一种方法再验
② 一个字段有 N 条构造路径，只修报错那条 = 没修
③ 保存/读回、写入/消费、写/删 —— 都必须成对验证
```
