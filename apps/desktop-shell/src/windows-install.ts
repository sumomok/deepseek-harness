/** Observable Windows elevation; a spawned launcher is not an accepted UAC prompt. */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { tmpdir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { system32Program } from './terminal-env.ts'

/** A definite OS outcome, or a lost launcher report that cannot authorize a retry. */
export type WindowsInstallResult =
  | { kind: 'started' }
  | { kind: 'not-started'; detail: string; code?: number }
  | { kind: 'unconfirmed'; detail: string }

/** Inputs of one visible NSIS update launch. */
export interface WindowsInstallRequest {
  /** The downloaded installer whose identity, artifact name, size and digest were verified. */
  file: string
  /** The current shell; NSIS must wait for this process before its first sweep. */
  ownerPid: number
  /** The system directory and launch environment; credentials are removed before spawn. */
  env: NodeJS.ProcessEnv
}

/** Process boundary, injectable without replacing the installer coordinator. */
export type WindowsInstallSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/** Bound one fixed-script report, including a localized Windows error. */
const OUTPUT_LIMIT = 8192

/** @returns a PowerShell single-quoted literal; paths never become script syntax. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** @returns the validated fixed-script report, or undefined for incomplete/invalid output. */
function report(line: string): WindowsInstallResult | undefined {
  let value: unknown
  try { value = JSON.parse(line) } catch { return undefined }
  if (typeof value !== 'object' || value === null || !('kind' in value)) return undefined
  if (value.kind === 'started') return { kind: 'started' }
  if (value.kind !== 'not-started' || !('detail' in value) || typeof value.detail !== 'string') return undefined
  if (!('code' in value) || typeof value.code !== 'number' || !Number.isSafeInteger(value.code) || value.code < 0) return undefined
  return { kind: 'not-started', detail: value.detail, code: value.code }
}

/**
 * Keep the shell alive through UAC and observe ShellExecuteEx's actual result.
 * The unelevated system PowerShell elevates the installer itself, never a script.
 * NSIS receives the owner PID and must abort instead of sweeping a live owner.
 * A definite rejection permits recovery; lost output retains the install lock
 * because it cannot prove the installer did not start. No timeout grants consent.
 * @param request - the verified installer and shell identity.
 * @param start - the owned process allocator.
 * @returns the OS report, or an unconfirmed outcome after the launcher closes.
 */
export async function launchWindowsInstaller(
  request: WindowsInstallRequest, start: WindowsInstallSpawn = spawn,
): Promise<WindowsInstallResult> {
  if (!Number.isSafeInteger(request.ownerPid) || request.ownerPid <= 0) {
    return { kind: 'not-started', detail: 'invalid update owner PID' }
  }
  const args = `--updated --force-run --dsh-update-owner-pid=${String(request.ownerPid)}`
  const script = [
    "$ErrorActionPreference='Stop'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '$psi=New-Object System.Diagnostics.ProcessStartInfo',
    `$psi.FileName=${literal(request.file)}`,
    `$psi.Arguments=${literal(args)}`,
    `$psi.WorkingDirectory=${literal(tmpdir())}`,
    "$psi.UseShellExecute=$true; $psi.Verb='runas'; $psi.ErrorDialog=$false",
    '$installer=$null; $failure=$null',
    'try { $installer=[System.Diagnostics.Process]::Start($psi) } catch { $failure=$_.Exception }',
    'if ($null -ne $failure) {',
    'while ($null -ne $failure.InnerException) { $failure=$failure.InnerException }',
    // Only a Win32Exception proves ShellExecuteEx refused the launch. Other
    // failures could have happened after it, so they carry no rejection report.
    'if ($failure -isnot [System.ComponentModel.Win32Exception]) { exit 3 }',
    '$detail=$failure.Message; if ($detail.Length -gt 2048) { $detail=$detail.Substring(0,2048) }',
    "@{kind='not-started';code=$failure.NativeErrorCode;detail=$detail} | ConvertTo-Json -Compress",
    'exit 0',
    '}',
    'if ($null -eq $installer) { exit 2 }',
    "@{kind='started'} | ConvertTo-Json -Compress",
    '$installer.Dispose()',
  ].join('\n')
  const env = Object.fromEntries(Object.entries(request.env).filter(([key]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(key)))
  return await new Promise<WindowsInstallResult>((resolve) => {
    let output = ''
    let outputBytes = 0
    const decoder = new StringDecoder('utf8')
    let spawned = false
    let reported = false
    let child: ChildProcess
    const finish = (result: WindowsInstallResult): void => {
      if (reported) return
      reported = true
      resolve(result)
    }
    try {
      child = start(system32Program(request.env, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
        '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
      ], { env, cwd: tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ kind: 'not-started', detail: error instanceof Error ? error.message : String(error) })
      return
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (reported) return
      outputBytes += chunk.byteLength
      output += decoder.write(chunk)
      if (outputBytes > OUTPUT_LIMIT) {
        output = ''
        finish({ kind: 'unconfirmed', detail: 'Windows installer launcher report exceeded its limit' })
        return
      }
      const end = output.indexOf('\n')
      if (end < 0) return
      const result = report(output.slice(0, end).trim())
      finish(result ?? { kind: 'unconfirmed', detail: 'Windows installer launcher returned an invalid report' })
    })
    // Drain stderr without treating localized text as a launch verdict.
    child.stderr?.resume()
    child.once('spawn', () => { spawned = true })
    child.once('error', (error) => { finish({ kind: spawned ? 'unconfirmed' : 'not-started', detail: error.message }) })
    child.once('close', (code, signal) => {
      finish({ kind: 'unconfirmed', detail: `Windows installer launch was not acknowledged (exit ${String(code)}, signal ${String(signal)})` })
    })
  })
}
