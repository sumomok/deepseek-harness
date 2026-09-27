/**
 * The server-log exporter against a real cordis context: which records reach
 * the file, how many times, from which contexts, and what survives a file
 * that cannot be written.
 * @module
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as serverLog from '../src/server-log.ts'

let directory: string
let file: string
let root: Context

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-server-log-'))
  file = join(directory, 'dsh-server.log')
  root = new Context()
})

afterEach(async () => {
  await root.fiber.dispose()
  rmSync(directory, { recursive: true, force: true })
})

/**
 * Mount the exporter on the root context at the deployment's threshold.
 * @returns the plugin's fiber, settled.
 */
async function mount(): Promise<ReturnType<Context['plugin']>> {
  const fiber = root.plugin(serverLog, { file, level: 2 })
  await fiber
  return fiber
}

/** The file's lines, empty when nothing was written. */
function lines(): string[] {
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    // ENOENT: nothing was appended yet, which is an empty log.
  }
  return text.split('\n').filter(line => line !== '')
}

describe('the server-log exporter', () => {
  it('appends a named logger\'s info and warn once each, and drops its debug', async () => {
    await mount()
    const logger = root.logger('auto-compact')
    logger.info('compacted %d messages', 12)
    logger.warn('summary took %s', '9s')
    logger.debug('plan: %o', { keep: 3 })

    const written = lines()
    expect(written).toHaveLength(2)
    expect(written[0]).toMatch(/^\[server-log\] \d{4}-\d\d-\d\dT[\d:.]+Z I auto-compact: compacted 12 messages$/)
    expect(written[1]).toMatch(/^\[server-log\] \S+ W auto-compact: summary took 9s$/)
  })

  it('reaches the records of an isolated realm and of a child context, which is where a preset\'s plugins log', async () => {
    await mount()
    root.isolate('planMode').logger('plan-mode').info('entered')
    root.extend().logger('subagent').error('child failed')

    expect(lines()).toEqual([
      expect.stringMatching(/ I plan-mode: entered$/),
      expect.stringMatching(/ E subagent: child failed$/),
    ])
  })

  it('puts an error\'s stack under its header line, indented', async () => {
    await mount()
    const error = new Error('listen EADDRINUSE')
    root.logger('webserver').warn(error)

    const [header, ...continuation] = lines()
    expect(header).toMatch(/ W webserver: Error: listen EADDRINUSE$/)
    const frames = (error.stack ?? '').split('\n').slice(1)
    expect(frames.length).toBeGreaterThan(0)
    expect(continuation).toEqual(frames.map(frame => `  ${frame}`))
  })

  it('appends what the logger buffered before it mounted, once, and the level filter applies to it', async () => {
    root.logger('early').info('before the exporter')
    root.logger('early').debug('never exported')
    await mount()
    root.logger('late').info('after the exporter')

    expect(lines()).toEqual([
      expect.stringMatching(/ I early: before the exporter$/),
      expect.stringMatching(/ I late: after the exporter$/),
    ])
  })

  it('holds the buffered records to its own threshold as well', async () => {
    root.logger('early').info('an info the threshold drops')
    root.logger('early').error('an error it keeps')
    await root.plugin(serverLog, { file, level: 0 })

    expect(lines()).toEqual([expect.stringMatching(/ E early: an error it keeps$/)])
  })

  it('stops appending once its fiber is disposed', async () => {
    const fiber = await mount()
    root.logger('a').info('kept')
    await fiber.dispose()
    root.logger('a').info('after dispose')

    expect(lines()).toEqual([expect.stringMatching(/ I a: kept$/)])
  })

  it('does not throw into the logging plugin when the file cannot be written', async () => {
    file = join(directory, 'missing-directory', 'dsh-server.log')
    await mount()
    expect(() => { root.logger('a').error('lost') }).not.toThrow()
  })

  it('appends beside lines another writer puts in the same file', async () => {
    writeFileSync(file, '[desktop] server ready at http://127.0.0.1:1\n')
    await mount()
    root.logger('a').info('after the shell line')
    expect(lines()).toEqual(['[desktop] server ready at http://127.0.0.1:1', expect.stringMatching(/ I a: after the shell line$/)])
  })
})

describe('the server-log config', () => {
  // What the Loader hands the schema is the row's untyped config.
  const validate = serverLog.Config as (value: unknown) => unknown

  it('requires the file and the threshold', () => {
    expect(() => validate({ level: 2 })).toThrow()
    expect(() => validate({ file })).toThrow()
    expect(() => validate({ file, level: 4 })).toThrow()
    expect(validate({ file, level: 2 })).toEqual({ file, level: 2 })
  })
})
