import { deepStrictEqual, equal, throws } from 'node:assert/strict'
import { test } from 'node:test'

import { assembleChangelog, checkPrCoverage, parseFragment } from './changelog.mjs'

const fragment = (name) => parseFragment({ name, content: '- A change.\n' })

const released = '## 1.0.0\n\n### Fixed\n\n- Historical entry.\n'
const changelog = `# Changelog\n\n## Unreleased\n\n### Added\n\n- Existing addition.\n\n### Fixed\n\n- Existing fix.\n\n${released}`

test('assembles sorted fragments into existing sections and preserves history', () => {
  equal(
    assembleChangelog({
      changelog,
      fragments: [
        parseFragment({ name: 'z-last.fixed.md', content: '- Last fix.\n  Continued detail.' }),
        parseFragment({ name: 'new-feature.added.md', content: '- New addition.' }),
        parseFragment({ name: 'a-first.fixed.md', content: '- First fix.' }),
      ],
    }),
    `# Changelog\n\n## Unreleased\n\n### Added\n\n- New addition.\n- Existing addition.\n\n### Fixed\n\n- First fix.\n- Last fix.\n  Continued detail.\n- Existing fix.\n\n${released}`,
  )
})

test('creates missing sections in the existing taxonomy order', () => {
  equal(
    assembleChangelog({
      changelog: `# Changelog\n\n## Unreleased\n\n${released}`,
      fragments: [
        fragment('remove-api.removed.md'),
        fragment('fix-api.fixed.md'),
        fragment('add-api.added.md'),
        fragment('change-api.changed.md'),
      ],
    }),
    `# Changelog\n\n## Unreleased\n\n### Added\n\n- A change.\n\n### Fixed\n\n- A change.\n\n### Changed\n\n- A change.\n\n### Removed\n\n- A change.\n\n${released}`,
  )
})

test('does nothing without fragments, including after a release assembly', () => {
  equal(assembleChangelog({ changelog, fragments: [] }), changelog)
})

test('rejects ambiguous or unsupported changelog headings', () => {
  for (const text of [
    '# Changelog\n',
    '## Unreleased\n\n## Unreleased\n',
    '## Unreleased\n\n### Fixed\n\n### Fixed\n',
    '## Unreleased\n\n### Typo\n',
  ])
    throws(() => assembleChangelog({ changelog: text, fragments: [] }), /Unreleased/)
})

test('accepts slug names, Markdown links, multiline entries and multiple bullets', () => {
  deepStrictEqual(
    parseFragment({
      name: 'cache-admission.fixed.md',
      content: '- Fix [cache](https://example.com).\n  More detail.\n- Another fix.\n',
    }),
    {
      name: 'cache-admission.fixed.md',
      section: 'Fixed',
      body: '- Fix [cache](https://example.com).\n  More detail.\n- Another fix.',
    },
  )
})

test('rejects invalid names, empty entries, comments-only entries and headings', () => {
  for (const name of [
    '123.md',
    'slug.unknown.md',
    'slug.Fixed.md',
    '../escape.fixed.md',
    'slug.with-dots.fixed.md',
  ])
    throws(() => fragment(name), /Invalid fragment name/)
  for (const content of ['', '  \n', '<!-- - Write a change. -->', '- <!-- placeholder -->'])
    throws(() => parseFragment({ name: 'slug.fixed.md', content }), /Empty fragment/)
  for (const content of ['Not a bullet.', '- Change.\n\n## Injected heading'])
    throws(() => parseFragment({ name: 'slug.fixed.md', content }), /fragment/)
})

test('requires a genuinely added valid fragment, not a README or modified fragment', () => {
  const fragments = [fragment('feature.added.md')]
  equal(
    checkPrCoverage({ addedPaths: ['changelog.d/feature.added.md'], fragments, trailers: '' }),
    'PR adds a changelog fragment',
  )
  for (const addedPaths of [[], ['changelog.d/README.md'], ['changelog.d/other.added.md']])
    throws(() => checkPrCoverage({ addedPaths, fragments, trailers: '' }), /PR must add/)
})

test('permits an explicit nonempty no-user-facing-change trailer', () => {
  equal(
    checkPrCoverage({ addedPaths: [], fragments: [], trailers: 'Changelog-None: Tests only\n' }),
    'Changelog exemption: Tests only',
  )
  for (const trailers of [
    'Changelog-None:\n',
    'Changelog-None:   \n',
    'Text mentions Changelog-None: Tests only\n',
  ])
    throws(() => checkPrCoverage({ addedPaths: [], fragments: [], trailers }), /PR must add/)
})
