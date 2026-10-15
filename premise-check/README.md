# premise-check

Claude's knowledge of libraries and frameworks comes from training data, and new releases often add the very feature it says is missing. (Example: Claude says Wolverine can't run on Dapr, but a newer Wolverine release supports it.) This mod spots those claims and makes sure someone checks them against a current source.

## What it does

1. **System-prompt rule.** It tells the agent to check the registry, changelog or docs before saying something "isn't supported", naming a "latest version", or building a workaround for a feature it thinks is missing.
2. **Claim detection.** When a turn ends, it scans the agent's text for:
   - claims that something is unsupported or impossible ("X doesn't support Y", "there's no official integration", "deprecated")
   - claims about the latest version ("the latest version of X is …")
   - hedges about training knowledge ("as far as I know", "I'm not aware of")

   It skips claims if the same turn already looked something up: WebSearch or WebFetch, a docs MCP like Context7, registry commands (`npm view`, `dotnet package search`, `pip index`, `gh release`, registry `curl`s …), or reading an installed package's source.
3. **Reaction**, depending on the mode:

| Mode | Behaviour |
| --- | --- |
| `escalate` (default) | Blocks the stop and asks the agent to verify. If the agent finishes again without looking anything up, an independent checker subagent verifies the claims. |
| `nudge` | Only the blocking re-check. |
| `verify` | Never blocks. A background checker subagent checks registries, release notes and docs, plus the version your project pins. If it finds a claim outdated, the mod sends its findings to the agent, which then corrects itself. |
| `off` | Only the system-prompt rule. |

## Commands

- `/premise-check now`: run the checker on the last answer, whether or not anything was flagged
- `/premise-check escalate|nudge|verify|off`: switch modes (saved across sessions)
- `/premise-check status`: show the current mode

The default mode and the checker's model (default `sonnet`) can also be set in `/config`.

## Limits

- Detection uses heuristics. Expect some misses and some false positives. To reduce noise, each claim set gets flagged at most once and each answer gets nudged at most once.
- Any lookup during the turn counts as verification, even one about a different library.
- The hooks on `prompt.compose` and `classic.Stop` don't run for user-installed plugins in an organization-managed Claude Code.

## Develop

```
claude plugin validate premise-check
claude plugin test premise-check
claude --plugin-dir ./premise-check
```
