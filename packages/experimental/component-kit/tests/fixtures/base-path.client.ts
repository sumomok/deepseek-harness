/**
 * The stand-in a spec mocks `data-page-settings.ts` with:
 * `vi.mock('../src/client/data-page-settings.ts', () => import('./fixtures/base-path.client.ts'))`.
 * Both reads answer whatever {@link basePathRead} holds, which a case replaces
 * to hold a block back or to refuse it the base path.
 */

/** The base path every block's requests go under unless a case answers otherwise. */
export const BASE_PATH = '/probe-base/'

/** What the base-path read answers with, per case. */
export const basePathRead: { answer: Promise<string> } = { answer: Promise.resolve(BASE_PATH) }

/**
 * The read a block waits on before it mounts.
 * @returns the case's answer.
 */
export function dataPageBasePathReady(): Promise<string> {
  return basePathRead.answer
}

/**
 * The read the row's browser half settles once.
 * @returns the case's answer.
 */
export function settleDataPageBasePath(): Promise<string> {
  return basePathRead.answer
}
