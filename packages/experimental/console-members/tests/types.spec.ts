import type { Context } from '@deepseek-ai/cordis'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expectTypeOf, it } from 'vitest'
import type { ConsoleMemberDirectory, PrincipalKey } from '../src/index.ts'

describe('console member directory types', () => {
  it('names the directory on the Cordis context as consoleMembers', () => {
    expectTypeOf<Context['consoleMembers']>().toEqualTypeOf<ConsoleMemberDirectory>()
  })

  it('keeps a principal key distinct from a Session id', () => {
    const principal = brandString<PrincipalKey>('login-uid')

    expectTypeOf(principal).toEqualTypeOf<Branded<'PrincipalKey'>>()
    expectTypeOf(principal).not.toEqualTypeOf<SessionId>()
    expectTypeOf<ConsoleMemberDirectory['principalOfSession']>().parameter(0).toEqualTypeOf<SessionId>()
    expectTypeOf<ConsoleMemberDirectory['principalOfSession']>().returns.toEqualTypeOf<PrincipalKey | undefined>()
  })
})
