#!/usr/bin/env bun

/**
 * Reference implementation demonstrating CLI output style guide.
 *
 * Run: bun reference-output.ts
 *
 * @see CLI_STYLE_GUIDE.md for the full specification
 */

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  black: '\x1b[30m',
}

const styled = {
  bold: (s: string) => `${c.bold}${s}${c.reset}`,
  dim: (s: string) => `${c.dim}${s}${c.reset}`,
  red: (s: string) => `${c.red}${s}${c.reset}`,
  green: (s: string) => `${c.green}${s}${c.reset}`,
  yellow: (s: string) => `${c.yellow}${s}${c.reset}`,
  blue: (s: string) => `${c.blue}${s}${c.reset}`,
  cyan: (s: string) => `${c.cyan}${s}${c.reset}`,
  magenta: (s: string) => `${c.magenta}${s}${c.reset}`,
}

/** Render a truncated list with "+ N more" indicator */
// oxlint-disable-next-line overeng/named-args -- simple formatter with clear positional args
const renderList = (items: string[], max: number, indent: string) => {
  const shown = items.slice(0, max)
  const remaining = items.length - max
  for (const item of shown) {
    console.log(`${indent}${styled.cyan(item)}`)
  }
  if (remaining > 0) {
    console.log(`${indent}${styled.dim(`+ ${remaining} more`)}`)
  }
}

// Sample data demonstrating various list lengths
const manyPackages = [
  '@scope/package-one',
  '@scope/package-two',
  '@scope/package-three',
  '@scope/package-four',
  '@scope/package-five',
  '@scope/package-six',
  '@scope/package-seven',
  '@scope/package-eight',
  '@scope/package-nine',
  '@scope/package-ten',
  '@scope/package-eleven',
  '@scope/package-twelve',
]

const fewPackages = ['@scope/util-a', '@scope/util-b', '@scope/util-c']

const main = () => {
  // Context header
  console.log(styled.dim('my-workspace'))
  console.log()

  // CRITICAL section - blocking issues
  console.log(`${c.bgRed}${c.white}${c.bold} CRITICAL ${c.reset}`)
  console.log()

  console.log(`  ${styled.bold('missing-dep')} ${styled.dim('missing')}`)
  console.log(`    ${styled.dim('Required by: project-a, project-b')}`)
  console.log(`    ${styled.cyan('fix:')} git clone <url> repos/missing-dep`)
  console.log(`    ${styled.cyan('fix:')} tool clone missing-dep`)
  console.log(`    ${styled.dim('skip:')} tool ignore missing-dep`)
  console.log()

  // WARNING section - needs attention
  console.log(`${c.bgYellow}${c.black}${c.bold} WARNING ${c.reset}`)
  console.log()

  console.log(
    `  ${styled.bold('project-a')} ${styled.dim('diverged')} ${styled.dim('(local: abc1234, remote: def5678)')}`,
  )
  console.log(`    ${styled.cyan('fix:')} cd project-a && git pull --rebase`)
  console.log(`    ${styled.cyan('fix:')} tool sync project-a`)
  console.log(`    ${styled.dim('skip:')} tool ignore project-a --diverged`)
  console.log()

  console.log(`  ${styled.bold('3 repos')} ${styled.dim('have uncommitted changes')}`)
  console.log(`    ${styled.dim('project-a, project-b, project-c')}`)
  console.log(`    ${styled.cyan('fix:')} tool commit -a`)
  console.log(`    ${styled.cyan('fix:')} git status <repo> ${styled.dim('to review')}`)
  console.log()

  // Separator
  console.log(styled.dim('─'.repeat(40)))
  console.log()

  // Main content - repos with various states
  // Clean repo with default branch
  console.log(
    `${styled.bold('project-a')} ${styled.green('main')}${styled.dim('@abc1234')} ${styled.yellow('*')} ${styled.red('↕def5678')} ${styled.dim('← shared-lib')}`,
  )
  console.log()

  // Repo with feature branch and many packages
  console.log(
    `${styled.bold('project-b')} ${styled.magenta('feature/new')}${styled.dim('@789abcd')} ${styled.yellow('*')} ${styled.dim('← shared-lib')}`,
  )
  console.log(`  ${styled.dim(`packages(${manyPackages.length}):`)}`)
  renderList(manyPackages, 5, '    ')
  console.log()

  // Repo with detached HEAD and few packages
  console.log(
    `${styled.bold('project-c')} ${styled.blue('HEAD')}${styled.dim('@fedcba9')} ${styled.yellow('*')} ${styled.dim('← shared-lib')}`,
  )
  console.log(`  ${styled.dim(`packages(${fewPackages.length}):`)}`)
  renderList(fewPackages, 5, '    ')
  console.log()

  // Clean repo (no status symbols)
  console.log(`${styled.bold('shared-lib')} ${styled.green('main')}${styled.dim('@1234567')}`)
  console.log()

  // Summary line
  console.log(styled.dim('4 members · 1 dep'))
}

main()
