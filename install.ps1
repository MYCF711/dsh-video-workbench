# 安装 DSH 视频工作台到指定 profile
#
# 用法：
#   .\install.ps1                          # 装到 comfy-test profile
#   .\install.ps1 -Profile myprofile       # 装到指定 profile
#   .\install.ps1 -Uninstall               # 卸载
#
# 做的事：
#   ① 找到 DSH_HOME 与 profile 目录
#   ② 在 profile 的 package.json 里写入 4 个 link: 依赖
#   ③ 在 dsh.profile.bundles 里追加 3 个包（dsh-video-knowledge 不进 bundles）
#   ④ 建 node_modules 软链
#   ⑤ 提示重启
#
# ★ 这个脚本不装 ComfyUI，也不下模型 —— 那两件事必须在设置页里做，
#   因为路径是本机专属的，猜不出来。

param(
    [string]$Profile = "comfy-test",
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

# ── 定位 ────────────────────────────────────────────────
$repoRoot = Split-Path -Parent $PSCommandPath
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { "D:\DeepSeek Harness\home" }

Write-Host ""
Write-Host "=== DSH 视频工作台 安装器 ===" -ForegroundColor Cyan
Write-Host "  仓库:   $repoRoot"
Write-Host "  DSH:    $dshHome"
Write-Host "  profile: $Profile"
Write-Host "  模式:   $(if ($Uninstall) { '卸载' } else { '安装' })"
Write-Host ""

$profileDir = Join-Path $dshHome "profiles\$Profile"
if (-not (Test-Path $profileDir)) {
    Write-Host "❌ profile 不存在: $profileDir" -ForegroundColor Red
    Write-Host "   先创建: dsh profile add $Profile"
    exit 1
}

$pkgPath = Join-Path $profileDir "package.json"
if (-not (Test-Path $pkgPath)) {
    Write-Host "❌ 找不到 $pkgPath" -ForegroundColor Red
    exit 1
}

# ── 要处理的包 ──────────────────────────────────────────
$pkgs = @(
    "dsh-comfy-bridge",
    "dsh-comfy-workbench-tab",
    "dsh-editor",
    "dsh-video-knowledge"
)
# 只有前三个有插件入口，第四个是被 dsh-editor 引用的库
$bundleNames = @("dsh-comfy-bridge", "dsh-comfy-workbench-tab", "dsh-editor")

# ── 校验包都在 ──────────────────────────────────────────
foreach ($p in $pkgs) {
    $dir = Join-Path $repoRoot "packages\$p"
    if (-not (Test-Path $dir)) {
        Write-Host "❌ 缺包: $dir" -ForegroundColor Red
        exit 1
    }
}

Write-Host "① 备份 package.json"
$backup = "$pkgPath.install-backup-$(Get-Date -Format 'HHmmss')"
Copy-Item $pkgPath $backup
Write-Host "   → $backup" -ForegroundColor DarkGray

Write-Host "② 读取现有配置"
$cfg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json

if (-not $cfg.dependencies) {
    $cfg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([PSCustomObject]@{}) -Force
}
if (-not $cfg.dsh) {
    $cfg | Add-Member -NotePropertyName dsh -NotePropertyValue ([PSCustomObject]@{}) -Force
}
if (-not $cfg.dsh.profile) {
    $cfg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([PSCustomObject]@{}) -Force
}
if (-not $cfg.dsh.profile.bundles) {
    $cfg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force
}

if ($Uninstall) {
    Write-Host "   （卸载模式）" -ForegroundColor DarkGray
    foreach ($p in $pkgs) {
        $cfg.dependencies.PSObject.Properties.Remove($p)
    }
    $cfg.dsh.profile.bundles = @($cfg.dsh.profile.bundles | Where-Object { $bundleNames -notcontains $_ })
} else {
    foreach ($p in $pkgs) {
        # 用正斜杠，与 npm/yarn 的 link: 约定一致
        $target = (Join-Path $repoRoot "packages\$p").Replace('\', '/')
        $cfg.dependencies | Add-Member -NotePropertyName $p -NotePropertyValue "link:$target" -Force
    }
    $bundles = [System.Collections.ArrayList]@($cfg.dsh.profile.bundles)
    foreach ($b in $bundleNames) {
        if ($bundles -notcontains $b) { [void]$bundles.Add($b) }
    }
    $cfg.dsh.profile.bundles = @($bundles)
}

Write-Host "③ 写回 package.json"
$cfg | ConvertTo-Json -Depth 20 | Set-Content $pkgPath -Encoding UTF8

Write-Host "④ 处理 node_modules 软链"
$nmDir = Join-Path $profileDir "node_modules"
if (-not (Test-Path $nmDir)) { New-Item -ItemType Directory -Path $nmDir -Force | Out-Null }

foreach ($p in $pkgs) {
    $linkPath = Join-Path $nmDir $p
    $target = Join-Path $repoRoot "packages\$p"

    if (Test-Path $linkPath) {
        $item = Get-Item $linkPath -Force
        if ($item.LinkType) {
            Remove-Item $linkPath -Force -Recurse
        } else {
            Write-Host "   ⚠️  $p 是真目录不是软链，跳过（请手动确认）" -ForegroundColor Yellow
            continue
        }
    }

    if (-not $Uninstall) {
        try {
            New-Item -ItemType SymbolicLink -Path $linkPath -Target $target -Force | Out-Null
            Write-Host "   ✅ $p" -ForegroundColor Green
        } catch {
            Write-Host "   ❌ $p 软链失败: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "      需要管理员权限，或开启开发者模式" -ForegroundColor Yellow
        }
    } else {
        Write-Host "   ✅ 已移除 $p" -ForegroundColor Green
    }
}

Write-Host ""
if ($Uninstall) {
    Write-Host "✅ 卸载完成" -ForegroundColor Green
} else {
    Write-Host "✅ 安装完成" -ForegroundColor Green
    Write-Host ""
    Write-Host "下一步（必须做，否则跑不起来）：" -ForegroundColor Cyan
    Write-Host "  1. 重启 DSH:  dsh --profile $Profile"
    Write-Host "  2. 打开 设置 → ComfyUI 与环境"
    Write-Host "  3. 填写 ComfyUI 安装目录 / 输出目录 / 输入目录"
    Write-Host "  4. 点「体检」，看缺哪些模型"
    Write-Host "  5. 点底部状态栏的 ComfyUI 圆点启动它"
    Write-Host ""
    Write-Host "★ 插件不内置任何本机路径，第 3 步不能跳过。" -ForegroundColor Yellow
}
Write-Host ""

