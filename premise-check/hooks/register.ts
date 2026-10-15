import type { EngineInterface, Register, SessionMessage } from 'claude-code'
import { type Claim, findClaims, fingerprint, isVerification, verdictOf } from './claims'

type Mode = 'escalate' | 'nudge' | 'verify' | 'off'
const MODES: readonly Mode[] = ['escalate', 'nudge', 'verify', 'off']
const CHECKER = 'premise-check:checker'

const FRESHNESS = `# Library knowledge freshness

What you know about third-party libraries, frameworks, SDKs, CLIs and hosted services comes from training data with a cutoff, and releases ship fast: integrations get added, APIs change, limits get lifted. Treat that knowledge as possibly stale.

Before you (a) tell the user something cannot be done, is unsupported, or does not exist, (b) state which version is latest or what a version contains, or (c) build a workaround for a feature you believe is missing, check a current source first: Context7 or other docs tools, the package registry, the project's release notes or changelog, or the installed package's source. Say which version you checked. Mind the version the project actually pins as well as the latest one. If you cannot check, say plainly that the claim comes from training data and may be out of date.`

const CHECKER_PROMPT = `You fact-check claims another AI agent made about third-party software (libraries, frameworks, SDKs, CLIs, hosted services) from possibly stale training data. Assume the claims may be outdated: newer releases often add the capability that was said to be missing.

For each claim:
1. Identify the software and what is claimed.
2. Find the current truth from live sources, newest first: the package registry (npm https://registry.npmjs.org/<pkg>/latest, NuGet https://api.nuget.org/v3-flatcontainer/<id-lowercase>/index.json, PyPI https://pypi.org/pypi/<pkg>/json, crates.io https://crates.io/api/v1/crates/<name>, Go https://proxy.golang.org/<module>/@v/list, RubyGems https://rubygems.org/api/v1/versions/<gem>/latest.json), GitHub releases and changelogs, official docs (Context7 tools if available), and web search. Look for integrations shipped as separate packages too (e.g. "<Lib>.<Other>" or "<lib>-<other>").
3. If the working directory is a project, check which version it pins (package.json, *.csproj, Directory.Packages.props, pyproject.toml, Cargo.toml, go.mod, ...), since a capability may exist only in a newer version than the one pinned.

Do not edit files. Be brief and concrete: versions, package names, links.

End your answer with exactly one line:
VERDICT: OUTDATED   (at least one claim is wrong or outdated for the current release)
VERDICT: CONFIRMED  (every claim still holds for the current release)
VERDICT: UNCERTAIN  (you could not establish it either way)`

type Turn = { texts: string[]; isVerified: boolean; prompt: string }

/** The main conversation's current turn: its assistant text, whether it checked a live source, and the prompt that began it. */
function currentTurn(messages: readonly SessionMessage[]): Turn {
  const texts: string[] = []
  let isVerified = false
  let prompt = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m === undefined) continue
    if (m.role === 'user') {
      if (m.toolResults === undefined || m.toolResults.length === 0) {
        if (m.text.trim() !== '') {
          prompt = m.text
          break
        }
      }
      continue
    }
    if (m.text.trim() !== '') texts.unshift(m.text)
    if (m.toolUses.some(u => isVerification(u.tool, u.input))) isVerified = true
  }
  return { texts, isVerified, prompt }
}

function listed(claims: readonly Claim[]): string {
  return claims.map(c => `- (${c.kind}) "${c.sentence}"`).join('\n')
}

function nudgeText(claims: readonly Claim[]): string {
  return `[premise-check] Before finishing, verify these statements against current sources. They read as coming from training data, which may predate recent releases:

${listed(claims)}

Check the package registry, release notes/changelog, current docs (Context7 if available) or the installed package source, for both the latest release and the version this project pins. If a statement still holds, say which version you checked. If it is outdated, correct your answer and any code built around it. If a statement is about this project's own code rather than an external dependency, ignore it.`
}

function checkerTask(claims: readonly Claim[], turn: Turn): string {
  return `The user asked:
"""
${turn.prompt.slice(0, 2000)}
"""

The agent stated, without checking a live source:
${listed(claims)}

Today's date matters: check what the newest releases say, not what you remember.`
}

type Settings = { defaultMode: Mode; checkerModel: string | undefined }

// Module state: a reload drops it, which costs at most one repeated check.
const settings: Settings = { defaultMode: 'escalate', checkerModel: undefined }
let lastFlagged = ''
let nudged: Claim[] | undefined
const pending = new Map<string, Claim[]>()

async function modeOf($: EngineInterface): Promise<Mode> {
  const stored = await $.store.get('mode')
  return MODES.includes(stored as Mode) ? (stored as Mode) : settings.defaultMode
}

async function spawnChecker($: EngineInterface, claims: Claim[], turn: Turn): Promise<string | undefined> {
  const spawned = await $.agent.spawn({
    subagentType: CHECKER,
    description: `Check ${claims.length} library claim${claims.length === 1 ? '' : 's'}`,
    prompt: checkerTask(claims, turn),
    ...(settings.checkerModel !== undefined ? { model: settings.checkerModel } : {}),
  })
  if (spawned.agentId === undefined) {
    $.ui.toast(`premise-check: checker not started${spawned.deny !== undefined ? `: ${spawned.deny}` : ''}`)
    return undefined
  }
  pending.set(spawned.agentId, claims)
  $.ui.status(`premise-check: verifying ${claims.length} claim${claims.length === 1 ? '' : 's'}…`)
  return spawned.agentId
}

export const register: Register = (on, options) => {
  settings.defaultMode = MODES.includes(options.mode as Mode) ? (options.mode as Mode) : 'escalate'
  settings.checkerModel = typeof options.checkerModel === 'string' && options.checkerModel !== '' ? options.checkerModel : undefined

  on('session.start', async ($, e, next) => {
    await $.agent.register({
      name: 'checker',
      description: 'Verifies claims about third-party software against current registries, release notes and docs.',
      prompt: CHECKER_PROMPT,
      disallowedTools: ['Write', 'Edit', 'NotebookEdit', 'Agent'],
      omitClaudeMd: true,
    })
    await $.command.register({
      name: 'premise-check',
      description: 'Check library/framework claims against current sources, or set how premise-check reacts.',
      argumentHint: '[now | escalate | nudge | verify | off | status]',
    })
    return next(e)
  })

  // The checker is this mod's own; the main agent gets the system-prompt rule instead.
  on('agent.offer', { agent: CHECKER }, () => ({ isOffered: false }))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (e.traits.includes('bare') || e.traits.includes('analysis')) return composed
    return { ...composed, sections: [...composed.sections, { id: 'premise-check:freshness', text: FRESHNESS, scope: 'session' }] }
  })

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (result.block !== undefined) return result
    const mode = await modeOf($)
    if (mode === 'off') return result

    const turn = currentTurn(await $.session.messages())

    // Re-prompted by our own nudge: escalate if the agent still did not look anything up.
    if (e.stop_hook_active) {
      const claims = nudged
      nudged = undefined
      if (claims !== undefined && mode === 'escalate' && !turn.isVerified) await spawnChecker($, claims, turn)
      return result
    }

    const answer = turn.texts.length > 0 ? turn.texts.join('\n\n') : (e.last_assistant_message ?? '')
    const claims = findClaims(answer)
    if (claims.length === 0 || turn.isVerified) return result
    const print = fingerprint(claims)
    if (print === lastFlagged) return result
    lastFlagged = print

    if (mode === 'verify') {
      await spawnChecker($, claims, turn)
      return result
    }
    nudged = claims
    $.ui.toast(`premise-check: asking for a re-check of ${claims.length} unverified claim${claims.length === 1 ? '' : 's'}`)
    return { ...result, block: nudgeText(claims) }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const claims = e.agentId === undefined ? undefined : pending.get(e.agentId)
    if (e.agentId === undefined || claims === undefined) return result
    pending.delete(e.agentId)
    $.ui.status(undefined)

    if (e.reason !== 'answer') {
      $.ui.toast('premise-check: the checker did not finish')
      return result
    }
    const verdict = verdictOf(e.answer)
    if (verdict === 'CONFIRMED') {
      $.ui.toast('premise-check: claims hold for the current releases')
    } else if (verdict === 'OUTDATED') {
      $.ui.toast('premise-check: an earlier claim looks outdated, telling the agent')
      await $.prompt.submit({
        text: `[premise-check] An independent check found that something you told the user earlier is outdated or wrong for current releases.

Your statements:
${listed(claims)}

Checker's findings:
${e.answer.trim()}

Re-evaluate with this in mind, tell the user what changed, and revise any code or plan built on the old premise.`,
      })
    } else {
      $.ui.toast('premise-check: could not confirm the claims either way, see the checker\'s report')
    }
    return result
  })

  on('command.run', { command: 'premise-check' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (MODES.includes(arg as Mode)) {
      await $.store.set('mode', arg)
      return { text: `premise-check mode: ${arg}` }
    }
    if (arg === '' || arg === 'status') {
      return {
        text: `premise-check mode: ${await modeOf($)} (default ${settings.defaultMode}). Checks running: ${pending.size}.\nUsage: /premise-check now | escalate | nudge | verify | off`,
      }
    }
    if (arg === 'now') {
      const turn = currentTurn(await $.session.messages())
      const answer = turn.texts.join('\n\n')
      if (answer.trim() === '') return { text: 'premise-check: no answer to check yet.' }
      const found = findClaims(answer)
      const claims: Claim[] =
        found.length > 0 ? found : [{ kind: 'unsupported', sentence: `(no single sentence flagged; check every claim about external software in this answer) ${answer.slice(0, 3000)}` }]
      const agentId = await spawnChecker($, claims, turn)
      return { text: agentId === undefined ? 'premise-check: could not start the checker.' : `premise-check: checking ${found.length || 'all'} claim(s) from the last answer in the background.` }
    }
    return { text: `premise-check: unknown argument "${arg}". Use now | escalate | nudge | verify | off | status.` }
  })
}
