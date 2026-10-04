/**
 * Link plans for a move: absolute links into the old home under any of its
 * spellings, relative links inside and outside it, Windows extended-length and
 * UNC forms, junction creation, and the in-place rewrite and its undo.
 * @module
 */

import { mkdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  linkCreation, movedLinkTarget, planInPlaceRewrites, planLink, rewriteInPlace, sameTarget,
  type LinkCreation, type LinkMove, type RewriteFs,
} from '../src/move/links.ts'
import { scratchDir } from './move-fixture.ts'

let scratch: string | undefined

afterEach(async () => {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

const POSIX: LinkMove = { sourceRoots: ['/Volumes/SSD/home/.dsh', '/Users/p/.dsh'], destRoot: '/Volumes/Ext/DSH-Data', platform: 'darwin' }
const WINDOWS: LinkMove = { sourceRoots: ['C:\\Users\\p\\.dsh'], destRoot: 'D:\\DSH-Data', platform: 'win32' }

describe('planLink', () => {
  it('rewrites an absolute link into the old home, under every spelling of it', () => {
    const rel = 'profiles/desktop-shell/node_modules/clsx'
    expect(planLink('/Volumes/SSD/home/.dsh/profiles/desktop-shell/.dsh-module-fallback/node_modules/clsx', rel, POSIX))
      .toEqual({ kind: 'rewrite', target: '/Volumes/Ext/DSH-Data/profiles/desktop-shell/.dsh-module-fallback/node_modules/clsx', reason: 'inside-root' })
    expect(planLink('/Users/p/.dsh/profiles/web/node_modules/x', rel, POSIX))
      .toEqual({ kind: 'rewrite', target: '/Volumes/Ext/DSH-Data/profiles/web/node_modules/x', reason: 'inside-root' })
    expect(planLink('/Users/p/.dsh', rel, POSIX)).toEqual({ kind: 'rewrite', target: '/Volumes/Ext/DSH-Data', reason: 'inside-root' })
  })

  it('keeps absolute links elsewhere, including a sibling whose name starts the same', () => {
    expect(planLink('/Applications/DSH Desktop.app/Contents/Resources/server/node_modules/a', 'x', POSIX)).toEqual({ kind: 'keep' })
    expect(planLink('/Users/p/.dsh-other/x', 'x', POSIX)).toEqual({ kind: 'keep' })
  })

  it('keeps a relative link inside the home and makes one that climbs out absolute', () => {
    expect(planLink('../.dsh-module-fallback/node_modules/clsx', 'profiles/desktop-shell/node_modules/clsx', POSIX)).toEqual({ kind: 'keep' })
    expect(planLink('../../../outside', 'profiles/desktop-shell/x', POSIX))
      .toEqual({ kind: 'rewrite', target: '/Volumes/SSD/home/outside', reason: 'relative-escapes-root' })
  })

  it('reads Windows extended-length and UNC forms', () => {
    expect(planLink('\\\\?\\C:\\Users\\p\\.dsh\\profiles\\web\\node_modules\\x\\', 'profiles\\a', WINDOWS))
      .toEqual({ kind: 'rewrite', target: 'D:\\DSH-Data\\profiles\\web\\node_modules\\x', reason: 'inside-root' })
    expect(planLink('\\\\?\\c:\\users\\P\\.DSH\\x', 'a', WINDOWS)).toEqual({ kind: 'rewrite', target: 'D:\\DSH-Data\\x', reason: 'inside-root' })
    expect(planLink('\\\\?\\UNC\\srv\\share\\pkg', 'a', WINDOWS)).toEqual({ kind: 'keep' })
    expect(planLink('C:\\Program Files\\DSH\\server\\node_modules\\a', 'a', WINDOWS)).toEqual({ kind: 'keep' })
  })

  it('gives the text a moved link is created with', () => {
    expect(movedLinkTarget('../a', 'profiles/b', POSIX)).toBe('../a')
    expect(movedLinkTarget('/Users/p/.dsh/a', 'profiles/b', POSIX)).toBe('/Volumes/Ext/DSH-Data/a')
  })
})

describe('linkCreation', () => {
  it('keeps the text on POSIX', () => {
    expect(linkCreation('../a', '/h/p/l', 'darwin')).toEqual({ target: '../a', type: undefined })
  })

  it('makes a Windows directory link a junction to an absolute target resolved at the link', () => {
    expect(linkCreation('..\\fallback\\clsx', 'D:\\DSH-Data\\profiles\\nm\\clsx', 'win32', () => false))
      .toEqual({ target: 'D:\\DSH-Data\\profiles\\fallback\\clsx', type: 'junction' })
    expect(linkCreation('\\\\?\\D:\\x\\', 'D:\\l', 'win32', () => false)).toEqual({ target: 'D:\\x', type: 'junction' })
    expect(linkCreation('a.txt', 'D:\\d\\l', 'win32', () => true)).toEqual({ target: 'a.txt', type: 'file' })
  })
})

describe('sameTarget', () => {
  it('compares by the platform rules', () => {
    expect(sameTarget('\\\\?\\C:\\A\\b\\', 'c:\\a\\B', 'C:\\l', 'win32')).toBe(true)
    expect(sameTarget('/a/b/', '/a/b', '/l', 'darwin')).toBe(true)
    expect(sameTarget('/a/B', '/a/b', '/l', 'darwin')).toBe(false)
    expect(sameTarget('../x', '/h/x', '/h/l', 'darwin')).toBe(true)
  })
})

describe('in-place rewrites', () => {
  it('plans only the links that change', () => {
    const links = [
      { rel: 'a', target: '/Users/p/.dsh/x' },
      { rel: 'profiles/b', target: '../x' },
      { rel: 'c', target: '/opt/y' },
    ]
    expect(planInPlaceRewrites(links, POSIX)).toEqual([{ rel: 'a', from: '/Users/p/.dsh/x', to: '/Volumes/Ext/DSH-Data/x' }])
  })

  it('rewrites on disk, runs again without change, and undoes with the texts swapped', async () => {
    scratch = realpathSync(await scratchDir('dsh-links-'))
    const oldRoot = join(scratch, 'old')
    const newRoot = join(scratch, 'new')
    mkdirSync(join(newRoot, 'pkg'), { recursive: true })
    symlinkSync(join(oldRoot, 'pkg'), join(newRoot, 'link'))
    const rewrite = { rel: 'link', from: join(oldRoot, 'pkg'), to: join(newRoot, 'pkg') }
    expect(rewriteInPlace(newRoot, rewrite, process.platform)).toBe('rewritten')
    expect(readlinkSync(join(newRoot, 'link'))).toBe(join(newRoot, 'pkg'))
    expect(rewriteInPlace(newRoot, rewrite, process.platform)).toBe('already')
    expect(rewriteInPlace(newRoot, { ...rewrite, from: rewrite.to, to: rewrite.from }, process.platform)).toBe('rewritten')
    expect(readlinkSync(join(newRoot, 'link'))).toBe(join(oldRoot, 'pkg'))
  })

  it('leaves a link someone re-pointed, and refuses a link that is gone', async () => {
    scratch = realpathSync(await scratchDir('dsh-links-'))
    symlinkSync('/somewhere/else', join(scratch, 'link'))
    mkdirSync(join(scratch, 'dir'))
    expect(rewriteInPlace(scratch, { rel: 'link', from: '/a', to: '/b' }, process.platform)).toBe('changed-by-someone-else')
    expect(readlinkSync(join(scratch, 'link'))).toBe('/somewhere/else')
    expect(() => rewriteInPlace(scratch ?? '', { rel: 'dir', from: '/a', to: '/b' }, process.platform)).toThrow(/no longer a link/)
  })

  it('replaces a Windows junction by unlinking it, never by removing what it points to', () => {
    const calls: string[] = []
    const fs: RewriteFs = {
      isLink: () => true,
      readlink: () => '\\\\?\\C:\\Users\\p\\.dsh\\pkg\\',
      symlink: (target: string, path: string, type: LinkCreation['type']) => { calls.push(`symlink ${target} ${path} ${String(type)}`) },
      unlink: (path: string) => { calls.push(`unlink ${path}`) },
    }
    const outcome = rewriteInPlace('D:\\DSH-Data', { rel: 'nm/pkg', from: 'C:\\Users\\p\\.dsh\\pkg', to: 'D:\\DSH-Data\\pkg' }, 'win32', fs)
    expect(outcome).toBe('rewritten')
    expect(calls).toEqual(['unlink D:\\DSH-Data\\nm\\pkg', 'symlink D:\\DSH-Data\\pkg D:\\DSH-Data\\nm\\pkg junction'])
  })
})
