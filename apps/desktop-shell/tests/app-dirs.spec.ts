/**
 * The shell's own directories named to the server child: one variable per
 * directory, none for an empty one, and the server launch in main.ts carries
 * them from Electron's own paths.
 * @module
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { appDirsEnv, LOG_DIR_ENV, UPDATE_CACHE_DIR_ENV, USER_DATA_DIR_ENV } from '../src/app-dirs.ts'

describe('appDirsEnv', () => {
  it('names userData, the log directory, and the update cache on macOS, where the logs sit outside userData', () => {
    expect(appDirsEnv({
      userData: '/Users/张三/Library/Application Support/@deepseek-ai/dsh-desktop',
      logs: '/Users/张三/Library/Logs/@deepseek-ai/dsh-desktop',
      updateCache: '/Users/张三/Library/Caches/@deepseek-aidsh-desktop-updater',
    })).toEqual({
      [USER_DATA_DIR_ENV]: '/Users/张三/Library/Application Support/@deepseek-ai/dsh-desktop',
      [LOG_DIR_ENV]: '/Users/张三/Library/Logs/@deepseek-ai/dsh-desktop',
      [UPDATE_CACHE_DIR_ENV]: '/Users/张三/Library/Caches/@deepseek-aidsh-desktop-updater',
    })
  })

  it('names nothing for an empty directory', () => {
    expect(appDirsEnv({ userData: 'C:\\Users\\me\\AppData\\Roaming\\@deepseek-ai\\dsh-desktop', logs: '', updateCache: '' }))
      .toEqual({ [USER_DATA_DIR_ENV]: 'C:\\Users\\me\\AppData\\Roaming\\@deepseek-ai\\dsh-desktop' })
  })

  it('uses the variables the desktop composition layer reads', () => {
    expect([USER_DATA_DIR_ENV, LOG_DIR_ENV, UPDATE_CACHE_DIR_ENV])
      .toEqual(['DSH_DESKTOP_USER_DATA_DIR', 'DSH_DESKTOP_LOG_DIR', 'DSH_DESKTOP_UPDATE_CACHE_DIR'])
  })
})

describe('the server launch in main.ts', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

  it('takes the directories from Electron, the log directory it writes to, and the updater\'s cache', () => {
    expect(source).toContain('const appDirs = appDirsEnv({ userData: app.getPath(\'userData\'), logs: logDir, updateCache: updaterCacheDir() })')
  })

  it('logs each one and adds them to the environment of the server it starts', () => {
    expect(source).toContain('for (const [name, path] of Object.entries(appDirs)) sink(`[desktop] ${name}: ${path}\\n`)')
    expect(source).toContain('env: { ...renderEnv, ...updateEnv, ...pnpmEnv, ...installEnv, ...appDirs, ...officeEngineEnv, [SERVER_LOG_ENV]: logFile }')
  })
})
