/**
 * Storybook stories for SyncOutput component.
 *
 * These stories demonstrate the various states of the sync command output.
 * Supports both TTY (terminal preview) and non-TTY (string output) modes.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useEffect, useRef } from 'react'
import { renderToString } from '@overeng/tui-react'
import { xtermTheme, containerStyles } from '@overeng/tui-react/storybook'
import { forceColorLevel } from '@overeng/cli-ui'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  SyncOutput,
  type SyncOutputProps,
  type MemberSyncResult,
} from './SyncOutput.tsx'

// =============================================================================
// Example Data
// =============================================================================

const exampleSyncResults: MemberSyncResult[] = [
  { name: 'effect', status: 'already_synced' },
  { name: 'effect-utils', status: 'synced', ref: 'main' },
  { name: 'livestore', status: 'cloned', ref: 'main' },
  { name: 'dotfiles', status: 'updated', commit: 'abc1234def', previousCommit: '9876543fed' },
  { name: 'private-repo', status: 'skipped', message: 'dirty worktree' },
]

const exampleSyncResultsWithErrors: MemberSyncResult[] = [
  { name: 'effect', status: 'synced', ref: 'main' },
  { name: 'broken-repo', status: 'error', message: 'network timeout' },
  { name: 'missing-repo', status: 'error', message: 'repository not found' },
  { name: 'effect-utils', status: 'already_synced' },
]

const exampleAllSynced: MemberSyncResult[] = [
  { name: 'effect', status: 'already_synced' },
  { name: 'effect-utils', status: 'already_synced' },
  { name: 'livestore', status: 'already_synced' },
  { name: 'dotfiles', status: 'already_synced' },
  { name: 'schickling.dev', status: 'already_synced' },
]

// Force colors on in Storybook (browser environment has no TTY)
forceColorLevel('truecolor')

// =============================================================================
// Non-TTY Preview Component
// =============================================================================

/**
 * Preview component that shows the string output (non-TTY mode).
 * Uses renderToString to generate the ANSI output, then renders it in xterm.js.
 */
const StringOutputPreview = (props: SyncOutputProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    // Initialize terminal if not already done
    if (!terminalRef.current) {
      const terminal = new Terminal({
        fontFamily: 'Monaco, Menlo, "DejaVu Sans Mono", Consolas, monospace',
        fontSize: 14,
        theme: xtermTheme,
        allowProposedApi: true,
        cursorBlink: false,
        cursorStyle: 'bar',
        disableStdin: true,
      })

      const fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)
      terminal.open(containerRef.current)
      fitAddon.fit()

      terminalRef.current = terminal
    }

    // Render to string and write to terminal
    const terminal = terminalRef.current
    terminal.clear()
    terminal.reset()

    renderToString(React.createElement(SyncOutput, props))
      .then((ansiOutput) => {
        // Write each line to terminal
        const lines = ansiOutput.split('\n')
        lines.forEach((line, i) => {
          terminal.write(line)
          if (i < lines.length - 1) {
            terminal.write('\r\n')
          }
        })
      })
      .catch((err: Error) => {
        terminal.write(`Error: ${err.message}`)
      })

    return () => {
      // Don't dispose terminal on prop changes, only on unmount
    }
  }, [props])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      terminalRef.current?.dispose()
      terminalRef.current = null
    }
  }, [])

  return <div ref={containerRef} style={containerStyles} />
}

// =============================================================================
// Meta Configuration
// =============================================================================

/** Extended props with render mode toggle */
interface SyncOutputStoryProps extends SyncOutputProps {
  /** Render mode: tty (terminal) or string (non-TTY) */
  renderMode: 'tty' | 'string'
}

const meta: Meta<SyncOutputStoryProps> = {
  title: 'CLI/Sync Output',
  component: SyncOutput,
  parameters: {
    docs: {
      description: {
        component: `
Sync command output rendered with React components. This is a 1:1 port of sync-renderer.ts.

**Render Modes:**
- **TTY**: Renders in a terminal emulator (xterm.js) - used for interactive terminals
- **String**: Shows the raw string output from \`renderToString\` - used for non-TTY (pipes, redirects)
        `,
      },
    },
  },
  argTypes: {
    renderMode: {
      description: 'Switch between TTY (terminal) and non-TTY (string) output',
      control: { type: 'radio' },
      options: ['tty', 'string'],
      table: {
        category: 'Render Mode',
      },
    },
    dryRun: {
      description: 'Dry run mode - shows what would happen without making changes',
      control: { type: 'boolean' },
      table: { category: 'Sync Options' },
    },
    frozen: {
      description: 'Frozen mode (CI) - use exact commits from lock file',
      control: { type: 'boolean' },
      table: { category: 'Sync Options' },
    },
    pull: {
      description: 'Pull mode - fetch and update to latest remote commits',
      control: { type: 'boolean' },
      table: { category: 'Sync Options' },
    },
    deep: {
      description: 'Deep sync - recursively sync nested megarepos',
      control: { type: 'boolean' },
      table: { category: 'Sync Options' },
    },
  },
  args: {
    renderMode: 'tty',
    dryRun: false,
    frozen: false,
    pull: false,
    deep: false,
  },
  // Custom render function to handle mode switching
  render: ({ renderMode, ...props }) => {
    if (renderMode === 'string') {
      return <StringOutputPreview {...props} />
    }
    // TTY mode uses the default terminal preview from the decorator
    return <SyncOutput {...props} />
  },
}

export default meta

type Story = StoryObj<SyncOutputStoryProps>

// =============================================================================
// Basic Stories
// =============================================================================

/**
 * Mixed results showing various sync statuses.
 */
export const MixedResults: Story = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    results: exampleSyncResults,
    nestedMegarepos: ['effect-utils'],
    generatedFiles: ['flake.nix', '.envrc'],
  },
}

/**
 * Dry run mode - shows what would happen.
 */
export const DryRun: Story = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    results: [
      { name: 'new-repo', status: 'cloned', ref: 'main' },
      { name: 'effect', status: 'synced', ref: 'main' },
      { name: 'effect-utils', status: 'already_synced' },
    ],
    dryRun: true,
    generatedFiles: ['flake.nix'],
  },
}

/**
 * All repos already synced - nothing to do.
 */
export const AllSynced: Story = {
  args: {
    name: 'mr-all-blue',
    root: '/Users/dev/mr-all-blue',
    results: exampleAllSynced,
    dryRun: true,
  },
}

/**
 * Sync with errors.
 */
export const WithErrors: Story = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    results: exampleSyncResultsWithErrors,
  },
}

/**
 * Frozen mode (CI).
 */
export const FrozenMode: Story = {
  args: {
    name: 'ci-workspace',
    root: '/home/runner/workspace',
    results: [
      { name: 'effect', status: 'synced', ref: 'main', commit: 'abc1234' },
      { name: 'effect-utils', status: 'synced', ref: 'main', commit: 'def5678' },
      { name: 'livestore', status: 'cloned', ref: 'v1.0.0', commit: '9876543' },
    ],
    frozen: true,
  },
}

/**
 * Pull mode with updates.
 */
export const PullMode: Story = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    results: [
      { name: 'effect', status: 'updated', commit: 'abc1234def', previousCommit: '9876543fed' },
      { name: 'effect-utils', status: 'updated', commit: 'def5678abc', previousCommit: 'fedcba987' },
      { name: 'livestore', status: 'already_synced' },
    ],
    pull: true,
  },
}

/**
 * Lock updates.
 */
export const LockUpdates: Story = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    results: [
      { name: 'effect', status: 'locked', commit: 'abc1234def', previousCommit: '9876543fed' },
      { name: 'effect-utils', status: 'locked', commit: 'def5678abc', previousCommit: 'fedcba987' },
      { name: 'livestore', status: 'already_synced' },
    ],
  },
}

/**
 * Removed members (orphaned symlinks).
 */
export const RemovedMembers: Story = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    results: [
      { name: 'effect', status: 'synced', ref: 'main' },
      { name: 'old-repo', status: 'removed', message: '/store/old-repo-abc123' },
      { name: 'deprecated', status: 'removed', message: '/store/deprecated-def456' },
    ],
  },
}

/**
 * Skipped members.
 */
export const SkippedMembers: Story = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    results: [
      { name: 'effect', status: 'synced', ref: 'main' },
      { name: 'dirty-repo', status: 'skipped', message: 'dirty worktree' },
      { name: 'pinned-repo', status: 'skipped', message: 'pinned' },
      { name: 'private-repo', status: 'skipped', message: 'authentication required' },
    ],
  },
}

/**
 * Deep sync with nested megarepos hint.
 */
export const NestedMegareposHint: Story = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    results: [
      { name: 'effect', status: 'synced', ref: 'main' },
      { name: 'effect-utils', status: 'synced', ref: 'main' },
      { name: 'livestore', status: 'synced', ref: 'main' },
    ],
    nestedMegarepos: ['effect-utils', 'livestore'],
    deep: false,
  },
}

/**
 * Deep sync mode (no hint shown).
 */
export const DeepSyncMode: Story = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    results: [
      { name: 'effect', status: 'synced', ref: 'main' },
      { name: 'effect-utils', status: 'synced', ref: 'main' },
      { name: 'livestore', status: 'synced', ref: 'main' },
    ],
    nestedMegarepos: ['effect-utils', 'livestore'],
    deep: true,
  },
}

/**
 * With generators enabled (nix + vscode).
 */
export const WithGenerators: Story = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    results: [
      { name: 'effect', status: 'synced', ref: 'main' },
      { name: 'effect-utils', status: 'synced', ref: 'main' },
      { name: 'livestore', status: 'cloned', ref: 'main' },
      { name: 'dotfiles', status: 'already_synced' },
    ],
    generatedFiles: [
      'flake.nix',
      'flake.lock',
      '.envrc.generated.megarepo',
      '.vscode/megarepo.code-workspace',
    ],
  },
}

/**
 * With generators in dry run mode.
 */
export const WithGeneratorsDryRun: Story = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    results: [
      { name: 'effect', status: 'synced', ref: 'main' },
      { name: 'effect-utils', status: 'synced', ref: 'main' },
      { name: 'livestore', status: 'cloned', ref: 'main' },
    ],
    dryRun: true,
    generatedFiles: [
      'flake.nix',
      'flake.lock',
      '.envrc.generated.megarepo',
      '.vscode/megarepo.code-workspace',
    ],
  },
}

/**
 * Many members (compact already synced).
 */
export const ManyMembers: Story = {
  args: {
    name: 'large-workspace',
    root: '/Users/dev/large-workspace',
    results: [
      { name: 'repo-01', status: 'already_synced' },
      { name: 'repo-02', status: 'already_synced' },
      { name: 'repo-03', status: 'already_synced' },
      { name: 'repo-04', status: 'already_synced' },
      { name: 'repo-05', status: 'already_synced' },
      { name: 'repo-06', status: 'already_synced' },
      { name: 'repo-07', status: 'already_synced' },
      { name: 'repo-08', status: 'already_synced' },
      { name: 'repo-09', status: 'already_synced' },
      { name: 'repo-10', status: 'already_synced' },
    ],
  },
}

// =============================================================================
// Edge Cases
// =============================================================================

/**
 * First sync - everything is new.
 */
export const FirstSync: Story = {
  args: {
    name: 'new-workspace',
    root: '/Users/dev/new-workspace',
    results: [
      { name: 'effect', status: 'cloned', ref: 'main' },
      { name: 'effect-utils', status: 'cloned', ref: 'main' },
      { name: 'livestore', status: 'cloned', ref: 'dev' },
      { name: 'dotfiles', status: 'cloned', ref: 'main' },
    ],
    generatedFiles: ['flake.nix', '.envrc.generated.megarepo'],
  },
}

/**
 * All errors - network outage scenario.
 */
export const AllErrors: Story = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    results: [
      { name: 'effect', status: 'error', message: 'network timeout' },
      { name: 'effect-utils', status: 'error', message: 'authentication failed' },
      { name: 'livestore', status: 'error', message: 'repository not found' },
      { name: 'private-repo', status: 'error', message: 'permission denied' },
    ],
  },
}

/**
 * Mixed skipped - various reasons.
 */
export const MixedSkipped: Story = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    results: [
      { name: 'effect', status: 'already_synced' },
      { name: 'dirty-repo', status: 'skipped', message: '5 uncommitted changes' },
      { name: 'pinned-repo', status: 'skipped', message: 'pinned to v1.0.0' },
      { name: 'auth-repo', status: 'skipped', message: 'authentication required' },
      { name: 'missing-ref', status: 'skipped', message: 'ref feature/x not found' },
    ],
  },
}

/**
 * Deep sync with multiple nested megarepos.
 */
export const DeepSyncHint: Story = {
  args: {
    name: 'mr-all-blue',
    root: '/Users/dev/mr-all-blue',
    results: [
      { name: 'effect', status: 'synced', ref: 'main' },
      { name: 'effect-utils', status: 'synced', ref: 'main' },
      { name: 'livestore', status: 'synced', ref: 'dev' },
      { name: 'dotfiles', status: 'already_synced' },
    ],
    nestedMegarepos: ['effect-utils', 'livestore', 'dotfiles'],
    deep: false, // Not deep, so show hint
  },
}

/**
 * Single member sync.
 */
export const SingleMember: Story = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    results: [
      { name: 'effect', status: 'synced', ref: 'main' },
    ],
  },
}

/**
 * Ref change updates with commit transitions.
 */
export const RefChanges: Story = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    results: [
      { name: 'effect', status: 'synced', ref: 'v3.1.0' },
      { name: 'effect-utils', status: 'updated', commit: 'abc1234', previousCommit: 'def5678' },
      { name: 'livestore', status: 'updated', commit: '1234567', previousCommit: '9876543' },
    ],
    pull: true,
  },
}

/**
 * Long member names.
 */
export const LongNames: Story = {
  args: {
    name: 'organization-name/extremely-long-workspace-name-for-testing',
    root: '/Users/dev/extremely-long-path-to-workspace-directory-for-testing-purposes',
    results: [
      { name: '@organization/extremely-long-package-name-for-testing', status: 'synced', ref: 'main' },
      { name: '@another-org/another-very-long-package-name', status: 'already_synced' },
      { name: 'short', status: 'cloned', ref: 'feature/very-long-branch-name-for-testing' },
    ],
  },
}

// =============================================================================
// Interactive Story with Controls
// =============================================================================

/** Extended props for Storybook controls */
interface InteractiveSyncOutputProps extends Omit<SyncOutputStoryProps, 'results'> {
  /** Number of cloned repos */
  clonedCount: number
  /** Number of synced repos */
  syncedCount: number
  /** Number of updated repos */
  updatedCount: number
  /** Number of already synced repos */
  alreadySyncedCount: number
  /** Number of skipped repos */
  skippedCount: number
  /** Number of error repos */
  errorCount: number
}

/**
 * Interactive story with controls to adjust sync state.
 */
export const Interactive: StoryObj<InteractiveSyncOutputProps> = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    renderMode: 'tty',
    clonedCount: 1,
    syncedCount: 2,
    updatedCount: 1,
    alreadySyncedCount: 3,
    skippedCount: 1,
    errorCount: 0,
  },
  argTypes: {
    clonedCount: {
      description: 'Number of cloned repos',
      control: { type: 'range', min: 0, max: 10, step: 1 },
      table: { category: 'Results' },
    },
    syncedCount: {
      description: 'Number of synced repos',
      control: { type: 'range', min: 0, max: 10, step: 1 },
      table: { category: 'Results' },
    },
    updatedCount: {
      description: 'Number of updated repos',
      control: { type: 'range', min: 0, max: 10, step: 1 },
      table: { category: 'Results' },
    },
    alreadySyncedCount: {
      description: 'Number of already synced repos',
      control: { type: 'range', min: 0, max: 10, step: 1 },
      table: { category: 'Results' },
    },
    skippedCount: {
      description: 'Number of skipped repos',
      control: { type: 'range', min: 0, max: 10, step: 1 },
      table: { category: 'Results' },
    },
    errorCount: {
      description: 'Number of error repos',
      control: { type: 'range', min: 0, max: 10, step: 1 },
      table: { category: 'Results' },
    },
  },
  render: ({
    renderMode,
    clonedCount,
    syncedCount,
    updatedCount,
    alreadySyncedCount,
    skippedCount,
    errorCount,
    ...args
  }) => {
    // Generate results based on counts
    const results: MemberSyncResult[] = []
    let idx = 0

    for (let i = 0; i < clonedCount; i++) {
      results.push({ name: `cloned-repo-${++idx}`, status: 'cloned', ref: 'main' })
    }
    for (let i = 0; i < syncedCount; i++) {
      results.push({ name: `synced-repo-${++idx}`, status: 'synced', ref: 'main' })
    }
    for (let i = 0; i < updatedCount; i++) {
      results.push({
        name: `updated-repo-${++idx}`,
        status: 'updated',
        commit: 'abc1234',
        previousCommit: 'def5678',
      })
    }
    for (let i = 0; i < alreadySyncedCount; i++) {
      results.push({ name: `already-synced-${++idx}`, status: 'already_synced' })
    }
    for (let i = 0; i < skippedCount; i++) {
      results.push({ name: `skipped-repo-${++idx}`, status: 'skipped', message: 'dirty worktree' })
    }
    for (let i = 0; i < errorCount; i++) {
      results.push({ name: `error-repo-${++idx}`, status: 'error', message: 'network error' })
    }

    const props = { ...args, results }

    if (renderMode === 'string') {
      return <StringOutputPreview {...props} />
    }
    return <SyncOutput {...props} />
  },
}
