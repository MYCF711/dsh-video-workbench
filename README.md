# DSH 视频工作台

把「视频工作站」做成 DeepSeek Harness 插件：**生成走本机 ComfyUI，剪辑在 DSH 内完成**。

对标 YUH Studio 的创作链路（角色卡 / 分镜 / 逐镜生成 / 首尾帧衔接 / 拼接），全部跑在 DSH 里。

---

## 一 · 它是什么

四个模块，装进 DSH 后中栏多出两个 tab：

| tab | 干什么 |
|---|---|
| **视频工作台** | 写提示词、选参数、提交 ComfyUI 生成、看产物 |
| **剪辑台** | 多轨时间轴、预览、分割/复制/粘贴、字幕、导出成片 |

加一个设置页：填 ComfyUI 路径、看模型清单、一键启停 ComfyUI。

### 三个工作流，三个职责，不混用

```
krea2         → 生图（文生图 + 双采精修）
qwen21-edit   → 改图 / 洗图 / 生骨骼图 / 换装
yz            → 生视频（H3 文武双全）
```

---

## 二 · 装之前需要什么

| 依赖 | 说明 |
|---|---|
| **DeepSeek Harness** | 桌面端。插件挂在它的 Web GUI 上 |
| **Node.js ≥ 22** | 插件用 ESM，宿主会加载 `.mjs` |
| **ComfyUI** | 本机安装，默认 `127.0.0.1:8188` |
| **模型** | 见下面的清单。**这是最大的门槛** |
| **ffmpeg** | 剪辑台导出 / 字幕 / 抽帧必需。**不进 git**（83MB），装法见 §3.2 |

### 模型清单（会自动检查）

插件会从工作流反推需要哪些模型，在设置页逐个标「已找到 / 缺失」。

当前工作流声明了 **26 个**模型引用，其中必须的大件：

| 模型 | 用途 | 大约 |
|---|---|---|
| `Krea2-moodyKrea2Mix_v8_int8_convrot.safetensors` | Krea2 主模型（生图） | 大 |
| `qwen_image_2.1_int8_convrot.safetensors` | Qwen 主模型（改图） | 大 |
| `qwen3vl_4b_fp8_scaled.safetensors` | Qwen 视觉编码器 | 中 |
| `qwen_image_vae.safetensors` | VAE | 小 |
| `seedvr2_7b_int8_convrot.safetensors` | 放大模型 | 大 |
| `OmniSR_X4_DIV2K.safetensors` | 超分 | 小 |
| H3 系列（多个） | 生视频主模型 + LoRA | **很大**（19.5GB 主模型） |

★ **完整的清单不写在文档里** —— 它会随工作流变化。
  装好后打开 **设置 → ComfyUI 与环境 → 体检**，那里是唯一准确的清单。

★ H3 主模型 19.5GB，RTX 5070 Ti（16GB）跑之前需要先卸模型释放显存。
  插件里已有对应逻辑，但这是硬件现实，不是能绕过的。

---

## 三 · 安装

### 3.1 装 ComfyUI

自己按官方方式装。插件不代装。

### 3.2 装 ffmpeg（**必做**）

ffmpeg 有 83MB，被 `.gitignore` 排除了 —— **clone 下来的人没有它，导出功能会直接报错。**

```bash
node scripts/install-ffmpeg.mjs            # 下载到 packages/dsh-editor/bin/
node scripts/install-ffmpeg.mjs --check    # 只检查，不下载
```

装好后自检：
```bash
packages/dsh-editor/bin/ffmpeg.exe -version
```

★ 不想下载也行：设 `FFMPEG_PATH` 环境变量指向你已有的 ffmpeg。
  运行时的回落顺序是 `config.ffmpegPath → FFMPEG_PATH → 包内 bin → imageio-ffmpeg → PATH`。

### 3.3 装插件

**方式 A：一键脚本**（本地已有仓库时最省事）

```powershell
cd <这个仓库>
pwsh -NoProfile -File .\install.ps1 -Profile <你的profile>
```

它会做四件事并逐项打印结果：

```
① 找到 DSH_HOME 与 profile 目录
② 在 profile 的 package.json 里写入 4 个 link: 依赖
③ 在 dsh.profile.bundles 里追加 3 个包（dsh-video-knowledge 不进 bundles）
④ 建 node_modules 软链
```

**方式 B：从 GitHub 装**

```bash
dsh plugin --profile <你的profile> add github:<owner>/<repo>
```

**方式 C：手工改 profile**

```jsonc
// <DSH_HOME>/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-comfy-bridge":         "link:D:/path/to/DSH视频工作台/packages/dsh-comfy-bridge",
    "dsh-comfy-workbench-tab":  "link:D:/path/to/DSH视频工作台/packages/dsh-comfy-workbench-tab",
    "dsh-editor":               "link:D:/path/to/DSH视频工作台/packages/dsh-editor",
    "dsh-video-knowledge":      "link:D:/path/to/DSH视频工作台/packages/dsh-video-knowledge",
    "dsh-comfy-preset":         "link:D:/path/to/DSH视频工作台/packages/dsh-comfy-preset"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-comfy-bridge",
        "dsh-comfy-workbench-tab",
        "dsh-editor"
      ]
    }
  }
}
```

★ `dsh-video-knowledge` 只作依赖、不进 bundles（它没有插件入口）。

★ **`dsh-comfy-preset` 必须装**，否则技能不加载 ——
  对话框里的 LLM 不知道该选哪个工作流、也不知道有 `comfy_workbench_fill`，
  「说一句话 → LLM 写提示词 → 填进工作台」这条懒人路径整个失效。
  它也是**不进 bundles** 的（属 agentPreset 类型），
  装完还要在 DSH 的「Agent 预设」里选中它才生效。
  ★ 实测踩过：`install.ps1` 的包清单里漏了它，
    结果测试 profile 的预设列表只有 standard / ptc / minimal / cordis 四个内置。

★ 那 5 个 `link:` **必须**是绝对路径 —— profile 与仓库不在同一个
workspace 里，写成相对路径（`link:../../../...`）任何一边移动就断。
`install.ps1` 会按当前仓库位置自动生成，不用手算。

#### 装完怎么确认装对了

**别只看「有没有报错」** —— 跑一遍自检：

```powershell
cd packages
node verify-all.mjs --static
```

期望：`99 / 99`，全部通过。

（这个数字由 `packages/tools/verify-readme-consistency.mjs` 保证与
`verify-all.mjs` 的实际步数一致 —— 每加一个验收它就会提醒改这里。）

#### 3.3.1 构建客户端产物（**必做**，否则宿主启动会崩）

`dsh-comfy-workbench-tab` 声明了 `dsh.client`，而按 DSH 的规则
**声明了就必须有 `lib/client.js`，缺失会让整个宿主崩溃**
（不是「跳过这个插件」）。

这个文件**不在仓库里** —— 原因见 [§ 关于第三方组件](#关于第三方组件)：
它内联了 ArtCraft 的 base64 payload，而 ArtCraft 上游未声明许可协议。

所以从本仓库装的第一次，必须先构建：

```powershell
cd packages/dsh-comfy-workbench-tab
npm install          # 装 esbuild（devDependency）
node build.mjs       # 生成 lib/client.js
```

看到这个就算成功：

```
  ✓ lib/client.js  11383.5 KB
```

★ `npm install` 若报 `EPERM mkdir 'D:\'`，是中文路径下 npm 解析 prefix 出错，
改用：`npm install esbuild --no-save --prefix . --no-package-lock`

★ 剪辑台还需要额外的 ArtCraft 产物（可选，没有则只有剪辑台降级）：

```powershell
pwsh -NoProfile -File ./scripts/fetch-artcraft.ps1
```

### 3.4 填路径（**必做，否则跑不起来**）

插件**不内置任何本机路径**。启动后：

1. 点左下角 **设置**
2. 左侧选 **ComfyUI 与环境**
3. 填三项：

| 字段 | 填什么 |
|---|---|
| ComfyUI 安装目录 | 含 `ComfyUI\main.py` 与 `ComfyUI\.venv\Scripts\python.exe` 的目录 |
| 输出目录 | 产物写哪。留空用 `<ComfyUI>\output`。**建议显式填** |
| 输入目录 | 上传素材写哪。留空用 `<ComfyUI>\input` |

4. 点 **保存** → **体检**

体检会告诉你：ComfyUI 通不通、版本、缺哪些模型、该放到哪个子目录。

### 3.5 启动 ComfyUI

两个办法：

- **用插件**：底部状态栏有一个 `ComfyUI` 圆点。红点 = 未连接，点一下启动；绿点 = 已连接，点一下关闭
- **自己启动**：只要 `127.0.0.1:8188` 通就行

★ 长时间不用建议关掉，省设备损耗。

---

## 四 · 架构

```
┌─────────────────────────────────────────────────────────┐
│ 浏览器侧（client）                                        │
│   dsh-comfy-workbench-tab                                │
│     ├─ 视频工作台 tab   conversation.view                │
│     └─ 剪辑台 tab       conversation.view                │
│          └─ dsh-editor 的时间轴（通过 props/API 驱动）     │
└──────────────────┬──────────────────────────────────────┘
                   │ HTTP（同源）
┌──────────────────▼──────────────────────────────────────┐
│ 宿主侧（host, Node）                                       │
│   dsh-comfy-bridge    /comfy-bridge/*                    │
│     ├─ 工作流 bind 层（运行时输入，不写死节点 id）           │
│     ├─ WebSocket 进度总线                                 │
│     ├─ 路径配置 + 模型清单                                 │
│     └─ ffmpeg 能力（抽帧 / 衔接质检 / 字幕）                │
│   dsh-editor          /timeline/*                         │
│     ├─ 时间轴权威状态 + SSE                                │
│     ├─ LLM 工具（Agent 操控时间轴）                        │
│     └─ 导出（时间轴 → ffmpeg 一次成片）                     │
└──────────────────┬──────────────────────────────────────┘
                   │ HTTP / WebSocket
┌──────────────────▼──────────────────────────────────────┐
│ ComfyUI  127.0.0.1:8188                                 │
└─────────────────────────────────────────────────────────┘
```

### 两条重要的架构事实

**① host 与 client 是两棵独立的 cordis 树。**
`ctx.provide()` 跨不过进程边界。所以 M1（bridge）必须用
`ctx.webServer.register()` 暴露 HTTP 路由，M2（UI）用 `fetch` 调。

**② ComfyUI 的 WebSocket `progress` 是定向发送的。**

```python
# ComfyUI main.py:464
server_instance.send_sync("progress", progress, server_instance.client_id)
```

第三个参数是 target sid ⇒ 只发给那一个 socket。
所以建 WebSocket 时必须带 `?clientId=<与提交任务时相同的值>`。
不带的话只收得到 `status`，永远收不到 `progress`。

---

## 五 · 开发

### 构建

```bash
# 只改了 client 侧（UI）
cd packages/dsh-comfy-workbench-tab
node build.mjs

# 改了 host 侧（*.mjs）—— 无需构建，直接重启实例
```

### 验收

```bash
cd packages

# 全部（会真跑 ComfyUI，约 5 分钟）
node verify-all.mjs

# 只跑不碰 ComfyUI 的静态检查
node verify-all.mjs --static
```

### 单独跑某个模块

```bash
cd packages/dsh-comfy-workbench-tab
node verify-editor-console.mjs    # 剪辑台 145 项
node verify-assets.mjs            # 资产库 46 项

cd packages/dsh-comfy-bridge
node verify-m1.mjs                # 桥与工作流
node verify-subtitle.mjs          # 字幕
```

### 变异测试是必须的

每条新断言都要验「改坏代码它会不会变红」。没做过变异测试的断言，
很可能是个永远绿的空断言。

```bash
# 例：把某条 CSS 改坏，确认断言变红
# 断言太松 → 假绿（坏代码通过）
# 断言太紧 → 假红（好代码失败）
# 两个都要防
```

---

## 六 · 已知限制

| 项 | 状态 |
|---|---|
| 剪辑台底座 | OpenCut（`opencut-wasm`）+ `@storyteller/ui-video-editor` 改编版 |
| **授权** | **OpenCut 主仓是 AGPL-3.0，分发前必须确认授权状态** |
| 复制粘贴 | 用模块内存剪贴板，**不用系统剪贴板**，刷新即丢 |
| 实时进度 | 依赖 ComfyUI WebSocket；ComfyUI 离线时显示「无法判断」，不误报 0% |
| H3 显存 | 主模型 19.5GB > 16GB 显存，需要卸载其他模型 |
| 配置存放 | 优先 `COMFY_BRIDGE_CONFIG_DIR`；否则用 `DSH_PROFILE_DIR`（**可能属于别的 profile**），设置页会提示 |

---

## 七 · 排障

### tab 不出现

**先看这一条：空会话不渲染 tab。**

DSH 的 `conversation.view` 标签条**只在「有消息的会话」里渲染**。
新建的空会话，或者初次打开 DSH 时，中栏只有「空面板」——
这时候看不到 视频工作台 / 剪辑台 **是正常的**，不是装坏了。

判据（浏览器控制台里跑）：

```js
Array.from(document.querySelectorAll('[role="tablist"]')).length
// 1 → 只有「空面板」，当前没有打开有消息的会话
// 2 → 第 1 个是会话视图（对话 / 轨迹 / 视频工作台 / 剪辑台）
```

正确验证方式：**点开左侧任意一个「有历史消息」的会话**，等 12~15 秒
（插件 bundle 有 22MB，首次加载慢），再跑上面那行 —— 应该是 2。

> 2026-10-23 实测：同一 profile，新建空会话 tablist=1、四个 tab 一个不见；
> 点开历史会话 tablist=2、四个 tab 全在、视频工作台与剪辑台功能都正常。
> 我曾因此连续三轮误判「安装脚本有缺陷」，实际安装没问题。

确认不是上面这条之后，再看**跨包依赖是否打包完整**：

```bash
node -e "import('./packages/dsh-editor/lib/index.js').then(m=>console.log('OK:',Object.keys(m))).catch(e=>console.log('FAIL:',e.message))"
```

打包时最容易漏的是**跨包依赖**。上面这条命令会立刻暴露。

### 路径含中文时什么都不能用

检查有没有人还在用 `new URL(import.meta.url).pathname` ——
它**不做 percent-decoding**，中文路径会变成 `%E4%B8%BB...`。
必须用 `fileURLToPath()`。

### 资产库空 / 剪辑台看不到素材

```bash
# 看 assets.json 在哪
node -e "console.log(require('node:path').resolve('packages/dsh-editor/outputs/assets.json'))"
```

`pickOutDir()` 会按 `WORKSPACE_ROOT/outputs` → `PKG_DIR/outputs` → `cwd/outputs` 找
第一个含 `timeline-state.json` 的目录。找错就会「有数据但看不到」。

### ffmpeg 找不到

```
FFMPEG_PATH 环境变量 → dsh-editor/bin/ffmpeg.exe → imageio-ffmpeg → PATH
```

四级都失败时导出和字幕会报错。装一份到 `packages/dsh-editor/bin/` 即可。

---

## 八 · 目录

```
packages/
├── verify-all.mjs                一键总验收
├── dsh-comfy-bridge/             M1  host 侧桥
│   ├── src/*.mjs
│   ├── workflows/*.json + *.bind.json
│   └── verify-*.mjs
├── dsh-comfy-workbench-tab/      M2  中栏两个 tab
│   ├── src/                      可读源码
│   ├── lib/                      实际加载（client.js IIFE + index.js ESM）
│   └── verify-*.mjs
├── dsh-editor/                   时间轴宿主
│   ├── src/*.mjs
│   ├── lib/index.js
│   └── test/
└── dsh-video-knowledge/          提示词规则（被 dsh-editor 引用）
```

---

## 九 · 许可

本项目自身的代码是 **MIT**，全文见仓库根的 [`LICENSE`](./LICENSE)。

### 关于第三方组件

这个仓库**不含** ArtCraft 引擎（`@storyteller/ui-video-editor`）的代码 ——
这一点与常见项目不同，需要说清楚：

| 项 | 状态 |
|---|---|
| ArtCraft 上游许可 | ⚠ **未声明任何协议** |
| 未声明 = | 默认「版权保留（All Rights Reserved）」 |
| 因此 | 不能在没有明确许可的情况下再分发它的代码 |
| 本仓库的做法 | **不含**它的源码与构建产物 |

具体地：

- `src/editor/_artcraft-payload.js` 只是一个占位符（`export default ""`）
- `lib/client.js` 不在仓库里（它内联了 ArtCraft 的 base64 payload）
- `.gitignore` 排除了这两者

需要剪辑台功能的，自行获取并构建，产物留在本地：

```powershell
pwsh -NoProfile -File ./scripts/fetch-artcraft.ps1
```

★ **没有 ArtCraft 产物也能用**：视频工作台（生图 / 生视频 / ComfyUI 桥接）
完全不依赖它，只有剪辑台会显示「需要先准备 ArtCraft 产物」的提示。

★ 本项目原创的适配层（`artcraft-adapter.mjs` / `artcraft-wire.mjs` /
`artcraft-storage.mjs`）适用 MIT —— 它们是与 ArtCraft 对接的接口代码，
不含上游实现。

### 其他第三方依赖

React、esbuild 等通过 npm 依赖引入，各自的许可见各自包内声明。
以 npm 依赖方式引用不构成对这些代码的再分发。

### 如果你认为侵权

请开 issue 说明具体文件与理由，核实后会立即移除相关内容。


