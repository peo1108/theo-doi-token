# Icon khay hệ thống cho dashboard token Claude Code.
# - Tự chạy server (node tracker.js serve) ngầm nếu chưa chạy
# - Màu icon theo cửa sổ 5 giờ: xám = không có cửa sổ, xanh = bình thường, vàng = cao hơn TB, đỏ = vượt ngưỡng cảnh báo
# - Rê chuột xem tóm tắt, nháy đúp mở dashboard
param([switch]$Open)

$ErrorActionPreference = 'Stop'
$Port = if ($env:PORT) { [int]$env:PORT } else { 7788 }
$Base = "http://127.0.0.1:$Port"

# chỉ chạy 1 icon
$mutex = New-Object System.Threading.Mutex($false, 'Local\ClaudeTokenTray')
if (-not $mutex.WaitOne(0)) {
  if ($Open) { Start-Process $Base }
  exit
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

function Test-Server {
  try { Invoke-RestMethod "$Base/api/config" -TimeoutSec 3 | Out-Null; return $true } catch { return $false }
}

$script:serverProc = $null
if (-not (Test-Server)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    [System.Windows.Forms.MessageBox]::Show('Không tìm thấy Node.js trong PATH.', 'Theo dõi token') | Out-Null
    exit 1
  }
  $script:serverProc = Start-Process -FilePath $node -ArgumentList 'tracker.js', 'serve' `
    -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
  for ($k = 0; $k -lt 40 -and -not (Test-Server); $k++) { Start-Sleep -Milliseconds 250 }
}

function New-DotIcon([string]$hex) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex))
  $g.FillEllipse($brush, 3, 3, 26, 26)
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  # biểu tượng 3 cột nhỏ
  $g.FillRectangle($white, 9, 17, 4, 7)
  $g.FillRectangle($white, 14, 12, 4, 12)
  $g.FillRectangle($white, 19, 8, 4, 16)
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $g.Dispose(); $brush.Dispose(); $white.Dispose()
  return $icon
}

$Icons = @{
  idle = New-DotIcon '#8a8984'
  good = New-DotIcon '#2f7d4f'
  warn = New-DotIcon '#c98500'
  bad  = New-DotIcon '#c0392b'
  off  = New-DotIcon '#555555'
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $Icons.idle
$tray.Text = 'Theo dõi token Claude Code'
$tray.Visible = $true

. (Join-Path $PSScriptRoot 'tray-ui.ps1')

$menu = New-Object System.Windows.Forms.ContextMenuStrip
Initialize-TrayMenu $menu
$tray.ContextMenuStrip = $menu

# Lấy `message` từ thân JSON của lỗi HTTP (PS 5.1: ErrorDetails, hoặc đọc luồng phản hồi); không có thì dùng thông báo ngoại lệ.
function Get-ApiErrorMessage($err) {
  $raw = $null
  try { $raw = $err.ErrorDetails.Message } catch { }
  if (-not $raw) {
    try {
      $st = $err.Exception.Response.GetResponseStream()
      $st.Position = 0
      $raw = (New-Object System.IO.StreamReader($st, [Text.Encoding]::UTF8)).ReadToEnd()
    } catch { }
  }
  try { $d = $raw | ConvertFrom-Json; if ($d.message) { return [string]$d.message } } catch { }
  return $err.Exception.Message
}

# POST /api/accounts/* (cần header X-Token-Tracker, body UTF-8), báo kết quả bằng balloon rồi làm mới.
function Invoke-AccountAction([string]$path, $body, [string]$okTitle, [string]$failTitle) {
  $ok = $false; $msg = ''
  try {
    $json = $body | ConvertTo-Json -Compress
    $r = Invoke-RestMethod "$Base$path" -Method Post -Headers @{ 'X-Token-Tracker' = '1' } `
      -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 15
    $ok = $true
    $n = @($r.running).Count
    $msg = if ($n -gt 0) { "Có $n phiên Claude Code đang chạy - cần mở lại phiên để dùng tài khoản mới" } else { 'Có hiệu lực từ phiên Claude Code kế tiếp' }
  } catch {
    $msg = Get-ApiErrorMessage $_
  }
  # Balloon lỗi không được làm thay đổi kết quả của thao tác đã thành công.
  try {
    if ($ok) { $tray.ShowBalloonTip(5000, $okTitle, $msg, 'Info') }
    else { $tray.ShowBalloonTip(5000, $failTitle, $msg, 'Error') }
  } catch { }
  try { Update-Status } catch { }
}

$Handlers = @{
  Open       = { Start-Process $Base }
  Settings   = { Start-Process "$Base/#settings" }
  Refresh    = { Update-Status }
  Folder     = { Start-Process explorer.exe (Join-Path $PSScriptRoot 'data') }
  AddAccount = { $tray.ShowBalloonTip(5000, 'Thêm tài khoản', 'Gõ /login trong Claude Code bằng tài khoản mới', 'Info') }
  Switch     = { param($id, $name) Invoke-AccountAction '/api/accounts/switch' @{ id = $id } "Đã đổi sang $name" 'Không đổi được tài khoản' }
  Keep       = { param($id, $name) Invoke-AccountAction '/api/accounts/keep' @{ id = $id } "Đã giữ $name" 'Không giữ được tài khoản' }
  Exit       = {
    $timer.Stop()
    $tray.Visible = $false
    if ($script:serverProc -and -not $script:serverProc.HasExited) { Stop-Process -Id $script:serverProc.Id -Force -ErrorAction SilentlyContinue }
    [System.Windows.Forms.Application]::Exit()
  }
}

function Update-Status {
  try {
    $s = Invoke-RestMethod "$Base/api/summary" -TimeoutSec 10
    $cfg = Invoke-RestMethod "$Base/api/config" -TimeoutSec 5
    $ai = $null
    try { $ai = Invoke-RestMethod "$Base/api/accounts" -TimeoutSec 10 } catch { }
    if ($s.window) {
      $end = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$s.window.end).LocalDateTime.ToString('HH:mm')
      $ratio = if ($s.avgWindowCost -gt 0) { $s.projected / $s.avgWindowCost } else { 0 }
      $state = if ($s.avgWindowCost -le 0) { 'good' } elseif ($ratio -gt $cfg.alertWindowRatio) { 'bad' } elseif ($ratio -gt 1) { 'warn' } else { 'good' }
      $line = "5h $(Fmt-Usd $s.window.cost) · reset $end"
    } else {
      $state = 'idle'
      $line = '5h: chưa mở cửa sổ'
    }
    $today = "Hôm nay $(Fmt-Usd $s.today)"
    if ($cfg.budgetDay -gt 0) {
      $today += " / $(Fmt-Usd $cfg.budgetDay)"
      if ($s.today -ge $cfg.budgetDay) { $state = 'bad' } elseif ($s.today -ge 0.8 * $cfg.budgetDay -and $state -ne 'bad') { $state = 'warn' }
    }
    if (($s.conflict -or @($s.needLogin).Count -gt 0) -and ($state -eq 'idle' -or $state -eq 'good')) { $state = 'warn' }
    $tip = "$line`n$today"
    if ($s.account -and $s.account.name) { $tip = "$($s.account.name)`n$tip" }
    if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
    $tray.Text = $tip
    $tray.Icon = $Icons[$state]
    try { Update-TrayMenu $menu $s $ai $Handlers } catch { }
  } catch {
    $tray.Icon = $Icons.off
    $tray.Text = 'Server không phản hồi'
    try { Update-TrayMenu $menu $null $null $Handlers } catch { }
  }
}

$tray.add_DoubleClick({ try { Start-Process $Base } catch { } })
# Bấm trái một lần cũng mở menu (NotifyIcon mặc định chỉ mở bằng chuột phải).
$tray.add_MouseUp({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    try { [System.Windows.Forms.NotifyIcon].GetMethod('ShowContextMenu', [Reflection.BindingFlags]'Instance,NonPublic').Invoke($tray, $null) } catch { }
  }
})
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 15000
$timer.add_Tick({ try { Update-Status } catch { } })
$timer.Start()

Update-Status
if ($Open) { Start-Process $Base }

[System.Windows.Forms.Application]::Run()
$tray.Dispose()
$mutex.ReleaseMutex()
