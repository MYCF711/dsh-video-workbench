---
name: comfy-mode-dispatch
description: 判断一个视频/图片生成需求该走 ComfyUI 的哪个工作流（krea2 生图 / qwen21-edit 改图 / yz 生视频），怎么把提示词写进「视频工作台」或直接调 HTTP，以及三个工作流各自的能力边界与已知坑。当用户要生成图、改图、生视频、做漫剧分镜、首尾帧衔接时使用。★ 用户的默认用法是在对话框说需求、让你写提示词，然后用 comfy_workbench_fill 填进工作台让他自己按生成。触发词：生成一张、改这张图、换装、洗图、骨骼图、出视频、首尾帧、分镜、生图、文生视频、多参、H3、Krea2、Qwen、帮我写提示词、按这个描述出图、填进工作台。
---

# ComfyUI 工作流调度

## 一 · 三个工作流，三个职责

| 需求 | mode id | 能力 |
|---|---|---|
| 从零造一张图 | `krea2` | 文生图 + 双采精修（一采出图 → ×1.5 放大 → 5 步 denoise 0.5） |
| 改一张已有的图 | `qwen21-edit` | 换装 / 洗图 / 生骨骼图 / 姿态参考 / 风格迁移 / 抠图 |
| 出视频 | `yz` | H3 文武双全：文生视频 / 首尾帧 / 多参参考（6 图 + 1 视频 + 3 音频）/ 武打开关 |

### 判断规则（照这个走）

```
要「一张新图」                       → krea2
给了图，要「改它 / 换 / 洗 / 变成」   → qwen21-edit
要「动起来 / 视频 / 镜头」            → yz
```

**不要混用。** 用 krea2 改图会丢掉原图身份；用 yz 做图会浪费 19GB 主模型的加载时间。

## 一·五 · ★ 先想清楚：这次该「填工作台」还是「直接调 HTTP」

这是最重要的一条分流，做错会让用户多干很多活。

```
用户在【对话框】里说需求，然后自己去工作台点生成   → comfy_workbench_fill
用户在【工作台/剪辑台】里已经在操作，要你替他跑     → 直接调 POST /generate
用户要一整部片子（多镜、分镜、拼接）              → timeline_add_shots + timeline_generate
```

### 默认走 `comfy_workbench_fill`

工具签名：
```
comfy_workbench_fill({ prompt, modeId?, aspect?, durationSec?, seed?, reason? })
```

它做三件事：**把提示词填进工作台输入框 + 切到指定工作流 + 弹一条「AI 已填入」提示**。
**它不会自动生成**（这是刻意的：一次生成 23 秒到 3 分钟，跑错很贵，
用户要有个用眼睛扫一遍再按的机会）。

用法要点：
- `reason` 一定要写，会显示给用户看。写「因为要浅景深所以加了 85mm」这种，
  让用户知道为什么这么改，比只丢一段提示词强得多。
- `modeId` 省略 = 保持用户当前选的工作流。**不确定用户想干嘛就别改。**
- 先按第一节的判断规则定 `modeId`，再按下面的规则写提示词。
- 填完就停，**不要在同一个回合里自己去调 /generate 把活干了** ——
  那等于绕过了用户手里的那个检查点。

### 什么时候才直接调 HTTP

只有当「用户明确要你替他跑」时（「你直接生成」「跑一个看看」「不用问我了」），
才走 POST /comfy-bridge/generate。这种场景用户放弃了检查点，他承担跑错的风险。

## 二 · 怎么调（HTTP，不 import）

```
GET  /comfy-bridge/health
GET  /comfy-bridge/modes             ← 先读这个，拿 defaults / media / toggles
GET  /comfy-bridge/lengths
POST /comfy-bridge/generate
GET  /comfy-bridge/job/<jobId>
POST /comfy-bridge/cancel/<jobId>
```

### generate 的参数

```jsonc
{
  "modeId": "krea2",
  "prompt": "…",
  "aspect": "9:16",          // 1:1 2:3 3:2 3:4 4:3 9:16 16:9 21:9
  "durationSec": 5,          // 仅视频
  "steps": 8,
  "seed": 123456,            // 省略 = 随机
  "toggles": { "wudA": false },
  "files": {
    "ref_image_0": { "base64": "…", "filename": "a.png" }
  }
}
```

**`files` 的槽名必须来自 `GET /comfy-bridge/modes` 返回的 `media` 键 —— 不要猜。**

槽名清单（截至当前）：

| mode | 槽名 |
|---|---|
| `krea2` | 无 |
| `qwen21-edit` | `ref_image_0`（原图）、`ref_image_1`（参考图） |
| `yz` | `ref_image_0..5`（6 张图）、`ref_video_0`、`ref_audio_0..2` |

## 三 · 三个工作流的坑（都是实测）

### krea2

- **turbo LoRA 与 steps=1 单步采样器是配套的，且默认 BYPASS。**
  把它打开会出玄幻画面 —— 因为 1 步严重欠采样。别开。
- 双采精修（`secondPass`）默认开。关掉更快但细节差。
- `redraw`（UltimateSDUpscale 高清重绘）默认关。

### qwen21-edit

- **必须用非 turbo 主模型**（`qwen_image_2.1_int8_convrot`）。
  turbo 是蒸馏加速版，编辑任务上提示词遵循度会掉。
- 吃两张图：**图1 = 原图**（构图身份保留），**图2 = 参考素材**（风格/服装/姿态）。
  图1 决定「像谁、什么构图」，图2 决定「换成什么」。
- 内建官方 Edit Prompt Enhancer（`459:479`，5000+ 字符）。
  它会把你的简短指令扩写成专业编辑指令 —— **写简短的自然语言就行，别堆关键词**。
- 官方原始工作流有 10 个图像槽（`images.image_1..10`），当前这版只接了两个。

### yz（H3）

- **length 必须落在 17k+5 网格上，没有 24 这一档。**
  ```
  5 22 39 56 73 90 107 124 141 158 175 192 209 226 243 260 277 294 311 328 345 362
  ```
  后端自动吸附：24 → 22，120 → 124，240 → 226，超 362 夹到 362。
  奇数网格点退到相邻偶数点（方便后期补帧）。
- **负向提示词原生无效** —— 官方链路用 `BasicGuider`，只有一个 conditioning。
  要生效得换 `CFGGuider`（cfg=1.5）。**别向用户承诺负向词有用。**
- **「秒级成功但产物为空」是已知坑。** 判据不是查产物目录 —— 是看
  `completed` 与 `outputs.length`。0 产物就报「completed 但 0 产物」，不要报成功。
- 编码器必须是 `qwen3vl_*_minimax_h3_*`。带 `pe` 的是 prompt enhancer，不是主编码器。
- 武打开关（`wudA`）在服务端执行：增删 4 个 LoRA 节点 + 重新接线。
  开：挂 H3_Combat_V2 / H3_Fight_Flow_V1 / Motion_Repair_V2 / H3_speed_slider。

## 四 · 做剧的顺序（对标 YUH Studio）

```
1. 角色卡    krea2 出三视图
             上 1/3：双头部特写（正面 + 45°侧面，纯灰底）
             下 2/3：横向三视图（正面 / 侧面 / 背面）
             同一人物长相发型肤色服装配饰必须统一

2. 场景卡    krea2，16:9
3. 道具卡    krea2，16:9

4. 分镜表    表格：镜次 / 时长 / 画面（机位·构图·动作）/ 台词 / 参考连线
             「参考连线」列写清每镜挂哪些角色卡与场景卡

5. 改图      换装、洗图、改姿态 → qwen21-edit
             把角色卡当图1、参考素材当图2

6. 逐镜生成   yz，每镜单独提交，files 里挂该镜的角色卡与场景卡

7. 首尾帧衔接 同场景连续镜：抽上镜尾帧 → 作下镜的第一张参考图
             验收：抽第 0 帧做 64×36 像素比对，mean_abs_diff < 10 算连上

8. 拼接      全部跑完合成
```

**第 7 步的 `mean_abs_diff < 10` 是硬判据**，不是「看着差不多」。

## 五 · 报错时怎么做

| 现象 | 判据 | 处置 |
|---|---|---|
| `completed` 但 `outputs` 为空 | 看返回值，别查目录 | 报「0 产物」，附 `node_errors` |
| `execution_success` 只用了几十毫秒 | 跑完 40+ 节点不可能这么快 | 同上，去 ComfyUI 日志找 traceback |
| `connection refused` | `/comfy-bridge/health` 返回 `ok:false` | 报「ComfyUI 未运行」，**不要去启动或重启它** |
| 值不在可选列表 | 模型名与本机实际不符 | 用 `GET /comfy-bridge/modes` 看真实可选值 |

## 六 · 硬约束

- **不许重启 ComfyUI**（主人在用时重启会打断他）。M1 只发请求，从不启动任何东西。
- 代码里不写死模型名与节点 id —— 工作流是运行时输入。
- 数字必须数出来，不是估的。没跑过的写「未验证」。
