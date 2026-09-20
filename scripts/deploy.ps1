# 打包 -> 上传 -> 后台跑 remote-deploy.sh -> 轮询日志直到 DEPLOY_EXIT=。
# 全程用 PowerShell 原生调用上传/执行命令（不经 Git Bash），避免 MSYS 把 /tmp/... 转成 Windows 路径。
#
# 首次 docker build 可能超过某些远程执行方式的默认超时（常见约 300 秒），所以远端命令一律先落成
# 不含任何 shell 特殊字符（重定向/&/管道）的小脚本再上传执行——直接把
# "nohup ... > log 2>&1 &" 塞进远程命令的命令行参数，某些包装工具转发时
# 会把引号剥掉，复杂命令必须走「本地写 .sh -> upload -> run sh」这条路。
[CmdletBinding()]
param(
  # ssh config 里的别名，或直接写 user@host。
  [string]$VpsAlias = 'larkrelay-host',
  # 默认走标准 scp/ssh。如果你用凭据隔离的包装器（比如内部运维工具），把这两个参数指过去即可——
  # 约定是 `& $UploadCmd upload <alias> <local> <remote>` / `& $RunCmd run <alias> <command>`。
  [string]$UploadCmd = 'scp',
  [string]$RunCmd = 'ssh',
  [int]$TimeoutMinutes = 10,
  [int]$PollSeconds = 10
)

$ErrorActionPreference = 'Stop'
$env:MSYS_NO_PATHCONV = '1'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# 参数名**不能叫 $Args**：那是 PowerShell 的自动变量，参数绑定会被它吃掉，
# 结果是每次都在无参调用远程命令（只打一屏用法就退出），上传静默不发生、日志也就永远不出现。
function Invoke-Upload {
  param([string]$LocalPath, [string]$RemotePath)
  if ($UploadCmd -eq 'scp') {
    & scp $LocalPath "${VpsAlias}:$RemotePath"
  } else {
    & $UploadCmd @('upload', $VpsAlias, $LocalPath, $RemotePath)
  }
  if ($LASTEXITCODE -ne 0) { throw "上传失败（$UploadCmd），退出码 $LASTEXITCODE" }
}

function Invoke-Run {
  param([string]$Command)
  if ($RunCmd -eq 'ssh') {
    $output = & ssh $VpsAlias $Command 2>&1
  } else {
    $output = & $RunCmd @('run', $VpsAlias, $Command) 2>&1
  }
  if ($LASTEXITCODE -ne 0) { throw "远程执行失败（$RunCmd $Command），退出码 $LASTEXITCODE" }
  return $output
}

# 1) 打包
Write-Host "== 打包 =="
$sha = (& (Join-Path $PSScriptRoot 'pack.ps1') | Select-Object -Last 1)
if (-not $sha) { throw "pack.ps1 没有返回 sha" }
$tarball = Join-Path $repoRoot "dist\larkrelay-$sha.tgz"
if (-not (Test-Path $tarball)) { throw "打包产物不存在：$tarball" }
Write-Host "sha=$sha 包=$tarball"

# 2) 上传制品与部署脚本
Write-Host "== 上传 =="
$remoteTarball = "/tmp/larkrelay-$sha.tgz"
Invoke-Upload -LocalPath $tarball -RemotePath $remoteTarball

$remoteDeployScript = '/tmp/remote-deploy.sh'
Invoke-Upload -LocalPath (Join-Path $repoRoot 'deploy\remote-deploy.sh') -RemotePath $remoteDeployScript

# 3) 起后台部署：本地生成一个只含固定 sha、没有任何 shell 特殊字符的启动脚本，
#    上传后用一句「sh /tmp/xxx.sh」触发——命令行本身没有 > & 之类的字符，
#    不给包装工具的引号处理留可乘之机。
$launcherLocal = Join-Path $env:TEMP "larkrelay-start-deploy-$sha.sh"
$launcherContent = "#!/bin/sh`nnohup sh /tmp/remote-deploy.sh $sha > /tmp/deploy.log 2>&1 &`n"
[System.IO.File]::WriteAllText($launcherLocal, $launcherContent, [System.Text.Encoding]::ASCII)

$remoteLauncher = "/tmp/start-deploy-$sha.sh"
Invoke-Upload -LocalPath $launcherLocal -RemotePath $remoteLauncher
Remove-Item $launcherLocal -Force -ErrorAction SilentlyContinue

Write-Host "== 后台启动部署（sha=$sha）=="
Invoke-Run -Command "sh $remoteLauncher"

# 4) 轮询日志，等 DEPLOY_EXIT=<0|1>
Write-Host "== 轮询 /tmp/deploy.log（最多 $TimeoutMinutes 分钟）=="
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$exitCode = $null

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds $PollSeconds
  $log = Invoke-Run -Command 'tail -5 /tmp/deploy.log'
  $log | ForEach-Object { Write-Host $_ }
  $match = $log | Select-String -Pattern 'DEPLOY_EXIT=(\d+)'
  if ($match) {
    $exitCode = [int]$match.Matches[0].Groups[1].Value
    break
  }
}

if ($null -eq $exitCode) {
  Write-Warning "$TimeoutMinutes 分钟内没等到 DEPLOY_EXIT=，去服务器上手工看 /tmp/deploy.log（docs/OPERATIONS.md 有排错表）"
  exit 1
}

if ($exitCode -eq 0) {
  Write-Host "== 部署成功：sha=$sha =="
  exit 0
} else {
  Write-Warning "== 部署失败，remote-deploy.sh 已自动回滚——看上面日志确认回滚后是否健康 =="
  exit 1
}
