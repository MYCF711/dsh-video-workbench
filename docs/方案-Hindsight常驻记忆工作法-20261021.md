# 方案 · Hindsight 常驻记忆工作法（2026-10-21）

> 主人指定：「临时让 hindsight 作为常驻记忆工具，目前的方法经常失灵忘记」
> 「hindsight 的 MCP 应该很全面的，不要出现手动 ping 和手动 ssh 灌输这种低级错误」
> 「AGENTS里面能进hindsight的就用hindsight的方法进行记忆」
>
> **这份文档是方法本身，不是某次任务的一次性记录。**

---

## 一 · 为什么要换方法

### 旧方法的失败模式

```
AGENTS.md 63.4KB / 64KB 预算 ⇒ 只剩 0.6KB
  ↓
加不下新的教训
  ↓
超限被截断，截掉的正好是最新的
  ↓
「我明明写过，怎么又忘了」
```

**根因不是记性，是载体选错了。** AGENTS.md 是一份有硬预算的注入文件，
它适合放「恒定不变的约定」，不适合放「持续增长的踩坑史」。

### 新方法的分工

| 载体 | 放什么 | 特征 |
|---|---|---|
| **Hindsight** | 踩坑史、既往决策、根因、为什么这么做 | 无预算，可检索，可追溯 |
| **AGENTS.md** | 硬约束、目录结构、必须知道的几条 | 有 64KB 预算，只留指针 |
| **docs/** | 交付报告、方案、归档原文 | 人读，不注入 |

**判据：会增长的内容进 Hindsight；恒定的进 AGENTS；给人读的进 docs。**

---

## 二 · 什么时候必须查（不是可选）

| 触发 | 调用 | 不查的后果 |
|---|---|---|
| **任何新任务/新需求开始时** | `hindsight_search_knowledge_pages(query)` | 重复造轮子 / 重复踩坑 |
| 报错、说「不对」「又坏了」 | 先查是否已有根因记录 | 从零重新排障 |
| 问「为什么这样设计」「还剩什么」 | 先查，别重新推导 | 给出与既往决策矛盾的建议 |
| 要改测试 / 写新代码 / 动配置 | 先查项目约定与既往决策 | 破坏已有约定 |
| **查 DSH 有哪些 slot / 插件怎么挂载 / 某个包管什么** | ← ★ 最容易绕过 | 去做手工解析 asar 这种低级活 |
| 遇到似曾相识的问题 | 先查，别从零再撞 | 花几小时挖已知答案 |

---

## 三 · 工具顺序

```
① hindsight_search_knowledge_pages(query)   ← 入口，先搜知识页
② hindsight_read_knowledge_page(id)         ← 命中后读全文
③ hindsight_reflect(query)                  ← 页面太浅才深推（慢，几秒）
④ hindsight_ingest_document(title, content) ← 查到新结论当场写回
⑤ hindsight_list_tags(prefix)
   hindsight_read_memory_chain(tag)         ← 找不到家族时
⑥ hindsight_diagnose()                      ← 怀疑记忆坏了时（不要假设库是空的）
```

### 注意：知识页可能属于别的项目

实测：本仓库的知识页（Component map / Core concepts / Key decisions）
描述的是 **archive** 项目，不是 DSH 视频工作台。

⇒ 知识页没命中时，**用 `recall` 搜原始记忆条目**，那里才有本项目的细节。

---

## 四 · 反模式（本轮真实犯过）

### ❌ 手动解析 app.asar 找 DSH 的 slot 列表

我做了：
```python
# 读 asar header、按 offset 读文件、正则扫 slot 键名（102 个）
```

**该做的**：
```
hindsight_search_knowledge_pages("DSH slot 挂载点 conversation.view composer.dock")
```

**Hindsight 里比手工挖到的还全**：

> 🧠 实测命中：`conversation.composer.dock` 的宿主声明是
> `{kind:"list", scope:"session"}`，渲染点在 `:16271` 的
> `renderSlot("conversation.composer.dock", extensionZone)`；
> 注册时用 `id` + `order`（而 `settings.plugin.item` 用 `key` + `priority`）；
> `apply` 要整体包 `try/catch`，防止 Slot API 破坏时拖崩 DSH loader。

**这三条（kind/scope 声明、id/order vs key/priority、apply 要 try/catch）
是我手工解析 asar 时完全没看到的。**

### ❌ 手动 ping / 手动 ssh 灌记忆

MCP 工具直接可用。探物理连通性会把注意力从「回答问题」带到「修通路」。

### ❌ 翻磁盘找知识库

`<WORKSPACE>\DSH源码知识库` 是空目录。
知识库是**逻辑资源**，走 MCP，不是 `Test-Path`。

---

## 五 · 写回纪律

### 什么时候写

| 场景 | 动作 |
|---|---|
| 踩了一个不报错、要几小时才找到的坑 | `hindsight_ingest_document` |
| 做了一个「为什么选 A 不选 B」的决策 | 同上 |
| 发现记忆里的某条是错的 | 写「Correction: <主题>」，说明旧说法、实际情况、证据 |
| AGENTS.md 某段太长要外移 | 整段 `ingest_document`，AGENTS 只留指针 |

### 写什么

```
✅ 要写：
   · 症状（可复现的第一步）
   · 根因（不是「看起来像」，是「实测是」）
   · 修法 + 判据（怎么验证修好了）
   · 通用教训（跨项目也成立的那一句）

❌ 不要写：
   · 「注意要小心」这种没有判据的话
   · 只有结论没有证据的断言
   · 已经写在 AGENTS 硬约束里的（重复）
```

---

## 六 · 本项目的现状（2026-10-21）

```
AGENTS.md          43.8 KB / 64 KB（已从 63.4KB 压缩，留出 20.2KB 余量）
已迁入 Hindsight   §6.1~§6.22（22 条早期踩坑）
归档原文           docs/踩坑-归档-6.1到6.22.md
```

### 已确认 Hindsight 里有的（本项目相关）

| 查什么 | 命中情况 |
|---|---|
| DSH slot 机制（composer.dock / conversation.view） | ✅ 有，且比手工解析更全 |
| dsh-editor 的分层结构（lib/index.js vs lib/client.js） | ✅ 有 |
| 插件加载机制的三处校验 | ✅ 有 |
| 会话存储路径与 zstd 逐帧解 | ✅ 有 |
| 本项目 ArtCraft 集成的具体改动 | ⚠️ 只有「agent 改了某个文件」这种流水，缺根因 |
| §6.1~6.22 的踩坑 | ✅ 刚写入 |

### 缺口（明天要补的）

```
· 本项目大部分「为什么这么做」的决策还没进 Hindsight
  （现在散在 12 份 docs/交付-*.md 里）
· 建议：按主题 ingest，而不是按轮次
  主题举例：ArtCraft 融合决策 / 时间轴数据模型 / 字幕方案选型 /
            whisper 模型选型 / UI 对齐方法
```

---

## 七 · 明天要汇报的

主人问：「明天在交付任务的时候告诉我哪个部分对 hindsight 常驻使用更有效果」

我需要在明天的交付里给出**实测数据**，不是印象：

```
指标                       怎么量
─────────────────────────────────────────────
查询命中率                 查 N 次，命中有效内容几次
首次查中率                 第一次查询就找到的比例
省下的时间                 对比「查 Hindsight」vs「手工挖」
哪些查询词好用             记录实际用过的 query 与结果
哪些场景 Hindsight 没帮上   如实记录（比如知识页是别的项目的）
写回的频率                 ingest 了几次，之后有没有再查到
```

**不能只写「很好用」——要给数字。**
