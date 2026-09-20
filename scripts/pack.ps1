# 本地打包：src/bin/package.json/package-lock.json/deploy 打成 dist/larkrelay-<sha>.tgz。
# sha 取当前 HEAD 短哈希；VERSION 文件写进包里，方便解包后核对版本。
# 用 Windows 10+ 自带 tar（bsdtar/libarchive），不装额外工具。
# 输出：唯一的管道对象是 sha 字符串，方便 deploy.ps1 用 `$sha = & .\pack.ps1` 直接拿到。
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

$sha = (& git -C $repoRoot rev-parse --short HEAD).Trim()
if (-not $sha) { throw "拿不到 git sha，确认 $repoRoot 是仓库" }

$distDir = Join-Path $repoRoot 'dist'
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

$paths = @('src', 'bin', 'package.json', 'package-lock.json', 'deploy')
foreach ($p in $paths) {
  if (-not (Test-Path (Join-Path $repoRoot $p))) {
    throw "缺少 $p，检查工作目录是不是仓库根"
  }
}

# VERSION 落在 dist/ 里（已 gitignore），不污染仓库；打包时用第二个 -C 把它并进包根目录
$versionFile = Join-Path $distDir 'VERSION'
"$sha`n" | Out-File -FilePath $versionFile -Encoding ascii -NoNewline

$tarball = Join-Path $distDir "larkrelay-$sha.tgz"
if (Test-Path $tarball) { Remove-Item $tarball -Force }

# 必须钉死系统自带的 bsdtar：如果这个脚本是从 Git Bash 派生的环境里调起的，
# PATH 里的 tar 会是 MSYS 版，它不认 D:\ 这种 Windows 路径，报「Error is not recoverable」。
$tarExe = Join-Path (Join-Path $env:SystemRoot 'System32') 'tar.exe'
if (-not (Test-Path $tarExe)) { $tarExe = 'tar' }

$tarArgs = @('-czf', $tarball, '-C', $repoRoot) + $paths + @('-C', $distDir, 'VERSION')
& $tarExe @tarArgs
if ($LASTEXITCODE -ne 0) { throw "tar 打包失败，退出码 $LASTEXITCODE" }

Write-Host "sha: $sha"
Write-Host "包: $tarball"

Write-Output $sha
