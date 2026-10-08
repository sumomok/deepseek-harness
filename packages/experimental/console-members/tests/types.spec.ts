import type { Context } from '@deepseek-ai/cordis'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type * as Root from '@deepseek-ai/dsh-experimental-console-members'
import type { ConsoleMemberDirectory, CustomerCredentialReader, MemberStore, PrincipalKey } from '@deepseek-ai/dsh-experimental-console-members/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expectTypeOf, it } from 'vitest'

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

  it('re-exports every type of the types entry from the package root', () => {
    expectTypeOf<Root.PrincipalKey>().toEqualTypeOf<PrincipalKey>()
    expectTypeOf<Root.ConsoleMemberDirectory>().toEqualTypeOf<ConsoleMemberDirectory>()
    expectTypeOf<Root.MemberStore>().toEqualTypeOf<MemberStore>()
    expectTypeOf<Root.CustomerCredentialReader>().toEqualTypeOf<CustomerCredentialReader>()
  })
})
