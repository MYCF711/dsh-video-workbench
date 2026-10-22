# v2026.10.23-g · dsh-editor 并入 + 四个真 bug

> 打包：2026-10-23 05:42
> 归档：`D:\主工作区\_branch-archive\DSH视频工作台-v2026.10.23-g-20261023-054207.zip`（51.5MB，含 ffmpeg 83.58MB 压缩后）
> 源码备份：`merge-backup-20261023-054207`
> 上一版：`VERSION-v2026.10.23-f.md`

---

## 一 · 验收

| 项 | 结果 |
|---|---|
| `verify-all.mjs --static` | **56 / 56** |
| `verify-assets.mjs` | **46 / 46**（从 42/45 修正） |
| `verify-editor-console.mjs` | 145 / 145 |

---

## 二 · 合并结构

`packages/` 现在是 4 个自包含包：

```
dsh-comfy-bridge          M1   ComfyUI 桥 + 路径配置 + 模型清单
dsh-comfy-workbench-tab   M2   视频工作台 tab + 剪辑台 tab（client）
dsh-editor                    时间轴宿主（host）：/timeline/*
dsh-video-knowledge           提示词规则（被 dsh-editor 引用）
```

**依赖链**：`dsh-editor` → `dsh-video-knowledge`（相对路径 `../../dsh-video-knowledge`），
两包现在都在同一个 `packages/` 下，相对引用天然成立。

**profile 依赖**全部指向本仓：
```json
"dsh-editor": "link:D:/主工作区/DSH视频工作台/packages/dsh-editor"
"dsh-video-knowledge": "link:D:/主工作区/DSH视频工作台/packages/dsh-video-knowledge"
```

---

## 三 · 四个真 bug（全部实测定位）

### 3.1 ★ `new URL(import.meta.url).pathname` 不解码中文路径

```js
// 错
const HERE_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
```

`.pathname` **不做 percent-decoding**。包放在 `D:\主工作区\DSH视频工作台\...` 时得到：

```
D:\%E4%B8%BB%E5%B7%A5%E4%BD%9C%E5%8C%BA\DSH%E8%A7%86%E9%A2%91...\outputs
```

实测诊断输出：
```
[DIAG] outDir=D:\%E4%B8%BB%E5%B7%A5...\outputs  al={"ok":false,"reason":"没有索引文件"}
```

**后果链**：`pickOutDir()` 的候选目录全不存在 → 返回 `cands[0]`（不存在的目录）
→ `assets.json` 读不到 → `/timeline/assets` 恒为 0
→ 资产库 `src=editor` 恒 0 条 → 3 条验收失败。

**修法**：`fileURLToPath(import.meta.url)`（内部做 percent-decoding）。

★ 判据：**URL 转本地路径只有 `fileURLToPath` 一种正确方式。**
  `.pathname` 只适合 URL 内部处理。纯 ASCII 路径下两者结果相同，所以这个 bug
  会一直潜伏到第一个中文路径。

### 3.2 ffmpeg 默认值简化过头 → PATH 里没有

去敏时我把 `FFMPEG` 简化成 `process.env.FFMPEG_PATH ?? "ffmpeg"`。
但**本机 PATH 里没有 ffmpeg**：

| 位置 | 存在 |
|---|---|
| `PATH` | ❌ |
| `dsh-editor/bin/ffmpeg.exe` | ✅ |
| `imageio-ffmpeg` 二进制 | ✅ |

**后果**：`hasAudioStream()` 恒返回 `false`
→ 转写接口报「这段视频没有音轨」（而视频明明有音轨，实测 `Stream #0:1 Audio: aac`）
→ 衔接质检 32/32 掉到 18/32、字幕 35/35 全红。

**修法**：四级回落 `FFMPEG_PATH → dsh-editor/bin → imageio-ffmpeg → "ffmpeg"`。

★ 判据：**去敏不能只删硬编码，必须同时提供可用的回落链。**
  「删掉了」和「能找到」是两件事。

### 3.3 合并漏了 `dsh-video-knowledge`

`dsh-editor` 的 `prompt-gate.mjs` / `reverse.mjs` 相对引用
`../../dsh-video-knowledge/src/verify-rules.mjs`。

只复制 `dsh-editor` 时，`dsh-editor: failed to import`。

**修法**：把 `dsh-video-knowledge`（40KB）一起并入。

★ 判据：**搬包时先跑一次 `node -e "import('./lib/index.js')"`**，
  它会立刻暴露所有缺失的跨包依赖。比等运行时 404 快得多。

### 3.4 测试文件里的硬编码

5 个测试文件写死了本机素材路径，改成环境变量：

```js
const SRC = process.env.EVIDENCE_VIDEO ?? "";
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
```

★ 副作用：`const SRC2 = ...` 被我的批量替换误改成 `const SRC`，
  产生重复声明。已修正 —— **批量正则替换后必须 `node --check` 逐个验证。**

---

## 四 · 清理

| 项 | 数量 |
|---|---|
| `.bak*` 文件 | 19 个 |
| `node_modules` | 排除 |
| `outputs`（数据） | **保留**（含 529 条 assets.json） |
| `bin/ffmpeg.exe` | **保留**（83.58MB，运行必需） |

---

## 五 · 可移植性状态

| 项 | 状态 |
|---|---|
| bridge 硬编码路径 | ✅ 已清 |
| workbench-tab `asset-scan.js` 硬编码 | ✅ 已清（改读 config.json） |
| dsh-editor 硬编码 | ✅ 已清（URL 解码 bug 也在此修复） |
| ffmpeg | ✅ 四级回落，包内自带 |
| 路径配置 | ✅ 设置页可填、持久化 |
| 模型清单 | ✅ 自动生成 |
| `link:` 绝对路径 | ⚠️ 仍在 profile 配置里（**这是 profile 的事，不是包的事**） |

**结论：包本身已经自包含。** 换个 profile 只要写 4 行 `link:` 指向本仓即可，
不再需要「先克隆另一个仓库」。

---

## 六 · 下一步

| 项 | 状态 |
|---|---|
| README + 安装说明 | **未做** |
| 一键安装脚本 | **未做** |
| GitHub 私密仓库 | **未做** |
| `.gitignore`（排除 .models/.frames/outputs） | **未做** |
