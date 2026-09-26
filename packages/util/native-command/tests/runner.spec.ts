/** Process options the native runner passes to `execFile`. */
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void
type ExecFileMock = (
  command: string,
  args: readonly string[],
  options: { encoding: string; signal: AbortSignal; windowsHide: boolean },
  callback: ExecFileCallback,
) => void

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn<ExecFileMock>() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { describe, expect, it, vi } from 'vitest'
import { runNativeCommand } from '../src/runner.ts'

describe('runNativeCommand process options', () => {
  it.each([
    ['hides the Windows window when the call states no options', undefined, true],
    ['hides the Windows window when the call asks for it', { windowsHide: true }, true],
    ['shows the Windows window when the call asks for it', { windowsHide: false }, false],
  ] as const)('%s', async (_label, options, windowsHide) => {
    execFileMock.mockReset()
    execFileMock.mockImplementation((_command, _args, _options, callback) => { callback(null, '', '') })
    const signal = new AbortController().signal
    await runNativeCommand('explorer.exe', ['/select,', 'file:///C:/a.txt'], signal, options)
    expect(execFileMock).toHaveBeenCalledExactlyOnceWith(
      'explorer.exe', ['/select,', 'file:///C:/a.txt'], { encoding: 'utf8', signal, windowsHide }, expect.any(Function))
  })
})
