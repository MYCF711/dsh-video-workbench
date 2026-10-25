# 准备 ArtCraft 客户端产物
#
# ══════════════════════════════════════════════════════════════════════
# 为什么需要这一步
#
#   剪辑台的底层是 ArtCraft（@storyteller/ui-video-editor）——
#   一个第三方视频编辑引擎。本仓库【不内置它的代码】，因为：
#
#     ★ 上游没有声明任何许可协议。
#       没有协议声明 = 默认版权保留（All Rights Reserved），
#       意味着不能在未获许可的情况下再分发。
#       把它打进公开仓库，等于把别人的代码重新发布一遍。
#
#   ⇒ 产物由使用者自己生成，脚本在本地跑，产物不进 git。
#
# ── 没有产物会怎样
#
#   插件照常加载，视频工作台（生图 / 生视频）完全可用。
#   只有剪辑台会显示「需要先准备 ArtCraft 产物」的提示。
#   —— 一个可选功能的依赖缺失，不该拖垮核心功能。
#
# 用法：
#   pwsh -NoProfile -File .\scripts\fetch-artcraft.ps1
#
# 参数：
#   -UpstreamDir <path>   指定 artcraft-demo\video-editor 的路径
#   -Force                即使产物已存在也重新生成

param(
    [string]$UpstreamDir = "",
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$payload = Join-Path $repo "packages\dsh-comfy-workbench-tab\src\editor\_artcraft-payload.js"

function Ok($m)   { Write-Host "  ✅ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  ⚠ $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "  ❌ $m" -ForegroundColor Red }

Write-Host "`n=== 准备 ArtCraft 产物 ===" -ForegroundColor Cyan

# ── ① 已经准备好了吗 ──
if ((Test-Path $payload) -and -not $Force) {
    $size = (Get-Item $payload).Length
    if ($size -gt 100000) {
        Ok "产物已存在（$([math]::Round($size/1MB,1)) MB）—— 不用重新生成"
        Write-Host "     要强制重建：加 -Force"
        exit 0
    }
    Warn "当前是占位符（$size 字节），需要生成"
}

# ── ② 找上游源码 ──
$candidates = @()
if ($UpstreamDir) { $candidates += $UpstreamDir }
if ($env:ARTCRAFT_UPSTREAM) { $candidates += (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $env:ARTCRAFT_UPSTREAM))) }
$candidates += @(
    (Join-Path $repo "..\_upstream\artcraft-demo\video-editor"),
    (Join-Path $repo "_upstream\artcraft-demo\video-editor"),
    "D:\主工作区\_upstream\artcraft-demo\video-editor"
)

$found = $null
foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) {
        $found = (Resolve-Path $c).Path
        break
    }
}

if (-not $found) {
    Write-Host ""
    Bad "找不到 ArtCraft 上游源码"
    Write-Host ""
    Write-Host "  这是第三方项目（@storyteller/ui-video-editor），本仓库不含它。"
    Write-Host "  你需要自己准备一份，然后告诉我它在哪："
    Write-Host ""
    Write-Host "     pwsh -NoProfile -File .\scripts\fetch-artcraft.ps1 -UpstreamDir <路径>"
    Write-Host ""
    Write-Host "  目录应符合这样的结构："
    Write-Host "     <路径>\package.json"
    Write-Host "     <路径>\src\VideoEditor.tsx"
    Write-Host "     <路径>\node_modules\"
    Write-Host ""
    Write-Host "  ★ 没有它也能用：视频工作台（生图 / 生视频）完全不受影响，"
    Write-Host "    只有剪辑台会提示「需要先准备 ArtCraft 产物」。"
    Write-Host ""
    exit 1
}

Ok "上游源码: $found"

# ── ③ 找 build-payload.mjs ──
$builders = @(
    (Join-Path $repo "scripts\build-payload.mjs"),
    (Join-Path $repo "packages\dsh-comfy-workbench-tab\build-payload.mjs"),
    (Join-Path $found "build-payload.mjs")
)
$builder = $null
foreach ($b in $builders) {
    if (Test-Path $b) { $builder = $b; break }
}

if (-not $builder) {
    Bad "找不到 build-payload.mjs"
    Write-Host "     它应该在 scripts\ 或 packages\dsh-comfy-workbench-tab\ 下"
    exit 1
}
Ok "构建脚本: $builder"

# ── ④ 跑它 ──
Write-Host ""
Write-Host "  正在生成（可能几分钟：要打包一个 ~8MB 的 CJS）…"
Push-Location $repo
try {
    $out = node $builder --upstream $found --out $payload 2>&1 | Out-String
    Write-Host $out
    if ($LASTEXITCODE -ne 0) {
        Bad "生成失败（exit $LASTEXITCODE）"
        exit 1
    }
} finally { Pop-Location }

# ── ⑤ 核对 ──
$size = (Get-Item $payload).Length
if ($size -lt 100000) {
    Bad "生成后文件只有 $size 字节 —— 看起来不对"
    exit 1
}

Ok "产物已就绪：$([math]::Round($size/1MB,1)) MB"

# ── ⑥ 导出宿主侧要读的纯文本（2026-10-25 按需下发）──
#
# 原来 payload 静态 import 进打包产物 ⇒ 首屏 11.4 MB，
# 而它只有打开剪辑台才用得上。现在改成宿主侧按需吐给浏览器，
# 宿主读的就是下面这两个 .b64.txt。
$editorDir = Join-Path $repo "packages\dsh-comfy-workbench-tab\src\editor"
foreach ($pair in @(
    @{ js = "_artcraft-payload.js"; txt = "artcraft-payload.b64.txt" },
    @{ js = "_artcraft-css.js";     txt = "artcraft-css.b64.txt"     }
)) {
    $jsPath = Join-Path $editorDir $pair.js
    $txtPath = Join-Path $editorDir $pair.txt
    if (-not (Test-Path $jsPath)) { continue }
    $raw = Get-Content $jsPath -Raw
    $m = [regex]::Match($raw, 'export default\s+"([A-Za-z0-9+/=]*)"')
    if (-not $m.Success) {
        Warn "解析不出 $($pair.js) 里的 base64，跳过"
        continue
    }
    [System.IO.File]::WriteAllText($txtPath, $m.Groups[1].Value, [System.Text.Encoding]::ASCII)
    Ok "已导出 $($pair.txt)（$([math]::Round($m.Groups[1].Value.Length/1MB,2)) MB）"
}

Write-Host ""
Write-Host "  下一步：重启 DSH，剪辑台就能用了。"
Write-Host "  ★ 这些文件都在 .gitignore 里 —— 生成物不会被提交到仓库。"
Write-Host ""
