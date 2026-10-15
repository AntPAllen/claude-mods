import type { SessionMessage } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { findClaims, isVerification, verdictOf } from '../hooks/claims'

describe('findClaims', () => {
  test('flags the Wolverine/Dapr kind of claim', () => {
    const claims = findClaims('Unfortunately Wolverine does not support Dapr as a transport, so we need a custom bridge.')
    expect(claims.length).toBe(1)
    expect(claims[0]?.kind).toBe('unsupported')
  })

  test('flags version and knowledge claims', () => {
    expect(findClaims('The latest version of Next.js is 14.2.')[0]?.kind).toBe('version')
    expect(findClaims("As far as I know, there isn't a Rust client for it.")[0]?.kind).toBe('knowledge')
    expect(findClaims('There is no official Dapr integration for WolverineFx.')[0]?.kind).toBe('unsupported')
  })

  test('leaves alone the agent describing itself or the local code', () => {
    expect(findClaims("I can't run the tests in this environment.").length).toBe(0)
    expect(findClaims('This function does not support null input yet.').length).toBe(0)
    expect(findClaims('Does Wolverine support Dapr?').length).toBe(0)
  })

  test('ignores code blocks', () => {
    expect(findClaims('Here:\n```\n// not supported by the library\n```\nDone.').length).toBe(0)
  })
})

describe('isVerification', () => {
  test('counts live sources', () => {
    expect(isVerification('WebSearch', { query: 'wolverine dapr' })).toBe(true)
    expect(isVerification('mcp__Context7__query-docs', {})).toBe(true)
    expect(isVerification('Bash', { command: 'npm view next version' })).toBe(true)
    expect(isVerification('Bash', { command: 'curl -s https://api.nuget.org/v3-flatcontainer/wolverinefx/index.json' })).toBe(true)
    expect(isVerification('Read', { file_path: '/app/node_modules/next/package.json' })).toBe(true)
  })

  test('does not count ordinary work', () => {
    expect(isVerification('Bash', { command: 'npm test' })).toBe(false)
    expect(isVerification('Read', { file_path: '/app/src/index.ts' })).toBe(false)
  })
})

test('verdictOf reads the last line', () => {
  expect(verdictOf('...\nVERDICT: OUTDATED')).toBe('OUTDATED')
  expect(verdictOf('**VERDICT: confirmed**')).toBe('CONFIRMED')
  expect(verdictOf('no verdict')).toBe('UNCERTAIN')
})

const CLAIM = 'Wolverine does not support Dapr, so I wrote a custom adapter.'

function rows(withLookup: boolean): SessionMessage[] {
  return [
    { role: 'user', text: 'Wire Wolverine up to Dapr pub/sub', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: withLookup ? [{ tool_use_id: 't1', tool: 'WebSearch', input: { query: 'wolverine dapr' }, text: 'results' }] : [],
    },
    { role: 'assistant', text: CLAIM, toolUses: [] },
  ]
}

const STOP = {
  stop_hook_active: false,
  last_assistant_message: CLAIM,
  session_id: 's',
  transcript_path: '/tmp/t.jsonl',
  cwd: '/tmp',
} as const

test('nudge mode blocks the stop on an unverified claim', { options: { mode: 'nudge' } }, async ($, on) => {
  mock.store(on)
  on('session.messages', () => ({ value: rows(false) }))
  on('classic.Stop', () => ({}))
  const result = await $.classic.Stop(STOP)
  expect(result.block).toContain('Wolverine does not support Dapr')
})

test('a turn that looked it up is left alone', { options: { mode: 'nudge' } }, async ($, on) => {
  mock.store(on)
  on('session.messages', () => ({ value: rows(true) }))
  on('classic.Stop', () => ({}))
  const result = await $.classic.Stop(STOP)
  expect(result.block).toBeUndefined()
})

test('off mode never blocks', { options: { mode: 'off' } }, async ($, on) => {
  mock.store(on)
  on('session.messages', () => ({ value: rows(false) }))
  on('classic.Stop', () => ({}))
  const result = await $.classic.Stop(STOP)
  expect(result.block).toBeUndefined()
})

test('verify mode hands the claims to the checker instead of blocking', { options: { mode: 'verify' } }, async ($, on) => {
  mock.store(on)
  on('session.messages', () => ({ value: rows(false) }))
  on('classic.Stop', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  const spawned: Record<string, unknown>[] = []
  on('agent.spawn', (_$, e) => (spawned.push(e as unknown as Record<string, unknown>), { model: 'sonnet' }))

  const stop = await $.classic.Stop(STOP)
  expect(stop.block).toBeUndefined()
  expect(spawned.length).toBe(1)
  expect(String(spawned[0]?.subagent_type ?? spawned[0]?.subagentType)).toBe('premise-check:checker')
  expect(String(spawned[0]?.prompt)).toContain('Wolverine does not support Dapr')
})
