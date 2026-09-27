/**
 * Putting the terminal's `DSH_HOME` setting back after a data move is rolled
 * back, from the {@link TerminalSnapshot} recorded before the move rather than
 * from what a terminal reported: that value may come from a file this app
 * never touched.
 *
 * On macOS the shell profile is restored whole only when nothing outside this
 * module's block changed since the snapshot; otherwise only the block is put
 * back (or removed), and every byte outside it stays as it is now. A profile
 * that did not exist before is deleted, with the `.dsh-backup` this module
 * made beside it. On Windows the user variable is written back with its
 * registry type through the registry, since .NET's `SetEnvironmentVariable`
 * writes only `REG_SZ` and treats an empty value as removal.
 * @module @deepseek-ai/dsh-desktop-shell/terminal-restore
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { writeDurably } from './durable-file.ts'
import {
  findProfileBlock, PROFILE_BACKUP_SUFFIX, withoutProfileBlock, type PowerShellRunner, type TerminalSnapshot,
} from './terminal-env.ts'

/**
 * What a rollback does to the shell profile.
 * - `write-whole`: write `bytes` with `mode` (nothing outside the block changed).
 * - `delete-file`: the file did not exist before and holds only the block now.
 * - `replace-block`: put `block` in place of the current block.
 * - `remove-block`: remove the current block.
 * - `nothing`: leave the file; `why` says why.
 * `deleteBackup` removes `<file>.dsh-backup`, which did not exist before.
 */
export type ProfileRestore =
  | { kind: 'write-whole'; bytes: Buffer; mode: number | undefined; deleteBackup: boolean }
  | { kind: 'delete-file'; deleteBackup: boolean }
  | { kind: 'replace-block'; bytes: Buffer }
  | { kind: 'remove-block'; bytes: Buffer }
  | { kind: 'nothing'; why: string; deleteBackup: boolean }

/**
 * Decide how to put a shell profile back.
 * @param snapshot - the profile as it was before the move.
 * @param current - its bytes now; `undefined` when it does not exist.
 * @returns the step.
 */
export function planProfileRestore(
  snapshot: Extract<TerminalSnapshot, { kind: 'profile' }>, current: Buffer | undefined,
): ProfileRestore {
  const deleteBackup = !snapshot.backupExisted
  if (current === undefined) return { kind: 'nothing', why: 'the profile is gone', deleteBackup }
  const now = findProfileBlock(current.toString('latin1'))
  if (now.kind === 'damaged') return { kind: 'nothing', why: 'the profile has a damaged block', deleteBackup: false }
  const outsideNow = now.kind === 'block' ? withoutProfileBlock(now) : current.toString('latin1')
  if (snapshot.content === undefined) {
    if (now.kind === 'none') return { kind: 'nothing', why: 'the profile holds no block', deleteBackup: false }
    if (outsideNow.length === 0) return { kind: 'delete-file', deleteBackup }
    return { kind: 'remove-block', bytes: Buffer.from(outsideNow, 'latin1') }
  }
  const original = Buffer.from(snapshot.content, 'base64')
  const then = findProfileBlock(original.toString('latin1'))
  const outsideThen = then.kind === 'block' ? withoutProfileBlock(then) : original.toString('latin1')
  if (then.kind !== 'damaged' && outsideNow === outsideThen) {
    return { kind: 'write-whole', bytes: original, mode: snapshot.mode, deleteBackup }
  }
  if (now.kind === 'none') return { kind: 'nothing', why: 'the profile changed and holds no block', deleteBackup: false }
  if (!snapshot.hadBlock) return { kind: 'remove-block', bytes: Buffer.from(outsideNow, 'latin1') }
  if (snapshot.block === undefined) return { kind: 'nothing', why: 'the profile changed and its block was damaged before', deleteBackup: false }
  const block = Buffer.from(snapshot.block, 'base64').toString('latin1')
  return { kind: 'replace-block', bytes: Buffer.from([...now.before, block, ...now.after].join(''), 'latin1') }
}

/**
 * Put the shell profile back as {@link planProfileRestore} decides.
 * @param snapshot - the profile as it was before the move.
 * @returns the step taken.
 * @throws when the profile exists but cannot be read, or cannot be written or deleted.
 */
export function restoreShellProfile(snapshot: Extract<TerminalSnapshot, { kind: 'profile' }>): ProfileRestore {
  const current = existsSync(snapshot.file) ? readFileSync(snapshot.file) : undefined
  const step = planProfileRestore(snapshot, current)
  switch (step.kind) {
    case 'write-whole':
      writeDurably(snapshot.file, step.bytes, step.mode)
      break
    case 'delete-file':
      unlinkSync(snapshot.file)
      break
    case 'replace-block':
    case 'remove-block':
      writeDurably(snapshot.file, step.bytes)
      break
    case 'nothing':
      break
    default:
      return step satisfies never
  }
  const backup = `${snapshot.file}${PROFILE_BACKUP_SUFFIX}`
  if ('deleteBackup' in step && step.deleteBackup && existsSync(backup)) unlinkSync(backup)
  return step
}

/** Environment variable the restore script reads the value from: `v` followed by the value's UTF-8 bytes in base64. */
export const RESTORE_VALUE_ENV = 'DSH_DATA_LOCATION_RESTORE'

/** Environment variable naming the registry type to write: `String` or `ExpandString`; absent to remove the value. */
export const RESTORE_TYPE_ENV = 'DSH_DATA_LOCATION_RESTORE_TYPE'

/**
 * Script writing the user-scope `DSH_HOME` back with its registry type, or
 * removing it, then broadcasting `WM_SETTINGCHANGE` for `Environment` so
 * programs started afterwards see it. The value arrives base64-encoded after
 * a `v`, so an empty value is still a variable.
 */
export const RESTORE_USER_ENV_SCRIPT = [
  "$key = 'HKCU:\\Environment'",
  `$type = $env:${RESTORE_TYPE_ENV}`,
  "if ([string]::IsNullOrEmpty($type)) { Remove-ItemProperty -LiteralPath $key -Name 'DSH_HOME' -ErrorAction SilentlyContinue } else { "
  + `$v = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:${RESTORE_VALUE_ENV}.Substring(1))); `
  + "New-ItemProperty -LiteralPath $key -Name 'DSH_HOME' -PropertyType $type -Value $v -Force | Out-Null }",
  "Add-Type -Namespace DshRestore -Name Native -MemberDefinition '[DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] "
  + 'public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);\'',
  '$r = [UIntPtr]::Zero',
  "[void][DshRestore.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)",
].join('; ')

/**
 * The environment the restore script runs with for a recorded value.
 * @param value - the variable as it was before the move.
 * @returns the variables {@link RESTORE_USER_ENV_SCRIPT} reads.
 */
export function restoreScriptEnv(value: Extract<TerminalSnapshot, { kind: 'user-environment' }>['value']): Record<string, string> {
  if (value.kind === 'unset') return {}
  return { [RESTORE_TYPE_ENV]: value.type, [RESTORE_VALUE_ENV]: `v${Buffer.from(value.raw, 'utf8').toString('base64')}` }
}

/**
 * Put the terminal's `DSH_HOME` setting back from the snapshot taken before a
 * move. `profile-unavailable` and `unsupported-platform` record that nothing
 * was ever written, so nothing is restored; `unknown` never reaches a journal,
 * because a move does not start without a snapshot.
 * @param snapshot - the setting before the move.
 * @param run - the PowerShell runner, for Windows.
 * @returns one line describing what was done, for the log.
 * @throws when the profile cannot be read or written, or PowerShell fails.
 */
export async function restoreTerminal(snapshot: TerminalSnapshot, run: PowerShellRunner): Promise<string> {
  switch (snapshot.kind) {
    case 'profile': {
      const step = restoreShellProfile(snapshot)
      return `${snapshot.file}: ${step.kind}${step.kind === 'nothing' ? ` (${step.why})` : ''}`
    }
    case 'user-environment': {
      const result = await run(RESTORE_USER_ENV_SCRIPT, restoreScriptEnv(snapshot.value))
      if (result.code !== 0) throw new Error(`PowerShell exited with ${String(result.code)} restoring DSH_HOME`)
      return snapshot.value.kind === 'unset' ? 'user DSH_HOME removed' : `user DSH_HOME restored as ${snapshot.value.type}`
    }
    case 'profile-unavailable':
    case 'unsupported-platform':
      return `nothing to restore (${snapshot.kind})`
    case 'unknown':
      throw new Error(`no terminal snapshot to restore from: ${snapshot.detail}`)
    default:
      return snapshot satisfies never
  }
}
