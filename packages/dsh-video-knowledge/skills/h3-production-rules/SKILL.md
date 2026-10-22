---
name: h3-production-rules
description: 做剧/生图/生视频的硬规则，来自 YUH Studio 实战踩坑（91 条经验的去重归并，每条可追到原文行号）。当要写 H3 提示词、排分镜、定镜头时长、配配音、做首尾帧衔接、用 TTS/声音克隆、或判断一段生成结果为什么不理想时使用。触发词：H3、生视频、分镜、镜头时长、台词、口型、配音、音色、首尾帧、续接、BGM、提示词规范、双胞胎、串脸、运镜、生图比例。
---

# H3 生产规则

> 来源：YUH Studio 的 67 条画布经验 + 24 条用户偏好，去重归并。
> 每条后面括号里是原文行号（`cs=N` = canvas_skills.md 第 N 条；`mm=N` = memory.md 第 N 条）。
> **这不是建议，是踩坑换来的硬规则，带实测数字。**

---

## 一 · 台词（最容易错，违反概率最高）

### 1.1 标准写法

```
有台词的镜头：
  The young woman with a quiet, breathy voice (S1) says: <d>[Chinese] 台词</d>

画外音 / 读信 / 内心独白：
  <Audio 1> SU QING (S1) says in an off-screen voiceover: <d>[Chinese] 台词</d>
  while her lips remain completely closed and do not move at all.
```

**四条硬规则：**
```
① 台词必须包进 <d>[语言] 文本</d>，说话人身份写在 <d> 外面（cs=42）
② 每个说话人给稳定 ID (S1)(S2)，全片一致；不说话的角色不给 ID（cs=42）
③ <Audio N> 后面不要写「说」字 —— 会被念出来（cs=19）
   ❌ <Audio 1> 说："台词"
   ✅ <Audio 1>："台词"
④ 画外音必须逐字用 "says in an off-screen voiceover"，
   且紧跟 "lips remain completely closed"（cs=32, mm=17）
   ⇒ 否则画面里的人会跟着张嘴乱念（分镜3 读信踩过）
```

**`lips remain completely closed` 要塞进【每一句】的引导语里，不能只在最后统一写一次**（mm=17，实测会失效）。

### 1.2 时长（最容易忽略）

```
中文语速约 4~5 字/秒。
⇒ 一句台词按字数给足秒数，句间留停顿（写 "A short pause"）

★ 一旦连线了音色参考，人物约 4.5s 才开始说话（cs=22）
  ⇒ 有台词的分镜时长一律 ≥10s，台词多的给 12~15s
  ⇒ prompt 时间轴把台词统一放在 4.5s 之后开始
  ⇒ 无台词的纯动作特写可不受此限

H3 单镜上限 15s。台词塞不下就砍句或拆镜，贪多必吞字（cs=32）
```

### 1.3 长台词必须拆

```
❌ 整段塞进 prompt → 模型一次念不完，漏字/吞词（cs=13）
✅ 拆成短句，一句一行，每句单独一个 <Audio N>
   <Audio 1>："你知道吗。"
   <Audio 1>："遇见你之后，我才发现。"
```

---

## 二 · 提示词（第二大坑）

### 2.1 正文一律英文

```
★ 除 <d>[Chinese] 台词</d> 之外，提示词正文【一律英文】（cs=44）

原因：实测 H3 会把提示词里的中文守则念出来
      用户听到分镜4 末尾念出「本镜只有苏晴一人」

⇒ 防克隆/防定格/人数站位/机位等守则全部改英文写：
   "Only two named people exist in this shot: SU QING (left) and
    LIN FENG (right); no duplicates, no clones, no mirror images,
    no extra faces."
```

### 2.2 三段式结构（官方规范，cs=15）

```
① integrated_multimodal_description
   按时间轴写每镜：整体风格（Cinematic / live-action / 2D-animated 标在段首）、
   构图、主体外观位置、环境光、动作状态变化、镜头运动、台词与同步音效

② overall_soundscape
   全片环境声与物理动作声

③ non_diegetic_music
   仅观众可听的 BGM
```

**四种基础模式的前置声明：**
```
I2VA（图生视频） 正文前加一行：
  "For the target video, at 0.00 seconds into the target video,
   <Picture 1> (from [Shot 1]) is fully referenced."

FL2VA（首尾帧）  写清 Picture1 对齐 0.00s、Picture2 对齐末帧秒数

L2VA（末帧）     末帧图只属于最后 [Shot N]
```

**全参考 Ref2VA 六段式（cs=16）：**
```
subject_definitions → summary → retention_analysis
→ detailed_description → overall_soundscape → non_diegetic_music
（retention_analysis 说明参考内容如何保留/迁移/复用）
```

### 2.3 参考标签体系

```
<Picture N>  参考图（作目标帧/分镜锚点）
<Video N>    参考视频
<Audio N>    参考音频（被复制或口型台词）
<Subject N>  从参考资产抽象出的主体

同一标签全文含义一致。
```

### 2.4 避免空泛词

```
❌ cinematic / beautiful / stunning 这类 abstract 空泛词（cs=14）
✅ 具体写构图 / 主体 / 环境 / 动作 / 镜头 / 声音
总时长须匹配请求时长（4~15s）
描述段落用英文，台词与歌词保留原文
```

---

## 三 · BGM 与音轨

```
★ 用户明确要求：视频不要背景音乐（mm=15）

① non_diegetic_music 写 N/A（官方 §4.7，cs=31）
② overall_soundscape 千万不能写 N/A
   —— 那是「全片静音」才用（§4.6）
   环境音/脚步/灯管嗡响要正常写
③ 正文里不要出现配乐描述（钢琴/弦乐/吉他 swell 一律删）
④ 全片所有分镜统一 N/A，别有的镜有配乐
   （否则拼合后一段有音乐一段没有）

★ H3 生成的视频自带语音音轨（画面口型与自带语音对应）
  禁止擅自用别的配音覆盖 H3 音轨（mm=4）
  只有用户明确要求「单独配音」时才做配音并替换
```

---

## 四 · 首尾帧续接（做剧的关键，坑最多）

### 4.1 锚定句必须用英文

```
★ 实测根因（cs=43）：
  应用侧 comicPipeline 的 stripChainFrameLine /
  stripAllChainFrameReferences 会正则剥离提示词里【中文格式】的
  「上一镜结尾画面…：<Picture N>」映射行
  ⇒ 被剥掉后模型丢掉第 0 帧锚定，自己重新构图

  实测数据：中文锚定 → 首帧 vs 上镜尾帧像素差 52（完全不对）
            英文锚定 → 差 3.4（精确锁定）
```

**正确写法（英文，写在最前面）：**
```
Continuity anchor: this video must open at 0.00 s on exactly <Picture 1>,
the final frame of the previous shot of the same continuous scene —
same framing/light/props; no fade-in, no re-establishing shot,
no reframing at the start. The people in <Picture 1> are X and Y
themselves, not new characters.
```

### 4.2 验证方法

```
ffmpeg 抽新镜第 0 帧 + 上镜尾帧
PIL 缩到 64×36 算 mean_abs_diff

  < 5   ⇒ 锁定成功
  > 40  ⇒ 失败，重跑
```

### 4.3 续接的执行纪律

```
① 同场景连续镜：上镜 run 完立刻抽尾帧（-sseof -0.1 ~ -0.2）
② 尾帧接到下镜作【第一个参考图】
③ 严格串行：上镜没生成完不许 run 下镜（cs=23）
④ 换场景才断开续接
⑤ ★ 重跑某镜后必须重新抽尾帧，并把下镜的旧尾帧断开、换接新尾帧
   （cs=45，否则续接的是废片画面）
⑥ ★ run 之前先读连线顺序，确认 <Picture 1> 就是当前这版上一镜的尾帧
   （cs=47，踩过旧尾帧残留锚到废片）
```

### 4.4 模式选择

```
分镜一律 mode=reference（角色/场景/道具/音色全部连线）（cs=46）
  ❌ 不要用 mode=image —— 只吃 1 张图（images.slice(0,1)），
     会把角色/场景/道具参考全丢掉
  ⚠ mode=image / firstlast 会丢掉全部音频参考（cs=29）
    ⇒ 有音色参考、有台词的分镜必须保持 reference

首帧锁定不靠模式，靠：
  ① 英文锚定句写最前
  ② 尾帧作为第 1 张图
  ③ run 完做像素校验
```

---

## 五 · 画面空间逻辑（用户反复强调，最重要）

```
① 肩后视角（cs=24, 25, mm=16）
   凡是角色「看手里拿着的东西」——信封/信纸/手机/书本/照片/证件/屏幕
   特写一律从该角色【肩后同侧】拍，观众看到的画面内容和角色看的一致
   ❌ 禁止正面平铺，否则像拿反了

② 追赶/出场方位要写死
   例：「男主从两个女孩身后追来」= 镜头正对两女、门在她们身后的走廊景深处，
       男主从景深里跑出来
   ❌ 不能写成「从女孩前面的门里冒出来」

③ 人数与站位逐镜写清
   出场角色一个不少、各一人，标明画面左/右/前/后与景深
   双胞胎必须写发型+衣服区分 + 中文防克隆守则
   （❗ 但守则本身要用英文写，见 §2.1）

④ 跨镜动作不重复
   上镜已经跨过门槛/开过门，下镜禁止再跨一次或再开关一次门
   写 "the door stays open and still; nobody steps back out"

⑤ 动作要顺，不要凭空加「停步回头/呆望」这类戏剧动作
   （mm=16，用户明确否掉过）

⑥ 对戏双方必须同框、有空间关系，不能一个人对着空气说话（cs=19）

⑦ 生成前先列全片动作链审计表：每镜承接上镜末态、给下镜留出合理起始态
```

---

## 六 · 防串脸 / 防克隆

```
★ <Picture N>/<Audio N> 编号 = 该节点的【入站连线顺序】
  （图片和音频各自 1 起算，手动槽在最前）
  ❌ 不要按「角色→场景→道具」臆测顺序（cs=26）
  ⇒ 顺序臆测会导致角色串脸/克隆人/台词挂错音色

★ 既然连线顺序不完全可控，prompt 里别用固定 <Picture N> 映射人物（cs=33）
  改用发型+衣服识别：
  "Reference anchors: <Picture 1> is the previous shot's final frame
   (0.00s anchor only). Other pictures show, in no fixed order:
   SHUYAO (低马尾+浅蓝衬衫) / YUNING (长直发+粉开衫) /
   LIN LUO (...) — identify every person by hairstyle and clothing,
   never by picture number."
```

---

## 七 · 生图（Krea2 / Qwen）

```
★ 比例必须在节点参数里设，写进提示词无效（mm=1, cs=1）
  未设比例默认 1280×720 横版

★ 用户说「生成/再生成一个/再出一版」= 新建节点，不覆盖旧节点（mm=5）
  旧节点与旧图原样保留以便对比
  只有用户明确说「这张不好看/重新生成」时才在原节点上重出

★ 生图默认比例用 9:16（竖）或 16:9（横）（mm=9）
  因为图生视频 H3 只输出这两种比例
  其它比例（如 3:4）的图拿去图生视频会被迫适配而变形
  （除非用 reference 参考融合模式才不会变形）

★ 角色资产图必须竖版 9:16，固定排版模板（cs=41）
  画面纵向三等分：
    上 1/3：双头部特写（左纯正面、右 45° 侧面，纯灰背景）
    下 2/3：横向并列三幅全身人设（正面/标准侧面/背面）
  三视图必须同一人物，长相发型肤色服装配饰完全统一
  背景纯灰、不留原图背景，不加外景/杂物/文字/水印
  双手自然放松且不持任何物品
  严禁侧逆光、影子、地面杂物
  生成时 preset 传「默认」（不要叠人物三视图预设，避免追加冲突文本）
```

---

## 八 · 分镜与做剧流程

### 8.1 四条硬规则（cs=34，做剧前先定死）

```
① 台词对白格式与秒数
② BGM 一律禁（除非用户要）
③ 同场景连续镜必须尾帧+锚定+串行
④ 画面空间逻辑（人数、站位、门的方位、动作承接）
```
**这四条决定成片能不能看，比画面漂亮更重要。**

### 8.2 执行流水线（cs=39）

```
① 读小说 → 出分镜表（画面+台词+时长+出场角色+站位）先给用户确认
② 资产：角色三视图 C1/C2…、场景 S1…、道具 D1…（比例写进参数不写提示词）
③ 音色花名册：每个有声角色一段固定 voice_desc，全剧复用同一段文字
④ 逐镜建 video 节点：官方三段式 + 连线资产 + 音色
⑤ 严格按 1→N 串行 run，每镜完成抽尾帧喂下镜
⑥ 全部跑完再拼合
```

### 8.3 分镜禁止项

```
★ 禁止回忆/闪回镜头（mm=14）
  一律只讲当下正在发生的事
  适用于以后所有剧
```

---

## 九 · 配音 / 音色

```
★ audio 音色设计节点的配音文本不能只有一两个字（cs=18）
  例：「哦」→ TTS 合成失败
  ✅ 补成完整句子当音色底本（可复制同角色其他台词或几句正常句子）
     音色文件生成后再在 video 台词里写短句

★ 音色/情绪/语速写在 <Audio N> 之外，标签里只放台词原文（cs=35）
```

---

## 十 · 提速

```
★ video 节点默认 accelLora/steps 为空 → 走默认步数 → 10s 镜头约 150s（cs=48）

显式设：
  steps = 8
  accel_lora = "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"
  （fl2va 族用 fl2v 的 8 步 turbo）

实测：15s 镜头 150s → 107s

要更快可试 4 步：
  minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors + steps=4
```

---

## 十一 · 参数网格（本机实测）

```
H3 的 length 必须落在 17k+5 网格上，没有 24 这一档。

合法值（22 个）：
  5 22 39 56 73 90 107 124 141 158 175 192
  209 226 243 260 277 294 311 328 345 362

吸附规则：
  请求 24 → 22      请求 120 → 124
  请求 240 → 226    超 362 → 362
  奇数网格点退到相邻偶数点（方便后期补帧）
  帧→秒：frames / 24
```

---

## 十二 · 自检清单（提交前逐条过）

```
□ 提示词正文是英文吗？（除 <d> 台词块）
□ 台词包在 <d>[语言] ...</d> 里了吗？
□ <Audio N> 后面有没有误写「说」字？
□ 画外音有没有 "says in an off-screen voiceover" + "lips remain completely closed"？
   每句都有吗？
□ 有音色参考的镜头，时长 ≥10s 吗？
□ 中文台词按 4~5 字/秒算，秒数够吗？
□ non_diegetic_music 是 N/A 吗？overall_soundscape 不是 N/A 吧？
□ 首尾帧锚定句是英文、写最前面了吗？
□ 出场人数、站位写清了吗？双胞胎有区分吗？
□ 有没有正面平铺拍角色手里的东西？
□ 生图比例是在参数里设的，不是写提示词里？
□ 时长落在 17k+5 网格上了吗？
```
