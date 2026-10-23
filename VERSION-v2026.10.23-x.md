# v2026.10.23-x · 可移植 / 可自检 / 可部署 收口

> 打包：2026-10-24 00:10
> 上一份 VERSION：`VERSION-v2026.10.23-m.md`
>
> ⚠ 中间 `n`~`w` 这些字母没有单独写 VERSION ——
> 那几轮做的是「补验收、修缺陷、去敏」这类收口工作，
> 一件件小事，合并成本文一次记录。

---

## 一 · 这一阶段做了什么（按目标条目）

### A · 五个缺陷：真机验证全部通过

| 项 | 实测证据 |
|---|---|
| **A1 进度条** | 采样到 `1/10 · 10%` → `2/10 · 20%` → `3/10 · 30%`，数值递增 |
| **A2 生成/停止合并** | 只有一个按钮，点击后**同一按钮**变「停止」 |
| **A3 首帧宽度** | 刷新后采样 30 次，`.ac-scope` 恒为 832px，零跳变 |
| **A4 导出位置** | `导入(361) → 导出(439) → 分割(505)…` 同排、在导入右边、未折叠 |
| **A5 导入失败提示** | `.ac-action-error` 红条 + `role=alert` + 可关闭 + 有值才渲染 |

**A1 的易混淆点**：状态区里还有一个 `45%`，那是**画布缩放比例**
（夹在 `−` 和 `+` 之间），不是进度。只按「有没有百分比」判会误判。

**A3 的根因**：CSS 自定义属性的 `var()` 在**声明它的元素**上解析。
`:root` 层拿不到 viewArea 的 `--dsh-composer-card-max-width`，
于是 `var(..., 100%)` 落成**字面量 100%** ⇒ 首帧顶格。
正确做法是声明在 `.ac-scope` 自己身上（实测 `calc(800px + 32px)`）。

### B · ComfyUI 状态点开关

- 关闭态点 → `POST /comfy-bridge/ensure`（实测 16 秒启动）
- 已连接点 → `POST /comfy-bridge/stop`
- `启动中…` / `关闭中…` 中间态 + 失败原因回显 + `busy` 期间禁用防连点
- 启动参数六件套齐全（`--listen` / `--port` / `--disable-auto-launch` /
  `--extra-model-paths-config` / `--output-directory` / `--input-directory`）

### C · 自检

- **C1** 静态 92 步 / 完整 97 步，全绿
- **C2** 补齐了原来 0 覆盖的两项（导入字段、状态点）
- **C3** 新增 3 个变异测试脚本，共 **43 个变异**，全部能打红
- **C4** 验收污染：连续 3 轮 0 新增

### D · dsh-editor 并入 + 去敏

- 指向本仓库的绝对路径：**16 处 → 0 处**
- `C:/Users/<本机>/dsh-tok.txt`：**15 个脚本改掉**，统一走 `tools/test-env.mjs`
- 包依赖可移植：四个包都能**真的 import**（不只是文件存在）

### E · 设置页 / 模型清单 / 一键体检

实测（19499 + ComfyUI 在线）：

```
ComfyUI 安装目录    ✅
输出目录可写        ✅
输入目录可写        ✅
ffmpeg              ✅ <repo>\packages\dsh-editor\bin\ffmpeg.exe
模型                共 26 项：25 就位，缺 1
端到端探活          HTTP 200 · 576ms · ComfyUI 0.40.0
ComfyUI 状态        已连接 · 版本 0.40.0 · 延迟 6ms · 4 个工作流
```

模型清单按**角色**分组（LoRA 8 / VAE 6 / 文本编码器 5 …），
每条标注 `[字段名] 用于：<工作流>.json · 应放到 models/xxx`。

### F · 发布

- **F1** 已跟踪 343 个文件 / 25.9 MB，不含 node_modules / .models / outputs / 证据目录
- **F2** ⏸ 阻塞：GitHub 凭据失效（详见第四节）
- **F3** 只推私密，不公开

---

## 二 · 这一阶段修掉的真实缺陷（12 个）

| # | 缺陷 | 怎么发现的 |
|---|---|---|
| 1 | `check-undeclared` 登记在 `if (!STATIC)` 块内，`--static` 下从未跑过 | 核对步骤数 |
| 2 | `verify-registry-complete` 自己漏扫三个层级 | 它报「全过」但有脚本未登记 |
| 3 | `index.js:830` 裸 `path.join` 被空 catch 吞掉 | 新写的 `check-undeclared` 抓出 |
| 4 | `dsh-video-knowledge` 没有 package.json 却被列为依赖 | D3 核对 |
| 5 | `packages/_snapshot-before.json`（288KB）被 git 跟踪 | F1 核对 |
| 6 | `verify-no-english` 缺样本时 exit(2)，永远显示失败 | D2 改路径后暴露 |
| 7 | `dsh-device-monitor.废弃` 废弃包还在 git 里 | D2 清理 |
| 8 | 根目录 `verify-asr.mjs` 是旧副本（包内才是新版） | D2 核对 |
| 9 | `verify-all` 的 `HERE2` 指向另一个仓库（双根逻辑过时） | D2 |
| 10 | 16 处指向本仓库的绝对路径 | D2 |
| 11 | 15 个脚本硬编码 `C:/Users/<本机>/dsh-tok.txt` | D3 |
| 12 | 验收跑完 output 必多 1 张（6 个假设全不成立后改用出口统一清） | C4 |

---

## 三 · 四条值得记住的教训

### 1 · 「检查通过」≠「检查真的在检查」

- `check-undeclared` 从没跑过却显示「全部通过」
- `verify-registry-complete` 自己漏扫却报「236/236 全过」

⇒ 已落地 `tools/meta-test-checkers.mjs`：对三个检查器各注入一个必发现的缺陷，
确认它们能变红。**一个从来没红过的检查器，和不存在的检查器没有区别。**

### 2 · 变异测试的三种假通过（一个比一个隐蔽）

| # | 假通过 | 修法 |
|---|---|---|
| ① | 路径写错 → 读空串 → 否定断言永真 | 读文件前先 `check(文件存在)` |
| ② | 变异插在注释里 → 被 `stripComments` 剥掉 | 插在真实代码区 |
| ③ | 检测「文本在不在」而非「会不会执行」 | 加负向前瞻排除 `&&` / `\|\|` 短路 |

### 3 · 「单跑干净、合跑必漏」时别再逐个脚本修

试到第 3 个假设不成立就该换方案。C4 试了 6 个全部不成立，
最后采纳「出口统一清」（AGENTS §6.46）——**最后一道闸，谁漏都挡住**。

★ 「目录数量稳定」是弱判据，会被「还没开始写」的间隙骗过。

### 4 · 批量改代码必须真跑

`pathToFileURL` 漏 import ⇒ `node --check` **通过**，真跑报 `ReferenceError`。
未声明标识符在语法层面完全合法。

⇒ 先跑 `tools/check-undeclared.mjs`（acorn 能抓），再真跑。

---

## 四 · F2 阻塞（唯一未完成项）

### 定位到文件级

```yaml
%APPDATA%\GitHub CLI\hosts.yml
  github.com:
      users:
          MYCF711:          ← 空条目，没有 oauth_token 字段
```

**Token 不是过期，是被彻底删掉了。**

### 已排除的替代路径

| 路径 | 结果 |
|---|---|
| `GH_TOKEN` / `GITHUB_TOKEN` | 都没有 |
| Windows 凭据管理器 | 无 github 条目 |
| `.git-credentials` | 不存在 |
| **SSH key** | ✅ 可用（`Hi MYCF711!`），但**不能创建仓库** |

### 需要主人做一件事

打开 https://github.com/new

- 名字填 `dsh-video-workbench`
- 选 **Private**
- **不要**勾 README / .gitignore / license（要空仓库）

之后我执行（已备好，一条不差）：

```powershell
git remote add origin git@github.com:MYCF711/dsh-video-workbench.git
git branch -M main
git push -u origin main
```

详见 `docs/F2-推送操作手册.md`。

---

## 五 · 验收快照

| 项 | 结果 |
|---|---|
| `verify-all --static` | **92 / 92** |
| `verify-all`（含真跑） | **97 / 97**，零污染 |
| `verify-registry-complete` | 229 / 229 |
| D3 去敏 | 273 / 273 |
| F1 仓库卫生 | 20 / 20 |
| E 段 | 29 / 29 |
| D4/D5 包可移植 | 15 / 15 |
| A/B 缺陷断言 | 25 / 25 |
| 变异测试 | 43 个变异，**43 / 43** 全打红 |

### 验收体系规模

```
verify-all 步骤        92（静态）/ 97（完整）
总断言数               约 1900 项
检查脚本               113 个，全部已登记（元验收保证）
变异测试脚本           3 个（43 个变异）
```
