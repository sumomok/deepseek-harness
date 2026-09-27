/**
 * Shared no-shell `execFile` runner for host-native OS integrations.
 * @module @deepseek-ai/dsh-native-command/runner
 */

import { execFile } from 'node:child_process'

/** Per-command process options; a runner call that omits them hides the Windows window. */
export interface NativeCommandOptions {
  /**
   * Whether Windows starts the command with a hidden window. Console tools
   * keep true so no console window appears. A GUI program whose first window
   * is the result, such as Explorer, needs false: Windows applies the hidden
   * show state to that window. Other platforms ignore the field.
   */
  readonly windowsHide: boolean
}

/** Testable command boundary; native implementations never invoke a shell. */
export type NativeCommandRunner = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
  options?: NativeCommandOptions,
) => Promise<{ stdout: string; stderr: string }>

/** Options for a command that states none: a hidden Windows window. */
const HIDDEN_WINDOW: NativeCommandOptions = { windowsHide: true }

/**
 * Run a host command with utf8 stdio and abort propagation; Windows hides its
 * window unless `options.windowsHide` is false.
 * @param command - executable path or PATH name.
 * @param args - argv (never a shell string).
 * @param signal - caller/connection lifetime; abort terminates the child.
 * @param options - process options; omitted means a hidden Windows window.
 * @returns captured stdout/stderr on exit 0.
 */
export const runNativeCommand: NativeCommandRunner = (command, args, signal, options = HIDDEN_WINDOW) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { encoding: 'utf8', signal, windowsHide: options.windowsHide },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure = Object.assign(new Error(error.message, { cause: error }), {
            code: error.code,
            stdout,
            stderr,
          })
          reject(failure)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
