# v2026.10.23-i · D2/D3 去敏补全

> 打包：2026-10-23 13:38
> 归档：`D:\主工作区\_branch-archive\DSH视频工作台-v2026.10.23-i-20261023-133855.zip`（51.6MB）
> 上一版：`VERSION-v2026.10.23-h.md`

---

## 一 · 本轮发现：去敏其实没做完

上一版我说「硬编码路径全部清除」，**那是错的**。本轮系统扫了一遍生产代码
（`lib/` + `src/`，排除测试脚本），发现还有 **8 处**：

| 文件 | 位置 | 原先的值 |
|---|---|---|
| `lib/asset-scan.js` | `DEFAULT_WS_ASSETS` | `D:/主工作区/outputs/assets.json` |
| `lib/asset-scan.js` | `DEFAULT_STATE` | `D:/主工作区/DSH视频工作台/.state/asset-library.json` |
| `lib/index.js` | `DEFAULT_WORKFLOWS_DIR` | `D:/主工作区/.../dsh-comfy-bridge/workflows` |
| `lib/index.js` | 字幕路径白名单 | `"D:\\主工作区"` |
| `lib/index.js` | `TMP_ROOT` | `D:\主工作区\DSH视频工作台\.frames` |
| `lib/index.js` | `FFMPEG` | `D:\主工作区\DSH视频工作站\...\ffmpeg.exe` |
| `lib/index.js` | `PYTHON` | `D:\Comfy-Desktop\...\.venv\Scripts\python.exe` |
| `lib/index.js` | `MODEL_DIR` | `D:\主工作区\DSH视频工作台\.models\whisper` |

**为什么上一版漏了**：我只扫了 `dsh-comfy-bridge/src/`，没扫
`dsh-comfy-workbench-tab/lib/`（那是 host 侧手写代码，不是构建产物）。

★ 判据：`lib/` 不等于「全是玩具」——`lib/index.js` 是 host 入口，手写的。

---

## 二 · 改法

统一原则：**从模块自身位置推导，跟着包走**。

```js
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG  = path.resolve(HERE, "..");
const REPO = path.resolve(PKG, "..", "..");
```

| 项 | 新推导 |
|---|---|
| `DEFAULT_WS_ASSETS` | `<包>/outputs/assets.json`（与 dsh-editor 的 pickOutDir 同一约定） |
| `DEFAULT_STATE` | `DSH_PROFILE_DIR/.comfy-bridge/asset-library.json`，否则 `<包>/.state/` |
| `DEFAULT_WORKFLOWS_DIR` | `<packages>/dsh-comfy-bridge/workflows` |
| 字幕白名单 | `REPO_ROOT`（收窄到本仓库，不是整个磁盘） |
| `TMP_ROOT` | `<repo>/.frames`（仍在工作区内，满足沙箱约束） |
| `FFMPEG` | 四级：`config` → `FFMPEG_PATH` → `<packages>/dsh-editor/bin` → `imageio-ffmpeg` → `"ffmpeg"` |
| `PYTHON` | 四级：`config` → `PYTHON_BIN` → venv → `"python"` |
| `MODEL_DIR` | `config` → `COMFY_WHISPER_DIR` → `<repo>/.models/whisper` |

★ 所有 `import.meta.url` 都用 `fileURLToPath()` ——
  `.pathname` 不解码中文路径，包放在 `D:\主工作区\...` 下会变成
  `%E4%B8%BB%E5%B7%A5%E4%BD%9C%E5%8C%BA`（dsh-editor 已踩过这个坑）。

---

## 三 · 新增断言 + 变异测试

```
check("生产代码里没有硬编码的本机绝对路径")
  扫描：lib/ 与 src/
  正则：C:\Users | C:/Users | D:\主工作区 | D:/主工作区 | D:\Comfy-Desktop | D:/Comfy-Desktop
  剥注释：整块 /* */ 与行 // —— 注释里记录「原先是写死的」是有价值的历史
```

变异测试：注入 `const HARDCODED_TEST = "D:/主工作区/测试";`
→ **✅ 变红**，正确报出 `\lib\index.js:25`。

### 写这条断言时踩的两个坑

**① `split("\\n")` 是字面量不是换行**
整个文件被当成一行，行号永远是 1，把注释里的历史记录也当成残留 → 4 条假红。
必须是 `split("\n")`。

**② 只跳过行首 `*` / `//` 不够**
块注释的**结尾行**（`  这里...。 */`）不以 `*` 开头，
需要整块剥离 `/\/\*[\s\S]*?\*\//g`。

---

## 四 · 验收

| 项 | 结果 |
|---|---|
| `verify-all.mjs --static` | **56 / 56** |
| `verify-editor-console.mjs` | **147 / 147**（从 146 增至 147） |
| `verify-asset-baseline.mjs` | ✅ 差集为空（1451 项） |
| 变异测试 | 1/1 变红并定位行号 |
| 三个包运行时 | ✅ bridge modes=4 / editor assets=529 / M2 matched=1451 |
| 19387 | PID **39236** 全程未变 |

### 基线变化说明

本轮跑了几次真实生成，ComfyUI 输出目录新增 52 个文件
（`output` 775 → 827）。**没有减少项**，全属正常增长，已重存基线。
`test-mix.m4a` 那条历史遗留不再出现在基线里（上一版已确认其文件仍在）。

---

## 五 · 目标完成度

| 段 | 状态 |
|---|---|
| A（5 项） | ✅ 全部真机验证 |
| B（4 项） | ✅ 已实现并复核 |
| C（4 项） | ✅ 56/56 + 污染基线通过 |
| **D（5 项）** | ✅ **本轮补全 D2/D3** |
| E（4 项） | ✅ 含模型配置页 |
| F1 | ✅ |
| **F2 GitHub 私密仓库** | ❌ **凭据失效（第 2 轮）** |
| F3 | ⏸ 等 F2 |
| G（3 项） | ✅ |

---

## 六 · F2 阻塞状态

```
gh auth status
  X Failed to log in to github.com account MYCF711 (default)
  - The token in default is invalid.
```

环境变量无 `GH_TOKEN` / `GITHUB_TOKEN`，`git remote` 为空。

需要主人执行：

```powershell
gh auth login -h github.com
```

在此之前无法推进 —— 没有 token 可用，硬推只会落到错误的仓库。
