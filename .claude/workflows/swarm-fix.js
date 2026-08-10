export const meta = {
  name: 'swarm-fix',
  description: 'Fix a list of confirmed findings one at a time in the shared working tree, each fix independently verified before moving on',
  whenToUse: 'Feed it swarm-audit output: Workflow({name: "swarm-fix", args: {findings: [...]}}). Sequential on purpose so fixes never collide.',
  phases: [
    { title: 'Fix', detail: 'fixer then independent verifier, per finding' },
    { title: 'Retro', detail: 'append run metrics to the ledger; update tuning so the next run is sharper' },
  ],
}

const REVIEW = {
  type: 'object',
  required: ['ship', 'score', 'blockers'],
  properties: {
    ship: { type: 'boolean' },
    score: { type: 'integer' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
}

// Role preambles inlined (mirroring .claude/agents/swarm-*.md) so the workflow
// works even in sessions where those agent types are not registered.
const FIXER_ROLE = [
  'You are the implementer in an agent swarm. An independent verifier will check your work; changes that do not fix the defect, break something else, or fake verification get reported as blocked.',
  'If .claude/swarm-context.md and .claude/swarm-tuning.md exist in the repo root, read both first; violating a listed invariant is an automatic failure, and tuning lists lessons from previous swarm runs.',
  'Read the code you are about to change AND its callers before editing. Match surrounding style. Make the minimal change that correctly fixes the defect; no scope creep.',
  'Run the narrowest relevant test/build/typecheck that proves the fix, and report what you ran with the ACTUAL results.',
  'Hard rules: fail loudly, never add silent fallbacks, mock data, or catch-and-ignore; never weaken auth, RLS, validation, or money-safety checks; never fabricate results. Do not commit, push, or deploy; leave changes uncommitted.',
].join('\n')

const CHECKER_ROLE = [
  'You are the verification gate of an agent swarm. The fixer report is a claim, not evidence.',
  'If .claude/swarm-context.md and .claude/swarm-tuning.md exist in the repo root, read both; a fix violating a listed invariant is an automatic blocker.',
  'Run git diff and review the actual change. Confirm it fixes the specific defect and does not break callers or weaken validation. Re-run claimed verification yourself when feasible.',
  'ship=true only if the defect is genuinely fixed and safe to merge; score 0-10. ship=false requires concrete blockers pointing at files and specific problems. Never edit files yourself.',
].join('\n')

// args may arrive as an object or, if the caller stringified it, as JSON text.
// Normalizing here turns a silent zero-agent no-op into a working run.
let parsedArgs = args
if (typeof parsedArgs === 'string') {
  try { parsedArgs = JSON.parse(parsedArgs) } catch (e) { parsedArgs = null }
}
const findings = (parsedArgs && (Array.isArray(parsedArgs) ? parsedArgs : parsedArgs.findings)) || []
if (!findings.length) return { error: 'Pass {findings: [...]}, e.g. the confirmed array returned by swarm-audit' }

phase('Fix')
const results = []
for (let i = 0; i < findings.length; i++) {
  if (budget.total && budget.remaining() < 40000) {
    log('Token budget nearly exhausted: stopping after ' + i + '/' + findings.length + ' findings')
    for (let j = i; j < findings.length; j++) {
      results.push({ finding: findings[j].title, ship: false, blockers: ['skipped: token budget exhausted'] })
    }
    break
  }
  const f = findings[i]
  const tag = (f.file || 'finding') + '#' + (i + 1)
  const report = await agent(
    FIXER_ROLE + '\n\nFix this confirmed defect with the minimal correct change. Leave changes uncommitted. Other fixes may already be in the working tree; do not revert or touch them.\nDefect:\n' + JSON.stringify(f, null, 2),
    { label: 'fix:' + tag }
  )
  if (report === null) {
    results.push({ finding: f.title, ship: false, blockers: ['fixer agent failed or was skipped'] })
    continue
  }
  const check = await agent(
    CHECKER_ROLE + '\n\nVerify that the current uncommitted changes actually fix this specific defect without breaking anything around it. Judge only this defect; ignore unrelated changes in the tree.\nDefect:\n' + JSON.stringify(f, null, 2) +
    '\nFixer report (a claim, not evidence):\n' + report,
    { label: 'check:' + tag, schema: REVIEW }
  )
  results.push({
    finding: f.title,
    file: f.file,
    ship: !!(check && check.ship),
    score: check ? check.score : null,
    blockers: (check && check.blockers) || [],
  })
  log((i + 1) + '/' + findings.length + ': ' + f.title + ' -> ' + (check && check.ship ? 'FIXED' : 'BLOCKED'))
}

const metric = {
  fixed: results.filter(r => r.ship).length,
  blocked: results.filter(r => !r.ship).length,
  total: results.length,
}

phase('Retro')
const RETRO_ROLE = [
  'You are the self-improvement layer of an agent swarm. Your job: make the NEXT swarm run measurably better than this one. You may create or edit ONLY these files, nothing else: .claude/swarm-metrics.jsonl, .claude/swarm-tuning.md, .claude/swarm-context.md, and report files under .claude/swarm-reports/. (The defect fixes made by earlier phases of this run are separate work: leave them untouched.)',
  '1. Append exactly one JSON line for this run to .claude/swarm-metrics.jsonl containing: ts (ISO timestamp from running `date -u +%Y-%m-%dT%H:%M:%SZ`), workflow name, and the metric object you were given.',
  '2. Read the whole ledger and compare against past runs: is fix rate falling, do the same blocker patterns recur? State the trend.',
  '3. Update .claude/swarm-tuning.md: distill blocked fixes into concrete guidance for future fixers (what the verifier keeps rejecting and why); under "## Proposed script changes", propose (never apply) workflow-script improvements the evidence supports. Prune stale guidance; keep the file under 120 lines.',
  '4. If a blocker reveals a DURABLE repo invariant not yet in .claude/swarm-context.md, add it there in the existing style.',
  '5. Email the report to Chris Preuss: write the full run report as markdown to .claude/swarm-reports/<UTC-timestamp>-swarm-fix.md (create the directory if needed) covering which defects were fixed vs blocked and why, the metrics with trend vs the ledger, every improvement you made to tuning/context, and any proposed script changes. Then use ToolSearch (query "create_draft") to load the Gmail draft tool and create a draft addressed to chris@cpz-lab.com with subject "[Swarm] fix report: <repo folder name>" and the report as the body. DRAFT ONLY, never send. If no Gmail tool is available in this session, note that in your summary and continue; do not fail the retro over it.',
  'Be conservative: every line you write is read by every future swarm agent, so wrong guidance compounds. Ground every claim in the run record. Report back a short summary of the trend and what you changed.',
].join('\n')
const retro = await agent(
  RETRO_ROLE + '\n\nRun record for this swarm-fix:\n' + JSON.stringify({ workflow: 'swarm-fix', metric, results }, null, 2),
  { label: 'retro', phase: 'Retro', model: 'sonnet' }
)

return { results, metric, retro }
