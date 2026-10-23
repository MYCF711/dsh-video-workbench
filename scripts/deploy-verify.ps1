# 部署实测脚本 —— 从零装一个实例，起起来，真生成一次，然后清理。
#
# ★ 为什么单独做一个脚本而不是塞进 verify-all：
#   完整流程 = 建 profile + 装包 + 起实例 32 秒 + 生成 35 秒 + 清理
#   ≈ 1.5 分钟，且会占用 ComfyUI 队列、污染 output。
#   每轮验收都跑会拖慢并制造垃圾。
#   ⇒ 需要时手动跑这个，日常用 verify-deploy-static.mjs 防回退。
#
# 用法：
#   pwsh -NoProfile -File .\scripts\deploy-verify.ps1
#   pwsh -NoProfile -File .\scripts\deploy-verify.ps1 -Port 19531 -Keep
#
# 前置：ComfyUI 在线（127.0.0.1:8188）

param(
    [string]$Profile = "deploy-test",
    [int]$Port = 19530,
    [switch]$Keep   # 保留 profile 与实例，便于排查
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { "D:\DeepSeek Harness\home" }
$cli = "D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
$profDir = Join-Path $dshHome "profiles\$Profile"
$outputDir = "D:\Comfy-Desktop\ComfyUI-Shared\output"
$cookie = "dsh-auth-CK36o8O6fn6VWHrnbEp0bsjzKPKRmilHp-TBfPBH65k"

function Step($n, $msg) { Write-Host "`n=== $n · $msg ===" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  ✅ $msg" -ForegroundColor Green }
function Bad($msg) { Write-Host "  ❌ $msg" -ForegroundColor Red; $script:failed = $true }

$failed = $false
$startedPid = $null
$madeFiles = @()

# ── 前置检查 ──
Step "0" "前置检查"
$comfy = Get-NetTCPConnection -LocalPort 8188 -State Listen -ErrorAction SilentlyContinue
if (-not $comfy) {
    Write-Host "  ⚠ ComfyUI 不在线（8188 未监听）—— 生成那一步会失败" -ForegroundColor Yellow
    Write-Host "     可以用底部状态栏的 ComfyUI 圆点启动它" -ForegroundColor Yellow
} else { Ok "ComfyUI 在线（PID $($comfy.OwningProcess)）" }

if (-not (Test-Path $cli)) { Bad "找不到 dsh CLI：$cli"; exit 1 }
Ok "dsh CLI 存在"

# ── ① 建 profile ──
Step "1" "建全新 profile（不复制现有的）"
if (Test-Path $profDir) { Remove-Item $profDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $profDir, "$profDir\node_modules" | Out-Null
@{
    name = $Profile; version = '0.0.1'; private = $true
    dependencies = [ordered]@{}
    dsh = @{ profile = @{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app') } }
} | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $profDir "package.json") -Encoding UTF8
Ok "profile 目录已建：$profDir"

# ── ② install.ps1 ──
Step "2" "跑 install.ps1"
Push-Location $repo
try {
    $out = pwsh -NoProfile -File .\install.ps1 -Profile $Profile 2>&1 | Out-String
    if ($out -match '安装完成') { Ok "install.ps1 完成" } else { Bad "install.ps1 未见「安装完成」"; Write-Host $out }
} finally { Pop-Location }

# ── ③ 补依赖 ──
Step "3" "dsh plugin install"
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = $dshHome
& $cli plugin install --profile $Profile 2>&1 | Select-Object -Last 2 | ForEach-Object { Write-Host "  $_" }

# ── ④ 起实例 ──
Step "4" "起实例（端口 $Port）"
$outLog = Join-Path $env:TEMP "deploy-out.log"
$errLog = Join-Path $env:TEMP "deploy-err.log"
Remove-Item $outLog, $errLog -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $cli -ArgumentList '--profile', $Profile, '--port', "$Port", '--no-open' `
    -NoNewWindow -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
$startedPid = $p.Id
Start-Sleep -Seconds 32

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listening) { Ok "端口 $Port 在监听" } else { Bad "端口 $Port 没起来"; Write-Host (Get-Content $errLog -Raw -EA SilentlyContinue) }

$errText = Get-Content $errLog -Raw -ErrorAction SilentlyContinue
if ($errText -match 'skipping|error') { Bad "错误日志有 skipping/error：`n$errText" } else { Ok "错误日志干净" }

$m = [regex]::Match((Get-Content $outLog -Raw -EA SilentlyContinue), 'token=([A-Za-z0-9_\-]+)')
$tok = $m.Groups[1].Value
if (-not $tok) { Bad "拿不到 token"; } else { Ok "拿到 token（长度 $($tok.Length)）" }

$hdr = @{ Cookie = "$cookie=$tok" }

# ── ⑤ 四个路由 ──
Step "5" "四个路由"
if ($tok) {
    foreach ($ep in @('/comfy-bridge/health', '/timeline/assets', '/comfy-bridge/config', '/comfy-bridge/modes')) {
        try {
            $r = Invoke-RestMethod "http://127.0.0.1:$Port$ep" -Headers $hdr -TimeoutSec 25
            $sum = if ($ep -match 'health') { "ok=$($r.ok) modes=$($r.modes)" }
                   elseif ($ep -match 'assets') { "total=$($r.stats.total)" }
                   elseif ($ep -match 'modes') { "$($r.Count) 个工作流" } else { "" }
            Ok "$ep  $sum"
        } catch { Bad "$ep : $($_.Exception.Message)" }
    }
}

# ── ⑥ 真实生成 ──
Step "6" "真实生成（krea2 生图）"
if ($tok) {
    <#
     * ★★ 2026-10-24 修：产物判定从「名字不在 before 里」改成「mtime 晚于开始时刻」。
     *
     *   第一次跑的实际输出是「本次新增 0 个产物」—— 但明明出了 2 个。
     *   根因：ComfyUI 的 SaveImage 用 前缀+计数器 命名，
     *         计数器会复用（这次生成的 Krea2-2ST-..._00358_.png
     *         之前就存在过），所以「名字不在 before 里」判不出来。
     *
     *   ⇒ 用 mtime 判：本次开始之后被写过的文件才是本次产物。
     #>
    $t0 = Get-Date
    $body = @{ modeId = 'krea2'; prompt = 'a single red apple on white table'; steps = 4 } | ConvertTo-Json
    try {
        $h2 = $hdr.Clone(); $h2['Content-Type'] = 'application/json'
        $g = Invoke-RestMethod "http://127.0.0.1:$Port/comfy-bridge/generate" -Method POST -Headers $h2 -Body $body -TimeoutSec 60
        Ok "提交成功 jobId=$($g.jobId) nodes=$($g.nodes)"

        $done = $false
        for ($i = 0; $i -lt 80; $i++) {
            Start-Sleep -Seconds 3
            $j = Invoke-RestMethod "http://127.0.0.1:$Port/comfy-bridge/job/$($g.jobId)" -Headers $hdr -TimeoutSec 25
            if ($j.completed) {
                Ok "完成 outputs=$($j.outputs.Count)"
                $j.outputs | Select-Object -First 3 | ForEach-Object { Write-Host "      $($_.filename)" }
                $done = $true
                break
            }
        }
        if (-not $done) { Bad "生成超时（240 秒）" }

        <#
         * ★★ 2026-10-24 第三修：轮询等文件真出现，别固定 sleep。
         *
         *   前两次都失败，实测证据：
         *     第一次：固定 sleep 4 秒 → 「本次新增 0 个」
         *     第二次：改用 /history 报文件名 + 固定 sleep 4 秒
         *             → 「报告产出 1 个，磁盘确认 0 个」
         *
         *   后来手动核对：那个文件【确实写了】，只是**在我检查之后才落盘**
         *   （1:04:44 写入，而脚本 0:52 就查完了）。
         *
         *   ★ 这与 C4（验收污染）那次是同一个教训：
         *     「等异步写入完成」不能用固定 sleep —— 要观察真实信号。
         *     这里最可靠的信号就是：**那个文件真的存在了**。
         *
         *   ⇒ 轮询最多 20 秒，每 1 秒看一次，直到文件出现。
         #>

        # 先从 /history 拿产物名
        $produced = @()
        try {
            $hist = Invoke-RestMethod "http://127.0.0.1:8188/history?max_items=1" -TimeoutSec 20
            foreach ($k in $hist.PSObject.Properties.Name) {
                $outs = $hist.$k.outputs
                if (-not $outs) { continue }
                foreach ($pk in $outs.PSObject.Properties) {
                    $o = $pk.Value
                    foreach ($arr in @('images', 'gifs', 'videos')) {
                        if ($o.$arr) {
                            foreach ($f in $o.$arr) {
                                if ($f.type -eq 'output' -and $f.filename) { $produced += $f.filename }
                            }
                        }
                    }
                }
            }
        } catch { Write-Host "  （读 /history 失败：$($_.Exception.Message)）" -ForegroundColor Yellow }

        $produced = @($produced | Select-Object -Unique)

        <# 轮询等文件真出现（最多 20 秒）—— 不用固定 sleep #>
        $onDisk = @()
        for ($w = 0; $w -lt 20; $w++) {
            $onDisk = @($produced | Where-Object { Test-Path (Join-Path $outputDir $_) })
            if ($onDisk.Count -ge $produced.Count -and $produced.Count -gt 0) { break }
            Start-Sleep -Seconds 1
        }

        Write-Host "  ComfyUI 报告产出 $($produced.Count) 个，磁盘上确认 $($onDisk.Count) 个（等了 $w 秒）"
        $produced | ForEach-Object { Write-Host "      $_" }

        if ($produced.Count -eq 0) {
            Bad "ComfyUI 没报告任何 output 类产物"
        } elseif ($onDisk.Count -eq 0) {
            Bad "ComfyUI 报了产物名，但 $outputDir 里等 20 秒仍找不到 —— output 目录可能配错了"
        } else {
            Ok "产物已落盘（$($onDisk.Count) 个）"
        }
        $madeFiles = $onDisk
    } catch { Bad "生成失败：$($_.Exception.Message)" }
}

# ── ⑦ 清理 ──
Step "7" "清理"
foreach ($n in $madeFiles) {
    $p3 = Join-Path $outputDir $n
    if (Test-Path $p3) { Remove-Item $p3 -Force; Write-Host "  删产物 $n" }
}

<#
 * ★★ 2026-10-24 修：停实例要【按端口找 PID】，不能按 Start-Process 拿到的那个。
 *
 *   第一次跑完发现 19530 还在监听（PID 33732），而脚本里停的是 $startedPid。
 *   根因：dsh.cmd 是批处理包装，它再启动 DeepSeek Harness.exe 子进程。
 *         停 cmd 的 PID 不会杀掉实际监听端口的进程。
 *
 *   ⇒ 一律按端口反查 PID 再停。
 #>
if (-not $Keep) {
    $lp = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($lp) {
        Stop-Process -Id $lp.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Host "  停实例（按端口找到 PID $($lp.OwningProcess)）"
        Start-Sleep -Seconds 2
        $still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($still) { Write-Host "  ⚠ 端口 $Port 仍被占用（PID $($still.OwningProcess)）" -ForegroundColor Yellow }
        else { Write-Host "  端口 $Port 已释放" }
    }
    <# 兜底：如果 $startedPid 还在，也停掉（包装进程） #>
    if ($startedPid) { Stop-Process -Id $startedPid -Force -ErrorAction SilentlyContinue }
}
if ((Test-Path $profDir) -and -not $Keep) {
    Remove-Item $profDir -Recurse -Force
    Write-Host "  删 profile $Profile"
}

Write-Host ""
if ($failed) {
    Write-Host "═══ 部署实测：有失败项 ═══" -ForegroundColor Red
    exit 1
}
Write-Host "═══ 部署实测：全部通过 ═══" -ForegroundColor Green
Write-Host "  装包 → 起实例 → 四个路由 → 真实生成 → 清理，全链路走通。"
exit 0

