# 从 YUH Studio 学到的两个能力（已落地）

> 2026-10-18。逆向报告见 `docs\调研\YUH逆向-功能全景.md`

---

## 一 · 参考图分用途

### 为什么需要

H3 官方 `references/ref-en.txt` 逐字：

> If an image is used only to define a character, scene, costume, or style,
> **do not create a standalone picture entry.**

四种标签：

| 标签 | 含义 | 约束 |
|---|---|---|
| `<Subject N>` | 角色/主体外观 | 外观可来自一张图、动作来自一个视频 |
| `<Picture N>` | 具体帧 / 分镜锚点 | **一张图只能定义一镜** |
| `<Video N>` | 动作 / 运镜 | — |
| `<Audio N>` | 声音 | — |

而工作流侧只有 `ref_images.ref_image_0..5` —— **按位置编号，分不出用途**。
用错会让 H3 把只该定角色长相的图强行凑成某一帧。

### 怎么做的

```
前端：每个素材槽选完文件后出现「用途」下拉
      图片 → 角色/物体外观 | 画面帧（首帧/关键帧/尾帧）
      视频 → 动作/运镜参考（只有一个选项，不显示下拉）
      音频 → 声音参考
      默认：图片=外观（最保守，不会强行当帧）

提交：tagReferences() 生成 subject_definitions 骨架 → params.refLabels
后端：拼到 prompt 最前面（H3 要求这个 section 排第一）
      用户写的 prompt 保持原样，不覆盖
```

### 代码

```
packages/dsh-comfy-workbench-tab/src/h3-labels.js
  REF_ROLES          四种用途定义
  rolesForKind(kind) 按素材类型给可选用途（不让用户选不可能的）
  tagReferences()    生成标签 + 警告

单测 13/13（含：外观图不占 Picture 编号 / 只有外观没帧要警告 /
            有动作没外观要警告 / 空输入不崩）
```

### 照 YUH 的做法加了「当场劝阻」

YUH 的界面上直接写「全能参考不建议」。我也加了三条警告：

```
· 只有外观没帧 → 「若你希望某一镜从某张图开始，把那张改成画面帧」
· 有动作没外观 → 「动作能对上，但人物长相会变」
· 外观超过 3 张 → 「多半应该合并成同一主体的不同角度」
```

### 实测

```
选 test-role.png 后 → select 出现，两个选项
提交时 → node 263 (Text) 的 text 输入 =
         "subject_definitions: | <Subject 1> is the young woman whose
          appearance comes from girl.png. | <Video 1> provides..."
```

---

## 二 · 首尾帧衔接（chain_from）

### 为什么需要

YUH 的 video 节点有 `chain_from`：「上一镜来源」。
多镜一致性的关键做法：**上一镜尾帧 → 下一镜首帧/参考图**。

我原来只有「整段替换」，没有这种原子操作。

### 怎么做的

```
① 抽帧（src/frames.mjs）
   extractFrame({ file, position })  position = first | last | at

② 衔接（src/chain.mjs）
   chainFromPrev({ prevVideo, slot })  单个
   chainAll(clips, slot)               批量（自动跳过没产物的镜头）

③ 路由
   GET  /comfy-bridge/frame/status     ffmpeg 就绪状态
   POST /comfy-bridge/frame            { file, position }
   POST /comfy-bridge/chain            { prevVideo, slot } 或 { clips, slot }
```

### 三个踩过的坑（全部有实测）

```
① ffmpeg 7.x 要求单图输出带 -update 1
   否则 "does not contain an image sequence pattern ... Could not open file"

② -update 1 是【输出选项】，必须放 -i 之后
   ❌ -y -update 1 -i in.mp4 -frames:v 1 out.png
      → "Error opening input file in.mp4 ... Option not found"
      ⚠ 报错行写的是【输入文件打不开】，极易误判成源文件坏了
   ✅ -y -i in.mp4 -frames:v 1 -update 1 out.png

③ 抽出的帧不能写 ComfyUI 的 input 目录
   DSH 文件沙箱只允许写工作区（实测三种路径）：
     <HOME>\*.png              → I/O error
     D:\Comfy-Desktop\ComfyUI-Shared\input\*.png → I/O error
     <REPO>\.frames\*.png     → ✓
   ⇒ 落盘在工作区，之后走 comfy.uploadImage() 传给 ComfyUI
```

### ffmpeg 位置

```
<OLD_REPO>\packages\dsh-editor\bin\ffmpeg.exe   v7.1  83.6MB
PATH 里没有 ffmpeg（实测 Get-Command ffmpeg 失败），必须用绝对路径。
```

### 实测

```
抽帧：
  frame-AnimateDiff_00001-audio-first-e0a5863e.png   831,459 B  PNG ✓
  frame-AnimateDiff_00001-audio-last-e0a5863e.png  1,072,534 B  PNG ✓
  首尾 hash 不同 → 确实是两帧不同画面（1376×768）

chain 批量：
  patched=1 skipped=1
    c2 ← 取自 c1 的尾帧
    c3 ← 上一镜没有产物，跳过（不报错，整条链不挂）

边界：
  单镜 / 空数组 → patched=0 skipped=0，不崩
```

---

## 三 · 还没做的三条（等主人回来定）

| # | 功能 | 为什么没做 |
|---|---|---|
| 1 | **画布节点化**（把时间轴换成节点图） | 换基座：要重写 host-store、render.mjs、ClipEditor、所有 Agent 工具。周级工作量，不该在主人出门时开工 |
| 2 | **分步状态机**（分镜已创建→不能换模型→可停可改→需重校） | 和 ① 绑在一起才有意义 |
| 3 | **chain_from 接进 UI** | 后端已通（`/chain` 路由），但 UI 上还没有「一键接上一镜」的按钮。缺的是入口，不是能力 |

---

## 四 · 明确不抄的

| 功能 | 理由 |
|---|---|
| 自动做剧全流水线（6 工具） | 要走「小说→章节→剧本→分镜」四道 LLM 环节，本机没配套模型服务 |
| 定时任务（7 工具） | 与本机 ComfyUI 的阻塞队列冲突，无明确需求 |
| 3D 导出 / SVG 转曲 / PPTX 预览 | 属设计工具范畴，与图音视频主线无关 |
| 46 个工具全抄 | 工具越多 Agent 越容易选错 |
