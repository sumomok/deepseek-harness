/**
 * Comparing paths by text the way each platform's default file system
 * compares names.
 * @module
 */

import { describe, expect, it } from 'vitest'
import { foldPath, samePathText } from '../src/path-text.ts'

describe('samePathText', () => {
  it('ignores letter case and trailing separators on Windows', () => {
    expect(samePathText('D:\\DSH-Data\\', 'd:\\dsh-data', 'win32')).toBe(true)
    expect(samePathText('D:\\DSH-Data', 'E:\\DSH-Data', 'win32')).toBe(false)
    expect(samePathText('D:\\a\\..\\DSH-Data', 'D:\\DSH-Data', 'win32')).toBe(true)
  })

  it('ignores letter case and Unicode normalization on macOS', () => {
    expect(samePathText('/Volumes/Data/DSH-Data/', '/volumes/data/dsh-data', 'darwin')).toBe(true)
    expect(samePathText('/a/caf\u0065\u0301', '/a/caf\u00e9', 'darwin')).toBe(true)
    expect(samePathText('/Volumes/Data', '/Volumes/Data 1', 'darwin')).toBe(false)
  })

  it('compares exactly elsewhere, apart from trailing separators', () => {
    expect(samePathText('/data/DSH', '/data/dsh', 'linux')).toBe(false)
    expect(samePathText('/data/dsh/', '/data/dsh', 'linux')).toBe(true)
    expect(foldPath('/A', 'linux')).toBe('/A')
  })
})
