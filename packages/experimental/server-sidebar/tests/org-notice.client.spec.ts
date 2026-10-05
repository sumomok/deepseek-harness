/**
 * The organization notice's answer checks and the card's store: which answer
 * shows a card, what putting a card away does on this page, how an agreement
 * travels, when the store asks again, and what reaches the browser console.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOrgNoticeStore, isRecord, OrgNoticeAnswerError, parseConfirmAnswer, parseMarkSeenAnswer, parseOrgNoticeDue,
  reportOncePerTopic, type OrgNoticeView,
} from '../src/client/org-notice.ts'
import { CALLER_UNKNOWN, DISCLOSURE, fakeOrgNoticePort, shownDue, UNAVAILABLE } from './fixtures/org-notice-port.client.ts'

/** The wire form of {@link DISCLOSURE}, with the fields the card does not read. */
const WIRE_DISCLOSURE = { ...DISCLOSURE, version: 3, acceptance: 'organization' }

/**
 * The field a bad answer is refused at.
 * @param read - the check to run.
 * @returns the field the check names, or nothing when it reads the answer.
 */
function refusedAt(read: () => unknown): string | undefined {
  try {
    read()
  } catch (error) {
    return error instanceof OrgNoticeAnswerError ? error.field : 'not an answer error'
  }
  return undefined
}

describe('isRecord', () => {
  it('takes a plain object and nothing else', () => {
    expect([{}, [], null, 'text', 1].map(isRecord)).toEqual([true, false, false, false, false])
  })
})

describe('parseOrgNoticeDue', () => {
  it('reads nothing to show, ignoring fields it does not use', () => {
    const unknownKind = vi.fn()
    expect(parseOrgNoticeDue({ kind: 'none', extra: 1 }, unknownKind)).toEqual({ kind: 'none' })
    expect(unknownKind).not.toHaveBeenCalled()
  })

  it('reads a wait with its delay', () => {
    expect(parseOrgNoticeDue({ kind: 'pending', retryAfterMs: 1500, reason: 'exchange' }, vi.fn()))
      .toEqual({ kind: 'pending', retryAfterMs: 1500 })
    expect(parseOrgNoticeDue({ kind: 'pending', retryAfterMs: 0 }, vi.fn())).toEqual({ kind: 'pending', retryAfterMs: 0 })
  })

  it('reads a wait longer than a timer can hold as the longest one it can', () => {
    expect(parseOrgNoticeDue({ kind: 'pending', retryAfterMs: 2_147_483_647 }, vi.fn()))
      .toEqual({ kind: 'pending', retryAfterMs: 2_147_483_647 })
    expect(parseOrgNoticeDue({ kind: 'pending', retryAfterMs: Number.MAX_SAFE_INTEGER }, vi.fn()))
      .toEqual({ kind: 'pending', retryAfterMs: 2_147_483_647 })
  })

  it('reads a notice and a disclosure to agree to, keeping only the fields the card reads', () => {
    expect(parseOrgNoticeDue({ kind: 'notice', version: 3, orgName: 'Acme', disclosure: WIRE_DISCLOSURE }, vi.fn()))
      .toEqual({ kind: 'notice', version: 3, orgName: 'Acme', disclosure: DISCLOSURE })
    expect(parseOrgNoticeDue({ kind: 'consent', version: 1, disclosure: { ...WIRE_DISCLOSURE, viewers: 'self' } }, vi.fn()))
      .toEqual({ kind: 'consent', version: 1, disclosure: { ...DISCLOSURE, viewers: 'self' } })
  })

  it('reads a kind it does not know as nothing to show, and says which kind', () => {
    const unknownKind = vi.fn()
    expect(parseOrgNoticeDue({ kind: 'reminder', version: 2 }, unknownKind)).toEqual({ kind: 'none' })
    expect(parseOrgNoticeDue({}, unknownKind)).toEqual({ kind: 'none' })
    expect(unknownKind.mock.calls).toEqual([['reminder'], [undefined]])
  })

  it('names the first field it cannot read', () => {
    const good = { kind: 'notice', version: 3, disclosure: WIRE_DISCLOSURE }
    const cases: [unknown, string][] = [
      [null, '(answer)'],
      [[], '(answer)'],
      [{ kind: 'pending' }, 'retryAfterMs'],
      [{ kind: 'pending', retryAfterMs: -1 }, 'retryAfterMs'],
      [{ kind: 'pending', retryAfterMs: Number.POSITIVE_INFINITY }, 'retryAfterMs'],
      [{ kind: 'pending', retryAfterMs: '10' }, 'retryAfterMs'],
      [{ ...good, version: 0 }, 'version'],
      [{ ...good, version: 1.5 }, 'version'],
      [{ ...good, version: '3' }, 'version'],
      [{ ...good, orgName: 7 }, 'orgName'],
      [{ ...good, disclosure: 'text' }, 'disclosure'],
      [{ ...good, disclosure: { ...WIRE_DISCLOSURE, categories: {} } }, 'disclosure.categories'],
      [{ ...good, disclosure: { ...WIRE_DISCLOSURE, viewers: 'everyone' } }, 'disclosure.viewers'],
      [{ ...good, disclosure: { ...WIRE_DISCLOSURE, title: 'Title' } }, 'disclosure.title'],
      [{ ...good, disclosure: { ...WIRE_DISCLOSURE, body: { zh: '正文' } } }, 'disclosure.body.en'],
      [{ ...good, disclosure: { ...WIRE_DISCLOSURE, categories: ['usage'] } }, 'disclosure.categories[0]'],
      [{ ...good, disclosure: { ...WIRE_DISCLOSURE, categories: [{ label: { zh: 'a', en: 'a' } }] } }, 'disclosure.categories[0].id'],
      [{ ...good, disclosure: { ...WIRE_DISCLOSURE, retentionDays: -1 } }, 'disclosure.retentionDays'],
      [{ ...good, disclosure: { ...WIRE_DISCLOSURE, contact: null } }, 'disclosure.contact'],
      [{ ...good, disclosure: { ...WIRE_DISCLOSURE, policyUrl: undefined } }, 'disclosure.policyUrl'],
    ]
    for (const [value, field] of cases) {
      expect({ value, field: refusedAt(() => parseOrgNoticeDue(value, vi.fn())) }).toEqual({ value, field })
    }
    expect(new OrgNoticeAnswerError('kind').message).toBe('server-sidebar: the organization notice answer is unusable at kind')
  })
})

describe('parseMarkSeenAnswer and parseConfirmAnswer', () => {
  it('read the two answers each method gives, ignoring fields they do not use', () => {
    expect(parseMarkSeenAnswer({ kind: 'recorded', at: 1 })).toEqual({ kind: 'recorded' })
    expect(parseMarkSeenAnswer({ kind: 'stale' })).toEqual({ kind: 'stale' })
    expect(parseConfirmAnswer({ kind: 'accepted', version: 4 })).toEqual({ kind: 'accepted' })
    expect(parseConfirmAnswer({ kind: 'stale' })).toEqual({ kind: 'stale' })
  })

  it('refuse any other answer at its kind', () => {
    expect(refusedAt(() => parseMarkSeenAnswer({ kind: 'accepted' }))).toBe('kind')
    expect(refusedAt(() => parseMarkSeenAnswer(undefined))).toBe('(answer)')
    expect(refusedAt(() => parseConfirmAnswer({ kind: 'recorded' }))).toBe('kind')
    expect(refusedAt(() => parseConfirmAnswer('accepted'))).toBe('(answer)')
  })
})

describe('reportOncePerTopic', () => {
  it('passes on the first report of each topic, with its cause when there is one', () => {
    const warn = vi.fn()
    const report = reportOncePerTopic(warn)
    const cause = new Error('refused')
    report('due refused', 'first due refusal', cause)
    report('due refused', 'second due refusal', cause)
    report('due unreadable', 'first unreadable due')
    report('due unreadable', 'second unreadable due')
    report('kind', 'first kind')
    report('kind', 'second kind')
    report('confirm refused', 'first confirm refusal', cause)
    expect(warn.mock.calls).toEqual([
      ['first due refusal', cause], ['first unreadable due'], ['first kind'], ['first confirm refusal', cause],
    ])
  })
})

/** Wait for every queued promise reaction to run. */
const settled = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/**
 * The card the view shows, or nothing.
 * @param view - the store's view.
 * @returns `<kind>:<version>` with the agreement's state, or nothing.
 */
function card(view: OrgNoticeView): string | undefined {
  if (view.shown === undefined) return undefined
  return `${view.shown.kind}:${String(view.shown.version)}${view.confirming ? ' confirming' : ''}${view.failed ? ' failed' : ''}`
}

describe('createOrgNoticeStore', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows nothing until it asks, then the answer it gets, and tells subscribers', async () => {
    const fake = fakeOrgNoticePort([shownDue('notice', 2)])
    const store = createOrgNoticeStore(fake.port, vi.fn())
    const changed = vi.fn()
    const unsubscribe = store.subscribe(changed)
    expect(card(store.getSnapshot())).toBeUndefined()
    await store.refresh()
    expect(card(store.getSnapshot())).toBe('notice:2')
    expect(changed).toHaveBeenCalledTimes(1)
    unsubscribe()
    fake.answers = [{ kind: 'none' }]
    await store.refresh()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(card(store.getSnapshot())).toBeUndefined()
  })

  it('stays quiet when nothing is shown and nothing is due', async () => {
    const store = createOrgNoticeStore(fakeOrgNoticePort().port, vi.fn())
    const changed = vi.fn()
    store.subscribe(changed)
    await store.refresh()
    expect(changed).not.toHaveBeenCalled()
  })

  it('puts an acknowledged notice away for the page, records it as read, and shows a newer version', async () => {
    const fake = fakeOrgNoticePort([shownDue('notice', 2)])
    const store = createOrgNoticeStore(fake.port, vi.fn())
    await store.refresh()
    store.acknowledge()
    expect(card(store.getSnapshot())).toBeUndefined()
    expect(fake.markSeen).toHaveBeenCalledWith(2)
    await settled()
    // Recorded: nothing more is asked.
    expect(fake.due).toHaveBeenCalledTimes(1)
    // The plugin has not caught up yet: the same version stays put away.
    await store.refresh()
    expect(card(store.getSnapshot())).toBeUndefined()
    fake.answers = [shownDue('notice', 3)]
    await store.refresh()
    expect(card(store.getSnapshot())).toBe('notice:3')
  })

  it('asks again when the plugin answers that the notice it was told about is stale', async () => {
    const fake = fakeOrgNoticePort([shownDue('notice', 2), shownDue('notice', 3)])
    fake.markSeenStep = { kind: 'stale' }
    const store = createOrgNoticeStore(fake.port, vi.fn())
    await store.refresh()
    store.acknowledge()
    await settled()
    expect(fake.due).toHaveBeenCalledTimes(2)
    expect(card(store.getSnapshot())).toBe('notice:3')
  })

  it('reports a notice the plugin refused to record as read once, and keeps it away for the page', async () => {
    const warn = vi.fn()
    const fake = fakeOrgNoticePort([shownDue('notice', 2), shownDue('notice', 3)])
    fake.markSeenStep = { reject: CALLER_UNKNOWN }
    const store = createOrgNoticeStore(fake.port, reportOncePerTopic(warn))
    await store.refresh()
    store.acknowledge()
    await settled()
    await store.refresh()
    expect(card(store.getSnapshot())).toBe('notice:3')
    store.acknowledge()
    await settled()
    expect(warn.mock.calls).toEqual([['server-sidebar: the organization notice was not recorded as read:', CALLER_UNKNOWN]])
    expect(fake.due).toHaveBeenCalledTimes(2)
  })

  it('reports an answer to markSeen it cannot read once by its field, apart from a refusal', async () => {
    const warn = vi.fn()
    const fake = fakeOrgNoticePort([shownDue('notice', 2), shownDue('notice', 3), shownDue('notice', 4), shownDue('notice', 5)])
    fake.markSeenStep = { reject: CALLER_UNKNOWN }
    const store = createOrgNoticeStore(fake.port, reportOncePerTopic(warn))
    const acknowledgeNext = async (): Promise<void> => {
      await store.refresh()
      store.acknowledge()
      await settled()
    }
    await acknowledgeNext()
    fake.markSeenStep = { reject: new OrgNoticeAnswerError('kind') }
    await acknowledgeNext()
    await acknowledgeNext()
    fake.markSeenStep = { reject: CALLER_UNKNOWN }
    await acknowledgeNext()
    expect(fake.markSeen.mock.calls).toEqual([[2], [3], [4], [5]])
    expect(warn.mock.calls).toEqual([
      ['server-sidebar: the organization notice was not recorded as read:', CALLER_UNKNOWN],
      ['server-sidebar: the organization notice answer to markSeen() is unusable at kind'],
    ])
  })

  it('acknowledges only a notice, and defers only a disclosure to agree to', async () => {
    const fake = fakeOrgNoticePort([shownDue('consent', 4)])
    const store = createOrgNoticeStore(fake.port, vi.fn())
    store.acknowledge()
    store.later()
    await store.refresh()
    store.acknowledge()
    expect(card(store.getSnapshot())).toBe('consent:4')
    expect(fake.markSeen).not.toHaveBeenCalled()
    fake.answers = [shownDue('notice', 4)]
    await store.refresh()
    store.later()
    expect(card(store.getSnapshot())).toBe('notice:4')
  })

  it('defers a disclosure for the page without telling the plugin, and shows the same version as a notice', async () => {
    const fake = fakeOrgNoticePort([shownDue('consent', 4)])
    const store = createOrgNoticeStore(fake.port, vi.fn())
    await store.refresh()
    store.later()
    expect(card(store.getSnapshot())).toBeUndefined()
    await store.refresh()
    expect(card(store.getSnapshot())).toBeUndefined()
    expect(fake.confirm).not.toHaveBeenCalled()
    expect(fake.markSeen).not.toHaveBeenCalled()
    // A notice is a different card from an agreement, even for the same version.
    fake.answers = [shownDue('notice', 4)]
    await store.refresh()
    expect(card(store.getSnapshot())).toBe('notice:4')
  })

  it('shows a deferred disclosure again on a page that starts over', async () => {
    const fake = fakeOrgNoticePort([shownDue('consent', 4)])
    const first = createOrgNoticeStore(fake.port, vi.fn())
    await first.refresh()
    first.later()
    const reloaded = createOrgNoticeStore(fake.port, vi.fn())
    await reloaded.refresh()
    expect(card(reloaded.getSnapshot())).toBe('consent:4')
  })

  it('holds the card while an agreement travels, takes no second one and no deferral, and puts it away once accepted', async () => {
    const fake = fakeOrgNoticePort([shownDue('consent', 4)])
    fake.confirmStep = 'hold'
    const store = createOrgNoticeStore(fake.port, vi.fn())
    await store.refresh()
    const sent = store.consent()
    expect(card(store.getSnapshot())).toBe('consent:4 confirming')
    await store.consent()
    store.later()
    expect(fake.confirm).toHaveBeenCalledTimes(1)
    // An ask that answers the same card meanwhile keeps it confirming.
    await store.refresh()
    expect(card(store.getSnapshot())).toBe('consent:4 confirming')
    fake.release({ kind: 'accepted' })
    await sent
    expect(fake.confirm).toHaveBeenCalledWith(4)
    expect(card(store.getSnapshot())).toBeUndefined()
    await store.refresh()
    expect(card(store.getSnapshot())).toBeUndefined()
  })

  it('shows a refused agreement on its card without asking again, and clears the refusal on a retry', async () => {
    for (const refusal of [UNAVAILABLE, CALLER_UNKNOWN]) {
      const warn = vi.fn()
      const fake = fakeOrgNoticePort([shownDue('consent', 4)])
      fake.confirmStep = { reject: refusal }
      const store = createOrgNoticeStore(fake.port, reportOncePerTopic(warn))
      await store.refresh()
      await store.consent()
      expect(warn).toHaveBeenCalledWith('server-sidebar: the organization did not record the agreement:', refusal)
      expect(card(store.getSnapshot())).toBe('consent:4 failed')
      expect(fake.due).toHaveBeenCalledTimes(1)
      // A retry clears the refusal while it travels.
      fake.confirmStep = 'hold'
      const retry = store.consent()
      expect(card(store.getSnapshot())).toBe('consent:4 confirming')
      fake.release({ reject: refusal })
      await retry
      expect(card(store.getSnapshot())).toBe('consent:4 failed')
      // The same card keeps its refusal through an ask; another version starts clean.
      await store.refresh()
      expect(card(store.getSnapshot())).toBe('consent:4 failed')
      fake.answers = [shownDue('consent', 5)]
      await store.refresh()
      expect(card(store.getSnapshot())).toBe('consent:5')
    }
  })

  it('shows an agreement whose answer it cannot read as not recorded, and reports that once by its field, apart from a refusal', async () => {
    const warn = vi.fn()
    const fake = fakeOrgNoticePort([shownDue('consent', 4)])
    fake.confirmStep = { reject: UNAVAILABLE }
    const store = createOrgNoticeStore(fake.port, reportOncePerTopic(warn))
    await store.refresh()
    await store.consent()
    fake.confirmStep = { reject: new OrgNoticeAnswerError('kind') }
    await store.consent()
    expect(card(store.getSnapshot())).toBe('consent:4 failed')
    await store.consent()
    fake.confirmStep = { reject: CALLER_UNKNOWN }
    await store.consent()
    expect(fake.confirm).toHaveBeenCalledTimes(4)
    expect(warn.mock.calls).toEqual([
      ['server-sidebar: the organization did not record the agreement:', UNAVAILABLE],
      ['server-sidebar: the organization notice answer to confirm() is unusable at kind'],
    ])
  })

  it('asks again when the plugin answers that the agreement it was sent is stale', async () => {
    const fake = fakeOrgNoticePort([shownDue('consent', 4), shownDue('consent', 5)])
    fake.confirmStep = { kind: 'stale' }
    const store = createOrgNoticeStore(fake.port, vi.fn())
    await store.refresh()
    await store.consent()
    expect(fake.due).toHaveBeenCalledTimes(2)
    expect(card(store.getSnapshot())).toBe('consent:5')
  })

  it('leaves a stale agreement\'s card answerable again when the plugin still asks for the same version', async () => {
    const fake = fakeOrgNoticePort([shownDue('consent', 4)])
    fake.confirmStep = { kind: 'stale' }
    const store = createOrgNoticeStore(fake.port, vi.fn())
    await store.refresh()
    await store.consent()
    expect(card(store.getSnapshot())).toBe('consent:4')
  })

  it('leaves the view alone when an agreement settles after the card it was for is gone', async () => {
    for (const outcome of [{ kind: 'accepted' }, { kind: 'stale' }, { reject: UNAVAILABLE }] as const) {
      const fake = fakeOrgNoticePort([shownDue('consent', 4)])
      fake.confirmStep = 'hold'
      const store = createOrgNoticeStore(fake.port, vi.fn())
      await store.refresh()
      const sent = store.consent()
      fake.answers = [shownDue('consent', 5)]
      await store.refresh()
      expect(card(store.getSnapshot())).toBe('consent:5')
      fake.release(outcome)
      await sent
      expect({ outcome, card: card(store.getSnapshot()) }).toEqual({ outcome, card: 'consent:5' })
    }
  })

  it('shows nothing when the plugin refuses or answers what the page cannot read, reporting each once for the page and the unreadable answer by its field', async () => {
    const warn = vi.fn()
    const fake = fakeOrgNoticePort([
      shownDue('notice', 2), { reject: CALLER_UNKNOWN }, { reject: new OrgNoticeAnswerError('version') },
      { reject: CALLER_UNKNOWN }, { reject: new OrgNoticeAnswerError('disclosure') },
    ])
    const store = createOrgNoticeStore(fake.port, reportOncePerTopic(warn))
    await store.refresh()
    expect(card(store.getSnapshot())).toBe('notice:2')
    await store.refresh()
    expect(card(store.getSnapshot())).toBeUndefined()
    await store.refresh()
    await store.refresh()
    await store.refresh()
    expect(fake.due).toHaveBeenCalledTimes(5)
    expect(warn.mock.calls).toEqual([
      ['server-sidebar: the organization notice could not be read:', CALLER_UNKNOWN],
      ['server-sidebar: the organization notice answer to due() is unusable at version'],
    ])
  })

  it('keeps a card whose agreement is travelling when an ask fails meanwhile', async () => {
    const fake = fakeOrgNoticePort([shownDue('consent', 4)])
    fake.confirmStep = 'hold'
    const store = createOrgNoticeStore(fake.port, vi.fn())
    await store.refresh()
    const sent = store.consent()
    fake.answers = [{ reject: new Error('offline') }]
    await store.refresh()
    expect(card(store.getSnapshot())).toBe('consent:4 confirming')
    fake.release({ kind: 'accepted' })
    await sent
  })

  it('drops an answer to an earlier ask that arrives after a later one', async () => {
    const fake = fakeOrgNoticePort()
    let answerFirst: ((value: ReturnType<typeof shownDue>) => void) | undefined
    let refuseSecond: ((reason: unknown) => void) | undefined
    fake.due.mockImplementationOnce(() => new Promise((resolve) => { answerFirst = resolve }))
    fake.due.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuseSecond = reject }))
    const warn = vi.fn()
    const store = createOrgNoticeStore(fake.port, warn)
    const first = store.refresh()
    const second = store.refresh()
    fake.answers = [shownDue('notice', 9)]
    await store.refresh()
    expect(card(store.getSnapshot())).toBe('notice:9')
    answerFirst?.(shownDue('notice', 2))
    refuseSecond?.(new Error('late'))
    await Promise.all([first, second])
    expect(card(store.getSnapshot())).toBe('notice:9')
    expect(warn).not.toHaveBeenCalled()
  })

  it('leaves the card as it is on a wait, and asks again once the named delay has passed', async () => {
    vi.useFakeTimers()
    const fake = fakeOrgNoticePort([shownDue('notice', 2), { kind: 'pending', retryAfterMs: 2000 }, shownDue('notice', 3)])
    const store = createOrgNoticeStore(fake.port, vi.fn())
    await store.refresh()
    await store.refresh()
    expect(card(store.getSnapshot())).toBe('notice:2')
    await vi.advanceTimersByTimeAsync(1999)
    expect(fake.due).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.due).toHaveBeenCalledTimes(3)
    expect(card(store.getSnapshot())).toBe('notice:3')
  })

  it('cancels a scheduled ask when it asks sooner', async () => {
    vi.useFakeTimers()
    const fake = fakeOrgNoticePort([{ kind: 'pending', retryAfterMs: 2000 }, shownDue('notice', 3)])
    const store = createOrgNoticeStore(fake.port, vi.fn())
    await store.refresh()
    await store.refresh()
    expect(fake.due).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fake.due).toHaveBeenCalledTimes(2)
    expect(card(store.getSnapshot())).toBe('notice:3')
  })

  it('stops asking once disposed: no scheduled ask, no new ask, and no answer still on its way', async () => {
    vi.useFakeTimers()
    const fake = fakeOrgNoticePort([{ kind: 'pending', retryAfterMs: 2000 }])
    const store = createOrgNoticeStore(fake.port, vi.fn())
    await store.refresh()
    expect(vi.getTimerCount()).toBe(1)
    store.dispose()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    await store.refresh()
    expect(fake.due).toHaveBeenCalledTimes(1)

    const late = fakeOrgNoticePort()
    let answer: ((value: ReturnType<typeof shownDue>) => void) | undefined
    let refuse: ((reason: unknown) => void) | undefined
    late.due.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    late.due.mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject }))
    const warn = vi.fn()
    const answered = createOrgNoticeStore(late.port, warn)
    const pendingAnswer = answered.refresh()
    answered.dispose()
    answer?.(shownDue('notice', 2))
    await pendingAnswer
    expect(card(answered.getSnapshot())).toBeUndefined()
    const refused = createOrgNoticeStore(late.port, warn)
    const pendingRefusal = refused.refresh()
    refused.dispose()
    refuse?.(new Error('late'))
    await pendingRefusal
    expect(warn).not.toHaveBeenCalled()
  })
})
