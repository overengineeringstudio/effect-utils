/**
 * AlignmentOutput View
 *
 * Renders alignment coordinator status as a table.
 * Supports both TTY (live progress) and CI (markdown) modes.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, Spinner, useTuiAtomValue, useRenderConfig } from '@overeng/tui-react'

import { symbols } from '../../components/mod.ts'
import type { AlignmentState, MemberState, PollStatus } from './schema.ts'

export interface AlignmentViewProps {
  stateAtom: Atom.Atom<AlignmentState>
}

export const AlignmentView = ({ stateAtom }: AlignmentViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const { members, phase } = state

  if (members.length === 0 && phase === 'loading') {
    return (
      <Box>
        <Text dim>Loading alignment results...</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>Alignment Coordinator</Text>
      </Box>
      <Box>
        <Text dim>{''}</Text>
      </Box>
      <AlignmentTable members={members} phase={phase} />
      {phase === 'polling' && (
        <Box>
          <Text dim>{''}</Text>
        </Box>
      )}
      <FailedTaskDetails members={members} />
    </Box>
  )
}

// =============================================================================
// Table
// =============================================================================

const AlignmentTable = ({
  members,
  phase,
}: {
  members: readonly MemberState[]
  phase: string
}) => {
  const renderConfig = useRenderConfig()
  const isAnimated = renderConfig.animation

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text bold>
          <Cell width={24}>{'Member'}</Cell>
          <Cell width={22}>{'Tasks'}</Cell>
          <Cell width={18}>{'Changes'}</Cell>
          <Cell width={14}>{'PR'}</Cell>
          <Cell width={16}>{'Auto-merge'}</Cell>
          <Cell width={18}>{'Merge'}</Cell>
        </Text>
      </Box>
      {/* Separator */}
      <Box>
        <Text dim>{'─'.repeat(110)}</Text>
      </Box>
      {/* Rows */}
      {members.map((m) => (
        <Box key={m.name}>
          <Cell width={24}>
            <Text>{m.name}</Text>
          </Cell>
          <Cell width={22}>
            <TasksCell member={m} />
          </Cell>
          <Cell width={18}>
            <ChangesCell member={m} />
          </Cell>
          <Cell width={14}>
            <PRCell member={m} />
          </Cell>
          <Cell width={16}>
            <AutoMergeCell member={m} />
          </Cell>
          <Cell width={18}>
            <MergeCell member={m} phase={phase} isAnimated={isAnimated} />
          </Cell>
        </Box>
      ))}
    </Box>
  )
}

const Cell = ({ width, children }: { width: number; children: React.ReactNode }) => (
  <Box width={width}>{children}</Box>
)

// =============================================================================
// Cell renderers
// =============================================================================

const TasksCell = ({ member }: { member: MemberState }) => {
  if (member.taskStatus === 'skipped') return <Text dim>skipped</Text>
  if (!member.taskResults || member.taskResults.length === 0) return <Text dim>—</Text>

  const total = member.taskResults.length
  const ok = member.taskResults.filter((t) => t.status === 'ok').length
  const allOk = ok === total

  if (allOk) {
    return (
      <Text>
        {ok}/{total} <Text color="green">{symbols.check}</Text>
      </Text>
    )
  }

  const failed = member.taskResults.filter((t) => t.status !== 'ok').map((t) => t.name)
  return (
    <Text>
      {ok}/{total} <Text color="yellow">{symbols.warning}</Text>
      <Text dim> ({failed.join(', ')})</Text>
    </Text>
  )
}

const ChangesCell = ({ member }: { member: MemberState }) => {
  if (!member.prResult) return <Text dim>—</Text>
  const { status, filesChanged, safeOnly } = member.prResult

  if (status === 'no-changes') return <Text dim>no changes</Text>
  if (status === 'skipped') return <Text dim>skipped</Text>

  const count = filesChanged ?? 0
  if (safeOnly) {
    return (
      <Text>
        {count} files <Text dim>(safe)</Text>
      </Text>
    )
  }
  return (
    <Text>
      {count} files <Text color="yellow" bold>(review)</Text>
    </Text>
  )
}

const PRCell = ({ member }: { member: MemberState }) => {
  if (!member.prResult || !member.prResult.prNumber) return <Text dim>—</Text>
  return <Text>#{member.prResult.prNumber}</Text>
}

const AutoMergeCell = ({ member }: { member: MemberState }) => {
  if (!member.prResult?.autoMerge || member.prResult.autoMerge === 'n/a') {
    return <Text dim>—</Text>
  }

  switch (member.prResult.autoMerge) {
    case 'enabled':
      return (
        <Text color="green">
          {symbols.check} enabled
        </Text>
      )
    case 'needs-review':
      return (
        <Text color="yellow">
          {symbols.cross} needs review
        </Text>
      )
    case 'failed':
      return (
        <Text color="yellow">
          {symbols.warning} failed
        </Text>
      )
  }
}

const MergeCell = ({
  member,
  phase,
  isAnimated,
}: {
  member: MemberState
  phase: string
  isAnimated: boolean
}) => {
  if (!member.pollStatus) {
    if (phase === 'polling' && member.prResult?.prNumber) {
      return isAnimated ? (
        <Box>
          <Spinner type="dots" color="cyan" />
          <Text dim> polling</Text>
        </Box>
      ) : (
        <Text dim>polling...</Text>
      )
    }
    return <Text dim>—</Text>
  }

  return <PollStatusText status={member.pollStatus} isAnimated={isAnimated} />
}

const PollStatusText = ({
  status,
  isAnimated,
}: {
  status: PollStatus
  isAnimated: boolean
}) => {
  switch (status) {
    case 'merged':
      return (
        <Text color="green">
          {symbols.check} merged
        </Text>
      )
    case 'checks_passed':
      return (
        <Text color="green">
          {symbols.check} checks passed
        </Text>
      )
    case 'checks_failed':
      return (
        <Text color="red">
          {symbols.cross} checks failed
        </Text>
      )
    case 'closed':
      return (
        <Text color="red">
          {symbols.cross} closed
        </Text>
      )
    case 'pending':
      return isAnimated ? (
        <Box>
          <Spinner type="dots" color="cyan" />
          <Text dim> pending</Text>
        </Box>
      ) : (
        <Text dim>pending...</Text>
      )
    case 'timeout':
      return (
        <Text color="yellow">
          {symbols.warning} timeout
        </Text>
      )
    case 'no_pr':
      return <Text dim>—</Text>
  }
}

// =============================================================================
// Failed Task Details (collapsible in markdown)
// =============================================================================

const FailedTaskDetails = ({ members }: { members: readonly MemberState[] }) => {
  const hasFailedDetails = members.some(
    (m) => m.failedTaskDetails && m.failedTaskDetails.length > 0,
  )
  if (!hasFailedDetails) return null

  return (
    <Box flexDirection="column">
      <Box>
        <Text dim>{''}</Text>
      </Box>
      <Box>
        <Text bold dim>
          Failed task details:
        </Text>
      </Box>
      {members.map((m) =>
        m.failedTaskDetails?.map((detail) => (
          <Box key={`${m.name}-${detail.taskName}`} flexDirection="column">
            <Box>
              <Text color="yellow">
                {symbols.warning} {m.name}/{detail.taskName}
              </Text>
            </Box>
            <Box>
              <Text dim>{detail.output}</Text>
            </Box>
          </Box>
        )),
      )}
    </Box>
  )
}

// =============================================================================
// Markdown rendering (for GITHUB_STEP_SUMMARY)
// =============================================================================

/** Render alignment state as a GitHub-flavored markdown string */
export const renderMarkdownSummary = (state: AlignmentState): string => {
  const lines: string[] = []
  lines.push('## Alignment Coordinator')
  lines.push('')
  lines.push('| Member | Tasks | Changes | PR | Auto-merge | Merge |')
  lines.push('|--------|-------|---------|----|------------|-------|')

  for (const m of state.members) {
    const tasksCol = formatTasksMarkdown(m)
    const changesCol = formatChangesMarkdown(m)
    const prCol = formatPRMarkdown(m)
    const autoCol = formatAutoMergeMarkdown(m)
    const mergeCol = formatMergeMarkdown(m)
    lines.push(`| ${m.name} | ${tasksCol} | ${changesCol} | ${prCol} | ${autoCol} | ${mergeCol} |`)
  }

  // Task details collapsible
  const membersWithFailures = state.members.filter(
    (m) => m.failedTaskDetails && m.failedTaskDetails.length > 0,
  )
  if (membersWithFailures.length > 0) {
    lines.push('')
    lines.push('<details><summary>Task details</summary>')
    lines.push('')

    for (const m of state.members) {
      if (!m.taskResults || m.taskResults.length === 0) continue

      const taskParts = m.taskResults.map(
        (t) => `${t.name} ${t.status === 'ok' ? '✓' : '⚠'}`,
      )
      lines.push(`**${m.name}**: ${taskParts.join(' · ')}  `)

      if (m.failedTaskDetails) {
        for (const detail of m.failedTaskDetails) {
          lines.push('')
          lines.push(`<details><summary><code>${detail.taskName}</code> error output (${m.name})</summary>`)
          lines.push('')
          lines.push('```')
          lines.push(detail.output)
          lines.push('```')
          lines.push('')
          lines.push('</details>')
        }
      }
    }

    lines.push('')
    lines.push('</details>')
  }

  return lines.join('\n')
}

const formatTasksMarkdown = (m: MemberState): string => {
  if (m.taskStatus === 'skipped') return 'skipped'
  if (!m.taskResults || m.taskResults.length === 0) return '—'

  const total = m.taskResults.length
  const ok = m.taskResults.filter((t) => t.status === 'ok').length
  if (ok === total) return `${ok}/${total} ✓`

  const failed = m.taskResults.filter((t) => t.status !== 'ok').map((t) => t.name)
  return `${ok}/${total} ⚠ (${failed.join(', ')})`
}

const formatChangesMarkdown = (m: MemberState): string => {
  if (!m.prResult) return '—'
  if (m.prResult.status === 'no-changes') return 'no changes'
  if (m.prResult.status === 'skipped') return 'skipped'

  const count = m.prResult.filesChanged ?? 0
  if (m.prResult.safeOnly) return `${count} files (safe)`
  return `${count} files (**review**)`
}

const formatPRMarkdown = (m: MemberState): string => {
  if (!m.prResult?.prNumber) return '—'
  if (m.prResult.prUrl) return `[#${m.prResult.prNumber}](${m.prResult.prUrl})`
  return `#${m.prResult.prNumber}`
}

const formatAutoMergeMarkdown = (m: MemberState): string => {
  if (!m.prResult?.autoMerge || m.prResult.autoMerge === 'n/a') return '—'
  switch (m.prResult.autoMerge) {
    case 'enabled':
      return '✓ enabled'
    case 'needs-review':
      return '✗ needs review'
    case 'failed':
      return '⚠ failed'
  }
}

const formatMergeMarkdown = (m: MemberState): string => {
  if (!m.pollStatus) return '—'
  switch (m.pollStatus) {
    case 'merged':
      return '✓ merged'
    case 'checks_passed':
      return '✓ checks passed'
    case 'checks_failed':
      return '✗ checks failed'
    case 'closed':
      return '✗ closed'
    case 'pending':
      return '⏳ pending'
    case 'timeout':
      return '⚠ timeout'
    case 'no_pr':
      return '—'
  }
}
