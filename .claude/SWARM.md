# CPZAI Agent Swarm

Swarm infrastructure per Alexandr Wang's formula: the right agentic loop plus the right evaluation system and metric for the agents to optimize. Installed identically across all CPZ repos; each repo adds its own `.claude/swarm-context.md` with local invariants and traps that every swarm agent reads first.

## The evaluation system (why this beats one big agent)

Nothing an agent claims is trusted. Every layer is graded by an independent adversary:

- **Finders** are scored on confirmed findings; every candidate faces a 3-refuter panel that defaults to "refuted" when uncertain. Only 2-of-3 survivors count. The audit loop keeps spawning finder rounds until two consecutive rounds surface nothing new (converged), and reports precision (confirmed/candidates) as its metric.
- **Implementers** face a ship gate: a reviewer reads the actual `git diff` (never the implementer's report), re-runs verification itself, and blocks with concrete blockers. Blocked work loops back for repair, max 3 attempts. Metric: ship verdict + 0-10 score.
- **Designs** compete: three angles (minimal-diff, robustness-first, product-first) are drafted in parallel and a judge picks the winner, grafting the losers' best ideas.

## How to run it

Say any of these in a Claude Code session in the repo:

- "run the swarm-audit workflow" — full-repo hunt for confirmed defects. Scoped: "run swarm-audit with scope: the billing edge functions".
- "run the swarm-fix workflow with the confirmed findings" — fixes an audit's output one finding at a time, each fix independently verified. Changes stay uncommitted for your review.
- "run the swarm-build workflow: <what you want built>" — feature/fix built end to end through design competition and the ship gate.

Or turn on **ultracode** (say "ultracode" in the prompt) to make Claude orchestrate swarms for every substantive task by default.

## Self-improvement loop

Every workflow ends with a **Retro phase** that makes the next run measurably better:

1. Appends this run's metrics (audit precision/rounds, fix rate, gate attempts/score) as one JSON line to `.claude/swarm-metrics.jsonl` — the permanent ledger; trends across runs are the swarm's report card.
2. Mines the run's failures: refuted candidates become false-positive patterns finders must not repeat; gate blockers become implementer guidance; confirmed-defect clusters become hot spots for extra depth.
3. Writes those lessons to `.claude/swarm-tuning.md`, which every swarm agent reads at the start of the next run — so precision and fix rate compound over time.
4. Promotes durable new invariants into `.claude/swarm-context.md`, and proposes (never applies) workflow-script changes under "Proposed script changes" in the tuning file for a human or the main session to adopt.

5. Emails Chris a run report: the full report (metrics + trend, findings/fixes, every improvement made, proposed script changes) is saved to `.claude/swarm-reports/` and dropped as a **Gmail draft** to chris@cpz-lab.com with subject `[Swarm] <workflow> report: <repo>`. Drafts only — the connected Gmail has no send capability, so nothing auto-sends; check the Drafts folder after a run.

The Retro agent may touch ONLY those files (ledger, tuning, context, reports). Check `swarm-metrics.jsonl` occasionally: falling precision or rising gate attempts means the tuning file needs pruning.

## Pieces

- `.claude/agents/` — swarm-scout, swarm-finder, swarm-verifier, swarm-fixer, swarm-reviewer. Also usable individually via the Agent tool.
- `.claude/workflows/` — swarm-audit.js, swarm-build.js, swarm-fix.js.
- `.claude/swarm-context.md` — this repo's stack, invariants, and known traps. Keep it current; every swarm agent reads it first, so a stale entry misleads the whole swarm.

## Cost controls (built in)

- Verifier panels are severity-adaptive: critical/high findings get 3 refuters (2-of-3), medium/low get 2 (unanimous). Panels run on Sonnet — refutation is a focused code-trace task, and the panel is the workflow's token multiplier.
- Finders cap at 8 findings per lens per round with tight evidence; verification caps at the top 12 candidates per round by severity (dropped ones are logged, never silent).
- Retro agents run on Sonnet.
- Every loop honors a token budget: say "+300k" in your prompt to hard-cap a run; workflows stop cleanly and report what they skipped.
- Cheapest lever is scope: "run swarm-audit with scope: the billing edge functions" costs a fraction of a full-repo sweep.

## Notes

- Swarms are token-hungry (an unscoped audit can run 30+ agents). Scope audits when you don't need the full repo.
- Fixers and workflows never commit, push, or deploy. You keep the "git add commit push all" ritual.
