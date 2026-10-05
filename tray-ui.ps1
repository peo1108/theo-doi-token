# Giao diện menu khay kiểu bảng nổi (dot-source từ tray.ps1): chủ đề sáng/tối, bo góc, dòng 40px, icon tròn.
# Hàm chính: Update-TrayMenu (dựng lại menu từ dữ liệu), Initialize-TrayMenu (gắn sự kiện Opening).
# Không phụ thuộc server hay mutex, nên có thể gọi với dữ liệu giả để chụp thử.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:TrayAvatarColors = @('#d97757', '#2f7d4f', '#3987e5', '#8e5bd6', '#c98500', '#c0392b')
$script:TrayGlyph = @{ Dashboard = [string][char]0xE9D2; Settings = [string][char]0xE713; Refresh = [string][char]0xE72C
                       Folder = [string][char]0xE838; Add = [string][char]0xE710; Warn = [string][char]0xE7BA }
$script:TrayLast = $null      # tham số lần dựng gần nhất (để dựng lại khi Opening)
$script:TrayDirty = $false
$script:TrayDarkUsed = $null

if (-not ('TrayRenderer' -as [type])) {
  Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

public class TrayRenderer : ToolStripProfessionalRenderer
{
    public Color Back, Hover, Text, SubText, Sep, Warn;
    public Dictionary<ToolStripItem, Image> Badges = new Dictionary<ToolStripItem, Image>();

    public TrayRenderer() : base(new ProfessionalColorTable()) { RoundedEdges = false; }

    static string TagOf(ToolStripItem it) { return it.Tag as string ?? ""; }

    static bool Inert(ToolStripItem it)
    {
        string t = TagOf(it);
        return t == "sub" || t == "head" || t == "dim" || t == "warn" || t == "acct-on" || t == "acct-dim-on";
    }

    static GraphicsPath Round(Rectangle r, int rad)
    {
        int d = rad * 2;
        GraphicsPath p = new GraphicsPath();
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
    {
        using (SolidBrush b = new SolidBrush(Back)) e.Graphics.FillRectangle(b, e.AffectedBounds);
    }

    protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { }

    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
    {
        using (Pen p = new Pen(Sep))
            e.Graphics.DrawRectangle(p, 0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
    }

    protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
    {
        int y = e.Item.Height / 2;
        using (Pen p = new Pen(Sep)) e.Graphics.DrawLine(p, 14, y, e.Item.Width - 14, y);
    }

    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
    {
        ToolStripItem it = e.Item;
        Graphics g = e.Graphics;
        if (it.Enabled && (it.Selected || it.Pressed) && !Inert(it))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle r = new Rectangle(6, 1, it.Width - 12, it.Height - 2);
            using (GraphicsPath p = Round(r, 6))
            using (SolidBrush b = new SolidBrush(Hover)) g.FillPath(b, p);
        }
        Image badge;
        if (Badges.TryGetValue(it, out badge) && badge != null)
            g.DrawImage(badge, it.Width - 14 - badge.Width, (it.Height - badge.Height) / 2, badge.Width, badge.Height);
    }

    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        string tag = TagOf(e.Item);
        Color c = Text;
        if (tag == "sub" || tag == "dim" || tag.StartsWith("acct-dim")) c = SubText;
        else if (tag == "warn") c = Warn;
        e.TextColor = c;
        if (e.Item is ToolStripMenuItem && e.Text != e.Item.Text && tag.StartsWith("acct"))
        {
            Rectangle r = e.TextRectangle;
            r.X -= 6;
            e.TextRectangle = r;
        }
        base.OnRenderItemText(e);
    }
}

public static class TrayDwm
{
    [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
}
'@
}

function Fmt-Usd([double]$v) { '$' + $v.ToString('0.00', [Globalization.CultureInfo]::InvariantCulture) }

function Get-TrayTheme([string]$Force) {
  $dark = $true
  if ($Force) { $dark = ($Force -ne 'Light') }
  else {
    try {
      $v = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction Stop).AppsUseLightTheme
      if ($v -eq 1) { $dark = $false }
    } catch { $dark = $true }
  }
  $c = { param($h) [System.Drawing.ColorTranslator]::FromHtml($h) }
  if ($dark) {
    @{ Dark = $true; Back = (& $c '#2b2b2b'); Hover = (& $c '#3d3d3d'); Text = (& $c '#ffffff'); SubText = (& $c '#a0a0a0'); Sep = (& $c '#444444'); Warn = (& $c '#f0b429'); WarnHex = '#f0b429' }
  } else {
    @{ Dark = $false; Back = (& $c '#f9f9f9'); Hover = (& $c '#e8e8e8'); Text = (& $c '#1a1a1a'); SubText = (& $c '#6b6b6b'); Sep = (& $c '#dddddd'); Warn = (& $c '#9a6700'); WarnHex = '#9a6700' }
  }
}

function New-TrayRenderer($theme) {
  $r = New-Object TrayRenderer
  $r.Back = $theme.Back; $r.Hover = $theme.Hover; $r.Text = $theme.Text
  $r.SubText = $theme.SubText; $r.Sep = $theme.Sep; $r.Warn = $theme.Warn
  return $r
}

function Set-RoundCorners([IntPtr]$hwnd) {
  try { $v = 2; [void][TrayDwm]::DwmSetWindowAttribute($hwnd, 33, [ref]$v, 4) } catch { }
}

function Get-GlyphFontName {
  if (-not $script:TrayGlyphFont) {
    $names = (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }
    $script:TrayGlyphFont = if ($names -contains 'Segoe Fluent Icons') { 'Segoe Fluent Icons' } else { 'Segoe MDL2 Assets' }
  }
  $script:TrayGlyphFont
}

function New-TrayBitmap([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)
  return @{ Bmp = $bmp; G = $g }
}

function New-GlyphIcon([string]$glyph, [string]$hex, [int]$size = 20) {
  $o = New-TrayBitmap $size $size
  $font = New-Object System.Drawing.Font((Get-GlyphFontName), ($size * 0.72), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex))
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $o.G.DrawString($glyph, $font, $brush, (New-Object System.Drawing.RectangleF 0, 0, $size, $size), $sf)
  $o.G.Dispose(); $font.Dispose(); $brush.Dispose(); $sf.Dispose()
  return $o.Bmp
}

function Get-AvatarColor([string]$id) {
  $h = 0
  foreach ($ch in $id.ToCharArray()) { $h = ($h * 31 + [int]$ch) % 1000003 }
  $script:TrayAvatarColors[$h % $script:TrayAvatarColors.Count]
}

function New-AvatarIcon([string]$letter, [string]$hex, [int]$size = 22) {
  $o = New-TrayBitmap $size $size
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex))
  $o.G.FillEllipse($brush, 0, 0, ($size - 1), ($size - 1))
  $font = New-Object System.Drawing.Font('Segoe UI', ($size * 0.5), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $o.G.DrawString($letter.ToUpper(), $font, $white, (New-Object System.Drawing.RectangleF 0, 0, $size, ($size + 1)), $sf)
  $o.G.Dispose(); $brush.Dispose(); $font.Dispose(); $white.Dispose(); $sf.Dispose()
  return $o.Bmp
}

function New-StatusDot([string]$hex) {
  $o = New-TrayBitmap 8 8
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex))
  $o.G.FillEllipse($brush, 0, 0, 7, 7)
  $o.G.Dispose(); $brush.Dispose()
  return $o.Bmp
}

# Dòng menu: $kind = '' | 'sub' | 'dim' | 'warn' | 'acct' | 'acct-dim' | 'head'
function Add-TrayRow($menu, [string]$text, $image, [string]$kind, $onClick, [string]$right, [bool]$bold, [int]$height, [string]$dotHex, [int]$indent) {
  $it = New-Object System.Windows.Forms.ToolStripMenuItem
  $it.Text = $text.Replace('&', '&&')   # & là ký tự mnemonic của menu
  $it.Tag = $kind
  $it.AutoSize = $false
  $it.Size = New-Object System.Drawing.Size(300, $height)
  $it.Padding = New-Object System.Windows.Forms.Padding((14 + $indent), 0, 14, 0)
  $it.ImageScaling = 'None'
  $it.ImageAlign = 'MiddleLeft'
  $it.TextAlign = 'MiddleLeft'
  if ($image) { $it.Image = $image }
  if ($right) { $it.ShortcutKeyDisplayString = $right }
  if ($bold) { $it.Font = New-Object System.Drawing.Font($menu.Font, [System.Drawing.FontStyle]::Bold) }
  if ($onClick) { $oc = $onClick; $it.add_Click(({ try { & $oc } catch { } }).GetNewClosure()) }
  [void]$menu.Items.Add($it)
  if ($dotHex) { $menu.Renderer.Badges[$it] = New-StatusDot $dotHex }
  return $it
}

function Add-TraySep($menu) {
  $s = New-Object System.Windows.Forms.ToolStripSeparator
  $s.AutoSize = $false
  $s.Size = New-Object System.Drawing.Size(300, 9)
  [void]$menu.Items.Add($s)
}

function Clear-TrayMenu($menu) {
  foreach ($i in @($menu.Items)) {
    if ($i.Image) { $i.Image.Dispose() }
    $i.Dispose()
  }
  $menu.Items.Clear()
  if ($menu.Renderer -is [TrayRenderer]) {
    foreach ($b in $menu.Renderer.Badges.Values) { if ($b) { $b.Dispose() } }
    $menu.Renderer.Badges.Clear()
  }
}

function Set-TrayTheme($menu, $theme) {
  $menu.Renderer = New-TrayRenderer $theme
  $menu.BackColor = $theme.Back
  $menu.ForeColor = $theme.Text
  $menu.Font = New-Object System.Drawing.Font('Segoe UI', 10)
  $menu.ImageScalingSize = New-Object System.Drawing.Size(24, 24)
  $menu.ShowImageMargin = $true
  $menu.MinimumSize = New-Object System.Drawing.Size(300, 0)
  $menu.Padding = New-Object System.Windows.Forms.Padding(0, 6, 0, 6)
  $script:TrayDarkUsed = $theme.Dark
}

# Chiều rộng menu = max(300, dòng dài nhất): đo chữ rồi đặt đồng loạt cho mọi dòng (dòng AutoSize=false không tự giãn theo menu).
function Set-TrayMenuWidth($menu) {
  $w = 300
  foreach ($i in $menu.Items) {
    if ($i -isnot [System.Windows.Forms.ToolStripMenuItem]) { continue }
    $tw = [System.Windows.Forms.TextRenderer]::MeasureText([string]$i.Text, $i.Font).Width
    $need = 14 + 31 + $i.Padding.Left - 14 + $tw + 24
    if ($i.ShortcutKeyDisplayString) {
      $need += 24 + [System.Windows.Forms.TextRenderer]::MeasureText($i.ShortcutKeyDisplayString, $i.Font).Width + 26
    }
    if ($need -gt $w) { $w = $need }
  }
  $menu.MinimumSize = New-Object System.Drawing.Size($w, 0)
  foreach ($i in $menu.Items) { $i.Size = New-Object System.Drawing.Size($w, $i.Height) }
}
function Format-Pct($x) {
  if ($x -and $null -ne $x.pct) { return ('{0}%' -f [math]::Round([double]$x.pct)) }
  return '–'
}

# Dựng lại toàn bộ menu.
#   $summary      : kết quả GET /api/summary (hoặc $null khi lỗi)
#   $accountsInfo : kết quả GET /api/accounts (hoặc $null)
#   $handlers     : @{ Open; Settings; Refresh; Folder; Exit; AddAccount; Switch = {param($id,$name)}; Keep = {param($id,$name)} }
#   $Theme        : tuỳ chọn, mặc định Get-TrayTheme
# Khi menu đang mở chỉ ghi nhớ dữ liệu, dựng lại ở lần Opening kế tiếp.
function Update-TrayMenu($menu, $summary, $accountsInfo, $handlers, $Theme) {
  $script:TrayLast = @{ Menu = $menu; Summary = $summary; Accounts = $accountsInfo; Handlers = $handlers; Theme = $Theme }
  if ($menu.Visible) { $script:TrayDirty = $true; return }
  $script:TrayDirty = $false
  try { Build-TrayMenu $menu $summary $accountsInfo $handlers $Theme }
  catch { Set-TrayFallbackMenu $menu $handlers $Theme }
}

# Menu tối thiểu (Mở dashboard + Thoát) khi dựng menu đầy đủ lỗi, để luôn còn đường thoát.
function Set-TrayFallbackMenu($menu, $handlers, $Theme) {
  try {
    $theme = if ($Theme) { $Theme } else { Get-TrayTheme }
    Clear-TrayMenu $menu
    Set-TrayTheme $menu $theme
    [void](Add-TrayRow $menu 'Mở dashboard' $null '' $handlers.Open '' $true 40 '' 0)
    Add-TraySep $menu
    [void](Add-TrayRow $menu 'Thoát' $null '' $handlers.Exit '' $false 40 '' 0)
    Set-TrayMenuWidth $menu
  } catch { }
}

function Build-TrayMenu($menu, $summary, $accountsInfo, $handlers, $Theme) {
  $theme = if ($Theme) { $Theme } else { Get-TrayTheme }
  Clear-TrayMenu $menu
  Set-TrayTheme $menu $theme

  $glyphHex = if ($theme.Dark) { '#ffffff' } else { '#1a1a1a' }
  $h = $handlers
  $row = { param($text, $glyph, $click, $bold)
    $img = New-GlyphIcon $glyph $glyphHex 20
    [void](Add-TrayRow $menu $text $img '' $click '' $bold 40 '' 0)
  }

  # --- Đầu menu: tài khoản đang dùng ---
  $accs = @()
  if ($accountsInfo -and $accountsInfo.accounts) { $accs = @($accountsInfo.accounts) }
  $activeAcc = $accs | Where-Object { $_.id -eq $accountsInfo.active } | Select-Object -First 1
  $acct = if ($summary) { $summary.account } else { $null }
  $name = if ($activeAcc) { $activeAcc.name } elseif ($acct) { $acct.name } else { $null }

  if ($name) {
    $id = if ($activeAcc) { $activeAcc.id } else { $name }
    $headImg = New-AvatarIcon ([string]$name[0]) (Get-AvatarColor $id) 24
    [void](Add-TrayRow $menu "Claude · $name" $headImg 'head' $null '' $true 34 '' 0)
  } else {
    $headImg = New-GlyphIcon $script:TrayGlyph.Dashboard $glyphHex 20
    [void](Add-TrayRow $menu 'Claude · chưa có tài khoản' $headImg 'head' $null '' $true 34 '' 0)
  }
  $sub = $null
  if ($acct -and $acct.fiveHour) {
    $sub = "5h $(Format-Pct $acct.fiveHour) · tuần $(Format-Pct $acct.sevenDay)"
    if ($acct.fiveHour.resetsAt) {
      $sub += ' · reset ' + [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$acct.fiveHour.resetsAt).LocalDateTime.ToString('HH:mm')
    }
  } elseif ($summary) {
    if ($summary.window) {
      $sub = "5h $(Fmt-Usd $summary.window.cost) · reset " + [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$summary.window.end).LocalDateTime.ToString('HH:mm')
    } else { $sub = '5h: chưa mở cửa sổ' }
    $sub += " · hôm nay $(Fmt-Usd $summary.today)"
  } else { $sub = 'Server không phản hồi' }
  [void](Add-TrayRow $menu $sub $null 'sub' $null '' $false 24 '' 0)

  # --- Xung đột đăng nhập ---
  $conf = if ($accountsInfo) { $accountsInfo.conflict } else { $null }
  if ($conf) {
    $nameOf = { param($i) $m = $accs | Where-Object { $_.id -eq $i } | Select-Object -First 1; if ($m) { $m.name } else { $i } }
    $fName = & $nameOf $conf.fileId
    $iName = & $nameOf $conf.chosenId
    $wImg = New-GlyphIcon $script:TrayGlyph.Warn $theme.WarnHex 20
    [void](Add-TrayRow $menu "Đăng nhập đang là $fName" $wImg 'warn' $null '' $true 36 '' 0)
    $cid = $conf.chosenId; $fid = $conf.fileId
    $apply = { & $h.Switch $cid $iName }.GetNewClosure()
    $keep = { & $h.Keep $fid $fName }.GetNewClosure()
    [void](Add-TrayRow $menu "Áp lại $iName" $null '' $apply '' $false 34 '' 30)
    [void](Add-TrayRow $menu "Giữ $fName" $null '' $keep '' $false 34 '' 30)
  }

  Add-TraySep $menu

  # --- Danh sách tài khoản ---
  foreach ($a in $accs) {
    $img = New-AvatarIcon (([string]$a.name + '?').Substring(0, 1)) (Get-AvatarColor $a.id) 22
    if ($a.error) {
      [void](Add-TrayRow $menu ([string]$a.name) $img 'dim' $null 'hồ sơ lỗi' $false 40 '' 0)
      continue
    }
    $isActive = ($a.id -eq $accountsInfo.active)
    $needLogin = ($a.loginState -eq 'expired') -or ($summary -and $summary.needLogin -and ($summary.needLogin -contains $a.name))
    if ($needLogin) { $right = 'cần /login' }
    else {
      $right = if ($a.usage -and ($a.usage.fiveHour -or $a.usage.sevenDay)) { "$(Format-Pct $a.usage.fiveHour) · $(Format-Pct $a.usage.sevenDay)" } else { '–' }
      if ($a.suggested -and -not $isActive) { $right += '   Gợi ý' }
    }
    $dot = if ($needLogin) { '#c0392b' } elseif ($isActive) { '#2f9e5a' } else { '' }
    $kind = if ($needLogin -and $isActive) { 'acct-dim-on' } elseif ($needLogin) { 'acct-dim' } elseif ($isActive) { 'acct-on' } else { 'acct' }
    $click = $null
    if (-not $isActive) { $aid = $a.id; $aname = $a.name; $click = { & $h.Switch $aid $aname }.GetNewClosure() }
    $it = Add-TrayRow $menu ([string]$a.name) $img $kind $click $right $isActive 40 $dot 0
  }
  [void](Add-TrayRow $menu 'Thêm tài khoản' (New-GlyphIcon $script:TrayGlyph.Add $glyphHex 20) '' $h.AddAccount '' $false 40 '' 0)

  Add-TraySep $menu

  & $row 'Mở dashboard' $script:TrayGlyph.Dashboard $h.Open $true
  & $row 'Cài đặt' $script:TrayGlyph.Settings $h.Settings $false
  & $row 'Làm mới' $script:TrayGlyph.Refresh $h.Refresh $false
  & $row 'Mở thư mục dữ liệu' $script:TrayGlyph.Folder $h.Folder $false

  Add-TraySep $menu
  [void](Add-TrayRow $menu 'Thoát' $null '' $h.Exit '' $false 40 '' 0)
  Set-TrayMenuWidth $menu
}

# Gắn sự kiện Opening: dựng lại nếu dữ liệu đổi khi menu đang mở hoặc chủ đề Windows đổi, rồi bo góc.
function Initialize-TrayMenu($menu) {
  $menu.add_Opening({
    param($s, $e)
    try {
      if ($script:TrayLast) {
        $theme = if ($script:TrayLast.Theme) { $script:TrayLast.Theme } else { Get-TrayTheme }
        if ($script:TrayDirty -or $script:TrayDarkUsed -ne $theme.Dark) {
          $l = $script:TrayLast
          Update-TrayMenu $l.Menu $l.Summary $l.Accounts $l.Handlers $l.Theme
        }
      }
      Set-RoundCorners $s.Handle
    } catch { }
  })
}
