// One-time Notion browser login. Launches Playwright HEADFUL so a human logs in
// once (SSO — the harness cannot do this itself), then persists the browser
// `storageState` to demo/harness/.auth/storageState.json (GITIGNORED — it is a
// credential). Every harness run afterwards reuses it for evidence screenshots.
//
//   bun demo/harness/login.ts
//
// Re-run any time the saved session expires.

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { run } from './exec.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const AUTH_DIR = join(HERE, '.auth')
const STORAGE_STATE = join(AUTH_DIR, 'storageState.json')
const PW = process.env.PLAYWRIGHT_CLI ?? 'playwright-cli'
const SESSION = 'notion-login'

const pw = (args: readonly string[]) =>
  run(PW, [`-s=${SESSION}`, ...args], { timeoutMs: 120_000 })

const main = async (): Promise<void> => {
  mkdirSync(AUTH_DIR, { recursive: true })

  console.log('▶ opening a headful browser at Notion login…')
  const opened = await pw(['open', '--headed', 'https://www.notion.so/login'])
  if (opened.code !== 0) {
    console.error(opened.stderr || opened.stdout)
    throw new Error('failed to launch headful browser')
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  await rl.question(
    '\n  1. Log into Notion in the opened window (email / SSO).\n' +
      '  2. Wait until your workspace is fully loaded.\n' +
      '  3. Then press Enter here to save the session… ',
  )
  rl.close()

  console.log('▶ saving storageState…')
  const saved = await pw(['state-save', STORAGE_STATE])
  await pw(['close']).catch(() => {})
  if (saved.code !== 0) {
    console.error(saved.stderr || saved.stdout)
    throw new Error('failed to save storageState')
  }
  console.log(`✓ saved: ${STORAGE_STATE}`)
  console.log('  (gitignored — never commit this file)')
  console.log('\nNext: bun demo/md/e2e.spec.ts')
}

main().catch((e) => {
  console.error(String(e))
  process.exit(1)
})
