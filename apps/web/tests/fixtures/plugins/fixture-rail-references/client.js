/**
 * A minimal prompt-reference owner: each click adds the next labeled reference
 * draft to the current Session's attachment row. The payload carries values
 * that no end-user surface may show.
 */
window.__ModuleLoader__.load({
  id: '@fixture/rail-references',
  factory(require) {
    const React = require('react')
    const { Button } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const LABELS = ['新增', '所属专题', '行 3', '列 4', '单独']
    let next = 0
    return {
      inject: ['slots', 'locale', 'conversation'],
      apply(ctx) {
        const labels = { point: 'Point' }
        ctx.effect(() => ctx.locale.register('fixtureRail', { en: labels, zh: labels }))
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left', id: 'fixture-rail-references', locale: 'fixtureRail',
        }, ({ inputActions, t }) => h(Button, {
          onClick: () => {
            const index = next++
            const label = LABELS[index % LABELS.length]
            const draft = ctx.conversation.createReferenceDraft({
              source: 'fixture-owner',
              label,
              resolve: () => Promise.resolve({ secret: `payload-e42-${index}`, index }),
              activate: () => { document.body.dataset.fixtureActivated = label },
            })
            inputActions.addAttachments([draft.id])
          },
        }, t('point'))))
      },
    }
  },
})
