/** Test support: a private Harness home per test and capture of every log line. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { inspect } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { afterEach, beforeEach, expect } from 'vitest'
import type { PrincipalKey } from '../src/types.ts'

/** A principal key with a distinctive value, so a leak into any text is found by substring. */
export function principal(value: string): PrincipalKey {
  return brandString<PrincipalKey>(value)
}

/** The per-test directories {@link useTempHome} creates. */
export interface TempHome {
  /** `DSH_HOME` for this test. */
  home: string
  /** A sibling directory for roots and other fixtures, outside the Harness home. */
  base: string
}

/**
 * Give every test of the calling file its own `DSH_HOME` and fixture base
 * under the OS temporary directory, restored and removed after the test.
 * @returns the current test's directories, read inside a test.
 */
export function useTempHome(): TempHome {
  const current: TempHome = { home: '', base: '' }
  const previous = process.env.DSH_HOME
  let top = ''
  beforeEach(() => {
    top = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-console-members-')))
    const temporary = realpathSync.native(tmpdir())
    expect(relative(temporary, top).startsWith(`..${sep}`)).toBe(false)
    current.home = join(top, 'home')
    current.base = join(top, 'base')
    expect(current.home.startsWith(`${temporary}${sep}`)).toBe(true)
    process.env.DSH_HOME = current.home
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(top, { recursive: true, force: true })
  })
  return current
}

/**
 * Collect every log line written under a context, each with its arguments
 * fully inspected so that an Error's message and stack are included.
 * @param ctx - the root context.
 * @returns the collected lines, filled as logging happens.
 */
export function captureLogs(ctx: Context): string[] {
  const lines: string[] = []
  ctx.logger.exporter({
    levels: { default: 5 },
    export: (message) => { lines.push(`${message.type} ${inspect(message.args, { depth: 8 })}`) },
  })
  return lines
}
