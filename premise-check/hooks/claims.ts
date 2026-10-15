// Pure detection logic: which sentences of an answer rest on what a library,
// framework or tool can do (or which version is current), and which tool
// calls count as having checked that against a live source.

export type ClaimKind = 'unsupported' | 'version' | 'knowledge'

export type Claim = { kind: ClaimKind; sentence: string }

// "X doesn't support Y", "can't be used with", "has no ... integration".
const NEGATIVE =
  /\b(?:does(?:n't| not)|do(?:n't| not)|can(?:'t|not| not)|won't|will not|isn't|is not|aren't|are not|has no|have no|lacks?|no longer)\s+(?:[\w-]+\s+){0,3}?(?:support(?:s|ed)?|work(?:s)? with|integrat(?:e|es|ed) with|be used with|compatible|possible|available|provide(?:s)?|offer(?:s)?|expose(?:s)?|ship(?:s)? with|include(?:s)?|allow(?:s)?|exist(?:s)?|implemented)\b/i
const NO_SUCH =
  /\bthere (?:is|are|'s) no (?:[\w-]+\s+){0,3}?(?:support|integration|package|library|adapter|plugin|extension|binding|api|way|option|equivalent|transport|provider|connector)\b/i
const UNSUPPORTED =
  /\b(?:not|un)(?:\s+(?:yet|currently|officially|natively))?\s*supported\b|\bnot (?:yet |currently )?(?:possible|available|implemented)\b|\bno (?:built-in|native|official|first-class) (?:support|integration|way)\b|\bdeprecated\b|\b(?:was|has been|have been) (?:removed|dropped)\b/i
const VERSION =
  /\b(?:the )?(?:latest|newest|most recent|current)(?: stable| LTS)? (?:version|release|major)\b(?: of [\w.@/-]+)? (?:is|was)\b|\bv?\d+(?:\.\d+)+ (?:is|was) (?:the )?(?:latest|newest|most recent|current)\b/i
const KNOWLEDGE =
  /\b(?:as far as I know|to (?:the best of )?my knowledge|I(?:'m| am) not aware of|last I (?:checked|knew)|as of my (?:knowledge|training|last update)|my (?:knowledge|training)(?: data)? cutoff|at the time of my training)\b|\bI don't (?:believe|think) (?:\S+\s+){0,5}?(?:supports?|has|provides?|offers?|works?)\b/i

// The speaker describing their own limits, not a library's.
const SELF = /\b(?:I|we|you)\s+(?:can(?:'t|not| not)|couldn't|don't|do not|won't|am unable|cannot|didn't)\b/i
// Words that put a sentence in the domain of third-party software.
const TECH =
  /\b(?:librar(?:y|ies)|packages?|frameworks?|sdks?|apis?|versions?|releases?|nuget|npm|pypi|crates?|gems?|maven|gradle|plugins?|extensions?|integrations?|adapters?|drivers?|runtimes?|toolkits?|cli|transports?|providers?|connectors?|bindings?|middleware)\b/i
// A named thing: `code`, dotted names (wolverine.fx, System.Text.Json),
// @scope/pkg, CamelCase, version numbers.
const ENTITY = /`[^`\n]+`|\b[\w-]+\.[A-Za-z]{2,}[\w.]*\b|@[\w-]+\/[\w.-]+|\b[A-Z][a-z]+[A-Z]\w*\b|\bv?\d+\.\d+(?:\.\d+)?\b/
// A proper noun past the sentence's first word (Dapr in "Wolverine can't use Dapr").
const PROPER = /\b[A-Z][A-Za-z0-9]+/
// About the project's own code rather than an external dependency.
const LOCAL =
  /\b(?:this|your|our|the current) (?:function|method|class|file|test|tests|repo|repository|codebase|code|component|script|branch|PR|config|endpoint|query|variable|schema|table|helper|handler)\b/i

const MAX_CLAIMS = 6

function sentencesOf(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/^\s*[>|].*$/gm, ' ')
  return prose
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.replace(/^[\s*\-#>\d.)]+/, '').trim())
    .filter(s => s.length > 12 && s.length < 600)
}

function isAboutSoftware(sentence: string): boolean {
  const named = ENTITY.test(sentence) || PROPER.test(sentence.slice(sentence.indexOf(' ') + 1))
  if (LOCAL.test(sentence) && !TECH.test(sentence) && !ENTITY.test(sentence)) return false
  return named || TECH.test(sentence)
}

function kindOf(sentence: string): ClaimKind | undefined {
  if (KNOWLEDGE.test(sentence)) return 'knowledge'
  if (VERSION.test(sentence)) return 'version'
  if (NO_SUCH.test(sentence) || UNSUPPORTED.test(sentence)) return 'unsupported'
  if (NEGATIVE.test(sentence) && !SELF.test(sentence)) return 'unsupported'
  return undefined
}

/** The sentences of `text` that state, from memory, what external software can do or which version is current. */
export function findClaims(text: string): Claim[] {
  const seen = new Set<string>()
  const claims: Claim[] = []
  for (const sentence of sentencesOf(text)) {
    if (sentence.endsWith('?')) continue
    const kind = kindOf(sentence)
    if (kind === undefined) continue
    if (kind !== 'knowledge' && !isAboutSoftware(sentence)) continue
    const key = sentence.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    claims.push({ kind, sentence })
    if (claims.length === MAX_CLAIMS) break
  }
  return claims
}

// Shell commands that ask a registry, a release feed or a package manager what exists now.
const REGISTRY_COMMAND =
  /\b(?:npm (?:view|info|show|outdated|search)|pnpm (?:view|info|outdated)|yarn (?:info|npm info|outdated)|pip(?:3)? (?:index|show|download)|uv pip (?:show|index)|poetry show|dotnet (?:package search|list[\s\S]*--outdated|add package)|nuget (?:search|list)|cargo (?:search|info)|go list -m|gem (?:search|info|list -r)|composer (?:show|outdated)|mvn [\s\S]*versions:|gh (?:release|api|repo view)|brew info|apt(?:-cache)? (?:show|policy))\b|\bcurl\b[\s\S]*(?:registry\.npmjs|api\.nuget|nuget\.org|pypi\.org|crates\.io|proxy\.golang|rubygems\.org|packagist|search\.maven|api\.github\.com|github\.com\/[^\s/]+\/[^\s/]+\/releases)/i
// Paths that hold an installed dependency's real source.
const INSTALLED_SOURCE = /(?:node_modules|\.nuget[\\/]packages|site-packages|\.cargo[\\/]registry|go[\\/]pkg[\\/]mod|[\\/]vendor[\\/]|\.m2[\\/]repository|\.gradle[\\/]caches)/
const DOC_MCP = /context7|docs|documentation|deepwiki|release|search|fetch|browse|web/i

/** Whether one tool call looked at a current source rather than memory. */
export function isVerification(tool: string, input: Record<string, unknown>): boolean {
  if (tool === 'WebSearch' || tool === 'WebFetch') return true
  if (tool.startsWith('mcp__')) return DOC_MCP.test(tool)
  if (tool === 'Bash') return typeof input.command === 'string' && REGISTRY_COMMAND.test(input.command)
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') {
    const where = [input.file_path, input.path, input.pattern].filter(v => typeof v === 'string').join(' ')
    return INSTALLED_SOURCE.test(where)
  }
  return false
}

/** One stable string per claim set, so the same answer is never flagged twice. */
export function fingerprint(claims: readonly Claim[]): string {
  return claims.map(c => c.sentence.toLowerCase()).join('\n')
}

export type Verdict = 'OUTDATED' | 'CONFIRMED' | 'UNCERTAIN'

/** The checker ends its report with `VERDICT: <word>`; anything else reads as uncertain. */
export function verdictOf(report: string): Verdict {
  const m = /VERDICT:\s*\**\s*(OUTDATED|CONFIRMED|UNCERTAIN)/i.exec(report)
  return (m?.[1]?.toUpperCase() as Verdict | undefined) ?? 'UNCERTAIN'
}
