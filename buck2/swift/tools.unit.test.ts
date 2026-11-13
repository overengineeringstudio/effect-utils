import { describe, expect, it } from 'vitest'

import { renderInfoPlist } from './info-plist.ts'
import { embedBuildStamp } from './stamp.ts'
import { discoverTests, renderTestMain } from './test-main.ts'
import { parseXCTestOutput, testVerdict } from './test-verdict.ts'

describe('Swift build stamp', () => {
  const stamp = '{"type":"nix","version":"0.1.0","rev":"7d5211e","commitTs":1,"dirty":false}'

  it('embeds the stamp JSON as the one placeholder string literal', () => {
    const source = 'let baseVersion = "0.1.0"\nlet embeddedBuildStamp = "__CLI_BUILD_STAMP__"\n'
    const stamped = embedBuildStamp({ source, placeholder: '__CLI_BUILD_STAMP__', stamp })
    expect(stamped).toBe(`let baseVersion = "0.1.0"\nlet embeddedBuildStamp = ${JSON.stringify(stamp)}\n`)
  })

  it.each([
    ['no placeholder', 'let x = 1\n'],
    ['two placeholders', '"__CLI_BUILD_STAMP__" + "__CLI_BUILD_STAMP__"'],
  ])('fails closed with %s', (_, source) => {
    expect(() => embedBuildStamp({ source, placeholder: '__CLI_BUILD_STAMP__', stamp })).toThrow()
  })

  it('rejects a stamp that is not single-line JSON', () => {
    const source = '"__CLI_BUILD_STAMP__"'
    expect(() => embedBuildStamp({ source, placeholder: '__CLI_BUILD_STAMP__', stamp: 'not json' })).toThrow()
    expect(() => embedBuildStamp({ source, placeholder: '__CLI_BUILD_STAMP__', stamp: '{}\n{}' })).toThrow()
  })
})

describe('XCTest entry point from the symbol graph', () => {
  const method = (owner: string, name: string, keywords: string[]) => ({
    kind: { identifier: 'swift.method' },
    identifier: { precise: `${owner}.${name}` },
    names: { title: `${name}()` },
    declarationFragments: keywords.map((spelling) => ({ kind: 'keyword', spelling })),
  })
  const graph = {
    module: { name: 'CoreTests' },
    symbols: [
      { kind: { identifier: 'swift.class' }, identifier: { precise: 'B' }, names: { title: 'BaseTests' } },
      { kind: { identifier: 'swift.class' }, identifier: { precise: 'Z' }, names: { title: 'ZTests' } },
      { kind: { identifier: 'swift.class' }, identifier: { precise: 'H' }, names: { title: 'Helper' } },
      method('B', 'testShared', ['func']),
      method('Z', 'testSync', ['func']),
      method('Z', 'testAsync', ['func', 'async', 'throws']),
      method('Z', 'helper', ['func']),
      { ...method('Z', 'testWith', ['func']), names: { title: 'testWith(_:)' } },
      method('H', 'testNotACase', ['func']),
    ],
    relationships: [
      { kind: 'inheritsFrom', source: 'B', target: 's:6XCTest0A4CaseC' },
      { kind: 'inheritsFrom', source: 'Z', target: 'B' },
      ...['B.testShared', 'Z.testSync', 'Z.testAsync', 'Z.helper', 'Z.testWith'].map((source) => ({
        kind: 'memberOf',
        source,
        target: source.split('.')[0]!,
      })),
      { kind: 'memberOf', source: 'H.testNotACase', target: 'H' },
    ],
  }

  it('lists XCTestCase subclasses with own and inherited zero-argument test methods', () => {
    expect(discoverTests(graph)).toEqual([
      { className: 'BaseTests', methods: [{ name: 'testShared', isAsync: false }] },
      {
        className: 'ZTests',
        methods: [
          { name: 'testAsync', isAsync: true },
          { name: 'testShared', isAsync: false },
          { name: 'testSync', isAsync: false },
        ],
      },
    ])
  })

  it('renders an XCTMain entry point that wraps async tests', () => {
    const main = renderTestMain({ module: 'CoreTests', cases: discoverTests(graph) })
    expect(main).toContain('@testable import CoreTests')
    expect(main).toContain('("testAsync", asyncTest(ZTests.testAsync)),')
    expect(main).toContain('("testSync", ZTests.testSync),')
    expect(main).toContain('await XCTMain([')
  })

  it('fails closed when a module declares no tests', () => {
    expect(() => renderTestMain({ module: 'CoreTests', cases: [] })).toThrow()
  })
})

describe('XCTest verdict', () => {
  const output = [
    "Test Suite 'All tests' started at 2026-11-13 14:43:28.980",
    "Test Case 'ZTests.testSync' started at 2026-11-13 14:43:28.981",
    "Test Case 'ZTests.testSync' passed (0.001 seconds)",
    "Test Case 'ZTests.testFails' started at 2026-11-13 14:43:28.982",
    'Tests/ZTests.swift:12: error: ZTests.testFails : XCTAssertEqual failed: ("1") is not equal to ("2") - ',
    "Test Case 'ZTests.testFails' failed (0.002 seconds)",
    "Test Case 'ATests.testSkip' skipped (0.000 seconds)",
  ].join('\n')

  it('groups results by test case class without timings', () => {
    expect(parseXCTestOutput(output)).toEqual([
      { suite: 'ATests', tests: [{ name: 'testSkip', status: 'skipped', failures: [] }] },
      {
        suite: 'ZTests',
        tests: [
          {
            name: 'testFails',
            status: 'failed',
            failures: ['Tests/ZTests.swift:12: XCTAssertEqual failed: ("1") is not equal to ("2") - '],
          },
          { name: 'testSync', status: 'passed', failures: [] },
        ],
      },
    ])
  })

  it('cross-checks the exit status and never accepts an empty run', () => {
    const suites = parseXCTestOutput(output)
    expect(testVerdict({ suites, status: 1 })).toBe('fail')
    expect(() => testVerdict({ suites, status: 0 })).toThrow()
    const passing = parseXCTestOutput("Test Case 'ZTests.testSync' passed (0.001 seconds)")
    expect(testVerdict({ suites: passing, status: 0 })).toBe('pass')
    expect(() => testVerdict({ suites: passing, status: 134 })).toThrow()
    expect(() => testVerdict({ suites: [], status: 0 })).toThrow()
  })
})

describe('Info.plist', () => {
  const entries = [
    ['CFBundleExecutable', 'tray'],
    ['CFBundleIdentifier', 'com.example.tray'],
    ['LSUIElement', true],
  ] as const

  it('keeps the rule-owned keys in order with the established layout', () => {
    expect(renderInfoPlist({ entries, extra: {} })).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>CFBundleExecutable</key>',
        '  <string>tray</string>',
        '  <key>CFBundleIdentifier</key>',
        '  <string>com.example.tray</string>',
        '  <key>LSUIElement</key>',
        '  <true/>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    )
  })

  it('appends sorted nested extra keys and refuses overrides', () => {
    const plist = renderInfoPlist({
      entries,
      extra: { NSHighResolutionCapable: true, CFBundleDisplayName: 'A & B', Nested: { Items: ['x', 1] } },
    })
    expect(plist).toContain(
      [
        '  <key>CFBundleDisplayName</key>',
        '  <string>A &amp; B</string>',
        '  <key>NSHighResolutionCapable</key>',
        '  <true/>',
        '  <key>Nested</key>',
        '  <dict>',
        '    <key>Items</key>',
        '    <array>',
        '      <string>x</string>',
        '      <integer>1</integer>',
        '    </array>',
        '  </dict>',
      ].join('\n'),
    )
    expect(() => renderInfoPlist({ entries, extra: { CFBundleExecutable: 'other' } })).toThrow()
  })
})
