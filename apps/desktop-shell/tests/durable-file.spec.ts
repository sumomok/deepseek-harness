/**
 * Replacing a file through a flushed temporary sibling: the content and mode
 * that land, the byte-for-byte copy, and what is left when the rename fails.
 * @module
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyDurably, replaceDurably, writeDurably } from '../src/durable-file.ts'

let root: string
const posixOnly = process.platform === 'win32' ? it.skip : it

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-durable-file-')))
  // Every file below is inside this directory.
  expect(root.startsWith(realpathSync(tmpdir()))).toBe(true)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('durable file writes', () => {
  posixOnly('writes the bytes with the given mode and leaves no temporary file', () => {
    const file = join(root, 'f')
    writeDurably(file, Buffer.from([0x61, 0xe9, 0x0a]), 0o600)
    expect(readFileSync(file).equals(Buffer.from([0x61, 0xe9, 0x0a]))).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(root)).toEqual(['f'])
  })

  posixOnly('copies a file byte for byte with its permission bits', () => {
    const source = join(root, 's')
    writeFileSync(source, Buffer.from([0xff, 0xfe, 0x0d, 0x0a]))
    chmodSync(source, 0o640)
    copyDurably(source, join(root, 'copy'))
    expect(readFileSync(join(root, 'copy')).equals(readFileSync(source))).toBe(true)
    expect(statSync(join(root, 'copy')).mode & 0o777).toBe(0o640)
    expect(readdirSync(root).sort()).toEqual(['copy', 's'])
  })

  it('removes the temporary file when writing it fails partway, and leaves the destination as it was', () => {
    const file = join(root, 'f')
    writeFileSync(file, 'old')
    expect(() => {
      replaceDurably(file, (temporary) => {
        writeFileSync(temporary, 'half')
        throw new Error('ENOSPC: no space left on device, write')
      })
    }).toThrow('ENOSPC')
    expect(readdirSync(root)).toEqual(['f'])
    expect(readFileSync(file, 'utf8')).toBe('old')
  })

  const writable = process.platform === 'win32' || process.getuid?.() === 0 ? it.skip : it

  writable('leaves nothing in a directory it may not write', () => {
    const source = join(root, 's')
    writeFileSync(source, 'x')
    const locked = join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    try {
      expect(() => { copyDurably(source, join(locked, 'copy')) }).toThrow(/EACCES/)
      expect(() => { writeDurably(join(locked, 'f'), Buffer.from('x')) }).toThrow(/EACCES/)
      expect(readdirSync(locked)).toEqual([])
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it('removes the temporary file when the rename fails', () => {
    const target = join(root, 'dir')
    mkdirSync(join(target, 'inside'), { recursive: true })
    expect(() => { writeDurably(target, Buffer.from('x')) }).toThrow()
    expect(readdirSync(root)).toEqual(['dir'])
  })
})
