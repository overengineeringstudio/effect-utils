import { describe, expect, it } from 'vitest'

import type { NormalizedValue } from '@overeng/effect-rpc-explorer'

import { normalizedValueText } from './normalized-value.ts'

describe('normalized content text', () => {
  it('renders only the normalized algebra and keeps redaction placeholders opaque', () => {
    const value: NormalizedValue = {
      _tag: 'Object',
      value: {
        public: { _tag: 'String', value: 'visible' },
        secret: { _tag: 'Redacted', label: 'credential' },
        unsupported: { _tag: 'Unsupported', type: 'CustomClass' },
      },
    }

    const rendered = normalizedValueText(value)
    expect(rendered).toContain('"public": "visible"')
    expect(rendered).toContain('"secret": Redacted value')
    expect(rendered).not.toContain('credential')
    expect(rendered).toContain('Unsupported value type: CustomClass')
  })

  it('makes truncation reason and bounded retained projection explicit', () => {
    expect(
      normalizedValueText({
        _tag: 'Truncated',
        reason: 'bytes',
        retained: { _tag: 'String', value: 'bounded prefix' },
      }),
    ).toBe('Value truncated: bytes\n"bounded prefix"')
  })
})
