/**
 * Host half of the organization fixture: the `sumomokOrgNotice` Remote the
 * console sidebar's notice card reads, answered from in-memory state instead
 * of an organization backend. The answers follow the organization plugin's
 * rules for one member: under `organization` acceptance a version the member
 * has not seen is a one-time notice, under `member` acceptance a version the
 * member has not agreed to asks for agreement, and a write naming a version
 * other than the current one answers `stale`. A test drives the state through
 * `ctx.get('sumomokOrgNotice').state`, in the same process as the Host.
 */

const NAMESPACE = 'sumomokOrgNotice'

/**
 * The disclosure text of one version.
 * @param {number} version - the version.
 * @returns the text the card shows.
 */
function disclosure(version) {
  return {
    version,
    title: { zh: `数据说明（第 ${version} 版）`, en: `About the data we collect (version ${version})` },
    body: { zh: '组织会收到这台控制台的运行情况。\n不包括你输入的内容。', en: 'Your organization receives how this console runs.\nWhat you type is not included.' },
    categories: [{ id: 'usage', label: { zh: '使用情况', en: 'Usage' } }],
    retentionDays: 30,
    viewers: 'self_and_admins',
    acceptance: 'organization',
    contact: 'privacy@example.test',
    policyUrl: 'https://example.test/policy',
  }
}

/** Mount the in-memory notice Remote. */
export function apply(ctx) {
  // `asked`, `seenCalls`, and `confirmCalls` count the calls each method received.
  const state = { acceptance: 'organization', version: 1, seen: 0, agreed: 0, asked: 0, seenCalls: 0, confirmCalls: 0 }
  const service = {
    state,
    async due() {
      state.asked += 1
      if (state.acceptance === 'member') {
        if (state.agreed >= state.version) return { kind: 'none' }
        return { kind: 'consent', version: state.version, orgName: 'Acme', disclosure: disclosure(state.version) }
      }
      if (state.seen >= state.version) return { kind: 'none' }
      return { kind: 'notice', version: state.version, orgName: 'Acme', disclosure: disclosure(state.version) }
    },
    async markSeen(version) {
      state.seenCalls += 1
      if (version > state.version) return { kind: 'stale' }
      state.seen = Math.max(state.seen, version)
      return { kind: 'recorded' }
    },
    async confirm(version) {
      state.confirmCalls += 1
      if (state.acceptance !== 'member' || version !== state.version) return { kind: 'stale' }
      state.agreed = Math.max(state.agreed, version)
      state.seen = Math.max(state.seen, version)
      return { kind: 'accepted', version }
    },
  }
  service.typertRemote = Object.freeze({ service, serviceKey: NAMESPACE, namespace: NAMESPACE })
  ctx.provide(NAMESPACE, service)
}
