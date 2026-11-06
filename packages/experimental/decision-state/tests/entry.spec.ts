import { expect, it } from 'vitest'
import DecisionState, { Config, PROPOSE_OPEN_WORK } from '@deepseek-ai/dsh-experimental-decision-state'

it('exports the service as the package default with its config schema', () => {
  expect(typeof DecisionState).toBe('function')
  expect(DecisionState.Config).toBe(Config)
  expect(DecisionState.inject).toEqual(['sessionProjections', 'tools', 'systemPrompt'])
  expect(PROPOSE_OPEN_WORK).toBe('propose_open_work')
})

it('parses scopes and view bounds, and defaults an empty config', () => {
  const parsed = Config.parse({ scopes: { demo: { units: ['a', 'b'] } }, viewLimit: 5, viewBudget: 600 })
  expect(parsed.scopes.demo?.units).toEqual(['a', 'b'])
  expect(parsed.viewLimit).toBe(5)
  expect(parsed.viewBudget).toBe(600)
  const empty = Config.parse({})
  expect(empty.scopes).toEqual({})
  expect(empty.viewLimit).toBe(40)
  expect(empty.viewBudget).toBe(4000)
})
