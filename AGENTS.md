# DSH 视频工作台 · 项目约定

> 这是本项目的行为约定。**踩过的坑全部写在 §三，改代码前先读那一节。**

---

## 〇 · ★ Hindsight 是常驻记忆工具（2026-10-21 主人指定，最高优先级）

> 主人原话：「临时让 hindsight 作为常驻记忆工具，目前的方法经常失灵忘记」
> 「hindsight 的 MCP 应该很全面的，不要出现手动 ping 和手动 ssh 灌输这种低级错误」

**为什么不靠 AGENTS.md**：它有 64KB 注入预算，2026-10-21 已达 63.4KB，
只剩 0.6KB —— 装不下新教训，超限还会被截断（截掉的正是最新的）。
⇒ **能进 Hindsight 的就进 Hindsight，AGENTS 只留指针。**

### 什么时候必须查（不是可选）

| 触发 | 调用 |
|---|---|
| **任何新任务/新需求开始时** | `hindsight_search_knowledge_pages(query)` |
| 报错、说「不对」「又坏了」 | 先查是否已有根因记录 |
| 问「为什么这样设计」「还剩什么」 | 先查，别重新推导 |
| **要改测试 / 写新代码 / 动配置** | 先查本项目约定与既往决策 |
| 遇到似曾相识的问题 | 先查，别从零再撞一遍 |
| **查 DSH 有哪些 slot / 插件怎么挂载 / 某个包管什么** | ← ★ 这里最容易绕过 Hindsight 去做低级活 |

### 工具顺序（照这个来，别自己发明）

```
① hindsight_search_knowledge_pages(query)   ← 入口，先搜知识页
② hindsight_read_knowledge_page(id)         ← 命中后读全文
③ hindsight_reflect(query)                  ← 页面太浅才深推
④ hindsight_ingest_document(title, content) ← 查到新结论当场写回
⑤ hindsight_list_tags(prefix) / hindsight_read_memory_chain(tag)  ← 找不到家族时
⑥ hindsight_diagnose()                      ← 怀疑记忆坏了时（不要假设库是空的）
```

### ★ 反模式（今天真实犯过，不要再犯）

```
❌ 手动解析 app.asar 用 PowerShell 读字节，去找 DSH 的 slot 列表
   → 该用 hindsight_search_knowledge_pages("DSH slot 挂载点")
   → Hindsight 里有：kind/scope 声明、id/order vs key/priority 的区别、
     渲染点行号、apply 要包 try/catch —— 比我手工挖到的还全

❌ 手动 ping / 手动 ssh 灌记忆
   → MCP 工具直接可用，不需要探物理连通性

❌ 翻磁盘目录找知识库（<WORKSPACE>\DSH源码知识库 是空目录）
   → 知识库是逻辑资源，走 MCP，不是 Test-Path
```

**判据一句话：动手前先问「这件事 Hindsight 里有没有？」**
没查就动手 = 可能重复别人已经踩过的坑，也可能像今天一样白挖一遍 asar。

---

> ⚠ **AGENTS.md 体积纪律**（现在 50.2KB，预算 64KB）：
> 新教训优先 `hindsight_ingest_document`，不要往这里堆。
> 这里只留「一句话结论 + 判据 + 指向 Hindsight 的查询词」。

## 一 · 项目是什么

把「视频工作站」做成 DSH 插件，生成走本机 ComfyUI 8188。对标 YUH Studio 的创作链路（角色卡 / 分镜 / 逐镜生成 / 首尾帧衔接 / 拼接），但全部跑在 DSH 内。

**四个可插拔模块，一个房间一个房间交付：**

| 模块 | 职责 | 状态 |
|---|---|---|
| M1 `dsh-comfy-bridge` | host 侧：ComfyUI 桥 + bind 层 + HTTP 路由 | ✅ |
| M2 `dsh-comfy-workbench-tab` | 中栏 `conversation.view` tab | ✅ |
| M3 `dsh-comfy-canvas` | 画布（延后） | ⬜ |
| M4 `dsh-comfy-preset` | Agent 预设 + 技能 | ✅ |

**三个工作流，三个职责，不混用：**
```
krea2         → 生图（文生图 + 双采精修）
qwen21-edit   → 改图 / 洗图 / 生骨骼图 / 换装
yz            → 生视频（H3 文武双全）
```

## 二 · 硬约束

1. **不许重启 ComfyUI** —— 主人在用。M1 只发请求，从不启动任何东西。
2. **不重启主人正在用的 DSH 实例（19387）** —— 测试走独立 profile `comfy-test`（端口 19499）。
3. **不装第三方 UI 插件** —— 右栏会话用官方 `ui-subagent` 的 `subagentchat`。
4. **代码里不写死模型名与节点 id** —— 工作流是运行时输入。已知例外：`qwen21-edit.bind.json` 的 `always.set` 指向 `459:484`，那是 bind 数据不是代码。
5. **改任何磁盘工作流前先备份 `.bak`**。
6. **数字必须数出来，不是估的。没跑过的写「未验证」。**
7. 每个模块必须通过自己的验收脚本才算完成。

## 三 · ★ 踩过的坑（改代码前必读）

### 3.1 cordis 插件层面

```
❌ apply() 返回对象
   报错：TypeError: Invalid effect
        at safeCollect (cordis/lib/index.js:1140)
   修：apply 只能返回 undefined 或合法的 effect 函数

❌ export const inject = ["@deepseek-ai/dsh-client-locale", ...]
   报错：pending (waiting for services: @deepseek-ai/dsh-client-locale)
        web boot: 1 entry did not activate
   原因：inject 里写的是【服务名】，不是【包名】
   正确：["slots", "locale"]  — 照 ui-trajectory 的写法
   包名只出现在 package.json 的 dsh.client.inject

❌ export const inject = []（M1 host 侧），但 apply 里访问 ctx.webServer
   报错：cannot get property "webServer" without inject
   修：inject = ["webServer"]
```

### 3.2 host / client 是两棵独立的树

```
❌ 以为 M1 的 ctx.provide("comfy", remote) 能让浏览器侧的 M2 直接用
   事实：host（Node）与 client（浏览器）是两棵独立 cordis 树，
         ctx.provide 只在各自树内可见，跨不过进程边界。
   正解：M1 用 ctx.webServer.register 暴露 HTTP 路由，M2 用 fetch 调。
```

### 3.3 dsh-host-webserver 的 prefix 路由（连踩两次）

```
源码逐字（lib/index.js）：
    const rawPath = new URL(req.url ?? "/", "http://x").pathname;
    const route = this.match(rawPath);
    if (route !== void 0) { await route.handler(req, res); return; }

❌ 坑 A · 注册的 prefix 带尾斜杠
   match() 逐字：if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
   它自己会拼 `${prefix}/` ⇒ 注册 "/job/" 要匹配 "/job//"，永不命中。
   正解：注册 "/comfy-bridge/job"，请求 "/comfy-bridge/job/xxx"

❌ 坑 B · 以为 handler 拿到的 req.url 已剥离前缀
   事实：rawPath 只用于匹配，传下去的仍然是【原始 req】，req.url 是完整路径。
   （我先写 slice(prefix.length) 切空，又改 slice(1) 切错 —— 同一个点踩两次）
   正解：从完整路径里剥掉 mount + "/"
```

### 3.4 客户端 bundle 格式

```
❌ 写成 ESM（import/export）
   事实：lib/client.js 必须是 IIFE：
       window.__ModuleLoader__.load({
           id: "包名",
           factory: (require) => {
               var module = { exports: {} };
               var exports = module.exports;
               let react = require("react");
               ...
               exports.apply = apply;
               exports.inject = ["slots", "locale"];
               return module.exports;
           }
       });
   lib/index.js 才是 ESM（export function apply() {}）
   宿主不编译源码 —— 缺 lib/client.js 会直接激活失败。
```

### 3.5 产物图片显示不出来

```
❌ M2 直接拿 o.url 当 <img src>
   o.url = "/api/view?filename=..."（ComfyUI 的相对路径）
   ⇒ 浏览器去请 DSH 的 /api/view → 404
   ⇒ 界面显示「完成 · 24.0s · 2」但两张图 naturalWidth=0（空白）

✅ 修：viewUrl() 拼到 M1 health 返回的 comfyBase 上
   实证：host=127.0.0.1:8188，img 1368×768 loaded:true
```

### 3.6 工作流语义层（最隐蔽）

```
❌ Qwen 改图不按指令执行
   现象：指令写「change to red Chinese silk dress」，输出只把长裤改成短裤。
   根因：ComfySwitchNode(459:484).switch = false
         on_false = 硬编码 "Replace costumes for the character"   ← 模型看到的是这句
         on_true  = TextGenerate(459:500) 的输出                  ← 用户指令在这，被丢弃
   判据：耗时 27s（没跑增强器）vs 144s（跑了增强器）
   修：bind 里加 always.set 强制 switch=true
   ⇒ 教训：工作流「能跑通」不等于「按用户意图跑」。要看每条支路最终喂给模型的是什么。
```

### 3.7 验收断言自己过期

```
❌ 写死 modes.length === 3，加了 qwen21-edit 后变 4 ⇒ 整套验收变红
   ❌ 写死节点数 > 100，实际 26（41 − 10 媒体剪枝 − 5 武打剪枝）⇒ 误报
   修：断言写成「≥N 且核心项齐全」，不硬编码总数。
       加工作流 / 加节点不该让断言变红。
```

### 3.8 ComfyUI 显存

```
H3 主模型 19.5 GB，RTX 5070 Ti 只有 16 GB。
跑 yz 前先 POST /free {unload_models:true, free_memory:true}
实测：3.4 GB free → 14.9 GB free
```


### 3.9 参数区 UI（主人 2026-10-18 明确要求，优先级高于任何方案书）

```
★ 三角在下拉框的【左边】，不在右边
   主人原话：「那个下拉的三角要在文字左边，现在放在右边太远了，看不见」
   实现：padding: "0 8px 0 18px"（左留 18px）+ arrow { left: 5 }

★ hover 底色只覆盖【文字宽度】，不覆盖整槽
   主人原话：「hover时的背景变淡最好控制一下范围，目前太大了，
             刚好覆盖住需要的文字即可」
   实现：绝对定位的 .wb-hl 高亮层，内含「三角 + 当前选项文字」

★ 切选项后控件【不许位移】
   主人原话：「要保证ui不会切换这部分的选项后因为文字长短不同出现位移」
   实现：控件占位由外层 grid 列决定；高亮层用 absolute，不参与布局
   验证：把每个下拉在所有选项间切一遍，getBoundingClientRect().x 必须全等

★ 参数区只有【一行】。核心区域留给提示词与成果展示。
   主人原话：「为什么不是四个可下拉的选择框？这样不是脱裤子放屁吗？要简洁！
             把核心区域留给成果展示和提示词」

❌ 曾经的错误做法（不要再犯）
   · 胶囊按钮排参数，每个参数一行标签 → 吃掉 4 行，比提示词框还高
   · 三角放右边（方案书 §3.4 初版写错了，后来被主人推翻）
```

### 3.10 DSH 没有的 token（会静默降级，不报错）

```
❌ --dsw-alias-button-primary-fg     实测 403 个 token 里没有
   → 降级成写死的 #fff → 暗色下底是近白 #f9fafb，白字白底，对比度 1.00
✅ 改用 --dsw-alias-label-primary-foreground
   它在浅色下是白、暗色下是黑，正好与 button-primary-fill 的翻转配对
   修后实测对比度 18.08 : 1

❌ --dsw-alias-bg-layer-2   浅色下 = #fff，与面板同色
   → 写「1px 边框 + bg-layer-2」等于白底白底 + 淡边框
✅ DSH 官方是 0 边框 + hover 变色

❌ --dsw-focus-ring-color    实测值是 transparent（空）
✅ DSH 自己回退到 --dsw-alias-state-business-primary，焦点环用 box-shadow 不是 outline
```

### 3.11 删 lib/client.js 会让整个 DSH 崩溃

```
❌ 想验证「无头模式」就删掉 lib/client.js
   报错：ClientModuleRegistry.captureArtifactBaseline
        at ClientModuleRegistry.reconcilePackage
        at new ClientModuleRegistry
   原因：package.json 声明了 dsh.client，DSH 扫描时就要求 client.js 存在
        缺失直接崩宿主，不是「跳过这个插件」

✅ 正确的无头模式做法：从 package.json 移除 dsh.client 整段
   实测（2026-10-18）：
     · dsh-comfy-workbench-tab 去掉 dsh.client → /comfy-bridge/health ok, modes=4,
       /timeline/snapshot total=4，UI 消失但能力全在
     · dsh-editor 去掉 dsh.client → /timeline/snapshot /align /assets 全部可用
   装回 dsh.client → UI 出现，功能正常
```

### 3.12 宿主对插件文件的写入冲突

```
现象：两个会话/子代理同时改 src/WorkbenchView.js，后写的覆盖先写的，
      且互相以为对方「改了不该改的地方」。
判据：改前先看 mtime，改后再看 mtime；不一致就是被人覆盖了。
纪律：同一文件同一时刻只让一个执行者写。UI 专员与我同时改同一个文件时，
      以【主人的最新要求】为准，不以方案书为准（方案书可能已过时）。
```

### 3.13 质检查出的 7 个真 bug（2026-10-18 独立复核 + 已修）

```
① 二采关闭仍传 steps2 → 500 "工作流里找不到 node=221"
   根因：prunedNodes 只记录【素材剪枝】，没记录【toggle 剪枝】
        setInput 误判成「bind 写错了」而抛错
   修：toggle 的 branch.delete 循环里也 prunedNodes.add(id)
   实测：{"error":"找不到 node=221"} → {"jobId":"...","nodes":12}

② 置灰的画幅仍在传 aspect → 静默改掉输出尺寸
   根因：params 里 aspect 无条件发送（batch/steps2 都有条件，只有它漏了）
   实测：qwen21-edit 不传 aspect → 1024×1024（工作流原值）
        传 aspect:16:9    →  832×480（被 aspectToSize 反推）
   修：if (caps.aspect) params.aspect = aspect;
   教训：置灰的控件必须同时挡住【数据】，不能只挡鼠标。

③ 生成失败 = 永久轮询，错误永远看不到
   根因：ComfyUI 对失败也写 history（status_str="error"，completed=false），
        前端只判 j.completed ⇒ 永不停止
   修：加 statusStr 终态判定（error/failed/cancel）+ job.failed 渲染分支
       + busy 也要排除 failed（否则按钮永远禁用没法重试）

④ 步数显示「4 步」实发 40/25
   根因：STEPS=[4,6,8,10,15,20]，但 qwen21 默认 40、qwen21-edit 默认 25
        find 返回 undefined → 回退 options[0] → 显示第一项
   修：当前值不在列表时，插进去当额外选项（opts = [{value,text:String(value)},...options]）
   教训：显示值必须等于提交值，凡有「兜底到第一项」的地方都要查。

⑤ 生成中切工作流，旧轮询把旧结果塞回新界面
   根因：pickMode 里 setJob(null) 但没 stopPoll()，1.5s 后旧 setJob 覆盖
   修：pickMode 开头 stopPoll()

⑥ 桥挂了伪装成「没有工作流」
   根因：modes() 的 catch 返回 [] ⇒ modesState="empty" ⇒ 提示「去改 workflows/ 目录」
        把用户往错误方向带
   修：modes() 不吞异常；UI 加 modesState="error" 分支显示真实错误
   附带：__degraded 是死代码（bridge.js 从不设置它），要么删要么真赋值

⑦ 无限请求疑云（实测否定）
   担心：inject 每次渲染都新建 bridge → useEffect([bridge]) 无限重发
   实测：静置 10 秒 0 新请求；切 tab 3 轮 0 新请求
   结论：宿主缓存 inject 返回值，不是 bug。
```
## 四 · 目录

```
<REPO>\
├── AGENTS.md                          ← 本文件
├── docs\
│   ├── 草稿\草稿-DSH视频工作台.md      ★ 否决留痕，永不删
│   ├── 方案-DSH视频工作台.md
│   ├── evidence\                      实测证据（图片/视频产物）
│   └── 调研\
└── packages\
    ├── verify-all.mjs                 一键总验收
    ├── dsh-comfy-bridge\              M1
    │   ├── src\{index,comfy,workflows,length,verify-workflow}.mjs
    │   ├── workflows\*.json + *.bind.json
    │   └── verify-{m1,m1-http,krea2,qwen-edit,yz}.mjs
    ├── dsh-comfy-workbench-tab\       M2
    │   ├── src\  （可读源码，供参考）
    │   └── lib\  （实际加载：index.js ESM + client.js IIFE）
    └── dsh-comfy-preset\              M4
        ├── preset.yml
        ├── agent.cordis.yml
        └── skills\comfy-mode-dispatch\SKILL.md
```

## 五 · 常用命令

```powershell
# 总验收（含真生成，约 5 分钟）
cd <REPO>\packages
node verify-all.mjs

# 只跑离线检查
node verify-all.mjs --static

# 起测试实例（不动主人的 19387）
pwsh -NoProfile -File <HOME>\restart-test.ps1

# 静态验证某个工作流（不提交，只查节点/连线/值类型）
cd packages\dsh-comfy-bridge
node src\verify-workflow.mjs workflows\qwen21-edit.json
```

## 六 · 2026-10-18 新增踩坑（全部有实测证据）

### 6.1~6.22 → 已迁入 Hindsight（2026-10-21）

```
★ 为什么迁走：AGENTS.md 有 64KB 注入预算，2026-10-21 时已达 63.4KB，
  只剩 0.6KB。超限会被截断，而截掉的正好是最新教训。

★ 现在怎么查（不要再往这里堆）：
  ① hindsight_search_knowledge_pages("ComfyUI 显存 / ffmpeg 抽帧 / toggle delete / cwd")
  ② 原文也在：docs\踩坑-归档-6.1到6.22.md

★ 这 22 条里仍有约束力的几条（改代码前必须知道）：
  · python 用 ComfyUI\.venv\Scripts\python.exe，不是 standalone-env
  · ffmpeg 单图输出必须 -update 1，且在 -i 之后（放前面会报「输入文件打不开」，极易误判）
  · 抽帧/临时文件只能写工作区（沙箱限制），不能写 C:\ 或 ComfyUI input
  · 8188 对带 Origin 的请求一律 403 ⇒ 资源必须走 /comfy-assets/view 代理
  · process.cwd() 不可靠（重启丢数据）⇒ 用 import.meta.url 推导
  · 新字段必须同时改三处：序列化 / 反序列化 / 对象构造
  · 改 toggle 的 off.delete 前先跑 tools\check-toggle-deps.mjs
  · 提交成功 ≠ 执行成功，必须查 /history 的 outputs 节点数
```
### 6.23 数据都在，只是漏了一个转换（2026-10-19，复核员打穿三条）

```
★ 独立复核（子代理 2e3543a0）一次打穿 3 条，共同特征：
  数据都存在，只是某条路径上漏了一个转换或一个判断。
  这类缺陷【不报错、不崩】，只能靠对着实际输出核对。

① audit 假阳性（最严重）
   quality.mjs 的 summary 只判 badSeams 与 defects，errors 既不参与
   summary 也不参与 rerunSuggestion。
   实测：喂 5 个内容全坏的文件（文件存在但读不出）→
         "5 段全部通过（0 处接缝都接得上）"
   对着坏文件说「质量合格」比报错更危险 —— 会让人以为片子没问题。
   修：
     · 加 judged = list.length - errors.length
     · 全都没判出来 → "N 段全部无法判定"，绝不报通过
     · 部分判出来 → "M 段通过 · N 段无法判定"
     · rerunSuggestion 补 errors 的段
   顺带：errors 有两种形状 {seam} 与 {clip}，
         直接 map(e => e.clip) 会取到 undefined，去重后变 null。
         要 filter(Boolean)，并把 {seam} 的单独映射。

② hover 底色盖满整槽，不是只盖文字
   AGENTS §3.9 写的「绝对定位 .wb-hl 高亮层」在源码与 lib/client.js 里
   都是 0 命中 —— 文档描述的方案从未实现。
   实际是：背景挂在 button{width:100%} 上，槽宽 96px，文字只有 62~86px。
   修：背景移到内层 span（只包「三角+文字」），按钮保持 width:100% 占位。
   实测：按钮 96px / 内层 84px / 按钮背景 transparent / 内层 rgba(38,49,72,.06)

③ 「放大模型」下拉两个选项是空的
   其它下拉都做了 {v,t} → {value,text} 映射（MEGAPIXELS / BATCHES 都 .map 过），
   只有 SEEDVR_MODELS 直接传了原数组。Select 读 o.text 得到 undefined。
   实测：修复前 ["seedvr2_7b_int8_convrot.safetensors", "", ""]（3 个，第 2、3 空）
         修复后 ["7B", "3B"]
   那多出来的第 3 个是 Select 的「当前值不在选项里」兜底项，
   因为选项 value 也是 undefined，匹配不上任何值。

★★ 排查方法：凡是「同一组下拉/同一组卡片/同一组判定」，逐个比对
   它们的构造方式。③ 就是靠 grep `options: [A-Z_]+,$`（无 .map）找出来的。

### 6.24 存档损坏要隔离，不能静默清零（2026-10-19，复核员附带发现）

```
❌ 原实现：load() 里 JSON.parse 失败 → 只 log.warn → 返回失败
   危害链：
     ① 存档损坏
     ② 服务照常启动，时间轴是空的
     ③ 用户以为「这次没数据」，开始操作
     ④ 下一次 writeNow() 用空状态【覆盖】坏存档
     ⑤ 原始数据永久消失，且无法与「本来就是空的」区分

✅ 修：quarantineCorrupt() —— 用 renameSync 隔离成
     <原名>.corrupt-<ISO时间戳>，再把备份名放进 reason 里告诉调用方。
   实测：load 返回
     {"ok":false,"reason":"存档损坏（原文件已备份为
       timeline-state.json.corrupt-2026-10-18T18-02-51-815Z）"}
     隔离后磁盘上确实留着 31 字节的原坏文件，可人工修复后改回原名。

★ 为什么用 rename 不用 copy：原子、不占双倍空间。
★ 隔离失败（权限等）也不阻断启动，只额外 warn 说明「下一次写入会覆盖它」。

### 6.25 控件启用 ≠ 数据会传下去（2026-10-19）
（细节见 docs\踩坑-控件是摆设-20261019.md）

```
★★ 本项目最严重的缺陷：主人调了两天的参数，一个都没生效。

现象：画幅/尺寸/张数/放大模型 四个下拉能点能显示能持久化，
     但提交给 ComfyUI 的全是工作流默认值。

根因（onGenerate 里）：
  const params = { prompt, steps, toggles };
  // 只补了 files/refLabels/steps2/seed，从未补 aspect/megapixels/batch/seedvrModel

❌ 为什么一直没发现
  界面显示对（state 更新了）、生成能成功、输出尺寸「看起来正常」
  ⇒ 只有对比「界面选的值」与「ComfyUI 收到的值」才能发现

★★ AGENTS §3.13 ② 曾写过「修：if (caps.aspect) params.aspect = aspect;」
   但 grep 代码 → 这一行【从未存在】。文档说已修，代码没有。
   ⇒ 「写在文档里的修复」不能当证据，必须 grep 代码。

✅ 修：四项都先问 caps
   if (caps.aspect) params.aspect = aspect;
   if (caps.megapixels) params.megapixels = Number(megapixels);
   if (caps.batch) params.batch = Number(batch);
   if (caps.seedvrModel && toggles?.seedvr) params.seedvrModel = seedvrModel;

★★ 纪律：加控件必须同处加 params 赋值；验证方式是【劫持 fetch 看真实 body】，
   不是「看界面」。对偶命题同样成立：启用的控件必须真的传数据。

★ 已固化：check-param-closure.mjs（25/25）
```


### 6.26 hook 的依赖变量必须先定义（2026-10-19，TDZ）

```
❌ 我加了一个 useMemo 做「参数组合提醒」，依赖里写了 secondPassOn，
   但把 useMemo 放在 secondPassOn 定义【之前】：
     const paramWarnings = useMemo(() => { ... }, [..., secondPassOn]);   ← 1213 行
     const secondPassOn = caps.secondPassToggle ? ... : true;             ← 1243 行

   报错：ReferenceError: Cannot access 'secondPassOn' before initialization
   表现：整个工作台渲染成一句话「[comfy-wb] 渲染出错：ReferenceError ...」
        但页面不崩（SafeMount 兜住了），只有工作台那块没了。

★ 这在 React 里是 TDZ（暂时性死区）——
  const 声明的变量在定义行之前不可访问，即使 hook 的回调还没执行，
  依赖数组里的【引用】就已经求值了。

★ 与 §6.20 的关系：
  §6.20 是「加 useState 就崩」（原因至今未查明，用 useRef 规避）
  本条是「useMemo 依赖了后定义的变量」（原因明确，是 TDZ）
  两者表现都是「工作台那块渲染成错误文字」，但根因不同，不要混为一谈。

✅ 修：把整块 useMemo 移到 secondPassOn 之后。

★★ 排查方法（加 hook 前做）：
   1. 列出 hook 依赖数组里的每个变量
   2. grep `const <变量名>` 看它的定义行号
   3. 全部必须在 hook 之前
   4. 尤其注意 `caps.xxx` 派生的变量（如 secondPassOn）——
      它们定义在组件中段，很容易被前面的 hook 引用

### 6.27 「持久化的视野」和「持久化的排版」必须同生共死（2026-10-19）

```
❌ 磁盘 .state/canvas-state.json 里存着：
     {"view":{"x":219,"y":75,"s":1}, "pos":{}, "at":...}
                                 ↑ scale=1，而 pos 是空的

   恢复逻辑无条件 setView(j.view)，把这个 scale=1 的旧视野回灌进来；
   而 pos 空 ⇒ 不设 userMovedRef ⇒ 之后 fit 又等不到完整的 pos。
   结果：16 张卡片以 scale=1 排在 4 列，右侧溢出 714px。

   ★ 为什么特别隐蔽
     · view 看起来像「有效的用户设置」（它确实是个合法的 {x,y,s}）
     · 实际上它是【孤儿】—— 没有 pos 的 view 没有任何意义
       （fit 会重算视野，用户手动的视野也需要 pos 才有参照）
     · 只恢复一半，比两个都不恢复更糟

✅ 修：只有 pos 非空时才算「有可恢复的排版」，才回灌 view
     const hasPos = j.pos && Object.keys(j.pos).length > 0;
     if (hasPos) {
       setView(j.view);
       setPos(j.pos);
       userMovedRef.current = true;
     }
     // pos 空 ⇒ 什么都不回灌，交给自动 fit 重新算

   实测（16 张卡 / 清空 localStorage）：
     修复前  view = matrix(1,0,0,1,219,75)      卡片最右 1323，画布右 609，溢出 714px
     修复后  view = matrix(0.45,0,0,0.45,28.3,56) 卡片 100~565，画布 56~609，左右各余 44px

★ 排查过程记一笔（我自己走了三轮弯路）：
   ① 先怪 Math.max(0, ...) 把居中量截断 —— 那行本来是对的
   ② 再改 fit 的触发条件（要求 pos 覆盖全部卡片）—— 条件对，但脏数据让它永不成立
   ③ 再用 requestAnimationFrame 推迟调用 —— 治标，脏数据还在
   ④ 最后读磁盘文件才看到 pos:{} —— 根因在这
   ⇒ 教训：**先看持久化的实际值，再猜代码逻辑。**
     这三轮改的都是「消费方」，问题在「数据源」。

★ 通用纪律：一个对象的多个字段如果【语义上必须一起存在】，
  恢复时必须一起判、一起恢复。单个字段的恢复条件不能只看它自己有没有值。

### 6.28 「成对字段」排查清单（2026-10-19，§6.27 的推广）

```
★ §6.27 的根因是「view 与 pos 语义上必须一起存在，但只恢复了 view」。
  按这个模式把工作台里其它成对字段逐个查了一遍。
  结论：只有画布那一处是缺陷，其余都是有意的分层设计。

已知的成对字段及其判定：

① view + pos（画布）              ★ 真缺陷，已修
   恢复时必须一起判：hasPos 为真才回灌 view

② files[slot].role + base64        ✅ 不是缺陷
   role 在前端 tagReferences() 转成 <Subject N> 文本，
   后端只读 params.refLabels —— 这是分层，不是漏传。
   判定方式：grep 后端有没有读 params.refLabels → src/index.js:154 有。

③ toggles[name] + steps2           ✅ 不是缺陷
   if (caps.steps2 && secondPassOn) params.steps2 = ...
   二采关掉时【故意】不传 steps2（§3.13 ① 修过的坑：
   关了还传会导致「工作流里找不到 node=221」）。

④ job + promptId                   ✅ 不是缺陷，同一对象里

⑤ sessionStorage 的 12 个字段      ✅ 不对应关系
   modeId/prompt/negative/aspect/durationSec/steps/steps2/
   batch/megapixels/seedvrModel/seed/toggles —— 与 params 一一对应。
   files（含 base64）【故意不存】—— 大对象会撑爆 sessionStorage 配额。

★★ 判定「是不是真缺陷」的两步：
   1. 这个字段是不是【另一个字段的派生或前置】？
      是 ⇒ 它可能只是前端的中间产物（如 role → refLabels），不算漏传
      否 ⇒ 继续看第 2 步
   2. 两个字段是否【语义上必须同时存在】才有效？
      是 ⇒ 恢复/保存都必须一起判（如 view + pos）
      否 ⇒ 各自独立，不用管

★ 排查话术：不要问「这个字段有没有传下去」，
  要问「没有它，另一个字段还有意义吗」。
  view 没有 pos → 无意义（view 的参照是卡片的包围盒）  ← 孤儿
  role 没有 base64 → 无意义（没有图就谈不上用途）      ← 但被前置校验挡住了
  steps2 没有 secondPass → 无意义（二采关着，步数给谁用）← 代码已用 && 挡住

### 6.29 必填素材没标 required = 悄悄用内置示例图跑（2026-10-19）

```
❌ qwen21-edit 的 ref_image_0「原图（要改的）」在 bind 里没写 "required": true
   ⇒ workflows.mjs:312  `required: spec.required === true` 得到 false
   ⇒ 前端不校验、后端不拦

   实测（2026-10-19）：
     提交 { modeId: "qwen21-edit", prompt: "make it red", steps: 4 }
     —— 完全不带素材
     结果：✓ 提交成功，16 个节点
     ⇒ 用工作流内置的示例图（459 系列里的默认图）跑完了
     用户以为改的是自己的图，实际改的是一张别人的示例图。

★ 为什么是最难察觉的一类
   · 不报错
   · 有输出
   · 输出还是「改过的图」（只是改的不是用户那张）
   · 和 §3.13 ⑥「桥挂了伪装成没有工作流」同构：
     功能没生效，但界面显示成功

✅ 修：bind 里给 ref_image_0 加 "required": true
   实测修复后：
     提交同样 body → {"error": "槽 ref_image_0（原图（要改的））是必填，但没提供文件"}

★ 为什么 ref_image_1（参考图）【不】设必填
   只写指令不改风格是有效用法（"把裤子改成红色"不需要参考图）。
   ⇒ 必填与否要按【语义】判，不是「全部都必填更安全」。
      需要原图才谈得上「改图」；参考图是可选增强。

★★ 排查纪律：
   每个工作流的 media 槽，都要回答「没有它，这个功能还成立吗？」
   不成立 ⇒ 必须 "required": true
   成立   ⇒ 保持可选
```

### 6.30 schema 的 required 不是运行时拦截（2026-10-19）

```
❌ timeline_add_shots 的工具定义里写了：
     items: { ..., required: ["prompt", "modeId"] }
   —— 但那只是给 LLM 看的【提示】，execute 里没有任何校验。

   实测：execute({ shots: [{ prompt: "x" }] })（缺 modeId）
     → 建出了一个 shot.modeId = undefined 的分镜
     → 等生成时才报「未知模式：undefined」
     → 错误位置（generate）离原因（addShot）很远

✅ 修：在 host-store 的 addShot() 入口拦住
     if (!modeId) throw new Error("分镜缺 modeId（工作流）：yz / krea2 / qwen21-edit 之一");
     if (!String(prompt ?? "").trim()) throw new Error("分镜缺 prompt（提示词）");

★ 通用纪律：**JSON Schema 的 required 是文档，不是校验器。**
  凡是写进 required 的字段，execute 里都要有对应的显式检查。
  检查方式：grep 每个工具的 required 列表，对照它的 execute 有没有判空。

### 6.31 加了校验之后验收变红 = 验收里有放松的假设（2026-10-19）

```
★ 这一轮加了两道校验（addShot 的 modeId/prompt、素材四项），
  结果让两个「一直绿」的验收变红。两个都是【验收脚本自己的问题】：

① verify-persist-restart 调用签名写错
     写的是 store.addShot(vt.id, { modeId: "yz", ... })   ← 多传了 trackId
     实际签名是 addShot({ modeId, prompt, ... }, who)
     ⇒ 从 vt.id 解构出来的 modeId 是 undefined
     ⇒ 之前没校验，所以「假通过」；加了校验才暴露

② verify-persist-host 断言用全等比较文案
     写的是 r.reason === "存档损坏"
     我给 reason 加了「（原文件已备份为 xxx）」后缀 ⇒ 变红
     ⇒ 改成 String(r.reason).startsWith("存档损坏")

★★ 这和后端 §3.7（断言自己过期）是同一类，但方向相反：
   §3.7 是「功能增长让断言过期」
   本条是「收紧校验让断言暴露原本就错的假设」

★ 纪律：**每次收紧校验，都要复跑全套验收。**
  它会帮你找出那些「依赖宽松假设」的测试 —— 那些测试的存在本身
  就是「产品之前不校验」的证据。

### 6.32~6.36 输入校验的五个坑（详见 docs\踩坑-输入校验-20261019.md）

```
这几条细节多，但【改校验相关代码时必读】。这里只留结论与判据。

§6.32  String(x).trim() 是假防护
       同一个错误写了 6 遍（bridge 1 + dsh-editor 5）。
       拦不住 String({a:1})→"[object Object]"、String(0)→"0"、零宽字符。
       ⇒ 收口到 src/text-guard.mjs 的 hasVisibleText()。

§6.33  不可见字符比想的多 —— \s 只认 Unicode 的 Zs 类
       视觉不可见横跨 Zs/Cc/Cf/Lo 四类，\s 只覆盖 Zs。
       实测穿透：\u3164 韩文填充（Lo）、\u0000 NUL（Cc）。

§6.34  独立质检员打穿 4 项 —— 换方法而不是补清单
       ★ 关键判断：「不是漏列几个字符，是黑名单方法本身失效。」
       证据：混合串 \u2060\u2800\u00ad\ufeff 也穿透 ——
       名单内的被删，名单外的留下来独自变成「有效内容」。
       ⇒ 改用白名单。同时修掉：槽名被 continue 跳过、
         魔数只看前 4 字节、base64 容差 ±4、filename 覆盖别人的文件。

§6.35  白名单也会「列不全」—— 漏了 \p{S} 误拒 14 个符号
       $ + = < > | ~ ^ ∑ ℃ √ ∞ ≈ ≠ 全被拒，报「提示词不能为空」。
       根因：只写了 \p{L}\p{N}\p{P}，漏 \p{S}（符号）。
       ★ 白名单和黑名单的「列不全」是同一个错误，方向相反。

§6.36  质检员的「固定基线」纪律
       它在复核期间源码被改了 4 次，于是固定 SHA256 + mtime + 行数 +
       ★ 服务进程启动时间晚于 mtime（证明测的就是这版）。
       我方对应纪律：改代码后必须重启，并确认进程启动时间晚于 mtime。

★★ 两条通用判据（跨项目适用）：
   1. 当「不要的集合」不可枚举而「要的集合」可枚举 ⇒ 用白名单。
   2. 改校验时必须同时跑正反两组用例 —— 只测「坏的拦住」不够，
      还要测「好的不被拒」。verify-bad-input.mjs 的第 ⑤ 组就是为此存在。
```

### 6.37 验收的第三个维度：副作用（2026-10-19）

```
★★ 我一直只验收「功能对不对」，没验收「有没有副作用」。
   这一轮扫了 41 个验收脚本，21 个有副作用，其中 2 个真是垃圾源。

三类要分开看，不能一概而论：

  ✅ 临时目录 + 自己清理（15 个）
     mkdtempSync / os.tmpdir() → 系统会清，脚本也在 finally 里清了。
     例：verify-m5-assets、verify-persist-host

  ✅ 固定证据目录（2 个，该留）
     verify-krea2 / verify-yz → docs/evidence
     这是【设计意图】—— 实测证据要留着给人看，不是垃圾。

  ⚠️ 固定临时目录 + 无清理（2 个，真问题，已修）
     verify-quality.mjs   → .frames/qtest    (2 个 1.79MB)
     verify-subtitle.mjs  → .frames/subtest  (1 个 0MB)
     都不是 mkdtemp，是写死的路径，跑一次留一批。

  还有一类更隐蔽（上一轮修的）：
     verify-bad-input.mjs 的「⑤ 正常输入仍能通过」必须发真实请求，
     而真实请求会上传文件到 ComfyUI 的 input 目录 ——
     每跑一次多一个 wb_ref_image_0_ok_xxxxxx.png。
     实测：验收前 108 个 → 验收后 109 个。
     cancel(promptId) 只撤队列，撤不掉已落盘的文件。

★ 修法统一：
     跑之前记下目录快照 → 跑完对比出新增 → 删掉
     const SNAPSHOT = new Set(fs.readdirSync(DIR));
     ... 测试 ...
     for (const n of created) fs.unlinkSync(path.join(DIR, n));

★★ 排查方法（新验收脚本或改验收时跑）：
   1. 这个脚本会往哪些目录写东西？（grep writeFileSync / mkdirSync / upload）
   2. 那些目录是 mkdtemp 还是写死路径？
   3. 有没有在 finally / 结尾删掉？

★ 顺带一条：**验收自己会占 ComfyUI 队列。**
   我发过 5 个 32MB 生成任务占满队列，导致下一次
   「M1 HTTP 端到端」15/16 失败（超时 309 秒），
   单独复跑 18/18 —— 那个「失败」是我自己造的假象。
   ⇒ 跑验收前先确认队列空闲：GET 8188/queue 的 running/pending 都是 0。

### 6.38 跨模块状态字段：生产方产出、消费方没接（2026-10-19）
（细节见 docs\踩坑-跨模块状态字段-20261019.md）

```
实测两个真缺陷，同一个模式：源头修了，调用方没接。
  ① bridge 产出 { lost:true }，dsh-editor 只判 h.completed ⇒ 当成「还在跑」
  ② ComfyUI 失败也写 history（status_str="error"）但 completed=false
     ⇒ 同样被当成「还在跑」⇒ clip 永久卡 running ⇒ 永远导不出片

✅ 修：completed 的语义是「结束了吗」不是「成功了吗」
   completed: Boolean(status.completed) ||
     ["success","error","failed","cancelled"].includes(status.status_str)
   消费方三段判断：okEnd → complete / badEnd → fail / lost → fail / 其余 → progress

★★ 判据：凡是跨模块传的状态字段，必须回答三个问题：
   1. 生产方：什么情况下产出这个值？
   2. 消费方：拿到每个值分别做什么？
   3. ★ 有没有「生产方能产出但消费方没处理」的值？
   ⇒ 第 3 问是漏网之鱼最常见的地方。

★ 已固化：verify-agent-progress.mjs 第 ⑨ 组（34/34）
```


### 6.39 ArtCraft 融合的八个静默失效（详见 docs\踩坑-ArtCraft融合-20261021.md）

```
全部「不报错、界面看着正常、结果不对」。改 ArtCraft 相关代码前必读。
已全部锁进 packages\dsh-artcraft-tab\verify-regression.mjs（42 项）。

① MediaTime 是整数 tick（120000/秒），不是 {numerator,denominator}
   ← {numerator,denominator} 是 FrameRate 的类型，两者别混
② tracks 是 { overlay, main(单个对象), audio } —— main 单数、audio 复数
③ element.type 按【实际扩展名】判，不是 clip.kind（后者是「在哪条轨上」）
④ duration = trimEnd - trimStart（时间轴占多长），不是 out-in
⑤ startTime 累加用 element 实际时长（双 clip 才暴露空隙）
⑥ AudioElement 必须声明 sourceType（联合类型，否则导出无音频流）
⑦ mediaId 必须修正成资产表真实 id（音频 id 是 editor: 不是 output:）
⑧ payload 必须 base64（否则 esbuild 导出被劫持、插件静默不激活）

★★ 两条方法论（比这八个具体坑更值钱）：
   · 位置类 bug 需要 ≥2 个元素才暴露 —— 单元素测试对偏移/累加是盲的
   · 加一种媒体类型就要独立验它的完整链路 —— 音频有 4 个坑是视频不触发的
     （没视觉产物 / id 格式不同 / element 是联合类型 / 只在导出时体现）
```

### 6.40~41 「我没找到」≠「不存在」·「数字对上」≠「数据没变」
（详见 docs\踩坑-误判-20261021.md）

```
2026-10-21 一天 6 次，观测都是真的，结论都是跳的：
  ① grep provide( 零命中   → 说「没有 LLM provider」（实际 3 个）
  ② 同上（说第二遍）       → 缺「回头验第一遍」
  ③ 只看跨文件引用         → 说「5 个导出是死代码」（本文件内都在用）
  ④ 只搜一行提示文字       → 说「@ 面板消失」（只是 360→115 变矮）
  ⑤ 三次报「数字对得上」   → 三次口径都不同（-File / -Recurse / API）
  ⑥ 只扫 *.mjs            → 说「refLabels 没人读」（它在 index.js）

★★ 判据一：「我没找到」是观测，「不存在」是推论。中间必须换一种方法再验。
   grep 前先问「它可能出现在哪些扩展名/目录」，不确定就别用 -Include 限定。
   识别对象用稳定特征（zIndex/position/尺寸），不用会随状态变化的文字。
   本机特例：宿主内建插件（llm-pi-ai）源码不在磁盘，grep 永远查不到。

★★ 判据二：「数字对得上」必须能补全成
   「用 <口径 X> 数出的 A，与用 <同一口径 X> 数出的 B 相等」。
   只说「对得上」不说口径 ⇒ 等于没验。
   ⇒ 已落地 packages\verify-asset-baseline.mjs（固定口径 + 基线 + 差集）

★★ 判据三：项目里已有检查工具时，【先跑工具】再自己 grep。
   check-param-closure.mjs 早就记过「只扫 src/ 会误报」，我又犯了一次。
```


#### 6.42~43 删除靠猜 · 字段漏路径（都是「只修一处」）

```
★ 6.42 删除前必须查「它是什么」，不能靠名字猜
  ❌ 「带 wb_ 前缀 + __ 后缀 ⇒ 测试残留」→ 批量删 7 个，
     其中 wb_Krea2-USD-..._vjo6r0.png 是工作台上传的真实文件
     前缀只说明「来源是工作台」，不说明「是我这次测试建的」
  ✅ 删前问三个问题：什么时候建的？谁建的？删错了能恢复吗？
     已落地：删除走回收站可 undo-delete，但「可撤销」不是随便删的理由

  ★ 第二次同错（2026-10-21 当晚）：这次的理由是「166 字节的 1x1 图 ⇒ 测试图」
    → 删了之后 @韩立 搜不到，功能退化。但那张图【有名字、有 role】，
      是被投入过的人造物，不是垃圾。
  ✅ 判据：看「有没有人为投入的痕迹」（被起名 / 标了用途 / 被引用过），
     不是看文件大小或前缀。小文件也可能是用户资产。

★ 6.43 一个字段有 N 条构造路径，只修报错那条 = 没修
  2026-10-21 同一天同类缺陷出现三次：
    ① lost/error 状态：bridge 产出，dsh-editor 没消费（§6.38）
    ② role 写回：写回做了，绑定槽位时没读回
    ③ role 持久化：绑定路径修了，saveSlotRefs + 恢复构造都没修

  ★ 本项目 files[slot] 有【三个】构造点，改字段必须同时改三处：
     fetchAsFilePayload   从资产库绑定
     saveSlotRefs         持久化到 sessionStorage
     loadSlotRefs → restored[slot]  刷新后恢复

  判据：加一个 payload 字段时，grep 所有「构造这个 payload 的地方」，
        不是只修报错的那一处。只测「写进去」不等于测「读回来」——
        「保存/读回」「写入/消费」必须成对验证。
```

#### 6.44 有工具 ≠ 在跑 · 写两边就清两边（2026-10-21）

```
★ 6.44a 未登记进总验收的脚本 = 心理安慰
  实测：37 个 check-*/verify-* 脚本，verify-all 只跑了 30 个。
  漏的里面 verify-assets.mjs（45 项）一直在【失败】，没人知道。
  ⇒ 纪律：新增检查脚本后第一件事是登记进 verify-all.mjs。
     纯逻辑测试（不碰 ComfyUI）要放静态段，别塞进 if (!STATIC)。

★ 6.44b 写两边就清两边
  我加了「tag 写进 PNG 本体」，却没给「清空」补同样逻辑：
    mutate { action:"rename", name:"" } → 清了 json ✅ 没清 PNG ❌
    而「读回时从 PNG 兜底」把旧值读回来了 ⇒ 改名变不可逆
  ⇒ writeTextTags 加 dropAlso 参数支持「只删不写」。
  判据：任何「双写」的功能，都要检查「双删」是否对称。

★ 6.44c 收紧校验后必须复跑全套（§6.31 的再次出现）
  §6.29 给 qwen21-edit 的 ref_image_0 加了 required:true，
  verify-batch.mjs 仍不传 files ⇒ 一启动就 WorkflowError。
  ⇒ 加校验时同步 grep 所有调用方（含测试）。
```

#### 6.45 验收不许污染用户数据（2026-10-21）

```
★★ 实测事故（比功能 bug 更严重）：
  verify-assets.mjs 用「input/ 下第一张图」当测试对象，
  命中了主人命名的「韩立-定妆照」——
  改名 → 清空名字（验证可逆）→ 结束【没有恢复】
  ⇒ 名字在 json 和 PNG 里都被清空，且「测试通过了」。

★ 它比功能 bug 隐蔽：测试绿了，但用户的数据没了。

★★ 判据：任何会写用户数据的测试，必须
   ① 测试前记录原始值（origName / origRole / origFav）
   ② 测试后无条件恢复（try/finally，异常也恢复）
   ③ 能用副本就用副本（delete 测试那条就是复制一份 _verify-assets-*.png 再删）

★ 已落地：packages\verify-no-pollution.mjs
   跑 verify-all 前后各取一次资产库快照，比对 6 个字段：
     id + displayName + role + folder + fav + renamed
   已有资产字段被改 = 污染（退出 1）；新增/减少单独报告。
   ★ 它是「元验收」，不能登记进 verify-all（会无限递归），独立跑。
   变异测试：手动改一个 displayName → 正确报 ❌ 并列出前后值。
```

#### 6.46 落盘晚于完成信号 → 清理必须在出口统一做（2026-10-21）

```
★★ 实测事故：每跑一次完整验收，output/ 里留 1 个、input/ 里留 1 个文件，
   39 项验收产物全进主人资产库，让列表变乱。

★ 为什么单跑能清、放进 verify-all 就漏：
  verify-krea2 的 runOnce：
    if (j.completed) return {...}        ← job 报 completed 就返回
  ★ completed 只表示「ComfyUI 认为任务完了」，文件落盘是异步的。
    PreviewImage(202) 先执行 → temp 文件 → 能删
    SaveImage(220)   后执行 → 落盘晚于脚本退出 → 删不掉

★ 试过的三个方案（前两个都不靠谱）：
  ① process.on("exit") 清理      → 时机太晚 / 也受落盘影响
  ② async IIFE 不 await          → 脚本先退出，清理没跑（verify-bad-input 就是这样）
  ③ ★ 出口统一清（采纳）：verify-no-pollution 跑前记 output/+input/ 快照，
     跑 verify-all，等 2 秒让最后一波落盘，再对比删掉新增。

★★ 判据：
   · 清理必须是【显式 await 的同步路径】，不能挂在生命周期事件上
   · 多脚本各自清 = 各自可能漏 ⇒ 统一在出口清，不管谁漏都兜住
   · 只删「跑之前不存在的」，绝不碰已有文件

★ 已落地：packages\verify-no-pollution.mjs
   实测：跑前 output 760/input 129 → 跑后 760/129（完全一致）
        输出列出删了哪两个文件
```

---

## 七 · 2026-10-22 · 剪辑台（只留指针，细节进 Hindsight）

> ⚠ 本文件已 50.2KB（预算 64KB）。下面**只有一句话结论 + 查询词**，
> 完整内容在 Hindsight 的两份知识库里。

### 7.1 ★ 复用 DSH 自身素材，不要自己画

```
主人原话：「你可以直接复用DSH自身的素材，这个插件最后是要在
          Deepseek harness桌面端上面运行的，可以直接复用，
          这也是最原生DSH风格DSH设计语言」

包名   @deepseek-ai/dsh-client-ui-primitives（282 个导出）
获取   factory(require) 里 require 它 —— 官方插件自己就这么用
判据   凡是 DSH 有同名概念的控件，一律用原生的
       自己画的只有 DSH 根本没有的：时间轴轨道 / 预览画面 / 波形 / 缩放尺 /
       素材网格 / 属性行 / 字幕列表

查：hindsight_search_knowledge_pages("DSH 原生 UI primitives 282 导出")
```

### 7.2 ★ slot 契约（混淆 = 静默失效）

```
conversation.view                      list  session  → id + order
conversation.session.header.utilities  list  session  → id + order
settings.section                       list  root     → id + order
settings.plugin.item                   keyed root     → key + priority   ← 唯一例外

查：hindsight_search_knowledge_pages("DSH slot 契约 list keyed")
```

### 7.3 ★ tracks 三层形状（本项目已踩三次）

```
tracks.overlay = [轨道, …]      ← 数组，元素在 track.elements
tracks.main    =  轨道(单个)     ← 注意是单数
tracks.audio   = [轨道, …]      ← 数组

❌ 把 overlay 当元素数组 ⇒ elementCount 永远等于轨道条数（默认 5）
   ⇒ 预览区空态永不显示，用户看到一片空白
```

### 7.4 ★ CSS 模板字符串里不能有反引号

```
editor.css.js 外层是 export default `...`，
CSS 注释里出现反引号会提前闭合模板 ⇒
esbuild 报 "Expected ; but found xxx" 且错误指向注释位置（看起来毫无问题）。
判据：文件里反引号总数 === 2。本轮连踩两次。
```

### 7.5 ★ 写验收断言前先剥注释

```
我在注释里写「第一版写 typeof mod.MenuSurface !== "function"」，
断言就抓到了这句 ⇒ 3 条假红。

判据：判「代码里有没有 X」必须先把注释剥掉。
     假红和假绿一样有害 —— 会让人去改本来正确的代码。
     已落地：verify-editor-console.mjs 里每个文件都有 x 与 xC（剥注释版）。
```

### 7.6 ★ 本轮 8 个静默失效

```
① esbuild 把裸 require 换成 __require 桩（typeof require 判定通过但调用必抛）
   → build.mjs 里 globalThis.__DSH_PLUGIN_REQUIRE__ = __requireShim
② forwardRef 组件 typeof 是 "object"，用 === "function" 判会误判
   → 用 isComponentLike()
③ tracks.overlay 是轨道数组不是元素数组
④ --dsw-alias-bg-layer-2 浅色下 = #fff（881 张卡在 DOM 里但看不见）
⑤ grid item 写 align-self ⇒ auto 行高塌成 0px，卡片重叠
   → .ac-media-grid { grid-auto-rows: min-content }
⑥ useMemo 依赖里放回调才赋值的派生字段 ⇒ TDZ（minify 后只剩 'k'）
⑦ const 函数定义在 if(...) return 之后 ⇒ 同款 TDZ
⑧ 面板写了但没入口 ⇒ 功能存在但打不开

查：hindsight_search_knowledge_pages("剪辑台实装 8 个静默失效")
```

### 7.7 ★ 大段挪代码不要用下标切片

```
我用 PowerShell 按下标切数组重排 ShortcutSettings.js，
下标算错一位 ⇒ 把整个文件切成两段乱码，只能整文件重写。

判据：宁可整文件重写，或「插入一处、删掉一处」的精确文本替换。
     下标基于「这一刻的精确行数」，中间任何编辑都会让它失效。
```

### 7.8 本轮交付与验收

```
交付报告  docs\交付-第14轮-剪辑台四区块实装-20261022.md
新验收    packages\dsh-artcraft-tab\verify-editor-console.mjs   59/59
          变异测试 4/4（改坏代码全部能变红）
补登记    verify-shortcuts.mjs 此前从未进 verify-all（§6.44a 那条）
读 asar   packages\tools\read-asar.mjs（按 asar 规范算 offset）
```

