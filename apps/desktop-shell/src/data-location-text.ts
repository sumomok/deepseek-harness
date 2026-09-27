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
  /** The unreadable-record sentence when an earlier record still names a place. */
  unavailableSuggested: (path: string) => string
  useSuggested: string
  retry: string
  choose: string
  quit: string
  chooseTitle: string
  refusedNoData: (path: string) => string
  refusedOtherData: (path: string) => string
  refusedSetAside: (path: string) => string
  abandonedUnreadableTitle: string
  /** The record of abandoned copies cannot be read, so the launch does not go on. */
  abandonedUnreadable: (path: string) => string
  /** The button that shows a file in the platform's file browser. */
  reveal: (platform: NodeJS.Platform) => string
  /** The button that makes a set-aside folder the data again. */
  useAnyway: string
  confirmUseTitle: (path: string) => string
  confirmUse: string
  confirmUseButton: string
  cancel: string
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
        case 'set-aside':
          return `你的数据记在「${path ?? ''}」，但那个文件夹是搬运数据时留下的，DSH 不再使用它。请选择数据所在的文件夹。`
        default:
          return reason satisfies never
      }
    },
    unavailableSuggested: path => `记录数据位置的文件读不出来了。上一次记下的位置是「${path}」，但它可能已经不是现在的位置。如果数据就在那里，请点「使用这个位置」；否则请选择数据所在的文件夹。`,
    useSuggested: '使用这个位置',
    retry: '重试',
    choose: '选择数据所在的文件夹…',
    quit: '退出',
    chooseTitle: '选择数据所在的文件夹',
    refusedNoData: path => `「${path}」里没有 DSH 的数据。请选择数据所在的文件夹。`,
    refusedOtherData: path => `「${path}」里是另一份 DSH 数据，不是你原来的。请选择数据所在的文件夹。`,
    refusedSetAside: path => `「${path}」是搬运数据时留下的文件夹，DSH 不再使用它。请选择数据所在的文件夹。`,
    abandonedUnreadableTitle: 'DSH 暂时不能启动',
    abandonedUnreadable: path => `记录搬运数据时留下的文件夹的文件「${path}」读不出来了。DSH 没法分辨哪些文件夹是留下的副本，为了不把副本当成你的数据，在这个文件修好之前不会启动。`,
    reveal: platform => platform === 'win32' ? '在资源管理器中显示' : '在访达中显示',
    useAnyway: '这就是我要用的数据，改用它',
    confirmUseTitle: path => `改用「${path}」里的数据？`,
    confirmUse: 'DSH 会把这个文件夹当作你的数据继续使用。同一份数据的其他副本，包括搬运数据时留下的，以后都不会再被使用。',
    confirmUseButton: '改用它',
    cancel: '取消',
    ok: '知道了',
    envTitle: '数据位置被改过了',
    env: (reason, envPath, current) => {
      switch (reason) {
        case 'missing':
          return `系统或终端里把数据位置设成了「${envPath}」，但这个文件夹不存在。\n现在的数据在「${current}」。选择「使用这个新位置」会从空白开始，原来的数据仍留在原处。`
        case 'not-harness-data':
          return `系统或终端里把数据位置设成了「${envPath}」，但这个文件夹里没有 DSH 的数据。\n现在的数据在「${current}」。选择「使用这个新位置」会从空白开始，原来的数据仍留在原处。`
        case 'not-a-folder':
          return `系统或终端里把数据位置设成了「${envPath}」，但那里不是一个能存放数据的文件夹，所以不能改用它。\n现在的数据在「${current}」。`
        case 'damaged-data':
          return `系统或终端里把数据位置设成了「${envPath}」，但那里的 DSH 数据已经损坏，认不出是哪一份，所以不能改用它。\n现在的数据在「${current}」。`
        case 'set-aside':
          return `系统或终端里把数据位置设成了「${envPath}」，但那是搬运数据时留下的文件夹，DSH 不再使用它，所以不能改用它。\n现在的数据在「${current}」。`
        case 'cannot-create':
          return `这个位置无法使用：没能在「${envPath}」建立数据文件夹，可能是磁盘没有接上，或者没有权限在那里写入。\n现在的数据在「${current}」。`
        default:
          return reason satisfies never
      }
    },
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
        case 'set-aside':
          return `Your data is recorded as being in "${path ?? ''}", but that folder was left behind by moving your data, and DSH no longer uses it. Choose the folder that holds your data.`
        default:
          return reason satisfies never
      }
    },
    unavailableSuggested: path => `The record of where your data is stored cannot be read. An earlier record names "${path}", which may no longer be where your data is. If your data is there, click Use This Location; otherwise choose the folder that holds your data.`,
    useSuggested: 'Use This Location',
    retry: 'Retry',
    choose: 'Choose the Folder with My Data…',
    quit: 'Quit',
    chooseTitle: 'Choose the folder that holds your data',
    refusedNoData: path => `"${path}" holds no DSH data. Choose the folder that holds your data.`,
    refusedOtherData: path => `"${path}" holds a different set of DSH data, not yours. Choose the folder that holds your data.`,
    refusedSetAside: path => `"${path}" was left behind by moving your data, and DSH no longer uses it. Choose the folder that holds your data.`,
    abandonedUnreadableTitle: 'DSH cannot start',
    abandonedUnreadable: path => `The file that records folders left behind by moving your data, "${path}", cannot be read. DSH cannot tell which folders are left-behind copies, so to avoid taking a copy for your data it does not start until this file is fixed.`,
    reveal: platform => platform === 'win32' ? 'Show in File Explorer' : 'Show in Finder',
    useAnyway: 'This Is My Data — Use It',
    confirmUseTitle: path => `Use the data in "${path}"?`,
    confirmUse: 'DSH will use this folder as your data from now on. Any other copy of the same data, including copies left behind by moving your data, will no longer be used.',
    confirmUseButton: 'Use It',
    cancel: 'Cancel',
    ok: 'OK',
    envTitle: 'The data location was changed',
    env: (reason, envPath, current) => {
      switch (reason) {
        case 'missing':
          return `The data location was set to "${envPath}" in the system or a terminal, but that folder does not exist.\nYour data is now in "${current}". Choosing "Use the New Location" starts empty; your data stays where it is.`
        case 'not-harness-data':
          return `The data location was set to "${envPath}" in the system or a terminal, but that folder holds no DSH data.\nYour data is now in "${current}". Choosing "Use the New Location" starts empty; your data stays where it is.`
        case 'not-a-folder':
          return `The data location was set to "${envPath}" in the system or a terminal, but that is not a folder that can hold data, so it cannot be used.\nYour data is now in "${current}".`
        case 'damaged-data':
          return `The data location was set to "${envPath}" in the system or a terminal, but the DSH data there is damaged and cannot be recognized, so it cannot be used.\nYour data is now in "${current}".`
        case 'set-aside':
          return `The data location was set to "${envPath}" in the system or a terminal, but that folder was left behind by moving your data, and DSH no longer uses it, so it cannot be used.\nYour data is now in "${current}".`
        case 'cannot-create':
          return `This location cannot be used: a data folder could not be created in "${envPath}". The drive may not be connected, or you may not have permission to write there.\nYour data is now in "${current}".`
        default:
          return reason satisfies never
      }
    },
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
