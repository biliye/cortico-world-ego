import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const psString = (value: string) => `'${value.replace(/'/g, "''")}'`;
const nativeArg = (value: string) => `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
export async function prepareHelperLauncher(dir: string, cliFile: string): Promise<{ launcherFile: string; helperDir: string }> {
  if (process.platform !== 'win32') throw new Error('Run the helper with node dist/ego-helper.mjs --dir <directory> from a non-root terminal.');
  const helperDir = resolve(dir);
  await mkdir(helperDir, { recursive: true });
  const bundle = fileURLToPath(new URL('../dist/ego-helper.mjs', import.meta.url));
  const args = [bundle, '--dir', helperDir, '--cli', cliFile || 'ego-browser'].map(value => psString(nativeArg(value))).join(', ');
  const script = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\ntry {\n` +
    `  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()\n` +
    `  $principal = New-Object Security.Principal.WindowsPrincipal($identity)\n` +
    `  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '请在文件资源管理器中普通双击启动脚本，不要以管理员身份运行。' }\n` +
    `  $nodeExe = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source\n` +
    `  Start-Process -FilePath $nodeExe -ArgumentList @(${args}) -WindowStyle Hidden -RedirectStandardOutput ${psString(join(helperDir, 'helper.stdout.log'))} -RedirectStandardError ${psString(join(helperDir, 'helper.stderr.log'))}\n` +
    `} catch { Write-Host $_.Exception.Message; exit 1 }\n`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const launcherFile = join(helperDir, 'start-ego-helper.cmd');
  await writeFile(join(helperDir, 'start-ego-helper.ps1'), script, 'utf8');
  await writeFile(launcherFile, `@echo off\r\npowershell.exe -NoLogo -NoProfile -EncodedCommand ${encoded}\r\nif errorlevel 1 pause\r\n`, 'ascii');
  return { launcherFile, helperDir };
}
