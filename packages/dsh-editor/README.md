# dsh-editor

DeepSeek Harness 的粗剪工作台：多轨时间轴、单段重跑、LLM 工具、SSE 实时同步。

## 这个插件做什么

一个「做完就能一条条看片、看到哪段不行当场改」的剪辑界面。核心是**每个片段记住自己是怎么生成的**，所以可以只重跑某一段，不动其他段。

- 时间轴：视频/音频分轨、加轨道、波纹删除、变速、单段裁剪、画面裁剪
- 单段操作：改提示词 → 重新生成（失败不毁旧成片）→ 替换成已有文件
- 音频：从视频分离原声到音频轨，可单独调音量/淡入淡出/静音
- 素材库：扫描目录、按种类/标签/关键字查、一键挂到片段
- 视觉反推：起草提示词 → 校验（结构段/标签/禁写参数）→ 回填
- 给 LLM 的工具：16 个，Agent 可以直接建分镜、生成、叫停、剪辑
- 前端与 Agent 落在同一个 store，SSE 实时同步，随时叫停

## 安装

```bash
# 1. 装插件
dsh plugin --profile web add dsh-editor

# 2. 装 ffmpeg（必需，用于剪辑与导出）
node node_modules/dsh-editor/scripts/install-ffmpeg.mjs

# 3. 重启
dsh web
```

`node scripts/install-ffmpeg.mjs` 会按顺序尝试：`FFMPEG_MIRROR` → npmmirror → GitHub → 本机 Python 环境（imageio_ffmpeg）。成功则写入 `bin/ffmpeg`。

也可以用已有 ffmpeg：设置 `FFMPEG_PATH=/path/to/ffmpeg`，或放进 `PATH`。

## 依赖

- **ComfyUI**（可选）：要走生成能力时需要，插件通过 `dsh-comfy-bridge` 的 HTTP 路由调用它。
  不装也能用时间轴、素材库、裁剪、导出这些本地能力。
- **ffmpeg**：必需。见上面的安装步骤。

## 配置

在 `cordis.patch.yml` 的插件条目里可以传：

| 字段 | 默认 | 说明 |
|---|---|---|
| `routePrefix` | `/timeline` | HTTP 路由前缀 |
| `comfyPrefix` | `/comfy-bridge` | ComfyUI 桥的路由前缀 |
| `outputDir` | `<cwd>/outputs` | 成片与缓存目录 |
| `pollMs` | `2000` | 任务轮询间隔 |
| `stateFile` | `<outputDir>/timeline-state.json` | 时间轴持久化文件 |
| `assetIndex` | `<outputDir>/assets.json` | 素材库索引 |
| `extraAllowedDirs` | `[]` | 额外允许预览的目录（绝对路径） |

## 开发

```bash
npm run build      # 构建 lib/client.js
npm test           # 跑全部验收
```

`src/` 下的模块职责：

| 文件 | 职责 |
|---|---|
| `host-store.mjs` | 权威状态（21 个操作入口） |
| `timeline.mjs` / `shot.mjs` | 时间轴模型 / 分镜数据 |
| `render.mjs` | 时间轴 → ffmpeg 命令 |
| `sse.mjs` | SSE 推送 + 5 个 GET 路由 |
| `commands.mjs` | 前端命令路由 |
| `tools-def.mjs` | LLM 工具定义 |
| `assets.mjs` | 素材库 |
| `reverse.mjs` | 视觉反推 |
| `audio-split.mjs` / `audio-edit.mjs` | 音画分离 / 音频编辑 |
| `preview.mjs` | 预览序列 |
| `persist-host.mjs` | 磁盘持久化 |
| `ffmpeg-resolver.mjs` | ffmpeg 定位 |
| `WorkbenchView.mjs` / `ClipEditor.mjs` | 界面 |

## 注意

- 时间轴状态存在 `outputDir/timeline-state.json`，重启后自动恢复。运行中的任务不会恢复（进程已退出），状态会标为 `cancelled`。
- 预览本地文件走 `/timeline/file?path=...`，只允许 `outputDir`、缓存目录、`extraAllowedDirs` 以及素材库登记过的文件。
- 单段重跑失败时旧成片会保留 —— 这是刻意的，不会因为一次失败就没有片子。

## License

MIT
