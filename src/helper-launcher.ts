import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELPER_PROTOCOL } from './helper-bridge.ts';
const psString = (value: string) => `'${value.replace(/'/g, "''")}'`;
const nativeArg = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
export async function prepareHelperLauncher(dir: string, cliFile: string): Promise<{ launcherFile: string; helperDir: string }> {
  if (process.platform !== 'win32') throw new Error('Run the helper with node dist/ego-helper.mjs --dir <directory> from a non-root terminal.');
  const helperDir = resolve(dir);
  await mkdir(helperDir, { recursive: true });
  const bundle = fileURLToPath(new URL('../dist/ego-helper.mjs', import.meta.url));
  const args = [bundle, '--dir', helperDir, '--cli', cliFile || 'ego-browser'].map(value => psString(nativeArg(value))).join(', ');
  const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$endpointFile = ${psString(join(helperDir, 'endpoint.json'))}
$stderrFile = ${psString(join(helperDir, 'helper.stderr.log'))}
$launcherLog = ${psString(join(helperDir, 'launcher.log'))}
$helperStarted = $false
function Get-HelperStatus([int]$ExpectedPid = 0) {
  try {
    $endpoint = Get-Content -LiteralPath $endpointFile -Raw | ConvertFrom-Json
    if (-not ($endpoint.protocol -gt 0 -and $endpoint.pid -gt 0 -and $endpoint.port -ge 1 -and $endpoint.port -le 65535) -or $endpoint.token -cnotmatch '^[a-f0-9]{64}$') { return 'offline' }
    if ($ExpectedPid -and $endpoint.pid -ne $ExpectedPid) { return 'offline' }
    $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $endpoint.port + '/health') -Headers @{ Authorization = ('Bearer ' + $endpoint.token) } -TimeoutSec 1
    if ($health.elevated -ne $false -or $health.pid -ne $endpoint.pid -or -not ($health.protocol -gt 0)) { return 'offline' }
    if ($endpoint.protocol -ne ${HELPER_PROTOCOL} -or $health.protocol -ne ${HELPER_PROTOCOL}) { return 'incompatible' }
    return 'ready'
  } catch { return 'offline' }
}
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '请在文件资源管理器中普通双击启动脚本，不要以管理员身份运行。' }
  $helperStatus = Get-HelperStatus
  if ($helperStatus -eq 'ready') { Write-Host 'Ego 助手已经在运行，请回到面板点击「连接浏览器」。'; exit 0 }
  if ($helperStatus -eq 'incompatible') { throw '检测到旧版 Ego 助手。请在扩展控制面板点击「停止助手」，再运行新启动脚本。' }
  if (-not (Test-Path -LiteralPath ${psString(bundle)} -PathType Leaf)) { throw '未找到扩展包的 ego-helper.mjs。请更新或重新安装 Ego 扩展，重启宿主后重新生成启动脚本。' }
  $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $nodeCommand) { throw '未找到 Node.js。普通权限助手需要 Node.js 22 或以上版本；安装后重新打开文件资源管理器再运行本脚本。' }
  $nodeExe = $nodeCommand.Source
  $nodeVersion = (& $nodeExe --version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\\d+)\\.' -or [int]$Matches[1] -lt 22) { throw ('Node.js 版本不可用：' + $nodeVersion + '。普通权限助手需要 Node.js 22 或以上版本。') }
  $helperProcess = Start-Process -FilePath $nodeExe -ArgumentList @(${args}) -WindowStyle Hidden -RedirectStandardOutput ${psString(join(helperDir, 'helper.stdout.log'))} -RedirectStandardError $stderrFile -PassThru
  $helperStarted = $true
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $helperStatus = Get-HelperStatus $helperProcess.Id
    if ($helperStatus -eq 'ready') { Write-Host 'Ego 助手已启动，请回到面板点击「连接浏览器」。'; exit 0 }
    if ($helperStatus -eq 'incompatible') { throw '启动了不兼容的 Ego 助手。请先停止助手，更新扩展并重新生成启动脚本。' }
    $helperProcess.Refresh()
    if ($helperProcess.HasExited) { $exitCode = $helperProcess.ExitCode; if ($null -eq $exitCode) { throw '助手进程已退出，没有拿到退出码。' } else { throw ('助手进程已退出，退出码：' + $exitCode) } }
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  throw '10 秒内未能确认助手启动成功。请查看下方日志；确认原因后再运行脚本。'
} catch {
  $message = 'Ego 助手启动失败：' + $_.Exception.Message
  Write-Host $message
  try { Add-Content -LiteralPath $launcherLog -Value ([DateTime]::Now.ToString('s') + ' ' + $message) -Encoding UTF8 } catch {}
  if ($helperStarted -and (Test-Path -LiteralPath $stderrFile)) { Get-Content -LiteralPath $stderrFile -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ } }
  Write-Host ('启动诊断：' + $launcherLog)
  Write-Host ('助手错误日志：' + $stderrFile)
  exit 1
}
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const launcherFile = join(helperDir, 'start-ego-helper.cmd');
  await writeFile(join(helperDir, 'start-ego-helper.ps1'), script, 'utf8');
  await writeFile(launcherFile, `@echo off\r\npowershell.exe -NoLogo -NoProfile -EncodedCommand ${encoded}\r\nif errorlevel 1 pause\r\n`, 'ascii');
  return { launcherFile, helperDir };
}
