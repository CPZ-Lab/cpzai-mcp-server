export const meta = {
  name: 'swarm-audit',
  description: 'Multi-lens defect hunt with adversarial 3-vote verification, looping until two dry rounds',
  whenToUse: 'Audit a repo or subsystem for real, confirmed defects. Optional args: {scope: "...", maxRounds: N}. Feed the confirmed output into swarm-fix.',
  phases: [
    { title: 'Find', detail: '4 lenses per round: correctness, security, data-integrity, integration' },
    { title: 'Verify', detail: '3 adversarial refuters per finding; survives on 2+ non-refutals' },
    { title: 'Retro', detail: 'append run metrics to the ledger; update tuning and context so the next run is sharper' },
  ],
}

const FINDINGS = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'title', 'severity', 'evidence', 'failure_scenario'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          title: { type: 'string' },
          severity: { enum: ['critical', 'high', 'medium', 'low'] },
          evidence: { type: 'string' },
          failure_scenario: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT = {
  type: 'object',
  required: ['refuted', 'reasoning'],
  properties: {
    refuted: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
}

// Role preambles are inlined (mirroring .claude/agents/swarm-*.md) so the
// workflow works even in sessions where those agent types are not registered.
const FINDER_ROLE = [
  'You are a defect finder in an agent swarm. An adversarial verification panel will try to refute everything you report; false positives cost you, so report only what you can prove.',
  'If .claude/swarm-context.md and .claude/swarm-tuning.md exist in the repo root, read both first: context lists this repo stack, invariants, and known traps; tuning lists lessons from previous swarm runs, including false-positive patterns you must not repeat and hot spots worth extra depth.',
  'Hunt strictly within your assigned lens and scope. Depth beats breadth: trace real code paths end to end.',
  'A finding must be evidenced by code you actually read: cite file, line, and the exact mechanism. Every finding needs a concrete failure scenario (specific inputs or state leading to wrong output, data loss, security exposure, or a crash).',
  'No style nits, no hypotheticals, no TODO archaeology. Do not re-report anything on the already-known list.',
  'Report at most 8 findings, your best by severity. Keep evidence fields tight: the cited code plus the mechanism, not essays.',
  'Severity: critical = money loss, data loss, or security breach; high = user-visible breakage; medium = incorrect behavior with a workaround; low = latent trap.',
  'You are read-only: never modify files; Bash only for read-only investigation (git log, ls, grep).',
].join('\n')

const VERIFIER_ROLE = [
  'You are the adversarial evaluation layer of an agent swarm. You receive one claimed defect. Your job is to REFUTE it: assume the finder was wrong until the code forces you to conclude otherwise.',
  'If .claude/swarm-context.md and .claude/swarm-tuning.md exist in the repo root, read both; known traps and past-run lessons there may explain behavior the finder misread.',
  'Open the cited file, verify the quoted code exists and says what is claimed, then trace the full path: callers, guards, upstream validation, downstream error handling. Attempt the failure scenario mentally with concrete values.',
  'refuted=true if the code is not as claimed, a guard prevents the scenario, the behavior is intentional, or the impact is not real. refuted=false ONLY when you traced the path yourself and the failure genuinely occurs.',
  'If uncertain after honest effort, default to refuted=true. You are read-only: never modify anything. Put your trace evidence in the reasoning field.',
].join('\n')

let parsedArgs = args
if (typeof parsedArgs === 'string') {
  try { parsedArgs = JSON.parse(parsedArgs) } catch (e) { parsedArgs = { scope: args } }
}
const scope = (parsedArgs && parsedArgs.scope) ||
  'the whole repository, prioritizing money paths, auth and permission checks, data writes, and recently changed code (check git log)'
const maxRounds = (parsedArgs && parsedArgs.maxRounds) || 3

const LENSES = [
  'correctness: logic errors, inverted or wrong conditions, off-by-one, broken state machines, wrong variable used',
  'security: auth/permission bypass, RLS gaps, injection, secret exposure, unsafe defaults, trust of client input',
  'data-integrity: silent failures, swallowed errors, fallbacks that fake data, race conditions, partial writes',
  'integration: API contract mismatches, schema drift, wrong column or table names, env/config drift, stale types',
]

const seen = new Set()
const confirmed = []
const refutedLog = []
const key = f => ((f.file || '') + ':' + (f.title || '')).toLowerCase()

let round = 0
let dry = 0
while (dry < 2 && round < maxRounds) {
  if (budget.total && budget.remaining() < 40000) {
    log('Token budget nearly exhausted (' + Math.round(budget.remaining() / 1000) + 'k left): stopping before round ' + (round + 1))
    break
  }
  round += 1
  const known = Array.from(seen).join('\n') || '(none yet)'
  const found = (await parallel(LENSES.map(lens => () =>
    agent(
      FINDER_ROLE + '\n\nAudit scope: ' + scope + '\nYour lens: ' + lens +
      '\nAlready-known findings, do NOT re-report these (file:title):\n' + known,
      { label: 'find:' + lens.split(':')[0] + ':r' + round, phase: 'Find', schema: FINDINGS }
    )
  ))).filter(Boolean).flatMap(r => r.findings || [])

  let fresh = found.filter(f => !seen.has(key(f)))
  if (fresh.length === 0) {
    dry += 1
    log('Round ' + round + ': dry (' + dry + '/2)')
    continue
  }
  dry = 0
  fresh.forEach(f => seen.add(key(f)))
  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 }
  fresh.sort((a, b) => (sevOrder[a.severity] || 9) - (sevOrder[b.severity] || 9))
  if (fresh.length > 12) {
    log('Round ' + round + ': capping verification at top 12 of ' + fresh.length + ' candidates by severity; dropped: ' +
      fresh.slice(12).map(f => f.severity + ':' + f.title).join(' | '))
    fresh = fresh.slice(0, 12)
  }
  log('Round ' + round + ': ' + fresh.length + ' new candidate(s), sending to adversarial verification')

  // Cost-adaptive panels: critical/high get 3 refuters (2-of-3 to survive);
  // medium/low get 2 refuters (unanimous non-refutal to survive). Verifiers run
  // on sonnet: refutation is a focused code-trace task, and the panel is the
  // token multiplier of the whole workflow.
  const judged = await parallel(fresh.map(f => () => {
    const panel = (f.severity === 'critical' || f.severity === 'high') ? 3 : 2
    const needed = 2
    return parallel(Array.from({ length: panel }, (_, i) => () =>
      agent(
        VERIFIER_ROLE + '\n\nYou are refuter #' + (i + 1) + ' of ' + panel + '. Claimed defect:\n' + JSON.stringify(f, null, 2),
        { label: 'verify:' + (f.file || '?'), phase: 'Verify', schema: VERDICT, model: 'sonnet' }
      )
    )).then(votes => {
      const valid = votes.filter(Boolean)
      return { f, valid, survives: valid.filter(v => !v.refuted).length >= needed }
    })
  }))
  const survivors = judged.filter(Boolean).filter(j => j.survives)
  survivors.forEach(j => confirmed.push(Object.assign({}, j.f, { verifier_notes: j.valid.map(v => v.reasoning) })))
  judged.filter(Boolean).filter(j => !j.survives).forEach(j => refutedLog.push({
    file: j.f.file,
    title: j.f.title,
    severity: j.f.severity,
    why_refuted: (j.valid.filter(v => v.refuted)[0] || {}).reasoning || 'no valid verdicts',
  }))
  log('Round ' + round + ': ' + survivors.length + '/' + fresh.length + ' survived verification')
}

const bySeverity = {}
confirmed.forEach(f => { bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1 })
const order = { critical: 0, high: 1, medium: 2, low: 3 }
confirmed.sort((a, b) => (order[a.severity] || 9) - (order[b.severity] || 9))

const metric = {
  candidates: seen.size,
  confirmed: confirmed.length,
  precision: seen.size ? Math.round(100 * confirmed.length / seen.size) + '%' : 'n/a',
  rounds: round,
  converged: dry >= 2,
  bySeverity,
}

phase('Retro')
const RETRO_ROLE = [
  'You are the self-improvement layer of an agent swarm. Your job: make the NEXT swarm run measurably better than this one. You may create or edit ONLY these files, nothing else: .claude/swarm-metrics.jsonl, .claude/swarm-tuning.md, .claude/swarm-context.md, and report files under .claude/swarm-reports/.',
  '1. Append exactly one JSON line for this run to .claude/swarm-metrics.jsonl containing: ts (ISO timestamp from running `date -u +%Y-%m-%dT%H:%M:%SZ`), workflow name, and the metric object you were given.',
  '2. Read the whole ledger and compare against past runs: is precision falling, are rounds rising, are the same false-positive patterns recurring? State the trend.',
  '3. Update .claude/swarm-tuning.md (create it from the existing template if missing): distill the refuted candidates into concrete false-positive patterns finders must not repeat; note hot spots (files/subsystems where confirmed defects clustered) deserving extra depth next run; under "## Proposed script changes", propose (never apply) any workflow-script improvements the evidence supports. Prune guidance that past runs prove stale; keep the file under 120 lines.',
  '4. If a confirmed finding reveals a DURABLE repo invariant or trap not yet in .claude/swarm-context.md, add it there in the existing style. Only durable facts; run-specific noise goes in tuning, not context.',
  '5. Email the report to Chris Preuss: write the full run report as markdown to .claude/swarm-reports/<UTC-timestamp>-swarm-audit.md (create the directory if needed) covering what ran, the metrics with trend vs the ledger, the confirmed findings, every improvement you made to tuning/context, and any proposed script changes. Then use ToolSearch (query "create_draft") to load the Gmail draft tool and create a draft addressed to chris@cpz-lab.com with subject "[Swarm] audit report: <repo folder name>" and the report as the body. DRAFT ONLY, never send. If no Gmail tool is available in this session, note that in your summary and continue; do not fail the retro over it.',
  'Be conservative: every line you write is read by every future swarm agent, so wrong guidance compounds. Ground every claim in the run record you were given. Report back a short summary of the trend and what you changed.',
].join('\n')
const retro = await agent(
  RETRO_ROLE + '\n\nRun record for this swarm-audit:\n' + JSON.stringify({
    workflow: 'swarm-audit',
    scope,
    metric,
    confirmed: confirmed.map(f => ({ file: f.file, title: f.title, severity: f.severity })),
    refuted: refutedLog,
  }, null, 2),
  { label: 'retro', phase: 'Retro', model: 'sonnet' }
)

return { confirmed, metric, retro }
