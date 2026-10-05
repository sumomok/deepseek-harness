/**
 * Test-only organization notice port and the disclosure answers it hands out.
 * A test queues what `due()` answers (an answer or a refusal, in order; the
 * last one repeats), decides how `markSeen` and `confirm` settle (an answer
 * or a refusal, and for `confirm` also held until released), and reads every
 * call made.
 */

import { vi, type Mock } from 'vitest'
import type {
  ConfirmAnswer, DisclosureText, MarkSeenAnswer, OrgNoticeDue, OrgNoticePort, ShownDue,
} from '../../src/client/org-notice.ts'

/** A disclosure text whose every field is set. */
export const DISCLOSURE: DisclosureText = {
  title: { zh: '数据收集说明', en: 'About the data we collect' },
  body: { zh: '我们会收集运行情况。\n第二行。', en: 'We collect how the console runs.\nSecond line.' },
  categories: [
    { id: 'usage', label: { zh: '使用情况', en: 'Usage' } },
    { id: 'errors', label: { zh: '运行出错信息', en: 'Errors' } },
  ],
  retentionDays: 30,
  viewers: 'self_and_admins',
  contact: 'privacy@example.test',
  policyUrl: 'https://example.test/policy',
}

/**
 * A due answer that shows a card.
 * @param kind - a one-time notice or a disclosure to agree to.
 * @param version - the version it shows.
 * @param extra - fields to add or replace.
 * @returns the answer.
 */
export function shownDue(kind: ShownDue['kind'], version: number, extra: Partial<ShownDue> = {}): ShownDue {
  return { kind, version, orgName: 'Acme', disclosure: DISCLOSURE, ...extra }
}

/** A refusal one call settles with. */
export interface Refused {
  reject: unknown
}

/** How one queued `due()` call settles. */
export type DueStep = OrgNoticeDue | Refused

/** A refusal the plugin answers with when it cannot tell which member called. */
export const CALLER_UNKNOWN = Object.assign(new Error('the caller is not a member'), { code: 'sumomokOrg/caller-unknown' })

/** A refusal `confirm` answers with when the organization cannot be reached. */
export const UNAVAILABLE = Object.assign(new Error('the organization is unreachable'), { code: 'sumomokOrg/unavailable' })

/** The programmable port and its controls. */
export interface FakeOrgNoticePort {
  port: OrgNoticePort
  /** Answers `due()` hands out in order; the last one repeats. */
  answers: DueStep[]
  /** How every later `markSeen` settles. */
  markSeenStep: MarkSeenAnswer | Refused
  /** How every later `confirm` settles; `hold` waits for {@link FakeOrgNoticePort.release}. */
  confirmStep: ConfirmAnswer | Refused | 'hold'
  /** Settle the held `confirm` with an answer or a refusal. */
  release(step: ConfirmAnswer | Refused): void
  due: Mock<() => Promise<OrgNoticeDue>>
  markSeen: Mock<(version: number) => Promise<MarkSeenAnswer>>
  confirm: Mock<(version: number) => Promise<ConfirmAnswer>>
}

/**
 * Settle one call.
 * @param step - the answer or the refusal.
 * @returns the call's promise.
 */
function settle<A>(step: A | Refused): Promise<A> {
  return typeof step === 'object' && step !== null && 'reject' in step ? Promise.reject(step.reject) : Promise.resolve(step)
}

/**
 * Create a port that answers from its queue.
 * @param answers - the first answers `due()` hands out.
 * @returns the port and its controls.
 */
export function fakeOrgNoticePort(answers: DueStep[] = [{ kind: 'none' }]): FakeOrgNoticePort {
  let held: ((step: ConfirmAnswer | Refused) => void) | undefined
  const fake: FakeOrgNoticePort = {
    answers,
    markSeenStep: { kind: 'recorded' },
    confirmStep: { kind: 'accepted' },
    release: (step) => { held?.(step) },
    due: vi.fn((): Promise<OrgNoticeDue> => {
      const step = fake.answers.length > 1 ? fake.answers.shift() : fake.answers[0]
      return settle<OrgNoticeDue>(step ?? { kind: 'none' })
    }),
    markSeen: vi.fn((_version: number) => settle<MarkSeenAnswer>(fake.markSeenStep)),
    confirm: vi.fn((_version: number): Promise<ConfirmAnswer> => {
      const step = fake.confirmStep
      if (step !== 'hold') return settle<ConfirmAnswer>(step)
      return new Promise<ConfirmAnswer>((resolve, reject) => {
        held = (outcome) => {
          if ('reject' in outcome) reject(outcome.reject)
          else resolve(outcome)
        }
      })
    }),
    port: {
      due: () => fake.due(),
      markSeen: version => fake.markSeen(version),
      confirm: version => fake.confirm(version),
    },
  }
  return fake
}
