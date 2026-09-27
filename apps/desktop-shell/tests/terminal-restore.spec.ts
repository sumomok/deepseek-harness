/**
 * Putting the terminal setting back after a rolled-back move: a shell profile
 * restored whole when nothing outside the block changed, only the block
 * otherwise, and deleted with its backup when it did not exist; the Windows
 * variable written back with its registry type. Profiles live in a temporary
 * home; the Windows side is checked through a recording runner.
 * @module
 */

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PROFILE_BACKUP_SUFFIX, snapshotShellProfile, updateShellProfile, type PowerShellRunner, type TerminalSnapshot,
} from '../src/terminal-env.ts'
import {
  planProfileRestore, RESTORE_TYPE_ENV, RESTORE_USER_ENV_SCRIPT, RESTORE_VALUE_ENV, restoreScriptEnv, restoreShellProfile, restoreTerminal,
} from '../src/terminal-restore.ts'

let home: string
const zsh = (): { home: string; shell: string; zdotdir: undefined } => ({ home, shell: '/bin/zsh', zdotdir: undefined })
const profile = (): string => join(home, '.zshrc')
const posixOnly = process.platform === 'win32' ? it.skip : it

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-terminal-restore-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** The profile snapshot, narrowed. */
function snapshot(): Extract<TerminalSnapshot, { kind: 'profile' }> {
  const taken = snapshotShellProfile(zsh())
  if (taken.kind !== 'profile') throw new Error(`expected a profile snapshot, got ${taken.kind}`)
  return taken
}

describe('restoring a shell profile', () => {
  it('deletes a profile the move created, and the backup made beside it', () => {
    const before = snapshot()
    updateShellProfile(zsh(), '/Volumes/Data/DSH-Data')
    // A second write backs up the file the first one created.
    updateShellProfile(zsh(), '/Volumes/Data/DSH-Data2')
    expect(existsSync(`${profile()}${PROFILE_BACKUP_SUFFIX}`)).toBe(true)
    expect(restoreShellProfile(before)).toMatchObject({ kind: 'delete-file', deleteBackup: true })
    expect(existsSync(profile())).toBe(false)
    expect(existsSync(`${profile()}${PROFILE_BACKUP_SUFFIX}`)).toBe(false)
  })

  it('keeps a profile the move created once someone else wrote into it, removing only the block', () => {
    const before = snapshot()
    updateShellProfile(zsh(), '/data')
    writeFileSync(profile(), `${readFileSync(profile(), 'utf8')}alias gs='git status'\n`)
    expect(restoreShellProfile(before).kind).toBe('remove-block')
    expect(readFileSync(profile(), 'utf8')).toBe("alias gs='git status'\n")
  })

  posixOnly('writes an untouched profile back byte for byte, with its permissions, and removes the backup the move made', () => {
    const bytes = Buffer.concat([Buffer.from('alias ll=ls\r\n'), Buffer.from([0xff, 0xfe]), Buffer.from('\nexport X=1')])
    writeFileSync(profile(), bytes)
    chmodSync(profile(), 0o600)
    const before = snapshot()
    updateShellProfile(zsh(), '/data')
    chmodSync(profile(), 0o644)
    expect(restoreShellProfile(before)).toMatchObject({ kind: 'write-whole', deleteBackup: true })
    expect(readFileSync(profile()).equals(bytes)).toBe(true)
    expect(statSync(profile()).mode & 0o777).toBe(0o600)
    expect(existsSync(`${profile()}${PROFILE_BACKUP_SUFFIX}`)).toBe(false)
  })

  it('puts an earlier CRLF block back exactly when nothing else changed, and keeps a backup that was there', () => {
    const original = 'alias a=b\r\n# >>> DSH data location >>>\r\nexport DSH_HOME=\'/old\'\r\n# <<< DSH data location <<<\r\nexport Y=2\r\n'
    writeFileSync(profile(), original)
    writeFileSync(`${profile()}${PROFILE_BACKUP_SUFFIX}`, 'earlier backup')
    const before = snapshot()
    updateShellProfile(zsh(), '/new')
    expect(readFileSync(profile(), 'utf8')).toContain('/new')
    expect(restoreShellProfile(before)).toMatchObject({ kind: 'write-whole', deleteBackup: false })
    expect(readFileSync(profile(), 'utf8')).toBe(original)
    expect(existsSync(`${profile()}${PROFILE_BACKUP_SUFFIX}`)).toBe(true)
  })

  it('puts only the old block back when the rest of the profile changed, keeping that change', () => {
    writeFileSync(profile(), "alias a=b\n# >>> DSH data location >>>\nexport DSH_HOME='/old'\n# <<< DSH data location <<<\n")
    const before = snapshot()
    updateShellProfile(zsh(), '/new')
    writeFileSync(profile(), `export EDITOR=vim\n${readFileSync(profile(), 'utf8')}`)
    expect(restoreShellProfile(before).kind).toBe('replace-block')
    expect(readFileSync(profile(), 'utf8'))
      .toBe("export EDITOR=vim\nalias a=b\n# >>> DSH data location >>>\nexport DSH_HOME='/old'\n# <<< DSH data location <<<\n")
  })

  it('removes only the block when the profile had none and the rest changed', () => {
    writeFileSync(profile(), 'alias a=b\n')
    const before = snapshot()
    updateShellProfile(zsh(), '/new')
    writeFileSync(profile(), `export EDITOR=vim\n${readFileSync(profile(), 'utf8')}`)
    expect(restoreShellProfile(before).kind).toBe('remove-block')
    expect(readFileSync(profile(), 'utf8')).toBe('export EDITOR=vim\nalias a=b\n')
  })

  it('never writes a block the profile did not have, and leaves a damaged or missing profile alone', () => {
    writeFileSync(profile(), 'alias a=b\n')
    const before = snapshot()
    writeFileSync(profile(), 'alias a=b\nexport Z=1\n')
    expect(planProfileRestore(before, readFileSync(profile()))).toMatchObject({ kind: 'nothing' })
    writeFileSync(profile(), '# >>> DSH data location >>>\nexport DSH_HOME=/x\n')
    expect(restoreShellProfile(before)).toMatchObject({ kind: 'nothing', why: 'the profile has a damaged block' })
    expect(readFileSync(profile(), 'utf8')).toBe('# >>> DSH data location >>>\nexport DSH_HOME=/x\n')
    expect(planProfileRestore(before, undefined)).toMatchObject({ kind: 'nothing', why: 'the profile is gone' })
  })
})

describe('restoring the Windows user variable', () => {
  /** A runner that records what it was asked to run. */
  function recording(code = 0): { run: PowerShellRunner; calls: Array<{ script: string; env: Record<string, string> }> } {
    const calls: Array<{ script: string; env: Record<string, string> }> = []
    return { calls, run: async (script, env) => { calls.push({ script, env }); return { code, stdout: '' } } }
  }

  it('writes the value back with its registry type, an empty value included, and removes one that was unset', async () => {
    const empty = recording()
    expect(await restoreTerminal({ kind: 'user-environment', value: { kind: 'set', type: 'String', raw: '' } }, empty.run))
      .toBe('user DSH_HOME restored as String')
    expect(empty.calls).toEqual([{ script: RESTORE_USER_ENV_SCRIPT, env: { [RESTORE_TYPE_ENV]: 'String', [RESTORE_VALUE_ENV]: 'v' } }])
    const expand = restoreScriptEnv({ kind: 'set', type: 'ExpandString', raw: '%USERPROFILE%\\数据' })
    expect(expand[RESTORE_TYPE_ENV]).toBe('ExpandString')
    expect(Buffer.from(expand[RESTORE_VALUE_ENV]?.slice(1) ?? '', 'base64').toString('utf8')).toBe('%USERPROFILE%\\数据')
    const unset = recording()
    expect(await restoreTerminal({ kind: 'user-environment', value: { kind: 'unset' } }, unset.run)).toBe('user DSH_HOME removed')
    expect(unset.calls[0]?.env).toEqual({})
    await expect(restoreTerminal({ kind: 'user-environment', value: { kind: 'unset' } }, recording(1).run)).rejects.toThrow('exited with 1')
  })

  it('writes through the registry with the type, never through SetEnvironmentVariable, and broadcasts the change', () => {
    expect(RESTORE_USER_ENV_SCRIPT).toContain('-PropertyType $type')
    expect(RESTORE_USER_ENV_SCRIPT).toContain('Remove-ItemProperty')
    expect(RESTORE_USER_ENV_SCRIPT).toContain('SendMessageTimeout')
    expect(RESTORE_USER_ENV_SCRIPT).not.toContain('SetEnvironmentVariable')
  })

  it('restores nothing where nothing was written, and refuses without a snapshot', async () => {
    const never = recording()
    expect(await restoreTerminal({ kind: 'profile-unavailable', reason: 'unsupported-shell', detail: 'fish' }, never.run)).toContain('nothing')
    expect(await restoreTerminal({ kind: 'unsupported-platform', platform: 'linux' }, never.run)).toContain('nothing')
    expect(never.calls).toEqual([])
    await expect(restoreTerminal({ kind: 'unknown', detail: 'x' }, never.run)).rejects.toThrow('no terminal snapshot')
  })
})
