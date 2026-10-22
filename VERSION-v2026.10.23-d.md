# v2026.10.23-d · 五个缺陷修复 + 进度真机验证

> 打包：2026-10-23 03:49
> 归档：`D:\主工作区\_branch-archive\DSH视频工作台-v2026.10.23-d-20261023-034923.zip`（117.9MB，含 docs/ 证据素材 102.6MB）
> 源码备份：`merge-backup-20261023-034923`
> 上一版：`VERSION-v2026.10.23-c.md`

---

## 一 · 验收状态

| 项 | 结果 |
|---|---|
| `verify-editor-console.mjs` | **139 / 139**（从 128 增至 139） |
| `verify-all.mjs --static` | **56 / 56** ← ComfyUI 在线，此前 2 项失败也绿了 |
| 变异测试 | **7 / 7** 全部能变红 |

---

## 二 · 五个缺陷的根因与修法

### A1 进度不显示 —— ComfyUI 的 progress 是「定向发送」

```
现象：WebSocket 已连接（connected: true），任务在跑（running=1），
      但 trackedPrompts = 0，前端进度永远 null。

根因（读 ComfyUI 源码确认，不是猜）：
  main.py:464
    server_instance.send_sync("progress", progress, server_instance.client_id)
                                                         ^^^^^^^^^^^^^^^^^^^
  第三个参数是 target sid ⇒ 这条消息【只发给那一个 socket】。

  server.py:337
    sid = request.rel_url.query.get('clientId', '')
  ⇒ 建连时可以用 ?clientId=xxx 指定自己的 sid。

  我们提交任务用 config.clientId ?? "dsh-comfy-bridge"（index.js:485），
  而 WS 连的是裸 /ws ⇒ 服务端随机 uuid 当 sid ⇒ 两者不匹配 ⇒ progress 全丢。
```

**修法**：抽出 `CLIENT_ID` 常量，提交与订阅共用；WS 建连时带上 `?clientId=`。

实测修复后：`wsUrl: ws://127.0.0.1:8188/ws?clientId=dsh-comfy-bridge`，
`trackedPrompts: 1`，前端显示 `1/10 · 10%`，进度条渲染成功。

★ 教训：**跨进程协议里的「广播」不一定是广播。** 先读发送端的源码，
  不要假设 send 就是群发。

### A2 生成/取消两个按钮 → 一个位置切换

照 DSH composer 的做法：streaming 时发送键原地变停止键，不新增元素。

```
busy ? 显示「停止」+ 方块图标 + onClick=onCancel + 中性底
     : 显示「生成」+ primary 蓝底 + onClick=onGenerate
```

实测：24/24 采样中「停止」出现 24 次，独立「取消」按钮 **0 次**。

### A3 剪辑台首帧满宽闪烁 —— CSS 变量在声明它的元素上解析

两次都错在同一个认知上：

```css
/* 第一版：以为这样首帧就有值 */
:root { --ac-follow-w: var(--dsh-composer-card-max-width, 100%); }
```

实测 `.ac-scope` 上算出的是**字面量 `100%`**。原因：

> CSS 自定义属性的 `var()` 在**声明所在的元素**上解析。
> `:root` 这一层没有 `--dsh-composer-card-max-width`（它定义在 viewArea 上），
> 于是 `:root` 把 `var(...)` 求值成 fallback `100%`，
> 然后作为**已解析的字面量**继承给所有后代。
> ⇒ 后代永远拿不到真正的宽度。

第二个真 bug（这个才是主人说的「卡成顶格最宽」）：

```
setInterval 补一次 --ac-follow-w 就 clearInterval
⇒ 切 tab 回来组件重建，新元素 inline style 是空的，
  定时器已停 ⇒ 宽度永远卡在满宽不恢复
实测：inlineFollow="(未设置)"，宽 1633 持续不降
```

**修法**：
1. 删掉 `:root` 的声明
2. 内联样式直接回落：`min(100%, var(--ac-follow-w, var(--dsh-composer-card-max-width, 100%)))`
3. `setInterval` → `MutationObserver`（元素一出现就设，且能感知替换）

实测：
- 切 tab 往返：宽度全程 **1496 恒定**，零跳变
- 刷新页面：从第一帧就是 **1496**，零跳变

### A4 导出按钮藏二级菜单 → 常驻位、紧跟导入

常驻位从 6 变 7。实测工具栏顺序（x 坐标）：
```
导入 361 → 导出 439 → 分割 505 → 删除 571 → 复制 637 → 撤销 716 → 重做 782
```
★ 这一条推翻了 2026-10-22 定的「常驻位只有 6 个」。主人当前要求优先。

### A5 导入静默失败 —— 字段名错 + 错误没显示

```
实测三个组合（19499）：
  {name, mime, data}     → 400 "缺 filename"
  {filename, mime, data} → 400 "缺 base64"
  {filename, base64}     → 200 {"ok":true,"id":"input:wb_xxx.png"}
```

两个错：
1. 字段名写错（`name`/`data` → `filename`/`base64`）
2. **错误只 console.warn，界面零反应** ⇒ 用户以为「点了没反应」

**修法**：修字段名 + 加 `actionError` 状态条，失败时显示红字（带关闭按钮）。

★ 判据：**静默失败比报错更糟。** 用户不知道是没选上还是功能坏了。

---

## 三 · 新增的 11 条验收

| 断言 | 防什么 |
|---|---|
| 导出在常驻位且紧跟导入 | 退回二级菜单 |
| 导出不重复出现在 ⋯ | 同一功能两处 |
| 生成/停止是同一个按钮 | 退回两个按钮 |
| 停止态用中性色 | 蓝底误导「再点会继续」 |
| 进度用进度条不是小字 | 退回不起眼的文字 |
| 进度只在有真实数据时显示 | 显示假 0% |
| 宽度不在 `:root` 声明 `--ac-follow-w` | 变量在错误层级解析 |
| 宽度有 DSH 变量作为最终回落 | 只依赖 JS |
| `--ac-follow-w` 用 MutationObserver | 定时器一次就停 |
| 导入字段是 `filename` + `base64` | 字段名写错 |
| 导入失败显示到界面 | 静默失败 |

---

## 四 · 本轮踩的两个坑

### 4.1 断言用错文件 → 5 条假红

进度条和生成/停止按钮在 `src/WorkbenchView.js`，
而我一直拿 `tabC`（= `ArtCraftTab.js`）去测 ⇒ 5 条全红但代码是对的。

**判据**：先确认「这段代码在哪个文件」，再写 `.test(那个文件的变量)`。
写断言前 grep 一次目标字符串落在哪个文件。

### 4.2 断言范围太宽 → 假红

`!/name:\s*file\.name/.test(整个文件)` —— 但 `_insertAsset` 的参数里
**合法地**有一处 `name: file.name`。

**修**：只切出 `/comfy-assets/upload` 附近的 700 字符再测。

★ 这与「假绿」是同一个错误的两面：
  · 假绿 = 断言太松，坏代码也通过
  · 假红 = 断言太松，好代码也失败

---

## 五 · 仍未做（下一轮）

| 项 | 状态 |
|---|---|
| ComfyUI 状态点开关（红/绿点点击启停） | **未做** |
| dsh-editor 并入本项目 | **未做** |
| 去敏 + 可移植 | **未做** |
| 模型配置页 + 需求清单 | **未做** |
| 部署自动化 | **未做** |
| GitHub 私密仓库 | **未做** |
| 剪辑台「从视频台切过来卡满宽」的具体复现场景 | 已修，但「有时候」这个概率条件未穷举 |

详见 `goal-8bc086e1` 的 B–F 段。
