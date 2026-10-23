# v2026.10.23-m · v2 工作流端到端跑通

> 打包：2026-10-23 16:20
> 上一版：`VERSION-v2026.10.23-k.md`

---

## 一 · 核心成果：v2 真的跑出片了

```
产物：YZ_H3__00040-audio.mp4
  时长   5.17 秒
  分辨率 1664×928
  帧率   24 fps
  编码   h264 (High) + AAC 双声道
  大小   1.75 MB
```

`ffmpeg -i` 实测输出：
```
Duration: 00:00:05.17, bitrate: 2846 kb/s
Stream #0:0: Video: h264 (High), yuv420p(tv, bt709, progressive), 1664x928, 24 fps
Stream #0:1: Audio: aac (LC), 32000 Hz, stereo, fltp, 131 kb/s
```

**实测性能**（10 步 / 关闭武打 / 5 秒）：

```
execution_start:   1792742512271
execution_success: 1792742660807
总耗时: 149 秒 = 2.48 分钟
```

证据归档：`docs/evidence/v2-workflow/v2-yz-10steps-5s.mp4`

---

## 二 · 为什么之前一直「0 秒假成功」

两个根因，**都是我自己造成的**，不是工作流的问题。

### ① 工作流文件里还是旧转换产物

```
文件 workflows/yz-ultimate-full.json 里： 265.ref_image_size = "match"  ✅
实际提交给 ComfyUI 的：                    265.ref_image_size = 1344    ❌
```

**桥进程缓存了旧工作流**。我用新转换结果替换了文件，但没重启桥 ——
它内存里还是上一版（`ref_image_size=1344`，合法值只有 `match`/`max`）。

★ 这也解释了为什么 `src/verify-workflow.mjs` 静态检查"全通过"：
  它读的是**磁盘文件**（正确），而 ComfyUI 收的是**桥内存里的对象**（过期）。
  两者不一致时，静态检查无法发现。

### ② steps=4 触发 SelfLift 的步数约束

为了省时间我把 `steps` 传成 4，而工作流里 `397.transition_step = 6`。

ComfyUI 报：
```
SelfLift: transition_step 6 out of range for 4 steps
sigmas = tensor([1.0000, 0.9730, 0.9231, 0.8000, 0.0000])   ← 5 个 = 4 步
```

---

## 三 · 修的三个真 bug

### 3.1 `transition_step` 与步数冲突无人校验

**证据**：前端 `STEPS = [4, 6, 8, 10, 15, 20]`，选 4 或 6 都会崩。

**为什么难发现**：ComfyUI 的 schema 只校验 `transition_step` 的
`min/max`（1~10000），**不校验它与总步数的关系** ——
那是节点内部的 `ValueError`，提交阶段完全看不出来，要跑几十秒才炸。

**修法**：前端在提交前拦截，判据**取自工作流本身**而不是写死 6：

```js
const wf = mode?._workflow;
if (wf && wf["397"]?.inputs?.transition_step != null) {
  const ts = Number(wf["397"].inputs.transition_step);
  const s = Number(steps);
  if (Number.isFinite(ts) && Number.isFinite(s) && s <= ts) {
    setError(`步数 ${s} 太小：这个工作流的低分辨率求解次数（transition_step）是 ${ts}，`
      + `总步数必须大于它。请选 ${ts + 1} 步或更多。`);
    return;
  }
}
```

★ 不写死 6：换工作流时自动跟着变。

### 3.2 ComfyUI 启动时 `stdio: "ignore"`，崩溃后查不到原因

**证据**：v2 第一次跑到第 10 分钟进程退出，
而 `logs/comfyui.log` 时间戳**还停在 10-18** —— 本次运行任何输出都没留下。

**根因**：
```js
const vbs = ['Set sh = CreateObject("WScript.Shell")',
             `sh.Run ${q(cmdLine)}, 0, False`];   // 0 = 隐藏窗口，同时丢弃 stdout/stderr
```

**修法**：用 `cmd /c` 加重定向，日志落在 `<ComfyUI 根>/.dsh-launch.log`：

```
cmd /c ""<命令>" 1>>"<log>" 2>&1"
```

★ 用 `>>` 追加而不是覆盖：多次启动的记录都在，崩溃前最后一段能直接看到。
★ 不放 ComfyUI 自己的 `logs/`：避免和它的日志轮转打架。

### 3.3 工作流文件替换后桥进程仍用旧缓存

上面 §2①。已通过重启解决。

---

## 四 · 验收

| 项 | 结果 |
|---|---|
| **`verify-all.mjs`（完整，含真生成）** | **64 / 64** ← **首次全绿** |
| `verify-all.mjs --static` | **56 / 56** |
| `verify-editor-console.mjs` | **163 / 163**（+4） |
| `verify-ui-to-api.mjs` | 23 / 23 |
| 变异测试（本轮新增） | **3 / 3 变红** |

### 新增的 4 条断言

```
✓ 提交前校验 transition_step 与步数冲突
✓ 校验判据取自工作流而不是写死数字
✓ ComfyUI 启动把输出重定向到日志文件
✓ 日志用追加而不是覆盖
```

变异测试：
- 去掉步数冲突提示 → 红
- 判据写死为 null → 红
- 日志改成覆盖 → 红

---

## 五 · 实测数据（写进记忆）

| 项 | 数值 | 口径 |
|---|---|---|
| v2 生成 5 秒 / 10 步 / 关闭武打 | **149 秒** | ComfyUI history 的 execution_start→success |
| 产物时长 | 5.17 秒 | ffmpeg -i Duration（请求 durationSec=5） |
| 产物分辨率 | 1664×928 | ffmpeg -i Stream（请求 16:9） |
| 产物大小 | 1.75 MB | 磁盘 |
| 音轨 | AAC 32000Hz stereo | ffmpeg -i Stream |

★ 作者称「12 秒视频约 6 分钟」。我这 5 秒用 2.48 分钟，
  按比例推算 12 秒约 5.95 分钟 —— **与作者的说法吻合**。

---

## 六 · 仍未验证的事

| 项 | 状态 |
|---|---|
| v2 的 1080p 直出（2.0 分辨率） | ❌ 未验证 |
| 参考尺寸 `match` 的实际画质效果 | ❌ 未验证（只验证了参数被正确传递） |
| 参考图 9 槽 / 参考视频 3 槽的实际使用 | ❌ 未验证（本次未提供任何素材） |
| 武打模式开启的链路 | ❌ 未验证（本次 `wudA=false`） |
| 12 秒视频的真实耗时 | ❌ 未实测（按 5 秒线性推算约 5.95 分钟） |

---

## 七 · 目标完成度

| 段 | 状态 |
|---|---|
| A（5 项） | ✅ |
| B（4 项） | ✅ 含 `/ensure` 真机验证（16s 启动） |
| C（4 项） | ✅ **64/64 全绿** |
| D（5 项） | ✅ |
| E（4 项） | ✅ |
| F1 | ✅ |
| **F2 GitHub 私密仓库** | ❌ **凭据失效（第 5 轮）** |
| F3 | ⏸ 等 F2 |
| G（3 项） | ✅ |
