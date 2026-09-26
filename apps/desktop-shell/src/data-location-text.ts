/**
 * What the boot window says when the data location needs the person: the
 * data cannot be found, a picked folder is refused, or `DSH_HOME` was changed
 * to a folder without data. The set is chosen by the system locale, the same
 * way the menu labels are.
 * @module @deepseek-ai/dsh-desktop-shell/data-location-text
 */

import type { EnvUnverifiedReason, UnavailableReason } from './data-location.ts'

/** One language's sentences. */
export interface DataLocationText {
  unavailableTitle: string
  unavailable: (reason: UnavailableReason, path: string | undefined) => string
  retry: string
  choose: string
  quit: string
  chooseTitle: string
  refusedNoData: (path: string) => string
  refusedOtherData: (path: string) => string
  ok: string
  envTitle: string
  env: (reason: EnvUnverifiedReason, envPath: string, current: string) => string
  useNew: string
  keep: string
}

/** The two sentence sets, keyed by the language they are written in. */
export const DATA_LOCATION_TEXT: Record<'zh' | 'en', DataLocationText> = {
  zh: {
    unavailableTitle: '找不到你的数据',
    unavailable: (reason, path) => {
      switch (reason) {
        case 'missing':
          return `你的数据存放在「${path ?? ''}」，现在打不开这个位置。如果它在移动硬盘上，请接好后点「重试」。`
        case 'id-mismatch':
          return `你的数据存放在「${path ?? ''}」，但这个位置现在的数据不是你原来的。如果换过磁盘，请选择数据所在的文件夹。`
        case 'pointer-unreadable':
          return '记录数据位置的文件读不出来了。请选择数据所在的文件夹。'
        default:
          return reason satisfies never
      }
    },
    retry: '重试',
    choose: '选择数据所在的文件夹…',
    quit: '退出',
    chooseTitle: '选择数据所在的文件夹',
    refusedNoData: path => `「${path}」里没有 DSH 的数据。请选择原来存放数据的文件夹。`,
    refusedOtherData: path => `「${path}」里是另一份 DSH 数据，不是你原来的。请选择原来存放数据的文件夹。`,
    ok: '知道了',
    envTitle: '数据位置被改过了',
    env: (reason, envPath, current) => [
      reason === 'missing'
        ? `系统或终端里把数据位置设成了「${envPath}」，但这个文件夹不存在。`
        : `系统或终端里把数据位置设成了「${envPath}」，但这个文件夹里没有 DSH 的数据。`,
      `现在的数据在「${current}」。选择「使用这个新位置」会从空白开始，原来的数据仍留在原处。`,
    ].join('\n'),
    useNew: '使用这个新位置',
    keep: '保持原位置',
  },
  en: {
    unavailableTitle: 'Your data cannot be found',
    unavailable: (reason, path) => {
      switch (reason) {
        case 'missing':
          return `Your data is stored in "${path ?? ''}", which cannot be opened right now. If it is on an external drive, connect the drive and click Retry.`
        case 'id-mismatch':
          return `Your data is stored in "${path ?? ''}", but the data there now is not yours. If you changed drives, choose the folder that holds your data.`
        case 'pointer-unreadable':
          return 'The record of where your data is stored cannot be read. Choose the folder that holds your data.'
        default:
          return reason satisfies never
      }
    },
    retry: 'Retry',
    choose: 'Choose the Folder with My Data…',
    quit: 'Quit',
    chooseTitle: 'Choose the folder that holds your data',
    refusedNoData: path => `"${path}" holds no DSH data. Choose the folder where your data was stored.`,
    refusedOtherData: path => `"${path}" holds a different set of DSH data, not yours. Choose the folder where your data was stored.`,
    ok: 'OK',
    envTitle: 'The data location was changed',
    env: (reason, envPath, current) => [
      reason === 'missing'
        ? `The data location was set to "${envPath}" in the system or a terminal, but that folder does not exist.`
        : `The data location was set to "${envPath}" in the system or a terminal, but that folder holds no DSH data.`,
      `Your data is now in "${current}". Choosing "Use the New Location" starts empty; your data stays where it is.`,
    ].join('\n'),
    useNew: 'Use the New Location',
    keep: 'Keep the Current Location',
  },
}

/**
 * The sentences for a locale.
 * @param locale - the system locale, as `app.getLocale()` reports it.
 * @returns the Chinese set on a `zh*` locale, the English set otherwise.
 */
export function dataLocationText(locale: string): DataLocationText {
  return locale.startsWith('zh') ? DATA_LOCATION_TEXT.zh : DATA_LOCATION_TEXT.en
}
