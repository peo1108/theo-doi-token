# Bật / tắt tự chạy icon khay (kèm server) khi đăng nhập Windows.
#   powershell -ExecutionPolicy Bypass -File autostart.ps1            -> bật
#   powershell -ExecutionPolicy Bypass -File autostart.ps1 -Uninstall -> tắt
param([switch]$Uninstall)

$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Theo doi token Claude.lnk'

if ($Uninstall) {
  if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Output "Đã tắt tự chạy (xoá $lnk)" }
  else { Write-Output 'Tự chạy chưa được bật' }
  exit
}

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = (Get-Command powershell.exe).Source
$s.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'tray.ps1')`""
$s.WorkingDirectory = $PSScriptRoot
$s.WindowStyle = 7
$s.Description = 'Theo dõi token Claude Code'
$s.Save()
Write-Output "Đã bật tự chạy: $lnk"
