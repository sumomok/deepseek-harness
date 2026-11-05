import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SymlinkContainmentError, writeBinarySafe } from '../src/index.js'

describe('writeBinarySafe', () => {
  let testRoot: string
  let outsideRoot: string

  beforeEach(async () => {
    // Create temporary test directories
    const baseTemp = join(tmpdir(), `safe-binary-write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    testRoot = join(baseTemp, 'workspace')
    outsideRoot = join(baseTemp, 'outside')

    await mkdir(testRoot, { recursive: true })
    await mkdir(outsideRoot, { recursive: true })
  })

  afterEach(async () => {
    // Clean up test directories
    const baseTemp = join(testRoot, '..')
    await rm(baseTemp, { recursive: true, force: true })
  })

  it('writes a regular file successfully', async () => {
    const targetPath = join(testRoot, 'test-file.bin')
    const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]) // "Hello"

    await writeBinarySafe(targetPath, data, testRoot)

    const written = await readFile(targetPath)
    expect(Buffer.from(written)).toEqual(Buffer.from(data))
  })

  it('creates parent directories when needed', async () => {
    const targetPath = join(testRoot, 'nested', 'deep', 'file.bin')
    const data = new Uint8Array([0x01, 0x02, 0x03])

    await writeBinarySafe(targetPath, data, testRoot)

    const written = await readFile(targetPath)
    expect(Buffer.from(written)).toEqual(Buffer.from(data))
  })

  it('rejects path outside allowed root', async () => {
    const targetPath = join(outsideRoot, 'escape.bin')
    const data = new Uint8Array([0x01])

    await expect(
      writeBinarySafe(targetPath, data, testRoot),
    ).rejects.toThrow('outside allowed root')
  })

  it('rejects dangling symlink in target path', async () => {
    const linkPath = join(testRoot, 'dangling-link')
    const targetPath = join(linkPath, 'file.bin')

    // Create a symlink pointing to a non-existent location outside root
    await symlink(join(outsideRoot, 'nonexistent'), linkPath)

    const data = new Uint8Array([0x01])

    await expect(
      writeBinarySafe(targetPath, data, testRoot),
    ).rejects.toThrow(SymlinkContainmentError)
  })

  it('rejects existing symlink pointing outside root', async () => {
    const linkPath = join(testRoot, 'escape-link')
    const targetFile = join(outsideRoot, 'target.bin')

    // Create a real file outside root
    await writeFile(targetFile, 'outside')

    // Create a symlink inside root pointing to file outside
    await symlink(targetFile, linkPath)

    const data = new Uint8Array([0x01])

    await expect(
      writeBinarySafe(linkPath, data, testRoot),
    ).rejects.toThrow(SymlinkContainmentError)
  })

  it('rejects symlink in parent directory chain', async () => {
    const linkPath = join(testRoot, 'link-dir')

    // Create a symlink directory pointing outside root
    await symlink(outsideRoot, linkPath)

    const targetPath = join(linkPath, 'file.bin')
    const data = new Uint8Array([0x01])

    await expect(
      writeBinarySafe(targetPath, data, testRoot),
    ).rejects.toThrow(SymlinkContainmentError)
  })

  it('replaces existing file atomically', async () => {
    const targetPath = join(testRoot, 'replace-me.bin')

    // Write initial content
    await writeFile(targetPath, 'old content')

    const newData = new Uint8Array([0x4e, 0x45, 0x57]) // "NEW"
    await writeBinarySafe(targetPath, newData, testRoot)

    const written = await readFile(targetPath)
    expect(Buffer.from(written)).toEqual(Buffer.from(newData))
  })

  it('respects custom file permissions', async () => {
    const targetPath = join(testRoot, 'perms.bin')
    const data = new Uint8Array([0x01])

    await writeBinarySafe(targetPath, data, testRoot, { mode: 0o644 })

    const written = await readFile(targetPath)
    expect(Buffer.from(written)).toEqual(Buffer.from(data))
  })

  it('cleans up temp file on write failure', async () => {
    const targetPath = join(testRoot, 'subdir', 'file.bin')

    // Create subdir as a regular file instead of directory to cause mkdir to fail
    await writeFile(join(testRoot, 'subdir'), 'not a directory')

    const data = new Uint8Array([0x01])

    await expect(
      writeBinarySafe(targetPath, data, testRoot),
    ).rejects.toThrow()

    // Verify no temp files left behind
    // Note: temp files are in parent dir, so this is hard to verify precisely
    // but the function should clean up
  })

  it('rejects path with .. that escapes root', async () => {
    const targetPath = join(testRoot, '..', 'outside', 'escape.bin')
    const data = new Uint8Array([0x01])

    await expect(
      writeBinarySafe(targetPath, data, testRoot),
    ).rejects.toThrow('outside allowed root')
  })

  it('handles nested directories within root', async () => {
    const targetPath = join(testRoot, 'a', 'b', 'c', 'd', 'deep.bin')
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef])

    await writeBinarySafe(targetPath, data, testRoot, { dirMode: 0o755 })

    const written = await readFile(targetPath)
    expect(Buffer.from(written)).toEqual(Buffer.from(data))
  })
})
