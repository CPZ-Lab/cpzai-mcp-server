export const meta = {
  name: 'swarm-build',
  description: 'Scout, competing designs judged by a panel, winning design implemented, then a review-gated repair loop until ship',
  whenToUse: 'Build a feature or fix end to end with design competition and a hard ship gate. Required args: {task: "..."}.',
  phases: [
    { title: 'Scout', detail: 'map the relevant code' },
    { title: 'Design', detail: '3 competing designs + judge' },
    { title: 'Implement', detail: 'winning design implemented' },
    { title: 'Gate', detail: 'review-gated repair loop, max 3 attempts' },
    { title: 'Retro', detail: 'append run metrics to the ledger; update tuning so the next run is sharper' },
  ],
}

const DESIGN = {
  type: 'object',
  required: ['plan', 'files', 'risks', 'verification'],
  properties: {
    plan: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    risks: { type: 'string' },
    verification: { type: 'string' },
  },
}

const JUDGMENT = {
  type: 'object',
  required: ['winner', 'why'],
  properties: {
    winner: { type: 'integer' },
    why: { type: 'string' },
    merge_ideas: { type: 'string' },
  },
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
const SCOUT_ROLE = [
  'You are the scout of an agent swarm. Downstream designers and an implementer will act on your map without re-reading the repo, so wrong or missing entries cause wrong implementations.',
  'If .claude/swarm-context.md and .claude/swarm-tuning.md exist in the repo root, read both first and fold them into your map.',
  'Locate every file the task will touch or depend on: entry points, code to change, callers, shared types/schemas, config, and covering tests. Trace the data flow end to end. Record invariants and traps a naive change would break. Note how a change is verified locally.',
  'You are read-only: never modify files; Bash only for investigation. Mark anything inferred but not verified. Output a compact structured map, no prose padding.',
].join('\n')

const FIXER_ROLE = [
  'You are the implementer in an agent swarm. A reviewer gate will score your work against the task; changes that do not solve the task, break something else, or fake verification get bounced back.',
  'If .claude/swarm-context.md and .claude/swarm-tuning.md exist in the repo root, read both first; violating a listed invariant is an automatic gate failure, and tuning lists what past gate reviews kept rejecting.',
  'Read the code you are about to change AND its callers before editing. Match surrounding style. Make the minimal change that correctly solves the task; no scope creep.',
  'Run the narrowest relevant test/build/typecheck that proves the change works, and report what you ran with the ACTUAL results.',
  'Hard rules: fail loudly, never add silent fallbacks, mock data, or catch-and-ignore; never weaken auth, RLS, validation, or money-safety checks; never fabricate results. Do not commit, push, or deploy; leave changes uncommitted.',
].join('\n')

const REVIEWER_ROLE = [
  'You are the ship gate of an agent swarm. The implementer report is a claim, not evidence.',
  'If .claude/swarm-context.md and .claude/swarm-tuning.md exist in the repo root, read both; a change violating a listed invariant is an automatic blocker.',
  'Run git diff and git status; review the diff itself, not the description of it. Check the change fully solves the task and its implied edge cases. Hunt regressions: read callers of changed code, look for broken contracts, weakened validation, silent fallbacks, faked data. Re-run claimed verification yourself when feasible and trust your own results.',
  'ship=true only if you would merge this to a money-handling production system; score 0-10. ship=false requires concrete blockers each pointing at a file and the specific problem. An empty diff when changes were required is ship=false. Never edit files yourself.',
].join('\n')

const task = typeof args === 'string' ? args : (args && args.task)
if (!task) return { error: 'Usage: Workflow({name: "swarm-build", args: {task: "<what to build or fix>"}})' }

phase('Scout')
const map = await agent(
  SCOUT_ROLE + '\n\nMap the code relevant to this task so designers and an implementer can work from your map alone.\nTask: ' + task,
  { label: 'scout' }
)

phase('Design')
const ANGLES = [
  'minimal-diff: the smallest correct change that fully solves the task',
  'robustness-first: enumerate failure modes and edge cases; no silent fallbacks, fail loudly',
  'product-first: the best user-facing outcome within reasonable scope',
]
const designs = (await parallel(ANGLES.map((angle, i) => () =>
  agent(
    'Produce an implementation design. You are competing against two other designs; a judge picks one winner.\nAngle: ' + angle +
    '\nTask: ' + task + '\nCodebase map:\n' + map,
    { label: 'design:' + angle.split(':')[0], phase: 'Design', schema: DESIGN }
  )
))).filter(Boolean)
if (!designs.length) return { error: 'All design agents failed' }

const judgment = await agent(
  'Judge these competing implementation designs for the task. Return the 0-based index of the winner and any ideas from the losers worth merging in.' +
  '\nTask: ' + task + '\nCodebase map:\n' + map + '\nDesigns:\n' + JSON.stringify(designs, null, 2),
  { label: 'judge', phase: 'Design', schema: JUDGMENT }
)
const winner = designs[judgment && judgment.winner] || designs[0]

phase('Implement')
let report = await agent(
  FIXER_ROLE + '\n\nImplement this approved design. Leave changes uncommitted.\nTask: ' + task +
  '\nDesign:\n' + JSON.stringify(winner, null, 2) +
  '\nIdeas to merge from competing designs: ' + ((judgment && judgment.merge_ideas) || 'none') +
  '\nRun the verification the design specifies and report actual results.',
  { label: 'implement', phase: 'Implement' }
)

phase('Gate')
let verdict = null
let attempts = 0
for (let attempt = 1; attempt <= 3; attempt++) {
  attempts = attempt
  verdict = await agent(
    REVIEWER_ROLE + '\n\nReview the current uncommitted changes against this task and return your verdict.\nTask: ' + task +
    '\nImplementer report (treat as a claim, not evidence):\n' + report,
    { label: 'review:' + attempt, phase: 'Gate', schema: REVIEW }
  )
  if (!verdict || verdict.ship) break
  log('Gate attempt ' + attempt + ': ' + verdict.blockers.length + ' blocker(s), sending back for repair')
  report = await agent(
    FIXER_ROLE + '\n\nA reviewer blocked your change. Fix every blocker, re-run verification, and report.\nTask: ' + task +
    '\nBlockers:\n' + JSON.stringify(verdict.blockers, null, 2),
    { label: 'repair:' + attempt, phase: 'Gate' }
  )
}

const metric = {
  ship: !!(verdict && verdict.ship),
  score: verdict ? verdict.score : null,
  gate_attempts: attempts,
  winning_design: (judgment && judgment.winner != null) ? ANGLES[judgment.winner] : ANGLES[0],
}

phase('Retro')
const RETRO_ROLE = [
  'You are the self-improvement layer of an agent swarm. Your job: make the NEXT swarm run measurably better than this one. You may create or edit ONLY these files, nothing else: .claude/swarm-metrics.jsonl, .claude/swarm-tuning.md, .claude/swarm-context.md, and report files under .claude/swarm-reports/. (The implementation produced by earlier phases of this run is separate work: leave it untouched.)',
  '1. Append exactly one JSON line for this run to .claude/swarm-metrics.jsonl containing: ts (ISO timestamp from running `date -u +%Y-%m-%dT%H:%M:%SZ`), workflow name, and the metric object you were given.',
  '2. Read the whole ledger and compare against past runs: are gate attempts rising, do the same blocker patterns recur, which design angle keeps winning? State the trend.',
  '3. Update .claude/swarm-tuning.md: distill gate blockers into concrete guidance for future implementers; note which design angles win for which task types; under "## Proposed script changes", propose (never apply) workflow-script improvements the evidence supports. Prune stale guidance; keep the file under 120 lines.',
  '4. If a blocker reveals a DURABLE repo invariant not yet in .claude/swarm-context.md, add it there in the existing style.',
  '5. Email the report to Chris Preuss: write the full run report as markdown to .claude/swarm-reports/<UTC-timestamp>-swarm-build.md (create the directory if needed) covering the task, which design won and why, gate attempts and final verdict, every improvement you made to tuning/context, and any proposed script changes. Then use ToolSearch (query "create_draft") to load the Gmail draft tool and create a draft addressed to chris@cpz-lab.com with subject "[Swarm] build report: <repo folder name>" and the report as the body. DRAFT ONLY, never send. If no Gmail tool is available in this session, note that in your summary and continue; do not fail the retro over it.',
  'Be conservative: every line you write is read by every future swarm agent, so wrong guidance compounds. Ground every claim in the run record. Report back a short summary of the trend and what you changed.',
].join('\n')
const retro = await agent(
  RETRO_ROLE + '\n\nRun record for this swarm-build:\n' + JSON.stringify({
    workflow: 'swarm-build',
    task,
    metric,
    final_review: verdict,
  }, null, 2),
  { label: 'retro', phase: 'Retro', model: 'sonnet' }
)

return { task, metric, retro, final_review: verdict, implementer_report: report }
