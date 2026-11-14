import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { launchWindowsInstaller, type WindowsInstallSpawn } from '../src/windows-install.ts'

const children = new Set<{ child: ChildProcess; closed: Promise<unknown> }>()

afterEach(async () => {
  for (const { child, closed } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
  }
  children.clear()
})

/** A real process at the OS-script boundary; the coordinator and transport stay real. */
function launcher(script: string): {
  start: WindowsInstallSpawn
  child: () => ChildProcess
  calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[]
} {
  let current: ChildProcess | undefined
  const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = []
  return {
    calls,
    child: () => {
      if (current === undefined) throw new Error('launcher has not spawned')
      return current
    },
    start: (command, args, options) => {
      calls.push({ command, args, env: options.env })
      current = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
      children.add({ child: current, closed: once(current, 'close') })
      return current
    },
  }
}

const request = { file: "C:\\Users\\O'Brien\\pending\\DSH Desktop Setup 1.exe", ownerPid: 123, env: { SystemRoot: 'C:\\Windows' } }

describe('observed Windows installer launch', () => {
  it('does not treat a spawned PID or a partial report as UAC acceptance', async () => {
    const fixture = launcher("process.stdout.write('{\"kind\":'); process.stdin.once('data',()=>{process.stdout.write('\"started\"}\\n');process.stdin.pause()})")
    let result: unknown
    const pending = launchWindowsInstaller(request, fixture.start).then((value) => { result = value; return value })
    const child = fixture.child()
    expect(child.pid).toBeTypeOf('number')
    await once(child.stdout!, 'data')
    expect(result).toBeUndefined()
    child.stdin?.write('accept')
    expect(await pending).toEqual({ kind: 'started' })
  })

  it('reports rejection after spawn, preserving the native UAC cancellation code', async () => {
    const fixture = launcher("process.stdout.write(JSON.stringify({kind:'not-started',code:1223,detail:'授权已取消'})+'\\n')")
    expect(await launchWindowsInstaller(request, fixture.start)).toEqual({ kind: 'not-started', code: 1223, detail: '授权已取消' })
  })

  it('does not mistake a clean launcher exit without an OS report for success or rejection', async () => {
    const fixture = launcher('process.exit(0)')
    expect(await launchWindowsInstaller(request, fixture.start)).toMatchObject({ kind: 'unconfirmed' })
  })

  it.each(["process.stdout.write('not-json\\n')", "process.stdout.write('{\"kind\":\"started\"}')", "process.stdout.write('x'.repeat(9000))"])(
    'keeps a malformed, truncated or oversized result unconfirmed: %s', async (script) => {
      const fixture = launcher(script)
      expect(await launchWindowsInstaller(request, fixture.start)).toMatchObject({ kind: 'unconfirmed' })
    },
  )

  it('distinguishes failure to allocate a launcher from a lost post-launch report', async () => {
    const start: WindowsInstallSpawn = () => { throw new Error('spawn denied') }
    expect(await launchWindowsInstaller(request, start)).toEqual({ kind: 'not-started', detail: 'spawn denied' })
  })

  it('elevates only the exact installer, uses an owner wait, quotes paths, and strips credentials', async () => {
    const fixture = launcher("process.stdout.write('{\"kind\":\"started\"}\\n')")
    await launchWindowsInstaller({ ...request, env: { ...request.env, DEEPSEEK_API_KEY: 'fixture-only', DSH_DESKTOP_UPDATE_TOKEN: 'fixture-only', TEMP: 'C:\\Temp' } }, fixture.start)
    const call = fixture.calls[0]
    expect(call?.command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(call?.env).toEqual({ SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp' })
    const encoded = call?.args.at(-1)
    if (encoded === undefined) throw new Error('missing encoded script')
    const script = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(script).toContain("$psi.FileName='C:\\Users\\O''Brien\\pending\\DSH Desktop Setup 1.exe'")
    expect(script).toContain("$psi.Arguments='--updated --force-run --dsh-update-owner-pid=123'")
    expect(script).toContain("$psi.UseShellExecute=$true; $psi.Verb='runas'")
    expect(script).toContain('[System.Diagnostics.Process]::Start($psi)')
    expect(script).toContain('$failure.NativeErrorCode')
    expect(script).not.toContain(' -Wait')
  })

  it('refuses invalid owner identities before allocating a process', async () => {
    let calls = 0
    const start: WindowsInstallSpawn = () => { calls++; throw new Error('must not start') }
    expect(await launchWindowsInstaller({ ...request, ownerPid: 0 }, start)).toMatchObject({ kind: 'not-started' })
    expect(calls).toBe(0)
  })
})
