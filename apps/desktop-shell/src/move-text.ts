/**
 * What the data move's own windows say: the progress window, the page for a
 * move stopped partway, and the pages that keep the application from
 * starting while a move cannot go on. The set is chosen by the system locale,
 * the same way the boot prompts are.
 * @module @deepseek-ai/dsh-desktop-shell/move-text
 */

/** One language's sentences. */
export interface MoveText {
  progressTitle: string
  /** Bytes moved so far, with the time left when it can be told. */
  progress: (done: string, total: string, secondsLeft: number | undefined) => string
  progressNote: string
  checking: string
  finishing: string
  rollingBack: string
  cancel: string
  cancelling: string
  blockedTitle: string
  sourceOccupiedAcross: (source: string) => string
  alsoAtTarget: (target: string) => string
  sourceOccupiedSame: (source: string, target: string) => string
  sourceOccupiedWays: (target: string, source: string) => string
  choiceAcrossUsed: (target: string, source: string, unusedName: string, targetParent: string) => string
  choiceAcrossUnused: (target: string, source: string) => string
  choiceSame: (target: string, source: string) => string
  changedAcross: (target: string, source: string, unusedName: string, targetParent: string) => string
  changedSame: (target: string, source: string) => string
  targetMissing: (target: string, source: string, unusedName: string) => string
  targetOccupied: (target: string) => string
  originalMissing: (source: string, target: string, unusedName: string) => string
  bothMissing: (source: string, target: string) => string
  refreshed: string
  keepTarget: string
  goBack: string
  goBackWithout: string
  reveal: (platform: NodeJS.Platform) => string
  quit: string
  stoppedTitle: string
  stalled: string
  failed: (detail: string) => string
  journalUnreadableTitle: string
  journalUnreadable: (path: string) => string
  lockedTitle: string
  locked: (home: string, owner: string) => string
  unfinishedTitle: string
  unfinished: (home: string, owner: string) => string
  lockUnreadable: (path: string) => string
  /** The button that discards another installation's unfinished move. */
  discardMove: string
  confirmDiscardTitle: string
  confirmDiscard: (path: string, owner: string) => string
  confirmDiscardButton: string
  back: string
  /** Why a move asked for in Settings did not start: the server could not be confirmed stopped. */
  serverStillRunning: string
  /** The notice after a launch withdrew a move that was asked for and never started copying. */
  requestWithdrawn: string
  /** The button that closes a notice. */
  understood: string
}

/** The two sentence sets, keyed by the language they are written in. */
export const MOVE_TEXT: Record<'zh' | 'en', MoveText> = {
  zh: {
    progressTitle: '正在搬运你的数据…',
    progress: (done, total, secondsLeft) => `已搬 ${done} / ${total}${secondsLeft === undefined ? '' : `，还需约 ${durationZh(secondsLeft)}`}`,
    progressNote: '中途关机或断电也没关系，下次打开 DSH 会接着搬。',
    checking: '正在检查搬过去的数据…',
    finishing: '正在用新位置启动…',
    rollingBack: '正在把你的数据放回原来的位置…',
    cancel: '取消搬运',
    cancelling: '正在取消…',
    blockedTitle: '搬运停在了一半',
    sourceOccupiedAcross: source => `原来的位置「${source}」现在有一个别的文件夹，可能是在终端里运行 DSH 时新建的。DSH 不会动这个文件夹里的任何东西。你的数据完整地保存在原来位置旁边的一个隐藏文件夹里。`,
    alsoAtTarget: target => `新位置「${target}」也有一份完整的数据。`,
    sourceOccupiedSame: (source, target) => `原来的位置「${source}」现在有一个别的文件夹，可能是在终端里运行 DSH 时新建的。DSH 不会动这个文件夹里的任何东西。你的数据完整地保存在新位置「${target}」。`,
    sourceOccupiedWays: (target, source) => `保留新位置：从「${target}」继续使用 DSH。\n回到原位置：先把「${source}」这个文件夹移到别处（它不是这次搬运的数据，移走前请确认里面没有你需要的东西），再重新打开 DSH。`,
    choiceAcrossUsed: (target, source, unusedName, targetParent) => `原来的位置已经空出来了。请选择接下来怎么做：\n保留新位置：从「${target}」继续使用 DSH，检查无误后删除原来的数据。\n回到原位置：把数据放回「${source}」。新位置的这份不会被删除，会改名为「${unusedName}」留在「${targetParent}」里，DSH 不再使用它；你确认里面没有需要的东西后，可以自己删掉。`,
    choiceAcrossUnused: (target, source) => `原来的位置已经空出来了。请选择接下来怎么做：\n保留新位置：从「${target}」继续使用 DSH，检查无误后删除原来的数据。\n回到原位置：把数据放回「${source}」。新位置的这份还没有被用过，会被删除。`,
    choiceSame: (target, source) => `原来的位置已经空出来了。请选择接下来怎么做：\n保留新位置：从「${target}」继续使用 DSH。\n回到原位置：把数据移回「${source}」，在新位置期间新增或修改的文件也一起移回去，什么都不会删除。`,
    changedAcross: (target, source, unusedName, targetParent) => `新位置「${target}」里有文件是在搬运停下之后才新增或修改的。\n保留新位置：从这里继续使用 DSH，这些文件都会保留。\n回到原位置：把数据放回「${source}」。这些文件不会被删除：新位置的这份会改名为「${unusedName}」留在「${targetParent}」里，但 DSH 不再使用它；需要里面的文件的话，请自己拿出来。`,
    changedSame: (target, source) => `新位置「${target}」里有文件是在搬运停下之后才新增或修改的。\n保留新位置：从这里继续使用 DSH，这些文件都会保留。\n回到原位置：把数据移回「${source}」，这些文件也一起移回去，什么都不会删除。`,
    targetMissing: (target, source, unusedName) => `找不到新位置「${target}」。如果它在移动硬盘上，请接好后重新打开 DSH。\n不等了，回到原位置：直接把数据放回「${source}」。那块盘上的这份会留在原处，DSH 不再使用它；下次接上那块盘时，DSH 会把它改名为「${unusedName}」，你确认里面没有需要的东西后，可以自己删掉。`,
    targetOccupied: target => `新位置「${target}」现在是一个别的文件夹，DSH 不会动它。你的数据完整地保存在原来位置旁边的一个隐藏文件夹里。`,
    originalMissing: (source, target, unusedName) => `找不到原来的数据「${source}」。如果它在移动硬盘上，请接好后重新打开 DSH。新位置「${target}」有一份完整的数据。\n保留新位置：从「${target}」继续使用 DSH。原来的数据以后如果重新接上，DSH 不会再使用它，会把它改名为「${unusedName}」留在原处；你确认里面没有需要的东西后，可以自己删掉。`,
    bothMissing: (source, target) => `原来的位置「${source}」和新位置「${target}」都打不开。如果它们在移动硬盘上，请接好后重新打开 DSH。`,
    refreshed: '页面内容已更新，请重新选择。',
    keepTarget: '保留新位置',
    goBack: '回到原位置',
    goBackWithout: '不等了，回到原位置',
    reveal: platform => platform === 'win32' ? '在资源管理器中显示' : '在访达中显示',
    quit: '退出',
    stoppedTitle: '搬运停下了',
    stalled: '搬运已经两分钟没有任何进展，可能是磁盘没有响应。DSH 会退出；重新打开 DSH 时会从停下的地方接着搬。',
    failed: detail => `搬运时出了错：${detail}。DSH 会退出；重新打开 DSH 时会从停下的地方接着处理。`,
    journalUnreadableTitle: 'DSH 暂时不能启动',
    journalUnreadable: path => `记录这次搬运进度的文件「${path}」读不出来了。为了不把只搬了一半的数据当成你的数据，DSH 在这个文件修好之前不会启动。`,
    lockedTitle: '另一个 DSH 正在搬运这份数据',
    locked: (home, owner) => `另一个 DSH（「${owner}」）正在搬运「${home}」里的数据。等它搬完之后再打开这个 DSH。`,
    unfinishedTitle: '另一个 DSH 的数据搬运还没做完',
    unfinished: (home, owner) => `另一个 DSH（「${owner}」）搬运「${home}」里的数据时停在了一半。请先打开那个 DSH，让它把这次搬运做完或退回，再打开这个 DSH。在那之前，这个 DSH 不会使用这份数据。`,
    lockUnreadable: path => `文件「${path}」表示有一个 DSH 正在搬运这份数据，但这个文件读不出来，分不清是哪一个 DSH。为了不在搬运途中使用这份数据，DSH 不会启动。确认没有别的 DSH 在搬运这份数据之后，可以删掉这个文件，再打开 DSH。`,
    discardMove: '那个 DSH 已经不在了，放弃它的搬运',
    confirmDiscardTitle: '放弃另一个 DSH 的搬运？',
    confirmDiscard: (path, owner) => `DSH 只会删掉文件「${path}」，不会动你的任何数据。如果那个 DSH（「${owner}」）其实还在，它这次没做完的搬运可能会因此出错。`,
    confirmDiscardButton: '放弃它的搬运',
    back: '返回',
    serverStillRunning: 'DSH 没能确认后台服务和它启动的程序都已经停下，所以这次没有开始搬运，你的数据还在原来的位置，一切照旧。请稍后再试；如果一直这样，重新启动电脑后再搬。',
    requestWithdrawn: '上次的数据搬运没有开始，你的数据还在原来的位置。需要的话，可以在设置里重新搬运。',
    understood: '知道了',
  },
  en: {
    progressTitle: 'Moving your data…',
    progress: (done, total, secondsLeft) => `${done} of ${total} moved${secondsLeft === undefined ? '' : `, about ${durationEn(secondsLeft)} left`}`,
    progressNote: 'If your computer shuts down, DSH picks up where it left off next time it opens.',
    checking: 'Checking the moved data…',
    finishing: 'Starting from the new location…',
    rollingBack: 'Putting your data back in its original location…',
    cancel: 'Cancel Move',
    cancelling: 'Cancelling…',
    blockedTitle: 'The move stopped partway',
    sourceOccupiedAcross: source => `Another folder is now at the original location "${source}", possibly created by running DSH in a terminal. DSH does not touch anything in that folder. Your data is safe in a hidden folder next to the original location.`,
    alsoAtTarget: target => `The new location "${target}" also has a complete copy.`,
    sourceOccupiedSame: (source, target) => `Another folder is now at the original location "${source}", possibly created by running DSH in a terminal. DSH does not touch anything in that folder. Your data is safe in the new location "${target}".`,
    sourceOccupiedWays: (target, source) => `Keep the new location: continue using DSH from "${target}".\nGo back to the original location: first move the folder "${source}" somewhere else (it is not the data being moved; check that it holds nothing you need before moving it), then reopen DSH.`,
    choiceAcrossUsed: (target, source, unusedName, targetParent) => `The original location is free again. Choose what to do next:\nKeep New Location: continue using DSH from "${target}"; the original data is deleted once it has been checked.\nGo Back: put your data back in "${source}". The copy in the new location is not deleted: it is renamed to "${unusedName}" and stays in "${targetParent}", and DSH no longer uses it; once you have checked that it holds nothing you need, you can delete it yourself.`,
    choiceAcrossUnused: (target, source) => `The original location is free again. Choose what to do next:\nKeep New Location: continue using DSH from "${target}"; the original data is deleted once it has been checked.\nGo Back: put your data back in "${source}". The copy in the new location has not been used yet and is deleted.`,
    choiceSame: (target, source) => `The original location is free again. Choose what to do next:\nKeep New Location: continue using DSH from "${target}".\nGo Back: move your data back to "${source}", together with any files added or changed while it was in the new location; nothing is deleted.`,
    changedAcross: (target, source, unusedName, targetParent) => `Some files in the new location "${target}" were added or changed after the move stopped.\nKeep New Location: continue using DSH from there; those files are kept.\nGo Back: put your data back in "${source}". Those files are not deleted: the copy in the new location is renamed to "${unusedName}" and stays in "${targetParent}", but DSH no longer uses it; if you need files from it, take them out yourself.`,
    changedSame: (target, source) => `Some files in the new location "${target}" were added or changed after the move stopped.\nKeep New Location: continue using DSH from there; those files are kept.\nGo Back: move your data back to "${source}", together with those files; nothing is deleted.`,
    targetMissing: (target, source, unusedName) => `The new location "${target}" cannot be found. If it is on an external drive, connect it and reopen DSH.\nGo Back Without It: put your data back in "${source}" now. The copy on that drive stays where it is, and DSH no longer uses it; the next time that drive is connected, DSH renames it to "${unusedName}", and once you have checked that it holds nothing you need, you can delete it yourself.`,
    targetOccupied: target => `Another folder is now at the new location "${target}"; DSH does not touch it. Your data is safe in a hidden folder next to the original location.`,
    originalMissing: (source, target, unusedName) => `Your original data "${source}" cannot be found. If it is on an external drive, connect it and reopen DSH. The new location "${target}" has a complete copy.\nKeep New Location: continue using DSH from "${target}". If the original data is connected again later, DSH does not use it; it renames it to "${unusedName}" where it is, and once you have checked that it holds nothing you need, you can delete it yourself.`,
    bothMissing: (source, target) => `Neither the original location "${source}" nor the new location "${target}" can be opened. If they are on an external drive, connect it and reopen DSH.`,
    refreshed: 'This page was updated. Please choose again.',
    keepTarget: 'Keep New Location',
    goBack: 'Go Back',
    goBackWithout: 'Go Back Without It',
    reveal: platform => platform === 'win32' ? 'Show in File Explorer' : 'Show in Finder',
    quit: 'Quit',
    stoppedTitle: 'The move stopped',
    stalled: 'The move has made no progress for two minutes; a drive may not be responding. DSH quits now; when you reopen it, the move picks up where it stopped.',
    failed: detail => `The move ran into an error: ${detail}. DSH quits now; when you reopen it, it picks up where it stopped.`,
    journalUnreadableTitle: 'DSH cannot start',
    journalUnreadable: path => `The file that records this data move's progress, "${path}", cannot be read. To avoid taking half-moved data for your data, DSH does not start until this file is fixed.`,
    lockedTitle: 'Another DSH is moving this data',
    locked: (home, owner) => `Another DSH ("${owner}") is moving the data in "${home}". Open this DSH again once that move has finished.`,
    unfinishedTitle: 'Another DSH has not finished moving this data',
    unfinished: (home, owner) => `Another DSH ("${owner}") stopped partway through moving the data in "${home}". Open that DSH first so it can finish or undo the move, then open this one. Until then this DSH does not use this data.`,
    lockUnreadable: path => `The file "${path}" says a DSH is moving this data, but it cannot be read, so it is not clear which one. To avoid using the data in the middle of a move, DSH does not start. Once you are sure no other DSH is moving this data, you can delete this file and open DSH again.`,
    discardMove: 'That DSH is gone — discard its move',
    confirmDiscardTitle: 'Discard the other DSH\'s move?',
    confirmDiscard: (path, owner) => `DSH will delete only the file "${path}" and will not touch any of your data. If that DSH ("${owner}") still exists, the move it has not finished may break.`,
    confirmDiscardButton: 'Discard its move',
    back: 'Back',
    serverStillRunning: 'DSH could not confirm that its background service and the programs it started have stopped, so the move did not start. Your data is still in its original location, and nothing has changed. Try again later; if this keeps happening, restart your computer and then move the data.',
    requestWithdrawn: 'The last data move did not start, and your data is still in its original location. You can move it again in Settings.',
    understood: 'OK',
  },
}

/**
 * A wait in Chinese, rounded to what a person reads.
 * @param seconds - the wait.
 * @returns e.g. `40 秒` or `3 分钟`.
 */
function durationZh(seconds: number): string {
  return seconds < 90 ? `${String(Math.max(1, Math.round(seconds)))} 秒` : `${String(Math.round(seconds / 60))} 分钟`
}

/**
 * A wait in English, rounded to what a person reads.
 * @param seconds - the wait.
 * @returns e.g. `40 seconds` or `3 minutes`.
 */
function durationEn(seconds: number): string {
  if (seconds < 90) {
    const whole = Math.max(1, Math.round(seconds))
    return `${String(whole)} second${whole === 1 ? '' : 's'}`
  }
  return `${String(Math.round(seconds / 60))} minutes`
}

/**
 * A byte count as the progress line shows it: decimal units, one decimal
 * from gigabytes up.
 * @param bytes - the count.
 * @returns e.g. `820 MB` or `1.2 GB`.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${String(Math.round(bytes / 1e6))} MB`
  if (bytes >= 1e3) return `${String(Math.round(bytes / 1e3))} KB`
  return `${String(bytes)} B`
}

/**
 * The sentence set for a system locale.
 * @param locale - `app.getLocale()`.
 * @returns Chinese on a `zh*` locale, English otherwise.
 */
export function moveText(locale: string): MoveText {
  return locale.startsWith('zh') ? MOVE_TEXT.zh : MOVE_TEXT.en
}
