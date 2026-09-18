/**
 * `ctx.loginIdentity`: a name for the visitor this process is currently serving,
 * which nothing can read the visitor's token back out of.
 *
 * The token itself is held in one closure and handed to the two rows that spend
 * it; nothing else in the process may see it. What a row that has to remember
 * something per signed-in person needs is not the token but a name that is the
 * same for as long as one person is signed in and different afterwards, so this
 * service answers the token's SHA-256 digest and never the token.
 *
 * A digest rather than a claim out of the token: this package authenticates
 * nobody and reads no claim, so a name derived from the bytes it was handed is
 * the only one it can honestly give. The cost is that a renewed token is a new
 * name — the deployment's own renewal endpoint issues a different token for the
 * same person — and whoever remembers something under it asks again at the next
 * renewal.
 * @module @deepseek-ai/dsh-experimental-auth-gate/src/identity
 */

import { createHash } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { HeldCredential } from '@deepseek-ai/dsh-experimental-biz-backend'

declare module '@deepseek-ai/cordis' {
  interface Context {
    loginIdentity: LoginIdentityService
  }
}

/**
 * `ctx.loginIdentity`: who this process is serving, as an opaque name.
 *
 * Registered wherever this row is composed, whether or not a data backend is,
 * because the token route that fills it exists either way.
 */
export class LoginIdentityService extends Service {
  private readonly credential: HeldCredential

  /**
   * Create and install the service as `ctx.loginIdentity`.
   * @param ctx - Cordis context that owns the service.
   * @param credential - the process's own memory of the access token, by reference.
   */
  constructor(ctx: Context, credential: HeldCredential) {
    super(ctx, 'loginIdentity')
    this.credential = credential
  }

  /**
   * The name of the login this process holds right now.
   *
   * Recomputed per call rather than cached, so a sign-out, a newly posted token
   * and a renewal are all visible to the next caller without anything here
   * having to be told about them.
   * @returns the SHA-256 digest of the held token, in lower-case hexadecimal, or
   *   `undefined` while no token is held — which is every state in which nobody
   *   is signed in, sign-out included.
   */
  current(): string | undefined {
    const token = this.credential.read()
    return token === undefined ? undefined : createHash('sha256').update(token).digest('hex')
  }
}
