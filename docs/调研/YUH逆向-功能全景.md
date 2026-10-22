# YUH Studio 3.0.0 逆向：功能全景与可借鉴点

> 逆向于 2026-10-18。来源：`D:\YUH Studio\resources\app.asar`（130.7MB）
> 手法：解析 asar header → 直读 `out/renderer/assets/index-DxKCWAe2.js`（6.4MB）与 `out/main/index.js`（1.3MB）
> 提取：3920 条中文 UI 文案、46 个 MCP 工具名

---

## 〇 · 一句话概括

**YUH 把「画布」做成了唯一的工作对象**，节点是创作单元，连线是语义（分镜链 / 参考 / 首尾帧），
Agent 通过 46 个 MCP 工具直接操作这张画布。它没有「表单参数区」这个概念 —— 参数在节点属性里。

我的工作台是「表单 + 时间轴」，**Agent 只能调 `timeline_summary/add_shots` 这种粗粒度工具**。
这是最大的结构性差距。

---

## 一 · 46 个 MCP 工具（它的 Agent 协同架构）

```
画布操作（10）
  yuh_canvas_add / connect / disconnect / delete / find / focus
  yuh_canvas_layout / list / move / update

媒体处理（6）
  yuh_canvas_extract_frame     取首帧 / 取尾帧
  yuh_canvas_extract_audio     从视频抽音轨
  yuh_canvas_merge_videos      拼接
  yuh_canvas_trim_video        按帧精确截取（会重新编码一次）
  yuh_canvas_trim_audio        音频裁剪
  yuh_canvas_image_op          图片操作

生成（3）
  yuh_generate_image / generate_video / generate_tts

自动做剧（6）
  yuh_auto_drama_start / status / stop / resume / plan_reply / info

定时任务（7）
  yuh_schedule_create / list / cancel / run / history / targets / update

记忆（2）      yuh_memory_get / memory_save
项目（2）      yuh_project_list / project_open
连接器（2）    yuh_connector_call / connector_tools
其他（6）      cancel_task / list_tasks / import_artifact /
              design_command / save_skill / json_object
```

**关键判据：它的工具是「动词 + 对象」的细粒度**（`canvas_move` 而不是 `update_layout`），
所以 Agent 能做「把这个节点往右挪 200px 并把它的输出接到下一个镜头」这种操作。
我的 `add_shots` 只能「一次传整张分镜表」。

---

## 二 · 画布节点模型（这是它的心脏）

### 节点类型

```
image    生图节点   count（1-4 张）、image_model、loras、preset
video    生视频节点 chain_from、shot_index、duration、steps、accel_lora、preset
text     文本节点   text_preset（语言模型预设）
audio    音频节点   voice（固定音色标识）
compare  对比节点   second_media_path（右图）
group    分组节点   collapsed、group_members
```

### 连线语义（这比我现在的「引用」丰富得多）

```
chain_from      仅 video：上一镜来源 —— 首尾帧衔接靠它
参考图连线      分用途：图片参考 / 动作与运镜参考 / 声音参考 / 全能参考
首尾帧         取首帧 / 取尾帧（从视频节点抽）
```

### ⚠ 它自己的警告（值得抄）

```
「全能参考不建议」
「Qwen Image 2.1 编辑需要已生成的参考图片，请先生成并连接原图」
「图生视频模式请添加一张参考图片」
「图生图模式，数值越低越保留参考图」
```

⇒ **它在界面上明确告诉用户「这个组合不推荐」**，而不是让人试错。

---

## 三 · 自动做剧流水线（它的主打功能）

```
小说/故事
  ↓ 章节规划（分章改编，不是一次到底）
剧本改编（可编辑、可保存、可停止后替换文本再继续）
  ↓
分镜编写（输出 shots 数组：每镜含提示词 / 时长 / 机位 / 角色 / 道具）
  ↓
按分镜批量创建 canvas 节点 + 连线
  ↓
逐镜生成（每个 video 节点一次）
  ↓
取首尾帧 → 下一镜 chain_from 衔接
  ↓
合并预览
```

### 它的状态管理（这点做得比我细）

```
「上一轮分镜任务仍在停止或恢复中，请稍后再继续」
「分镜已创建，本轮不能更换规划模型」
「分镜已创建，本轮使用的剧本可在这里查看」
「分镜已经创建，不能替换本轮规划剧本」
「剧本已保存，继续后编写分镜，再按原流程生成」
「前方新增章节，请重新校核承接关系」
「剧本已保存。停止后可替换文本，再继续编写分镜」
「剧本保存失败，请重试后再继续」
```

⇒ **每一步都有「已锁定 / 可回退 / 需重校」的明确状态**，不是我这种「一个 job 跑到底」。

---

## 四 · 其它值得注意的功能

### 提示词工程
```
优化提示词（自动识别编辑指令 / 视频 / 音色 / 人像 / 生图）
全屏编辑提示词
修订提示词
翻译 / 停止翻译保留原提示词
提示词结果存为预设
```

### 资产与音色
```
音频库 / 音色资产库（从已保存的音色资产库中选择）
H3 原生素材
上传图片 / 视频 / 音频素材
全部添加到画布
```

### 导出
```
3D 导出（three.js）
SVG 导出时把文字转成轮廓路径（对方没同款字体也能看）
PNG / JPG / WebP / AVIF 批量转换与重命名
全文导出与备份
```

### 定时任务（我没有）
```
每天查询杭州天气；根据画布技能执行指定创作任务
schedule_targets / schedule_run / schedule_history
```

### 画布持久化（我踩过这个坑）
```
[canvas] localStorage 画布缓存写入失败
[canvas] 初始画布迁移到磁盘失败
[canvas] 浏览器缓存已满，画布仍保存在磁盘
[canvas] 画布存储初始化失败 / 磁盘画布保存失败 / 磁盘画布读取失败
```
⇒ 它做的是 **localStorage 缓存 + 磁盘主存**双写，缓存满了还能落盘。

---

## 五 · 我该抄什么 / 不抄什么

### ★ 抄（按价值排序）

| # | 功能 | 为什么值得抄 | 工作量 |
|---|---|---|---|
| 1 | **画布节点化**（image/video/text/audio/compare/group + 连线语义） | 这是 Agent 协同的地基。没有它，Agent 只能「批量提交」，不能「编排」 | 大 |
| 2 | **chain_from（上一镜来源）** | 首尾帧衔接的正确做法。我现在完全没做 | 中 |
| 3 | **参考图分用途**（图片/动作运镜/声音/全能） | 我现在只有「参考图」一个笼统概念，全塞 ref_image_N | 中 |
| 4 | **分步状态机**（分镜已创建→不能换模型→可停止替换→需重校） | 比「一个 job 跑到底」可靠。我踩过「切工作流留孤儿任务」正是缺这个 | 中 |
| 5 | **界面明确说「这个组合不推荐」** | 比让人试错体面 | 小 |
| 6 | **画布持久化双写**（localStorage + 磁盘） | 我已经踩过「切 tab 状态全丢」 | 小 |
| 7 | **取首帧 / 取尾帧 / 抽音轨 / 按帧裁剪 作为独立工具** | 我的时间轴只有整段替换，没有这些原子操作 | 中 |

### ✗ 不抄

| 功能 | 不抄的理由 |
|---|---|
| 自动做剧全流水线（6 工具） | 它要「小说→章节→剧本→分镜」四道 LLM 环节，本机没有配套的模型服务；且主人要的是「全自动图音视频工作台」，不是「漫剧生成器」 |
| 定时任务（7 工具） | 与本机 ComfyUI 的阻塞队列冲突；且没有明确的用户需求 |
| 3D 导出 / SVG 转曲 / PPTX 预览 | 属于「设计工具」范畴，与本项目的图音视频主线无关 |
| 46 个工具全抄 | 工具越多 Agent 越容易选错。我的项目只需「画布操作 + 生成 + 媒资提取」三类 |

---

## 六 · 与我的工作台的结构对比

| 维度 | YUH | 我的工作台 |
|---|---|---|
| 主对象 | 画布（节点图） | 表单 + 时间轴 |
| 参数在哪 | 节点属性（右键/属性面板） | 底部一行（下拉+输入） |
| Agent 粒度 | 46 个细粒度工具（move/connect/trim） | 10 个粗粒度工具（add_shots/edit_clip） |
| 分镜表达 | 每个 video 节点 = 一镜，chain_from 串起来 | tracks[].clips[] 数组 |
| 首尾帧衔接 | chain_from + 取首帧/取尾帧 | 无 |
| 一致性 | 参考图分 4 种用途 + 角色/道具资产节点 | 只有 ref_image_N |
| 状态管理 | 分步状态机（已锁定/可回退/需重校） | 单一 job（running/done/failed） |
| 产物展示 | 画布上直接看 | 画布（刚做） |

---

## 七 · 结论：我的下一步

**主人要的「全局资产库 + @ 引用」，YUH 的做法是「资产节点 + 连线」。**

它的资产不是「一个列表让你挑」，而是：
```
资产（图片/视频/音频）是画布上的节点
连线到 video/image 节点 = 引用
连线种类决定用途（图片参考 / 动作运镜 / 声音）
```

⇒ **我的 `@` 引用应该做成「从资产库拖/选一个资源，插到当前节点的一个具体用途槽」**，
而不是「在提示词里插一段文字标记」。

这是我从 YUH 学到的最重要一条。

---

## 附 · 证据文件

```
C:\Users\Administrator\yuh-zh.txt    3920 条中文 UI 文案（提取自 renderer bundle）
```
