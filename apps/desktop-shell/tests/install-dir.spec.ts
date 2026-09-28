/**
 * The installation directory the shell names to the server child: which
 * directory each platform's packaged layout makes it, that a development
 * launch names none, and that the server launch in main.ts carries it.
 * @module
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { INSTALL_DIR_ENV, installDirEnv } from '../src/install-dir.ts'

describe('installDirEnv', () => {
  it('names the .app bundle on macOS, two levels above Contents/Resources', () => {
    expect(installDirEnv({ packaged: true, resourcesPath: '/Applications/北冥.app/Contents/Resources', platform: 'darwin' }))
      .toEqual({ [INSTALL_DIR_ENV]: '/Applications/北冥.app' })
  })

  it('names the directory holding resources on Windows', () => {
    expect(installDirEnv({
      packaged: true, resourcesPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\DSH Desktop\\resources', platform: 'win32',
    })).toEqual({ [INSTALL_DIR_ENV]: 'C:\\Users\\me\\AppData\\Local\\Programs\\DSH Desktop' })
  })

  it('names the directory holding resources on Linux', () => {
    expect(installDirEnv({ packaged: true, resourcesPath: '/opt/DSH Desktop/resources', platform: 'linux' }))
      .toEqual({ [INSTALL_DIR_ENV]: '/opt/DSH Desktop' })
  })

  it('names nothing in a development launch', () => {
    const electronResources = '/repo/node_modules/electron/dist/Electron.app/Contents/Resources'
    expect(installDirEnv({ packaged: false, resourcesPath: electronResources, platform: 'darwin' })).toEqual({})
    expect(installDirEnv({ packaged: false, resourcesPath: 'C:\\repo\\electron\\resources', platform: 'win32' })).toEqual({})
  })

  it('names nothing rather than an empty or relative directory when there is no resources path', () => {
    expect(installDirEnv({ packaged: true, resourcesPath: '', platform: 'win32' })).toEqual({})
    expect(installDirEnv({ packaged: true, resourcesPath: '', platform: 'darwin' })).toEqual({})
  })

  it('is the variable the permission gateway reads', () => {
    expect(INSTALL_DIR_ENV).toBe('DSH_DESKTOP_INSTALL_DIR')
  })
})

describe('the server launch in main.ts', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

  it('derives the variable from whether the app is packaged and where its resources are', () => {
    const location = '{ packaged: app.isPackaged, resourcesPath: process.resourcesPath, platform: process.platform }'
    expect(source).toContain(`const location = ${location}`)
    expect(source).toContain('const installEnv = installDirEnv(location)')
  })

  it('adds it to the environment of the server it starts', () => {
    expect(source).toContain('env: { ...renderEnv, ...updateEnv, ...pnpmEnv, ...installEnv, ...appDirs, [SERVER_LOG_ENV]: logFile }')
  })
})
