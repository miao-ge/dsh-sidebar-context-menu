<#
.SYNOPSIS
  把本仓库的这个 DSH 插件装进一个或多个 profile（幂等，可反复运行）。

.DESCRIPTION
  包名从本仓库根目录的 package.json 里读，所以这个脚本在两个插件仓库里是同一份，
  不需要改任何东西。

  为什么不能直接用 `dsh plugin --profile desktop add link:H:/xxx`：
  pnpm 10 在 Windows 上把 link: / file: 的路径当成「相对 profile 目录」处理，跨盘符
  （profile 在 C:，源码在别的盘）会退化成 path.join，生成一个垃圾链接：
      node_modules\<包名> -> C:\...\profiles\desktop\H:\xxx     ← 不存在
  于是 dsh 读不到 package.json，报 "declares no dsh.bundle"。

  本脚本绕开这个坑，而且**不需要 pnpm**：

    1. 在 C 盘建「发布点」<DSH_HOME>\plugins\<包名>，它是指向本仓库的 junction
       —— 源码仍然是活的，改完不用重新发布；
    2. dependencies 里写同盘符的相对链接 link:../../plugins/<包名>（将来真跑 pnpm 也不会坏）；
    3. 直接建 <profile>\node_modules\<包名> 的 junction 指向发布点；
    4. **校验 junction 真能解析到插件清单之后**，才把包名写进 dsh.profile.bundles
       （bundle 行指向解析不到的包会让该 profile 起不来或整条 bundle 被跳过）。

  跑完重启桌面端（或 dsh web）。客户端半边（lib/client.js）改完通常硬刷新页面即可，
  宿主半边（lib/index.js）改完要重启。

.PARAMETER Profile
  desktop | web | both，或者一个 profile 目录的绝对路径。默认 desktop。

.PARAMETER Uninstall
  先摘掉 dsh.profile.bundles 行，再删依赖与 node_modules junction（发布点也一起删）。

.PARAMETER RunPnpm
  额外在 profile 目录里跑一次 pnpm install。默认不跑：本脚本自己建 junction 就够了。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Profile both
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$Pnpm = '',
  [switch]$Uninstall,
  [switch]$RunPnpm
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- 读本包身份

$repoRoot = Split-Path -Parent $PSScriptRoot
$sourceManifestPath = Join-Path $repoRoot 'package.json'
if (-not (Test-Path -LiteralPath $sourceManifestPath)) { throw "找不到 $sourceManifestPath" }

$sourceManifest = Get-Content -LiteralPath $sourceManifestPath -Raw | ConvertFrom-Json
$packageName = $sourceManifest.name
if ([string]::IsNullOrWhiteSpace($packageName)) { throw "$sourceManifestPath 里没有 name 字段" }

$patchRel = $sourceManifest.dsh.bundle.patch
if ([string]::IsNullOrWhiteSpace($patchRel)) {
  throw "$packageName 的 package.json 没有声明 dsh.bundle.patch —— 这样装上去 profile 也不会加载它"
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $patchRel))) {
  throw "dsh.bundle.patch 指向的 $patchRel 不存在"
}

Write-Host "插件：$packageName@$($sourceManifest.version)" -ForegroundColor Cyan
Write-Host "源码：$repoRoot"

# ---------------------------------------------------------------- 目标 profile

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profilesDir = Join-Path $dshHome 'profiles'

$targetSpecs = switch ($Profile) {
  'both' { @('desktop', 'web') }
  default { @($Profile) }
}

function Resolve-ProfileDir([string]$spec) {
  if (Test-Path -LiteralPath $spec -PathType Container) { return (Resolve-Path -LiteralPath $spec).Path }
  return (Join-Path $profilesDir $spec)
}

# ---------------------------------------------------------------- 写权限预检

function Test-Writable([string]$dir, [string]$label) {
  try {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $probe = Join-Path $dir '.__dsh_plugin_write_probe.tmp'
    Set-Content -LiteralPath $probe -Value 'probe' -ErrorAction Stop
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
  } catch {
    throw "$label 没有写权限：$dir`n原因：$($_.Exception.Message)`n请在普通 Windows 终端（不要用 DSH 界面里的终端）里运行本脚本。"
  }
}

# ------------------------------------------------- 相对路径（必须同盘符）

function Get-RelativeTo([string]$Base, [string]$Target) {
  $b = [IO.Path]::GetFullPath($Base).TrimEnd('\') + '\'
  $t = [IO.Path]::GetFullPath($Target)
  if ([IO.Path]::GetPathRoot($b) -ne [IO.Path]::GetPathRoot($t)) {
    throw "profile 目录与发布点不在同一个盘符（$b vs $t）：pnpm 的 link: 在 Windows 上跨盘符会生成坏链接。"
  }
  $bu = [Uri]('file:///' + $b.Replace('\', '/'))
  $tu = [Uri]('file:///' + $t.Replace('\', '/'))
  return (([Uri]::UnescapeDataString($bu.MakeRelativeUri($tu).ToString())) -replace '/', '\')
}

# ------------------------------------------- 只删链接，绝不删链接指向的内容

function Remove-LinkOnly([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return }
  $item = $null
  try { $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop } catch { return }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    & cmd.exe /c rmdir "$path" 2>$null | Out-Null
  } else {
    throw "已存在真实目录，请先手动删除或改名：$path"
  }
}

function Set-Junction([string]$path, [string]$target) {
  Remove-LinkOnly $path
  $parent = Split-Path -Parent $path
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  New-Item -ItemType Junction -Path $path -Target $target | Out-Null
}

# ---------------------------------------------------------------- pnpm 探测

if ([string]::IsNullOrWhiteSpace($Pnpm)) {
  $cmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($cmd) { $Pnpm = $cmd.Source }
  elseif (Test-Path 'H:\node\node_global\pnpm.cmd') { $Pnpm = 'H:\node\node_global\pnpm.cmd' }
  else { $Pnpm = '' }
}

# ================================================================ 主流程

$publishDir = Join-Path (Join-Path $dshHome 'plugins') $packageName
$anythingInstalled = $false

foreach ($spec in $targetSpecs) {
  $profileDir = Resolve-ProfileDir $spec
  Write-Host ''
  Write-Host "=== profile: $spec" -ForegroundColor Cyan
  Write-Host "    $profileDir"

  if (-not (Test-Path -LiteralPath $profileDir)) {
    throw "找不到 profile 目录：$profileDir`n先启动一次该 profile（桌面端 / dsh web）再跑本脚本。"
  }
  $pkgPath = Join-Path $profileDir 'package.json'
  if (-not (Test-Path -LiteralPath $pkgPath)) {
    throw "找不到 $pkgPath`n先启动一次该 profile 再跑本脚本。"
  }
  Test-Writable $profileDir 'profile 目录'
  Test-Writable (Join-Path $profileDir 'node_modules') 'profile 的 node_modules 目录'
  Test-Writable (Join-Path $dshHome 'plugins') '发布点根目录'

  # ---- 备份一次
  $backup = "$pkgPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $pkgPath -Destination $backup
  Write-Host "    已备份 -> $backup"

  $pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
  $deps = [ordered]@{}
  if ($pkg.dependencies) {
    foreach ($property in $pkg.dependencies.PSObject.Properties) { $deps[$property.Name] = $property.Value }
  }
  $bundles = @()
  if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) { $bundles = @($pkg.dsh.profile.bundles) }

  $linkPath = Join-Path (Join-Path $profileDir 'node_modules') $packageName
  $enabled = $false

  if ($Uninstall) {
    Remove-LinkOnly $linkPath
    Remove-LinkOnly $publishDir
    if ($deps.Contains($packageName)) { $deps.Remove($packageName) }
    $bundles = @($bundles | Where-Object { $_ -ne $packageName })
    Write-Host "    已移除：$packageName（依赖 / bundles / junction）"
  } else {
    # 1) 发布点（junction -> 本仓库，源码保持活的）
    Set-Junction $publishDir $repoRoot

    # 2) dependencies：同盘符相对链接（将来真跑 pnpm 也安全）
    $linkSpec = 'link:' + ((Get-RelativeTo $profileDir $publishDir) -replace '\\', '/')
    $deps[$packageName] = $linkSpec

    # 3) profile 的 node_modules junction
    Set-Junction $linkPath $publishDir

    # 4) 校验：必须真能通过链接读到清单，且声明了 dsh.bundle.patch
    $manifest = $null
    $manifestPath = Join-Path $linkPath 'package.json'
    if (Test-Path -LiteralPath $manifestPath) {
      try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { $manifest = $null }
    }
    $ok = ($manifest -ne $null) -and ($manifest.name -eq $packageName) -and ($manifest.dsh.bundle.patch)
    if ($ok) {
      if ($bundles -notcontains $packageName) { $bundles += $packageName }
      $enabled = $true
      Write-Host "    OK  $packageName -> $linkSpec" -ForegroundColor Green
    } else {
      Write-Warning "    $packageName 没有通过链接解析到正确清单 —— 不会写进 dsh.profile.bundles。"
      Write-Warning "    期望：$manifestPath（name=$packageName + dsh.bundle.patch）"
    }
  }

  $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]$deps) -Force
  if ($null -eq $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{ profile = [pscustomobject]@{} }) }
  if ($null -eq $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
  $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
  [IO.File]::WriteAllText($pkgPath, (($pkg | ConvertTo-Json -Depth 20) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "    已写入 $pkgPath"
  Write-Host "    bundles = $($bundles -join ', ')"

  if ($enabled) {
    $anythingInstalled = $true
    Write-Host "    已启用：$packageName@$($manifest.version)" -ForegroundColor Green
  }

  # ---- 可选：跑一次 pnpm
  if ($RunPnpm -and -not $Uninstall) {
    if ([string]::IsNullOrWhiteSpace($Pnpm)) {
      Write-Warning '    没找到 pnpm，跳过 install。请手动在 profile 目录执行 pnpm install'
    } else {
      Push-Location $profileDir
      try {
        Write-Host "    执行：$Pnpm install --offline"
        & $Pnpm install --offline
        if ($LASTEXITCODE -ne 0) {
          Write-Warning '    --offline 失败，改试普通 install（可能需要联网）...'
          & $Pnpm install
        }
      } finally { Pop-Location }
    }
  }
}

# ---------------------------------------------------------------- 收尾

Write-Host ''
if ($Uninstall) {
  Write-Host '已卸载。重启桌面端 / dsh web 后生效。' -ForegroundColor Yellow
} elseif ($anythingInstalled) {
  Write-Host '下一步：' -ForegroundColor Yellow
  Write-Host '  1) 重启桌面端（若该 profile 开了 HMR，可能已经热挂上了）'
  Write-Host '  2) 浏览器硬刷新（Ctrl+Shift+R）'
} else {
  Write-Host '没有启用成功，请检查上面的警告。' -ForegroundColor Yellow
}
