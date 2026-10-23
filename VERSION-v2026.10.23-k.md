# v2026.10.23-k · 接入 YZ H3 v2 工作流 + 转换器定稿

> 打包：2026-10-23 15:45
> 归档：`<WORKSPACE>\_branch-archive\DSH视频工作台-v2026.10.23-k-20261023-154512.zip`（51.6MB）
> 上一版：`VERSION-v2026.10.23-i.md`

---

## 一 · 本轮：接入主人给的新版工作流

主人提供的文件：`YZ金鱼-MiniMax+H3+终极篇-文武双全 (1).json`（114.8 KB，100 个节点）

作者说明的 v2 改进：

| 项 | 说明 |
|---|---|
| 参考尺寸 | 不再用 `max`，改为遵从输入分辨率 |
| 高分辨率分块 | 去掉（实验性，导致速度降低与果冻效应） |
| 速度 | 12 秒视频从约 10 分钟降到 6 分多钟 |
| 分辨率 | 可直出 1080p |

### 1.1 v1 与 v2 的实际差异（逐项对比）

| 项 | v1 | v2 |
|---|---|---|
| 文本编码器 | `qwen3vl_32b_..._ultra_uncensored_heretic_int8_convrot` | **`qwen3vl_32b_..._nvfp4_awq`** |
| 放大模型 | `h3_upscaler_lms_v0.1` | **`minimax_h3_latent_upscaler_3d_fp16_V2`** |
| 参考图槽 | 6（`ref_image_0..5`） | **9（`ref_image_0..8`）** |
| 参考视频槽 | 1（`ref_video_0`） | **3（`ref_video_0..2`）** |
| 节点数 | 41 | 43 |
| LoRA / VAE / UNet | 6 / 2 / 1 | 完全一致 |

★ bind 层引用的 **23 个节点 id 与类型全部一致** ⇒ bind 可完全复用，只补 5 个媒体槽。

### 1.2 放大模型：「V2」就是同一份文件换名

本机只有 `minimax_h3_latent_upscaler_3d_fp16.safetensors`（无 V2），
且 ComfyUI 的合法值里也没有 `_V2`。

去 HuggingFace 查：

```
KENIC-1/minimax_h3_latent_upscaler_3d_fp16_V2
  minimax_h3_latent_upscaler_3d_fp16_V2.safetensors
  size:   690592672
  sha256: 043e5a48e161610ef6c3ea974645220354d06fa618abca15f76d084812eb55c2
```

本机现有文件：

```
D:\Comfy-Desktop\ComfyUI-Shared\models\latent_upscale_models\
  minimax_h3_latent_upscaler_3d_fp16.safetensors
  sha256: 043e5a48e161610ef6c3ea974645220354d06fa618abca15f76d084812eb55c2
```

**字节完全相同。** 所以不需要下载 670MB，直接复制改名即可（已做，ComfyUI 已识别）。

★ 顺带确认另一件事：`h3_upscaler_lms_v0.1.safetensors` 也是 658.60MB，
  但 sha256 不同（`40d42282…`，大小差 376 字节）——**它不是同一个模型**。

---

## 二 · UI 格式 → API 格式转换器（`tools/ui-to-api.mjs`）

### 2.1 为什么需要

从社群拿到的 ComfyUI 工作流是 **UI 导出格式**：
```json
{ "nodes": [...], "links": [...], "groups": [...], "extra": {...} }
```
而 `POST /prompt` 要的是 **API 格式**：
```json
{ "36": { "class_type": "VAELoader", "inputs": { "vae_name": "..." } } }
```

两者结构完全不同，必须转换。

### 2.2 ★ 对位规则我错了五次

这是本轮最大的坑。`widgets_values` 是一个数组，其元素按 UI 上从上到下的顺序
对应节点的各个「widget 输入」。但「哪些字段占位」这件事，我判错了五遍。

| 第几版 | 我的判据 | 错在哪 |
|---|---|---|
| 1 | 按 `/object_info` 的 key 顺序 | key 顺序 ≠ UI 顺序 |
| 2 | 用 `input_order` | 它把非 widget 字段也算进去了 |
| 3 | 只取 `link === null` 的输入 | **已连线的 widget 型字段仍占位** |
| 4 | 加类型过滤 | 漏了 `COMFY_DYNAMICCOMBO_V3` |
| 5 | ✅ 定稿 | widget 型字段都占位，**不管有没有连线** |

### 2.3 定稿的五条判据（都有实测证据）

**① widget 型字段都占 widgets_values 的位 —— 不管它有没有连线**

实测节点 265（`MiniMaxH3ReferenceToVideo`）：
```
widgets_values = ["", 1344, 768, 124, "match"]        ← 5 个
inputs:
  width                link=483   ← 有连线，但 FLOAT 型，仍占位
  height               link=484   ← 同上
  length               link=485   ← 同上
  ref_video_audio_0    link=null  ← 没连线，但是连线类型，不占位
  ref_image_size       link=null  ← 没连线，widget 型
```
只看 `link === null` 得到 2 个，而 `widgets_values` 有 5 个 ⇒ 整体错位。

**后果**：`ref_image_size` 拿到了 `1344`，而它的合法值只有 `match` / `max`。
提交时 ComfyUI 报：
```
value_not_in_list: ref_image_size: 1344 not in ['match', 'max']
```

**这正是作者说的「参考尺寸不再用 max」那个参数。** 如果没修，v2 根本提交不上去。

**② 连线型字段（MODEL/VAE/IMAGE/LATENT/SAMPLER/SIGMAS…）不占位**

**③ COMBO 家族都算 widget**

实测 `BlockSparseAttention.selection` 的类型是 `COMFY_DYNAMICCOMBO_V3`，
它的值 `"sol-attn"` 就在 `widgets_values[0]`。第一版只认
`INT/FLOAT/STRING/BOOLEAN/COMBO`，把它漏了 ⇒ 整体错一位。

**④ `widgets_values` 是对象时按键写入**

实测 `VHS_LoadVideo`（节点 27）的 `widgets_values` 是**一个对象**：
```json
{ "video": "", "force_rate": 0, "force_size": "Disabled", ... }
```
不是数组。第一版只处理 `Array.isArray`，于是整个节点的参数全丢，报：
```
LoadVideoUpload.VALIDATE_INPUTS() missing 1 required positional argument: 'video'
```

**⑤ `control_after_generate` 占一个位，但不是真参数**

`seed` 后面紧跟着一个控制值（`randomize` / `fixed`），
它在 `widgets_values` 里占位，但不该进 `inputs`。

### 2.4 验收与变异

`tools/verify-ui-to-api.mjs` —— **23 / 23**，覆盖五条判据 + 虚拟节点消除。

`tools/mutate-ui-to-api.mjs` —— **5 / 5 全部能变红**：
- 改回「只取 link===null」→ 红
- 去掉 COMBO 判断 → 红
- 不处理 control_after_generate → 红
- 不处理对象形式 → 红
- 不去掉虚拟节点 → 红

已登记进 `verify-all.mjs`（静态段，不碰 ComfyUI）。

★ 写测试时自己又踩了一个坑：`caseLinkedWidget` 第一版把连线源写成不存在的节点 99，
导致连线被丢弃、`megapixels` 保留了 widgets 值 `1.5`，**看着像对位对了其实是漏了连线**。
换成真实节点 5 之后才暴露。

---

## 三 · 另外三个真 bug

**① `忽略多组孤海` 是 `output_node` 却没有输入**

这 4 个 UI 占位节点（307/308/309/363）在 `/object_info` 里 `output_node: true`，
ComfyUI 执行时**在它们那里就终止了**，364（保存视频）永远不跑。
已从工作流里删除。

**② 媒体槽值 `"None"` 被当真值提交**

作者导出时未填的槽是字符串 `"None"`。ComfyUI 认真去加载一个叫 None 的文件：
```
node 51: LoadImage → image - Invalid image file: None
node 14: LoadAudio → audio - Invalid audio file: None
```
然后把这些节点标为不可执行，**连带整条下游（含输出节点）都不跑**。
表现极其误导：任务 55 毫秒就「成功」，`outputs` 为空。

★ bind 层本来就有这段剪枝逻辑（`workflows.mjs:677`），
  但它没生效 —— 因为槽在 bind 里声明过，`files` 却没提供，
  L703 的跳过条件把「画布未填」和「用户已提供」混在一起了。
  实测：不提供任何文件时，15 个槽被正确剪掉，**这条逻辑其实是对的**，
  上面那些报错来自我直接提交原始 43 节点 prompt（绕过 bind）。

**③ 断言写死槽数**

v1→v2 槽数从 10 增到 15、图槽从 6 增到 9，
三处断言（`verify-m1-http` ×1、`verify-slot-real` ×2）因此变红。
改成锁**结构约束**而不是快照：
- 至少 10 个槽
- 三类（图/视频/音频）都有
- 每个槽都指向工作流里真实存在的节点
- 占满后返回 null，不越界塞进别的 kind

---

## 四 · 验收

| 项 | 结果 |
|---|---|
| `verify-all.mjs --static` | **54 / 56** |
| `verify-editor-console.mjs` | **159 / 159** |
| `verify-ui-to-api.mjs` | **23 / 23** |
| `mutate-ui-to-api.mjs` | **5 / 5 变红** |
| `verify-assets.mjs` | 44 通过 / 2 跳过 |
| 19387 | PID **39236** 未变 |

### 那 2 项失败是什么

```
❌ M1 HTTP 端到端          12/16
   失败：health.ok · 报告 ComfyUI 版本 · generate 可达 · 有 jobId 可轮询
❌ M1 异常输入             21/23
   失败：正常文本生图 · 正常改图
   原因：★ 被误拒：ComfyUI 未运行或不可达（fetch failed）
```

**全部因为 ComfyUI 离线**（8188 无监听）。这是静态模式下的理论下限。

---

## 五 · v2 的真实执行证据（未拿到产物）

改完之后提交：
```
HTTP 200
✅ 提交成功 prompt_id = 9b8a04c4-7fc4-4fff-9db0-39f70db85b8d
```

执行状态：
```
[0.5 分钟] running=1 pending=0
...
[10 分钟] running=1 pending=0
```

★ 与之前的「0 秒假成功」有本质区别 —— 这是 v2 真的在生成视频。

但 **ComfyUI 在中途退出了**（8188 无监听，日志停在 10-18 说明本次未写日志），
所以**没有拿到最终产物**。

---

## 六 · 未验证的事（不虚报）

| 项 | 状态 |
|---|---|
| v2 端到端出片 | ❌ **未验证**（ComfyUI 中途退出） |
| v2 的实际耗时 | ❌ 未验证（作者称 12 秒视频约 6 分钟） |
| v2 的 1080p 直出 | ❌ 未验证 |
| 参考尺寸 `match` 的实际效果 | ❌ 未验证 |
| ComfyUI 为何退出 | ❌ 不知道（无日志） |

---

## 七 · 目标完成度

| 段 | 状态 |
|---|---|
| A（5 项） | ✅ |
| B（4 项） | ✅ |
| C（4 项） | ✅ 54/56（离线下限） |
| D（5 项） | ✅ |
| E（4 项） | ✅ |
| F1 | ✅ |
| **F2 GitHub 私密仓库** | ❌ **凭据失效（第 4 轮）** |
| F3 | ⏸ 等 F2 |
| G（3 项） | ✅ |
