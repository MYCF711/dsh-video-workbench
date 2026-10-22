# DSH 官方输入区规格（实测，2026-10-18）

> 全部用 `getComputedStyle` 从 19499 实例的真实 DOM 上量的，不是从文档抄的。
> **这是「和 DSH 整体统一」的唯一标准。** 改插件时逐项对齐，不要自己发明。

---

## 一 · 输入卡片（`[data-composer-card]` / `.RlGAzG_card`）

```css
display:        flex
padding:        8px 0px 0px
gap:            12px
border-radius:  28px            /* 大圆角，胶囊感 */
background:     #fff
border:         0
box-shadow:
  0 0 0 0.5px rgba(0,0,0,.10),
  0 4px 16px  rgba(0,0,0,.03),
  0 0 24px    rgba(0,0,0,.03)
font-size:      14px / 24px
color:          rgb(15,17,21)   /* --dsw-alias-label-primary */
```

实测尺寸：**952 × 98px**（宽度随容器，高度固定 98）

### 内部三段

| 段 | class | 高 | 关键样式 |
|---|---|---|---|
| 输入区 | `RlGAzG_scroll` | 36px | `margin-right: 4px`，透明底 |
| 底部工具行 | `RlGAzG_row` | 42px | `padding: 2px 8px 6px`，`gap: 12px`，`justify-content: space-between` |
| overlay 锚点 | `RlGAzG_overlayAnchor` | 0px | 浮层挂载点 |

---

## 二 · 底部工具行里的控件

### 2.1 下拉触发器（`.dlU_AG_trigger` / `.wq12jW_trigger`）

```css
height:         28px
padding:        0 4px 0 8px     /* 左 8 右 4 —— 紧凑的关键 */
gap:            4px
display:        flex
align-items:    center
border-radius:  8px
background:     transparent
border:         0
font:           13px / 20px
font-weight:    500
color:          rgb(97,102,107)  /* --dsw-alias-label-secondary */
cursor:         pointer
```

### 2.2 触发器内部

| 元素 | 尺寸 | 颜色 |
|---|---|---|
| 图标 `triggerIcon` | **14 × 14**，在**文字左边** | 同文字色 |
| 文字 `triggerLabel` | 13px | `label-secondary` |
| 箭标 `chevron` | **14 × 14** | `rgb(173,178,184)` = `label-tertiary` |

### 2.3 其他按钮

| 元素 | 尺寸 | 圆角 | 底色 |
|---|---|---|---|
| `+` 按钮 | 28 × 28 | **999px（正圆）** | `rgb(245,246,247)` |
| 发送键 | 34 × 34 | **999px** | `rgb(65,118,230)` = `#4176e6` |

---

## 三 · 下拉面板（`._surface_ri079_1` / `role="menu"`）

```css
/* 外层：透明，只负责定位与圆角裁剪 */
border-radius:  16px
padding:        4px
box-shadow:
  0 0 0 0.5px rgba(0,0,0,.04),
  0 3px 8px  rgba(0,0,0,.04),
  0 0 20px   rgba(0,0,0,.05)

/* 实底层 ._material_ri079_21 —— ★ 毛玻璃 */
background:      rgba(248,249,250,.58)
backdrop-filter: blur(40px) saturate(1.5)
border-radius:   16px
```

实测尺寸：**144 × 110px**（随内容）

### 面板项（`._item_4ub78_90` / `role="menuitem"`）

```css
height:         34px
padding:        6px 8px
gap:            6px
display:        flex
align-items:    center
border-radius:  12px           /* 注意是 12，不是 8 */
font:           13px / 20px
color:          label-primary
cursor:         pointer
```

内部图标 `_itemIcon`：**16 × 16 SVG，在文字左边**

---

## 四 · 改造我的插件要对照的表

| 项 | 官方值 | 我现在 | 要改成 |
|---|---|---|---|
| 参数区容器 | 输入卡片内底部行，h=42 | **独立一条铺满 1625px，h=33** | 收进卡片 |
| 卡片圆角 | 28px | 无卡片 | 28px |
| 卡片阴影 | 三层柔光 | 无 | 照抄 |
| 触发器 padding | `0 4px 0 8px` | `0 6px 0 4px` | 对齐 |
| 触发器 gap | 4px | 4px ✅ | — |
| 图标尺寸 | 14×14 SVG | 9px 文字 `▾` | 换 14px SVG |
| 箭标位置 | 文字**右边**（chevron 在 label 后） | 文字**左边** | ★ 主人要求左边，**保留左边** |
| 面板圆角 | 16px | 12px | 16px |
| 面板底色 | 半透明 + blur(40px) | 纯白 | 毛玻璃 |
| 面板项圆角 | 12px | 8px | 12px |
| 面板项 padding | `6px 8px` | `5px 10px` | 对齐 |
| 状态信息 | 在底部行左侧，13px | **独占 39px 一条** | 收进底部行 |
| 开关 | 在底部行 | **独占 30px 一条** | 收进底部行 |

### ★ 唯一故意不照抄的地方

**官方触发器的箭标在文字右边**（`triggerLabel` → `chevron`），
但主人明确要求「三角要在文字左边」（AGENTS.md §3.9）。

⇒ **保留左边**。这是主人的显式要求，优先级高于「照抄官方」。

---

## 五 · 改造后的预期收益

```
现在参数区占高：
  状态条  39px
  参数条  33px
  开关行  30px
  ─────────────
  合计   102px

改造后（全部收进卡片底部行）：
  卡片内底部行  42px（含状态 + 4 个下拉 + 开关 + 生成）
  卡片顶部 padding 8px
  ─────────────
  合计   50px

净省 52px → 提示词框 / 成果区各多 26px
横向：不再有 1247px 死空白（grid 列改为 flex 紧凑排列）
```

---

## 六 · 复现方法（下次要重新量时）

```js
// 1. 卡片
getComputedStyle(document.querySelector('[data-composer-card]'))

// 2. 底部行
getComputedStyle(document.querySelector('.RlGAzG_row'))

// 3. 触发器
getComputedStyle(document.querySelector('.dlU_AG_trigger'))

// 4. 面板（先点开）
document.querySelector('.dlU_AG_trigger').click()
getComputedStyle(document.querySelector('._material_ri079_21'))
getComputedStyle(document.querySelector('._item_4ub78_90'))
```

⚠ 这些 class 名是带 hash 的（`RlGAzG`、`dlU_AG`、`ri079`），版本升级会变。
   新版本里按 `[data-composer-card]`、`role="menu"`、`role="menuitem"` 找。
