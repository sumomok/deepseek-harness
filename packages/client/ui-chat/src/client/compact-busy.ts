/**
 * Composer refusal for a bare `/compact` addressed to a Session whose Turn is
 * running. The Host rejects manual compaction unless the agent is idle, so the
 * refusal happens before `command.execute` and names the reason in the
 * composer where the command was typed.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Decorate the Host `compact` command for as long as `commandUi` is composed.
 * While the addressed Session reports `running`, a bare menu pick or Enter
 * consumes the typed token, executes nothing, and shows `notice()` as an
 * error notice in that Session's composer. A bare invocation in an idle
 * Session reaches the Host command unchanged, including while the Host runs
 * maintenance that does not report `running`; the Host then answers with its
 * own command card. The decoration never sees an argued `/compact …` line.
 * @param ctx - client root context that owns the decoration effect.
 * @param sessions - Session registry read for the running flag and the composer scope.
 * @param notice - localized refusal text, read on each refusal.
 */
export function registerCompactBusyNotice(ctx: Context, sessions: ISessions, notice: () => string): void {
  const running = (sessionId: SessionId): boolean =>
    sessions.binding(sessionId)?.session.getSnapshot().running === true
  ctx.inject(['commandUi'], (scope) => {
    scope.effect(() => scope.commandUi.decorate({
      name: 'compact',
      available: session => running(session.sessionId),
      ui: {
        kind: 'action',
        run: (session) => {
          const actx = sessions.scope(session.sessionId)
          const conversation = actx?.get('conversation')
          if (actx !== undefined && conversation !== undefined) conversation.input.for(actx).notify('error', notice())
        },
      },
    }), 'ui-chat: /compact running-turn refusal')
  })
}
