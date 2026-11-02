/** Minimal concrete Session query for tests that exercise only corpus and point reads. */

import SessionQueryEngine from '@deepseek-ai/dsh-session-query'

/** Session query implementation whose search faces are intentionally unavailable. */
export class TestSessionQuery extends SessionQueryEngine {

  override searchMessages(): Promise<never> {
    throw new Error('this fake implements no message-granularity search')
  }
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}
