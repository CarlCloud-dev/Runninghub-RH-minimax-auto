# RH 画布视频生成 - API 冒烟测试
# test.bat gen  → 传入 "gen" 会跑一个真实导入任务（不跑生成，完成后节点自动清理）
param([string]$Mode = "")

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$Base   = "http://127.0.0.1:19387"
$ScanDir = "E:\Develop-App\RH-upload\upload\网店系统"
$pass = 0; $fail = 0

function ok($name, $cond, $extra = "") {
  if ($cond) { $script:pass++; Write-Host "  [PASS] $name $extra" -ForegroundColor Green }
  else       { $script:fail++; Write-Host "  [FAIL] $name $extra" -ForegroundColor Red }
}
function J($m, $u, $b = $null) {
  $p = @{ Method = $m; Uri = "$Base$u"; TimeoutSec = 20 }
  if ($b) {
    $p.ContentType = "application/json; charset=utf-8"
    $p.Body = [System.Text.Encoding]::UTF8.GetBytes(($b | ConvertTo-Json -Depth 8 -Compress))
  }
  Invoke-RestMethod @p
}

Write-Host "`n== 1. API 连通 ==" -ForegroundColor Cyan
try { $st = J GET "/api/status"; ok "API 响应 $Base" $true } catch { ok "API 响应 $Base" $false $_.Exception.Message; exit 1 }

Write-Host "`n== 2. 画布会话 ==" -ForegroundColor Cyan
ok "登录态 (token)"        ($st.page.token -eq $true)
ok "userId"                ([bool]$st.page.userId) $st.page.userId
ok "agent 已注入"          ($st.main.agentReady -eq $true)
# 影子 doc 需要建链/同步，触发的 ownConnect 后等它上来
try { J POST "/api/cv" @{ cmd = "ownConnect" } | Out-Null } catch {}
$shadowOk = $false; $shadowN = -1
for ($i = 0; $i -lt 10 -and -not $shadowOk; $i++) {
  Start-Sleep 1.5
  $st2 = J GET "/api/status"
  $shadowN = $st2.page.shadow.nodes
  if ($shadowN -ge 0) { $shadowOk = $true }
}
ok "影子节点已同步"        $shadowOk ("nodes=" + $shadowN)
ok "并发槽位"              ($st.maxConcurrent -ge 1) ("maxConcurrent=" + $st.maxConcurrent)

Write-Host "`n== 3. 目录扫描 ==" -ForegroundColor Cyan
try {
  $sc = J POST "/api/scan" @{ rootDir = $ScanDir }
  $segs = ($sc.projects | ForEach-Object { $_.eps } | ForEach-Object { $_.segs }).Count
  ok "扫描 $ScanDir" ($segs -gt 0) ("SEG=" + $segs)
} catch { ok "扫描" $false $_.Exception.Message }

Write-Host "`n== 4. 任务队列 ==" -ForegroundColor Cyan
$jb = J GET "/api/jobs"
ok "jobs 接口" ($null -ne $jb.jobs) ("历史任务=" + $jb.jobs.Count + " 运行=" + $jb.running + " 排队=" + $jb.pending)

if ($Mode -eq "gen") {
  Write-Host "`n== 5. 生成任务冒烟（run:false，建节点后自动清理）==" -ForegroundColor Cyan
  $imgs = @("$ScanDir\EP018\SEG004-7s\1.png", "$ScanDir\EP018\SEG004-7s\2.png") | Where-Object { Test-Path $_ }
  if ($imgs.Count -lt 1) { ok "测试图片存在" $false $ScanDir }
  else {
    try {
      $g = J POST "/api/generate" @{ images = @($imgs); prompt = "smoke test"; run = $false }
      $jid = $g.job.id
      ok "任务已入队" ([bool]$jid) $jid
      $deadline = (Get-Date).AddSeconds(90); $jj = $null
      do { Start-Sleep 2; $jj = J GET "/api/jobs/$jid" } while ($jj.status -in @("pending","running") -and (Get-Date) -lt $deadline)
      ok "任务完成" ($jj.status -eq "done") ($jj.status + " " + $jj.progress)
      ok "节点已清理" ($jj.cleaned -eq $true)
      $nd = J GET "/api/nodes"
      ok "画布无残留" ($nd.count -eq 0) ("剩余=" + $nd.count)
    } catch { ok "generate 冒烟" $false $_.Exception.Message }
  }
} else {
  Write-Host "`n(跳过生成测试；test.bat gen 可跑完整链路)" -ForegroundColor DarkGray
}

$color = if ($fail) { "Red" } else { "Green" }
Write-Host "`n===== 结果: $pass PASS / $fail FAIL =====" -ForegroundColor $color
if ($fail) { exit 1 } else { exit 0 }
