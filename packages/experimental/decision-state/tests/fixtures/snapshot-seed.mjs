/** Record one host decision before the first turn so the snapshot proves the constant survives a rewrite. */
export const name = 'decision-state-seed'
export const inject = ['decisionState']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    ctx.decisionState.record(agent, {
      scope: 'demo',
      decisions: [{ decisionId: 'd1', unitIds: ['a'], disposition: 'existing', targetIds: ['#1'], sourceEventSeqs: [1] }],
      supersedes: [],
    })
  })
}
