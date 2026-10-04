/**
 * What the data move's own windows say: the progress window, the page for a
 * move stopped partway, and the pages that keep the application from
 * starting while a move cannot go on. The set is chosen by the system locale,
 * the same way the boot prompts are.
 * @module @deepseek-ai/dsh-desktop-shell/move-text
 */

import type { HealthFailure, HealthFailures, MoveFailureKind } from './move/journal.ts'

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
  /** A move that stopped on an error, by what the error was, with what the person can do. */
  failed: (cause: StopCause) => string
  keptTargetTitle: string
  /**
   * The new location failed its check after the person chose to keep it, so
   * the move finished there; the original, when one was kept, is in `kept`.
   */
  keptTarget: (target: string, kept: string | undefined, failures: HealthFailures) => string
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
  lockLostTitle: string
  withdrawFailedTitle: string
  /** A move that never started copying could not be withdrawn at launch; `path` is the move's record. */
  withdrawFailed: (path: string) => string
  /** A move stopped because its lock is gone or another installation holds it. */
  lockLost: string
  lockUncheckedTitle: string
  /** A move stopped because its lock could not be read. */
  lockUnchecked: string
  lockSiblingTitle: string
  /** A move stopped because another process of this installation holds its lock. */
  lockSibling: string
  /** What abandoning does, on the page of a move that lost its lock while only its copy changed. */
  abandonNote: string
  abandonMove: string
  /** What taking the move back does, on the page of a move that lost its lock after hiding began, by what happens to the copy. */
  rollBackNote: (copy: RollBackCopy) => string
  rollBackMove: string
  retry: string
  /** Why a move asked for in Settings did not start: the server could not be confirmed stopped. */
  serverStillRunning: string
  /** The notice after a launch withdrew a move that was asked for and never started copying. */
  requestWithdrawn: string
  /** The button that closes a notice. */
  understood: string
}

/**
 * What taking a move back does with the copy at the new location: on one volume
 * there is none (the data is renamed back); otherwise it is deleted (it was
 * never made the data location), kept under a new name (it was), or left where
 * it is (it cannot be reached, or its removal was already given up). A copy
 * that was made the data location and cannot be reached now stops the take-back
 * once more at the page for a new location that cannot be found, which asks
 * again (`unreachable-exposed`).
 */
export type RollBackCopy = 'none' | 'deleted' | 'kept' | 'unreachable' | 'unreachable-exposed'

/**
 * What stopped a move on an error, as its page words it: a drive without
 * enough free space, a change refused for lack of permission, or anything
 * else.
 */
export type StopCause = 'no-space' | 'no-permission' | 'other'

/**
 * The stop cause a failure kind is worded as.
 * @param kind - why the move failed.
 * @returns `no-space` and `no-permission` as they are; `other` for every other kind.
 */
export function stopCauseOf(kind: MoveFailureKind): StopCause {
  return kind === 'no-space' || kind === 'no-permission' ? kind : 'other'
}

/** Each failure of a first launch on the new location, as a kept new location's page names it, by language. */
const HEALTH_FAILURE: Record<'zh' | 'en', Record<HealthFailure, string>> = {
  zh: {
    'not-started': '北冥没能在这里启动',
    'unreadable': '这里的数据读不出来',
    'fewer-sessions': '这里的对话比搬运前少',
    'plugin-quarantined': '有插件在这里没能加载',
    'workspaces-differ': '这里的工作区数量和搬运前不一样',
  },
  en: {
    'not-started': 'Beiming could not start there',
    'unreadable': 'the data there could not be read',
    'fewer-sessions': 'it holds fewer conversations than before the move',
    'plugin-quarantined': 'a plugin could not be loaded there',
    'workspaces-differ': 'it holds a different number of workspaces than before the move',
  },
}

/** The two sentence sets, keyed by the language they are written in. */
export const MOVE_TEXT: Record<'zh' | 'en', MoveText> = {
  zh: {
    progressTitle: '正在搬运你的数据…',
    progress: (done, total, secondsLeft) => `已搬 ${done} / ${total}${secondsLeft === undefined ? '' : `，还需约 ${durationZh(secondsLeft)}`}`,
    progressNote: '中途关机或断电也没关系，下次打开北冥会接着搬。',
    checking: '正在检查搬过去的数据…',
    finishing: '正在用新位置启动…',
    rollingBack: '正在把你的数据放回原来的位置…',
    cancel: '取消搬运',
    cancelling: '正在取消…',
    blockedTitle: '搬运停在了一半',
    sourceOccupiedAcross: source => `原来的位置「${source}」现在有一个别的文件夹，可能是在终端里运行 dsh 时新建的。北冥不会动这个文件夹里的任何东西。你的数据完整地保存在原来位置旁边的一个隐藏文件夹里。`,
    alsoAtTarget: target => `新位置「${target}」也有一份完整的数据。`,
    sourceOccupiedSame: (source, target) => `原来的位置「${source}」现在有一个别的文件夹，可能是在终端里运行 dsh 时新建的。北冥不会动这个文件夹里的任何东西。你的数据完整地保存在新位置「${target}」。`,
    sourceOccupiedWays: (target, source) => `保留新位置：从「${target}」继续使用北冥。\n回到原位置：先把「${source}」这个文件夹移到别处（它不是这次搬运的数据，移走前请确认里面没有你需要的东西），再重新打开北冥。`,
    choiceAcrossUsed: (target, source, unusedName, targetParent) => `原来的位置已经空出来了。请选择接下来怎么做：\n保留新位置：从「${target}」继续使用北冥，检查无误后删除原来的数据。\n回到原位置：把数据放回「${source}」。新位置的这份不会被删除，会改名为「${unusedName}」留在「${targetParent}」里，北冥不再使用它；你确认里面没有需要的东西后，可以自己删掉。`,
    choiceAcrossUnused: (target, source) => `原来的位置已经空出来了。请选择接下来怎么做：\n保留新位置：从「${target}」继续使用北冥，检查无误后删除原来的数据。\n回到原位置：把数据放回「${source}」。新位置的这份还没有被用过，会被删除。`,
    choiceSame: (target, source) => `原来的位置已经空出来了。请选择接下来怎么做：\n保留新位置：从「${target}」继续使用北冥。\n回到原位置：把数据移回「${source}」，在新位置期间新增或修改的文件也一起移回去，什么都不会删除。`,
    changedAcross: (target, source, unusedName, targetParent) => `新位置「${target}」里有文件是在搬运停下之后才新增或修改的。\n保留新位置：从这里继续使用北冥，这些文件都会保留。\n回到原位置：把数据放回「${source}」。这些文件不会被删除：新位置的这份会改名为「${unusedName}」留在「${targetParent}」里，但北冥不再使用它；需要里面的文件的话，请自己拿出来。`,
    changedSame: (target, source) => `新位置「${target}」里有文件是在搬运停下之后才新增或修改的。\n保留新位置：从这里继续使用北冥，这些文件都会保留。\n回到原位置：把数据移回「${source}」，这些文件也一起移回去，什么都不会删除。`,
    targetMissing: (target, source, unusedName) => `找不到新位置「${target}」。如果它在移动硬盘上，请接好后重新打开北冥。\n不等了，回到原位置：直接把数据放回「${source}」。那块盘上的这份会留在原处，北冥不再使用它；下次接上那块盘时，北冥会把它改名为「${unusedName}」，你确认里面没有需要的东西后，可以自己删掉。`,
    targetOccupied: target => `新位置「${target}」现在是一个别的文件夹，北冥不会动它。你的数据完整地保存在原来位置旁边的一个隐藏文件夹里。`,
    originalMissing: (source, target, unusedName) => `找不到原来的数据「${source}」。如果它在移动硬盘上，请接好后重新打开北冥。新位置「${target}」有一份完整的数据。\n保留新位置：从「${target}」继续使用北冥。原来的数据以后如果重新接上，北冥不会再使用它，会把它改名为「${unusedName}」留在原处；你确认里面没有需要的东西后，可以自己删掉。`,
    bothMissing: (source, target) => `原来的位置「${source}」和新位置「${target}」都打不开。如果它们在移动硬盘上，请接好后重新打开北冥。`,
    refreshed: '页面内容已更新，请重新选择。',
    keepTarget: '保留新位置',
    goBack: '回到原位置',
    goBackWithout: '不等了，回到原位置',
    reveal: platform => platform === 'win32' ? '在资源管理器中显示' : '在访达中显示',
    quit: '退出',
    stoppedTitle: '搬运停下了',
    stalled: '搬运已经两分钟没有任何进展，可能是磁盘没有响应。北冥会退出；重新打开北冥时会从停下的地方接着搬。',
    failed: (cause) => {
      const resume = '北冥现在退出，重新打开北冥时会从停下的地方接着处理。'
      switch (cause) {
        case 'no-space':
          return `磁盘空间不够，搬运没法继续。请先腾出一些空间；${resume}`
        case 'no-permission':
          return `北冥没有权限修改数据所在的文件夹（原来的位置或新位置）。请确认你能修改那里的文件，并且没有别的程序（比如安全软件）正占用着它们；${resume}`
        case 'other':
          return `搬运时出了错。${resume}如果重新打开后又看到这一页，请重新启动电脑，再打开北冥。`
        default:
          return cause satisfies never
      }
    },
    keptTargetTitle: '新位置没有通过检查',
    keptTarget: (target, kept, failures) => `你选择保留的新位置「${target}」没有通过检查：${failures.map(failure => HEALTH_FAILURE.zh[failure]).join('；')}。北冥按你的选择继续使用这个位置，重新打开北冥时仍从这里启动。${kept === undefined ? '' : `原来的数据没有删除，保留在「${kept}」。`}北冥现在退出。`,
    journalUnreadableTitle: '北冥暂时不能启动',
    journalUnreadable: path => `记录这次搬运进度的文件「${path}」读不出来了。为了不把只搬了一半的数据当成你的数据，北冥在这个文件修好之前不会启动。`,
    lockedTitle: '另一个北冥正在搬运这份数据',
    locked: (home, owner) => `另一个北冥（「${owner}」）正在搬运「${home}」里的数据。等它搬完之后再打开这个北冥。`,
    unfinishedTitle: '另一个北冥的数据搬运还没做完',
    unfinished: (home, owner) => `另一个北冥（「${owner}」）搬运「${home}」里的数据时停在了一半。请先打开那个北冥，让它把这次搬运做完或退回，再打开这个北冥。在那之前，这个北冥不会使用这份数据。`,
    lockUnreadable: path => `文件「${path}」表示有一个北冥正在搬运这份数据，但这个文件读不出来，分不清是哪一个北冥。为了不在搬运途中使用这份数据，北冥不会启动。确认没有别的北冥在搬运这份数据之后，可以删掉这个文件，再打开北冥。`,
    discardMove: '那个北冥已经不在了，放弃它的搬运',
    confirmDiscardTitle: '放弃另一个北冥的搬运？',
    confirmDiscard: (path, owner) => `北冥只会删掉文件「${path}」，不会动你的任何数据。如果那个北冥（「${owner}」）其实还在运行，它发现锁没了就会停下这次搬运，什么也不会删除。`,
    confirmDiscardButton: '放弃它的搬运',
    back: '返回',
    withdrawFailed: path => `上次没有开始的数据搬运没能撤回。搬运记录还在的时候，北冥不会启动，以免使用正要搬走的数据。请检查文件夹「${path}」能否写入，然后重新打开北冥。`,
    lockLostTitle: '另一个北冥可能接手了这份数据',
    lockLost: '这份数据上的搬运锁不见了，或者已经换了主人，可能是另一个北冥接手了这份数据。这次搬运先停在这里，之后没有再动数据。',
    lockUncheckedTitle: '暂时无法确认搬运锁',
    lockUnchecked: '读不出这份数据上的搬运锁，没法确认它仍属于这次搬运，所以搬运先停在这里，之后没有再动数据。如果数据所在的磁盘刚断开过，接好后重试。',
    lockSiblingTitle: '这个北冥的另一个窗口正在用这份数据',
    lockSibling: '这个北冥的另一个窗口或进程正拿着这份数据的搬运锁，所以这次搬运先停在这里，之后没有再动数据。关掉那个窗口后重试。',
    abandonNote: '也可以放弃这次搬运：北冥会删掉已经复制到新位置的那一份，然后照常打开原来位置的数据。',
    abandonMove: '放弃这次搬运',
    rollBackNote: (copy) => {
      if (copy === 'none') return '也可以撤回这次搬运：北冥会把数据改回原来的位置，然后照常打开，不会删除任何东西。'
      const back = '也可以撤回这次搬运：北冥会把数据放回原来的位置，然后照常打开。'
      if (copy === 'deleted') return `${back}新位置上的那一份还没设成数据位置，会被删掉。`
      if (copy === 'kept') return `${back}新位置上的那一份已经设成过数据位置，会改个名字留下，不会删除。`
      if (copy === 'unreachable-exposed') {
        return `${back}新位置上的那一份现在找不到（比如所在的磁盘没接上），而它已经设成过数据位置，所以撤回时北冥会先停下来再问你一次：等那块盘接上，或者不等它直接回到原来的位置。`
      }
      return `${back}新位置上的那一份现在找不到（比如所在的磁盘没接上），会原样留在那里。`
    },
    rollBackMove: '撤回这次搬运',
    retry: '重试',
    withdrawFailedTitle: '上次的搬运记录没能清除',
    serverStillRunning: '北冥没能确认后台服务和它启动的程序都已经停下，所以这次没有开始搬运，你的数据还在原来的位置，一切照旧。请稍后再试；如果一直这样，重新启动电脑后再搬。',
    requestWithdrawn: '上次的数据搬运没有开始，你的数据还在原来的位置。需要的话，可以在设置里重新搬运。',
    understood: '知道了',
  },
  en: {
    progressTitle: 'Moving your data…',
    progress: (done, total, secondsLeft) => `${done} of ${total} moved${secondsLeft === undefined ? '' : `, about ${durationEn(secondsLeft)} left`}`,
    progressNote: 'If your computer shuts down, Beiming picks up where it left off next time it opens.',
    checking: 'Checking the moved data…',
    finishing: 'Starting from the new location…',
    rollingBack: 'Putting your data back in its original location…',
    cancel: 'Cancel Move',
    cancelling: 'Cancelling…',
    blockedTitle: 'The move stopped partway',
    sourceOccupiedAcross: source => `Another folder is now at the original location "${source}", possibly created by running dsh in a terminal. Beiming does not touch anything in that folder. Your data is safe in a hidden folder next to the original location.`,
    alsoAtTarget: target => `The new location "${target}" also has a complete copy.`,
    sourceOccupiedSame: (source, target) => `Another folder is now at the original location "${source}", possibly created by running dsh in a terminal. Beiming does not touch anything in that folder. Your data is safe in the new location "${target}".`,
    sourceOccupiedWays: (target, source) => `Keep the new location: continue using Beiming from "${target}".\nGo back to the original location: first move the folder "${source}" somewhere else (it is not the data being moved; check that it holds nothing you need before moving it), then reopen Beiming.`,
    choiceAcrossUsed: (target, source, unusedName, targetParent) => `The original location is free again. Choose what to do next:\nKeep New Location: continue using Beiming from "${target}"; the original data is deleted once it has been checked.\nGo Back: put your data back in "${source}". The copy in the new location is not deleted: it is renamed to "${unusedName}" and stays in "${targetParent}", and Beiming no longer uses it; once you have checked that it holds nothing you need, you can delete it yourself.`,
    choiceAcrossUnused: (target, source) => `The original location is free again. Choose what to do next:\nKeep New Location: continue using Beiming from "${target}"; the original data is deleted once it has been checked.\nGo Back: put your data back in "${source}". The copy in the new location has not been used yet and is deleted.`,
    choiceSame: (target, source) => `The original location is free again. Choose what to do next:\nKeep New Location: continue using Beiming from "${target}".\nGo Back: move your data back to "${source}", together with any files added or changed while it was in the new location; nothing is deleted.`,
    changedAcross: (target, source, unusedName, targetParent) => `Some files in the new location "${target}" were added or changed after the move stopped.\nKeep New Location: continue using Beiming from there; those files are kept.\nGo Back: put your data back in "${source}". Those files are not deleted: the copy in the new location is renamed to "${unusedName}" and stays in "${targetParent}", but Beiming no longer uses it; if you need files from it, take them out yourself.`,
    changedSame: (target, source) => `Some files in the new location "${target}" were added or changed after the move stopped.\nKeep New Location: continue using Beiming from there; those files are kept.\nGo Back: move your data back to "${source}", together with those files; nothing is deleted.`,
    targetMissing: (target, source, unusedName) => `The new location "${target}" cannot be found. If it is on an external drive, connect it and reopen Beiming.\nGo Back Without It: put your data back in "${source}" now. The copy on that drive stays where it is, and Beiming no longer uses it; the next time that drive is connected, Beiming renames it to "${unusedName}", and once you have checked that it holds nothing you need, you can delete it yourself.`,
    targetOccupied: target => `Another folder is now at the new location "${target}"; Beiming does not touch it. Your data is safe in a hidden folder next to the original location.`,
    originalMissing: (source, target, unusedName) => `Your original data "${source}" cannot be found. If it is on an external drive, connect it and reopen Beiming. The new location "${target}" has a complete copy.\nKeep New Location: continue using Beiming from "${target}". If the original data is connected again later, Beiming does not use it; it renames it to "${unusedName}" where it is, and once you have checked that it holds nothing you need, you can delete it yourself.`,
    bothMissing: (source, target) => `Neither the original location "${source}" nor the new location "${target}" can be opened. If they are on an external drive, connect it and reopen Beiming.`,
    refreshed: 'This page was updated. Please choose again.',
    keepTarget: 'Keep New Location',
    goBack: 'Go Back',
    goBackWithout: 'Go Back Without It',
    reveal: platform => platform === 'win32' ? 'Show in File Explorer' : 'Show in Finder',
    quit: 'Quit',
    stoppedTitle: 'The move stopped',
    stalled: 'The move has made no progress for two minutes; a drive may not be responding. Beiming quits now; when you reopen it, the move picks up where it stopped.',
    failed: (cause) => {
      const resume = 'Beiming quits now; when you reopen it, it picks up where it stopped.'
      switch (cause) {
        case 'no-space':
          return `There is not enough free space on the drive to go on. Free up some space. ${resume}`
        case 'no-permission':
          return `Beiming was not allowed to change the folders that hold your data, at the original location or the new one. Check that you can change files there and that no other program, such as security software, has them open. ${resume}`
        case 'other':
          return `The move ran into an error. ${resume} If this page comes back after you reopen Beiming, restart your computer, then open Beiming again.`
        default:
          return cause satisfies never
      }
    },
    keptTargetTitle: 'The new location did not pass its check',
    keptTarget: (target, kept, failures) => `The new location "${target}" you chose to keep did not pass its check: ${failures.map(failure => HEALTH_FAILURE.en[failure]).join('; ')}. Beiming keeps using it as you chose, and starts from there when you reopen it.${kept === undefined ? '' : ` Your original data was not deleted; it is kept in "${kept}".`} Beiming quits now.`,
    journalUnreadableTitle: 'Beiming cannot start',
    journalUnreadable: path => `The file that records this data move's progress, "${path}", cannot be read. To avoid taking half-moved data for your data, Beiming does not start until this file is fixed.`,
    lockedTitle: 'Another Beiming is moving this data',
    locked: (home, owner) => `Another Beiming ("${owner}") is moving the data in "${home}". Open this Beiming again once that move has finished.`,
    unfinishedTitle: 'Another Beiming has not finished moving this data',
    unfinished: (home, owner) => `Another Beiming ("${owner}") stopped partway through moving the data in "${home}". Open that Beiming first so it can finish or undo the move, then open this one. Until then this Beiming does not use this data.`,
    lockUnreadable: path => `The file "${path}" says a Beiming is moving this data, but it cannot be read, so it is not clear which one. To avoid using the data in the middle of a move, Beiming does not start. Once you are sure no other Beiming is moving this data, you can delete this file and open Beiming again.`,
    discardMove: 'That Beiming is gone — discard its move',
    confirmDiscardTitle: 'Discard the other Beiming\'s move?',
    confirmDiscard: (path, owner) => `Beiming will delete only the file "${path}" and will not touch any of your data. If that Beiming ("${owner}") is still running, it stops its move when it notices, and nothing is deleted.`,
    confirmDiscardButton: 'Discard its move',
    back: 'Back',
    withdrawFailed: path => `The last data move, which had not started, could not be withdrawn. While its record is there, Beiming does not start, so it does not use data that was about to move. Check that the folder "${path}" can be written to, then open Beiming again.`,
    lockLostTitle: 'Another Beiming may have taken over this data',
    lockLost: 'The move lock on this data is gone or now belongs to someone else, so another Beiming may have taken over the data. This move has paused here and has not touched the data since.',
    lockUncheckedTitle: 'The move lock could not be checked',
    lockUnchecked: 'The move lock on this data could not be read, so Beiming cannot tell whether it still belongs to this move. The move has paused here and has not touched the data since. If the drive holding the data was just disconnected, reconnect it and retry.',
    lockSiblingTitle: 'Another window of this Beiming is using this data',
    lockSibling: 'Another window or process of this same Beiming is holding the move lock on this data, so this move has paused here and has not touched the data since. Close that window, then retry.',
    abandonNote: 'You can also abandon this move: Beiming deletes the copy it made at the new location, then opens the data in its original location as usual.',
    abandonMove: 'Abandon this move',
    rollBackNote: (copy) => {
      if (copy === 'none') return 'You can also take this move back: Beiming moves the data back to its original location and opens it there as usual. Nothing is deleted.'
      const back = 'You can also take this move back: Beiming puts the data back in its original location and opens it there as usual.'
      if (copy === 'deleted') return `${back} The copy at the new location was never made the data location, so it is deleted.`
      if (copy === 'kept') return `${back} The copy at the new location was already made the data location, so it is kept under a new name, not deleted.`
      if (copy === 'unreachable-exposed') {
        return `${back} The copy at the new location cannot be reached now (its drive may be disconnected), and it was already made the data location, so Beiming stops once more while taking the move back and asks you again: wait for that drive, or go back to the original location without it.`
      }
      return `${back} The copy at the new location cannot be reached now (its drive may be disconnected), so it is left as it is.`
    },
    rollBackMove: 'Take this move back',
    retry: 'Retry',
    withdrawFailedTitle: 'The last move\'s record could not be cleared',
    serverStillRunning: 'Beiming could not confirm that its background service and the programs it started have stopped, so the move did not start. Your data is still in its original location, and nothing has changed. Try again later; if this keeps happening, restart your computer and then move the data.',
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

const KB = 1024
const MB = KB * 1024
const GB = MB * 1024

/**
 * A byte count as the progress line shows it, by the rule of the size the
 * Settings page's data section asks the person to confirm
 * (`formatSize` in `@haoran/dsh-data-location`), since both count the same
 * data, the page from the preflight's scan and the progress line from the
 * copier's own scan of it: multiples of 1024 under the symbols `KB`, `MB`,
 * and `GB`, one decimal from gigabytes up, whole megabytes below that, and
 * whole kilobytes, at least 1, below a megabyte. Zero reads `0 KB`, where
 * that page's rule gives `1 KB`; the progress line starts at zero.
 * @param bytes - the count.
 * @returns e.g. `533 MB` or `1.2 GB`.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  if (bytes >= MB) return `${String(Math.round(bytes / MB))} MB`
  if (bytes === 0) return '0 KB'
  return `${String(Math.max(1, Math.round(bytes / KB)))} KB`
}

/**
 * The sentence set for a system locale.
 * @param locale - `app.getLocale()`.
 * @returns Chinese on a `zh*` locale, English otherwise.
 */
export function moveText(locale: string): MoveText {
  return locale.startsWith('zh') ? MOVE_TEXT.zh : MOVE_TEXT.en
}
