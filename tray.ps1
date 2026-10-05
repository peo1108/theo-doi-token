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

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miSummary = $menu.Items.Add('Đang tải…')
$miSummary.Enabled = $false
[void]$menu.Items.Add('-')
$miOpen = $menu.Items.Add('Mở dashboard')
$miOpen.Font = New-Object System.Drawing.Font($miOpen.Font, [System.Drawing.FontStyle]::Bold)
$miRefresh = $menu.Items.Add('Làm mới')
$miFolder = $menu.Items.Add('Mở thư mục dữ liệu')
[void]$menu.Items.Add('-')
$miExit = $menu.Items.Add('Thoát')
$tray.ContextMenuStrip = $menu

function Fmt-Usd([double]$v) { '$' + $v.ToString('0.00', [Globalization.CultureInfo]::InvariantCulture) }

function Update-Status {
  try {
    $s = Invoke-RestMethod "$Base/api/summary" -TimeoutSec 10
    $cfg = Invoke-RestMethod "$Base/api/config" -TimeoutSec 5
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
    $tip = "$line`n$today"
    if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
    $tray.Text = $tip
    $tray.Icon = $Icons[$state]
    $miSummary.Text = "$line  ·  $today"
  } catch {
    $tray.Icon = $Icons.off
    $tray.Text = 'Server không phản hồi'
    $miSummary.Text = 'Server không phản hồi'
  }
}

$miOpen.add_Click({ Start-Process $Base })
$tray.add_DoubleClick({ Start-Process $Base })
$miRefresh.add_Click({ Update-Status })
$miFolder.add_Click({ Start-Process explorer.exe (Join-Path $PSScriptRoot 'data') })
$miExit.add_Click({
  $timer.Stop()
  $tray.Visible = $false
  if ($script:serverProc -and -not $script:serverProc.HasExited) { Stop-Process -Id $script:serverProc.Id -Force -ErrorAction SilentlyContinue }
  [System.Windows.Forms.Application]::Exit()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30000
$timer.add_Tick({ Update-Status })
$timer.Start()

Update-Status
if ($Open) { Start-Process $Base }

[System.Windows.Forms.Application]::Run()
$tray.Dispose()
$mutex.ReleaseMutex()
