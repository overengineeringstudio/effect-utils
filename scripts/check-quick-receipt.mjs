import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = 'overengineeringstudio/effect-utils'
const command = ['devenv', 'tasks', 'run', 'check:quick', '--no-tui', '--show-output']

// This validates evidence, not authorship: the local gate receipt's trust model applies.
export const passingReceipt = (receipt, head) =>
  receipt.schema === 'gate-slot.receipt/v1' &&
  receipt.class === 'gate' &&
  receipt.exit === 0 &&
  receipt.exact === true &&
  receipt.cleanStart === true &&
  receipt.cleanEnd === true &&
  receipt.headStart === head &&
  receipt.headEnd === head &&
  /^[a-f0-9]{40}$/.test(receipt.treeStart) &&
  receipt.route?.execution === 'local' &&
  receipt.reroutedFrom === null &&
  JSON.stringify(receipt.cmd) === JSON.stringify(command) &&
  Array.isArray(receipt.failedTasks) &&
  receipt.failedTasks.length === 0 &&
  receipt.failedTasksTruncated === false &&
  Array.isArray(receipt.incompleteTasks) &&
  receipt.incompleteTasks.length === 0 &&
  receipt.incompleteTasksTruncated === false &&
  receipt.taskTraceTruncated === false &&
  receipt.notRunTasks === 0 &&
  Number.isFinite(Date.parse(receipt.startedAt)) &&
  Date.parse(receipt.endedAt) >= Date.parse(receipt.startedAt)

function run(argv, options = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${argv[0]} failed (${result.status ?? result.signal})`)
  return result.stdout?.trim()
}

export function main(args) {
  const receiptOnly = args.includes('--receipt-only')
  const flags = args.filter((arg) => arg !== '--receipt-only')
  if (flags.length !== 2 || flags[0] !== '--pr' || !/^[1-9][0-9]*$/.test(flags[1])) {
    throw new Error('Usage: node scripts/check-quick-receipt.mjs --pr N [--receipt-only]')
  }
  if (process.platform !== 'linux' || process.env.CI || process.env.GITHUB_ACTIONS) {
    throw new Error('Run locally on Linux, not in CI; CI cannot replace local exact-head evidence')
  }
  const pr = flags[1]
  const started = performance.now()
  const view = () => JSON.parse(run(['gh', 'pr', 'view', pr, '-R', repo, '--json', 'headRefOid,isDraft,state']))
  const target = view()
  if (target.state !== 'OPEN' || (!receiptOnly && target.isDraft)) throw new Error('PR must be open (and ready to enqueue)')
  const head = target.headRefOid
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Invalid PR head')
  const common = resolve(run(['git', 'rev-parse', '--git-common-dir']))
  const worktrees = join(common, 'gate-worktrees')
  mkdirSync(worktrees, { recursive: true })
  const state = join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'check-quick-receipt')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  const evidence = mkdtempSync(join(state, `pr-${pr}-`))
  const worktree = join(worktrees, `receipt-${pr}-${head.slice(0, 12)}-${process.pid}`)
  run(['git', 'fetch', '--no-tags', 'origin', `pull/${pr}/head`])
  if (run(['git', 'rev-parse', 'FETCH_HEAD']) !== head) throw new Error('PR head moved during fetch; no check or enqueue performed')
  run(['git', 'worktree', 'add', '--detach', worktree, head])
  const actor = process.env.FRACTAL_AGENT || process.env.ST_AGENT
  if (actor) {
    if (!actor.startsWith('agent/')) throw new Error('Invalid lease actor; refusing attribution')
    run(['gate-lease-write', worktree, 'gate', actor])
  } else {
    // Plain local sessions have no seat to attribute. Never invent one.
    // A clean detached checkout is disposable; dirty evidence is retained.
    process.once('exit', () => {
      try { run(['git', 'worktree', 'remove', worktree]) }
      catch { console.error(`Worktree retained for inspection: ${worktree}`) }
    })
  }
  const receiptFile = join(evidence, 'gate.jsonl')
  const log = join(evidence, 'check.log')
  console.error(`Exact-head gate ${head}; evidence ${evidence}; worktree ${worktree}`)
  // A regular log file lets gate-slot retain its native diagnostics without a pipe.
  const logFd = openSync(log, 'wx', 0o600)
  try {
    run(['gate-slot', '--class', 'gate', '--guard-git-config', '--max-wait-mode', 'admissible', '--', ...command], {
      cwd: worktree,
      env: { ...process.env, GATE_SLOTS_RECEIPT_FILE: receiptFile },
      stdio: ['ignore', logFd, logFd],
    })
  } finally {
    closeSync(logFd)
  }
  const receipts = readFileSync(receiptFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const receipt = receipts.findLast((value) => passingReceipt(value, head))
  if (!receipt) throw new Error(`No passing exact-head receipt; inspect ${evidence}`)
  if (view().headRefOid !== head) throw new Error('PR head moved during gate; receipt not posted and enqueue refused')
  // Allowlist public evidence: never publish hostnames, worktree paths, argv environments or logs.
  const publicReceipt = {
    schema: 'check-quick-receipt/v1', repository: repo, pr: Number(pr), head,
    execution: 'local', gateSchema: receipt.schema, class: receipt.class,
    cmd: receipt.cmd, treeStart: receipt.treeStart, headStart: receipt.headStart,
    headEnd: receipt.headEnd, cleanStart: true, cleanEnd: true, exact: true,
    startedAt: receipt.startedAt, endedAt: receipt.endedAt, exit: 0,
    failedTasks: [], notRunTasks: 0,
    failedTasksTruncated: false, incompleteTasks: [],
    incompleteTasksTruncated: false, taskTraceTruncated: false,
  }
  const payload = JSON.stringify(publicReceipt)
  const digest = createHash('sha256').update(payload).digest('hex')
  const body = join(evidence, 'comment.md')
  writeFileSync(body, `Passing LOCAL exact-head check:quick receipt. Native queue checks and independent review remain required.\n\n<!-- check-quick-receipt/v1 sha256=${digest} -->\n\n\`\`\`json\n${payload}\n\`\`\`\n`, { mode: 0o600 })
  run(['gh', 'pr', 'comment', pr, '-R', repo, '--body-file', body], { stdio: 'inherit' })
  if (!receiptOnly) {
    // Run only by the repository's authorized enqueuer. Never auto-merge or bypass protection.
    run(['gh', 'pr', 'merge', pr, '-R', repo, '--match-head-commit', head], { stdio: 'inherit' })
  }
  console.log(JSON.stringify({ pr: Number(pr), head, receiptSha256: digest, enqueueRequested: !receiptOnly, wallSeconds: (performance.now() - started) / 1000, evidence }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
