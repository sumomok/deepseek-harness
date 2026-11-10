/** Public headless profile coverage for Team model selection and completed-prefix forks. */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { isolatedSkillRootEnv, resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

const dshBinScript = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const fixturePlugin = pathToFileURL(fileURLToPath(
  new URL('./profiles/headless/tests/fixtures/team-model-llm.mjs', import.meta.url),
)).href

interface SessionRecord {
  type: string
  id?: string
  parentSession?: string
  isSeeded?: boolean
  data?: {
    turn?: number
    name?: string
    arguments?: string
    provider?: string
    model?: string
    reasoningEffort?: string
    content?: { type: string; text?: string }[]
    header?: { config: { provider: string; model: string; reasoningEffort?: string } }
    message?: { isError?: boolean; content: { type: string; text?: string }[] }
    [key: string]: unknown
  }
}

interface CapturedRequest {
  identity: string
  provider: string
  model: string
  reasoningEffort: string
  messages: { role: string; content: { type: string; text?: string }[] }[]
  tools: ToolSchema[]
}

function records<T>(content: string): T[] {
  return content.split('\n').filter(Boolean).map(line => JSON.parse(line) as T)
}

function hasUserMessage(log: SessionRecord[], text: string): boolean {
  return log.some(record => record.type === 'user/message'
    && record.data?.content?.some(block => block.type === 'text' && block.text === text))
}

function requestText(request: CapturedRequest): string[] {
  return request.messages.flatMap(message => message.content
    .flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []))
}

async function sessionLogs(root: string): Promise<SessionRecord[][]> {
  const paths = (await readdir(root, { recursive: true })).filter(path => path.endsWith('.jsonl'))
  return Promise.all(paths.map(async path => records<SessionRecord>(await readFile(join(root, path), 'utf8'))))
}

describe('dsh headless Team model selection', () => {
  it('runs fresh and completed-prefix fork children on selected routes and retries rejected names', {
    timeout: 195_000,
    retry: 0,
  }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-team-models-'))
    try {
      const home = join(cwd, '.dsh')
      const sessions = join(home, 'sessions')
      const capturePath = join(cwd, 'model-requests.jsonl')
      const profileDir = join(home, 'profiles', 'headless')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-headless',
        private: true,
        dependencies: {
          '@deepseek-ai/dsh-experimental-agent-team': 'workspace:^',
          '@deepseek-ai/dsh-experimental-tool-agent-team': 'workspace:^',
          '@deepseek-ai/dsh-tool-subagent': 'workspace:^',
        },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
      }, undefined, 2) + '\n')
      await writeFile(join(profileDir, 'cordis.patch.yml'), [
        '- id: llm-deepseek',
        '  disabled: true',
        '- id: llm-deepseek-account',
        '  disabled: true',
        '- id: session-title-llm',
        '  disabled: true',
        '- id: agent-default-model',
        '  config:',
        '    provider: team-model-a',
        '    model: model-a',
        '- id: session-persistence-jsonl',
        '  config:',
        `    root: ${JSON.stringify(sessions)}`,
        '    compression: none',
        '- id: tool-subagent-control',
        '  disabled: true',
        '- id: tool-subagent',
        '  disabled: true',
        '- id: tool-subagent-fork',
        '  disabled: true',
        '- id: subagent-model-selection-settings',
        '  config:',
        '    enabled: true',
        '    allowedModels:',
        '      - { provider: team-model-a, model: model-a }',
        '      - { provider: team-model-b, model: model-b }',
        '- insert:',
        '    - id: team-model-fixture-llm',
        `      name: ${JSON.stringify(fixturePlugin)}`,
        '      config:',
        `        capturePath: ${JSON.stringify(capturePath)}`,
        '    - id: agent-team',
        "      name: '@deepseek-ai/dsh-experimental-agent-team'",
        '    - id: tool-agent-team',
        "      name: '@deepseek-ai/dsh-experimental-tool-agent-team'",
        '      config:',
        '        modelSelection: true',
        '        modelDiscovery: true',
        '',
      ].join('\n'))
      async function run(args: string[]): Promise<string> {
        const launch = resolveExampleLaunch({
          srcBin: dshBinScript,
          configArgs: ['--profile', 'headless', ...args],
          tsconfigPath,
          env: {
            ...isolatedSkillRootEnv(cwd, { dshHome: home }),
            DSH_TELEMETRY_DISABLED: '1',
            DEEPSEEK_API_KEY: '',
            NODE_OPTIONS: [
              process.env.NODE_OPTIONS,
              '--disable-warning=ExperimentalWarning',
              '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
            ].filter(Boolean).join(' '),
          },
        })
        const result = await execa(launch.command, launch.args, {
          cwd,
          env: launch.env,
          input: '',
          timeout: 90_000,
          killSignal: 'SIGKILL',
          reject: false,
        })
        expect(result.timedOut, result.stderr).toBe(false)
        expect(result.signal, result.stderr).toBeUndefined()
        expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0)
        expect(result.stderr).toBe('')
        return result.stdout
      }

      expect(await run(['TEAM_MODEL_SEED'])).toContain('TEAM_MODEL_HISTORY_A')
      const initialLogs = await sessionLogs(sessions)
      expect(initialLogs).toHaveLength(1)
      const parentId = initialLogs[0]![0]!.id!
      expect(initialLogs[0]!.filter(record => record.type === 'turn/end')).toHaveLength(1)
      expect(initialLogs[0]!.find(record => record.type === 'subagent/model-selection-policy')?.data)
        .toEqual({ allowedModels: [
          { provider: 'team-model-a', model: 'model-a' },
          { provider: 'team-model-b', model: 'model-b' },
        ] })
      expect(await run(['--session-id', parentId, 'TEAM_MODEL_DELEGATE'])).toContain('TEAM_MODEL_SELECTION_OK')

      const logs = await sessionLogs(sessions)
      expect(logs).toHaveLength(4)
      const parent = logs.find(log => log[0]?.id === parentId)!
      const fresh = logs.find(log => hasUserMessage(log, 'TEAM_MODEL_FRESH'))!
      const fork = logs.find(log => hasUserMessage(log, 'TEAM_MODEL_FORK'))!
      const inherited = logs.find(log => hasUserMessage(log, 'TEAM_MODEL_INHERITED'))!
      expect(fresh[0]).toMatchObject({ parentSession: parentId, isSeeded: false })
      expect(fork[0]).toMatchObject({ parentSession: parentId, isSeeded: true })
      expect(inherited[0]).toMatchObject({ parentSession: parentId, isSeeded: false })
      expect(hasUserMessage(fresh, 'TEAM_MODEL_SEED')).toBe(false)
      expect(hasUserMessage(fork, 'TEAM_MODEL_SEED')).toBe(true)
      expect(hasUserMessage(fork, 'TEAM_MODEL_DELEGATE')).toBe(false)
      expect(fork.some(record => record.type === 'session/end-seed')).toBe(true)
      expect(fresh.find(record => record.type === 'subagent/descriptor')?.data).toMatchObject({ provider: 'spawn' })
      expect(fork.find(record => record.type === 'subagent/descriptor')?.data).toMatchObject({ provider: 'fork' })

      for (const [log, provider, model, effort, contextWindow] of [
        [fresh, 'team-model-b', 'model-b', 'low', 131072],
        [fork, 'team-model-b', 'model-b', 'high', 131072],
        [inherited, 'team-model-a', 'model-a', 'parent-only', 262144],
      ] as const) {
        const request = log.findLast(record => record.type === 'request/header')
        expect(request?.data?.header?.config).toMatchObject({ provider, model, reasoningEffort: effort })
        expect(log.findLast(record => record.type === 'request/context')?.data)
          .toMatchObject({ provider, model, contextWindow })
      }

      const attempts = parent.filter(record => record.type === 'tool/call' && record.data?.name === 'spawn_teammate')
      expect(attempts).toHaveLength(6)
      expect(attempts.slice(0, 4).map(record => (JSON.parse(record.data!.arguments!) as { name: string }).name))
        .toEqual(['retry-fresh', 'retry-fresh', 'retry-fresh', 'retry-fresh'])
      const errors = parent.filter(record => record.type === 'tool/result' && record.data?.message?.isError)
        .map(record => record.data!.message!.content.map(block => block.text).join('\n'))
      expect(errors, JSON.stringify(errors)).toHaveLength(3)
      expect(errors[0]).toContain('`provider` and `model` must be supplied together')
      expect(errors[1]).toContain('team-model-b/blocked-model" is not allowed')
      expect(errors[2]).toContain('parent-only')

      const requests = records<CapturedRequest>(await readFile(capturePath, 'utf8'))
      const leadRequests = requests.filter(request => request.identity.startsWith('You are the Team Lead'))
      expect(leadRequests.length).toBeGreaterThan(1)
      expect(leadRequests.every(request => request.provider === 'team-model-a'
        && request.model === 'model-a' && request.reasoningEffort === 'parent-only')).toBe(true)
      for (const [name, provider, model, effort, history] of [
        ['retry-fresh', 'team-model-b', 'model-b', 'low', false],
        ['selected-fork', 'team-model-b', 'model-b', 'high', true],
        ['inherited', 'team-model-a', 'model-a', 'parent-only', false],
      ] as const) {
        const childRequests = requests.filter(request => request.identity.startsWith(`You are teammate "${name}".`))
        expect(childRequests).toHaveLength(1)
        expect(childRequests[0]).toMatchObject({ provider, model, reasoningEffort: effort })
        expect(requestText(childRequests[0]!).includes('TEAM_MODEL_HISTORY_A')).toBe(history)
        expect(requestText(childRequests[0]!)).not.toContain('TEAM_MODEL_DELEGATE')
        expect(childRequests[0]!.tools.filter(tool => tool.name === 'list_subagent_models')).toHaveLength(1)
      }
      const toolResults = parent.filter(record => record.type === 'tool/result')
        .map(record => record.data?.message?.content.map(block => block.text).join('\n'))
      expect(toolResults).toContain('team-model-a — team-model-a\nteam-model-b — team-model-b')
      expect(toolResults).toContain('team-model-b/model-b — model-b')
      expect(toolResults).toContain('team-model-b/model-b — model-b\nReasoning efforts:\nlow (default) — low\nhigh — high')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
