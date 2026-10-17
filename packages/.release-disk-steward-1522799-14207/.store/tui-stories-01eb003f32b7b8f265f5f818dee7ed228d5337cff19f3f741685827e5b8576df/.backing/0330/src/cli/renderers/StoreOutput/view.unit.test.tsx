import React from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '@overeng/tui-react'

import type { StoreGcResult } from './schema.ts'
import { StoreGcResultRow, StoreGcView } from './view.tsx'

const generatedResult = {
  repo: 'github.com/acme/widget/',
  ref: 'feature/artifacts',
  refType: 'heads',
  path: '/store/github.com/acme/widget/refs/heads/feature/artifacts/node_modules',
  status: 'kept',
  reason: 'eligible',
  kind: 'generated-artifact',
  artifactClass: 'node_modules',
  workspacePath: '/store/github.com/acme/widget/refs/heads/feature/artifacts',
  allocatedBytes: 1024,
  exclusiveClosureBytes: 1024,
  outcome: 'would-delete',
  mtimeMs: 0,
} satisfies StoreGcResult

describe('StoreGcResultRow', () => {
  test('renders a generated-artifact dry-run candidate as a deletion', async () => {
    const output = await renderToString({
      element: <StoreGcResultRow result={generatedResult} dryRun={true} />,
      options: { width: 200 },
    })

    expect(output).toContain(`${generatedResult.workspacePath}/node_modules`)
    expect(output).toContain('(would delete)')
    expect(output).not.toContain('(kept: eligible)')
  })

  test('counts a generated-artifact dry-run candidate in the deletion summary', async () => {
    const output = await renderToString({
      element: (
        <StoreGcView
          basePath="/store"
          results={[generatedResult]}
          dryRun={true}
          showForceHint={false}
          done={true}
        />
      ),
      options: { width: 200 },
    })

    expect(output).toContain('1 would be removed')
    expect(output).not.toContain('1 kept')
  })

  test('renders failed-closed generated artifacts as unknown', async () => {
    const unknown = {
      ...generatedResult,
      reason: 'agent-liveness-unavailable',
      outcome: 'unknown',
    } satisfies StoreGcResult
    const output = await renderToString({
      element: (
        <StoreGcView
          basePath="/store"
          results={[unknown]}
          dryRun={true}
          showForceHint={false}
          done={true}
        />
      ),
      options: { width: 200 },
    })

    expect(output).toContain('(unknown: agent-liveness-unavailable)')
    expect(output).toContain('1 unknown')
    expect(output).not.toContain('1 kept')
  })
})
