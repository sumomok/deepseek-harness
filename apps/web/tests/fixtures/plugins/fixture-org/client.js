/**
 * Browser half of the organization fixture: the Settings section registered
 * under the id the console sidebar's identity menu opens (`sumomok-org`), and
 * the notice Remote mounted under `sumomokOrgNotice`, mirroring `typert.js`.
 */
window.__ModuleLoader__.load({
  id: '@fixture/org',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const strict = typeSymbol => ({ mode: 'strict', typeSymbol, create: () => ({ parse: value => value }) })
    const version = { name: 'version', wire: 'version', source: 'json', codec: strict('@fixture/org#DisclosureVersion') }
    const descriptor = (method, parameters) => ({
      id: `@fixture/org#sumomokOrgNotice/${method}`,
      service: 'sumomokOrgNotice',
      namespace: 'sumomokOrgNotice',
      method,
      invocation: { kind: 'direct' },
      parameters,
      result: strict(`@fixture/org#${method}Answer`),
    })
    const contribution = {
      package: '@fixture/org',
      descriptors: [descriptor('due', []), descriptor('markSeen', [version]), descriptor('confirm', [version])],
    }
    return {
      inject: ['slots', 'locale', 'remote'],
      async apply(ctx) {
        const labels = { body: 'Organization fixture section' }
        ctx.effect(() => ctx.locale.register('fixtureOrg', { en: labels, zh: labels }))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'sumomok-org', label: 'Organization', locale: 'fixtureOrg',
        }, ({ t }) => h('section', { 'data-fixture-org-section': '' }, t('body'))))
        const unmount = await ctx.remote.$mount(contribution)
        ctx.effect(() => () => { void unmount() })
      },
    }
  },
})
