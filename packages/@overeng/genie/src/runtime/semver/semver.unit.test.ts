import { describe, expect, it } from 'vitest'

import { parseVersion, satisfiesRange } from './mod.ts'

describe('parseVersion', () => {
  it('parses standard versions', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('0.58.0')).toEqual([0, 58, 0])
    expect(parseVersion('3.21.0')).toEqual([3, 21, 0])
  })

  it('handles .x wildcards', () => {
    expect(parseVersion('4.9.x')).toEqual([4, 9, 0])
  })

  it('handles two-part versions', () => {
    expect(parseVersion('3.19')).toEqual([3, 19, 0])
  })
})

describe('satisfiesRange', () => {
  describe('caret ranges (^)', () => {
    describe('pre-1.0 (minor-locked)', () => {
      it('does NOT satisfy when minor differs', () => {
        expect(satisfiesRange('0.60.0', '^0.58.0')).toBe(false)
        expect(satisfiesRange('0.96.0', '^0.94.2')).toBe(false)
        expect(satisfiesRange('0.75.0', '^0.73.0')).toBe(false)
      })

      it('satisfies when same minor and patch >=', () => {
        expect(satisfiesRange('0.58.0', '^0.58.0')).toBe(true)
        expect(satisfiesRange('0.58.5', '^0.58.0')).toBe(true)
        expect(satisfiesRange('0.60.0', '^0.60.0')).toBe(true)
      })

      it('does not satisfy when patch is lower', () => {
        expect(satisfiesRange('0.94.1', '^0.94.2')).toBe(false)
      })
    })

    describe('post-1.0 (major-locked)', () => {
      it('satisfies within same major', () => {
        expect(satisfiesRange('3.21.0', '^3.19.15')).toBe(true)
        expect(satisfiesRange('3.21.0', '^3.21.0')).toBe(true)
        expect(satisfiesRange('3.99.0', '^3.0.0')).toBe(true)
      })

      it('does not satisfy across major', () => {
        expect(satisfiesRange('4.0.0', '^3.19.0')).toBe(false)
      })

      it('does not satisfy below range', () => {
        expect(satisfiesRange('3.18.0', '^3.19.0')).toBe(false)
      })
    })

    describe('pre-1.0 with major 0 and minor 0', () => {
      it('locks to exact patch', () => {
        expect(satisfiesRange('0.0.5', '^0.0.5')).toBe(true)
        expect(satisfiesRange('0.0.6', '^0.0.5')).toBe(false)
      })
    })
  })

  describe('tilde ranges (~)', () => {
    it('allows patch-level changes', () => {
      expect(satisfiesRange('0.49.0', '~0.49.0')).toBe(true)
      expect(satisfiesRange('0.49.5', '~0.49.0')).toBe(true)
    })

    it('rejects minor-level changes', () => {
      expect(satisfiesRange('0.50.0', '~0.49.0')).toBe(false)
    })
  })

  describe('range pairs (>=X <Y)', () => {
    it('satisfies within range', () => {
      expect(satisfiesRange('0.208.0', '>=0.203.0 <0.300.0')).toBe(true)
      expect(satisfiesRange('5.9.3', '>=4.8.4 <6.0.0')).toBe(true)
      expect(satisfiesRange('1.9.0', '>=1.3.0 <1.10.0')).toBe(true)
    })

    it('rejects at upper bound', () => {
      expect(satisfiesRange('0.300.0', '>=0.203.0 <0.300.0')).toBe(false)
      expect(satisfiesRange('6.0.0', '>=4.8.4 <6.0.0')).toBe(false)
    })

    it('rejects below lower bound', () => {
      expect(satisfiesRange('0.202.0', '>=0.203.0 <0.300.0')).toBe(false)
    })
  })

  describe('>= (lower bound only)', () => {
    it('satisfies at and above', () => {
      expect(satisfiesRange('19.2.3', '>=19.0.0')).toBe(true)
      expect(satisfiesRange('19.0.0', '>=19.0.0')).toBe(true)
    })

    it('rejects below', () => {
      expect(satisfiesRange('18.9.9', '>=19.0.0')).toBe(false)
    })
  })

  describe('|| disjunction', () => {
    it('satisfies if any branch matches', () => {
      expect(satisfiesRange('19.2.3', '>=18.0.0 || >=19.0.0')).toBe(true)
      expect(satisfiesRange('7.3.1', '>=5.0.0 || >=6.0.0 || >=7.0.0')).toBe(true)
    })

    it('handles complex multi-version disjunctions', () => {
      expect(satisfiesRange('19.2.3', '^16.8.0 || ^17.0.0-rc.1 || ^18.0.0 || ^19.0.0-rc.1')).toBe(
        true,
      )
    })

    it('rejects when no branch matches', () => {
      expect(satisfiesRange('15.0.0', '^16.8.0 || ^17.0.0 || ^18.0.0')).toBe(false)
    })

    it('handles >= X <Y with ||', () => {
      expect(satisfiesRange('19.2.3', '>=18 <20')).toBe(true)
      expect(satisfiesRange('20.0.0', '>=18 <20')).toBe(false)
    })
  })

  describe('wildcard', () => {
    it('matches anything', () => {
      expect(satisfiesRange('0.0.1', '*')).toBe(true)
      expect(satisfiesRange('99.99.99', '*')).toBe(true)
    })
  })

  describe('exact match', () => {
    it('matches identical version', () => {
      expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true)
    })

    it('rejects different version', () => {
      expect(satisfiesRange('1.2.4', '1.2.3')).toBe(false)
    })
  })

  describe('real-world catalog cases', () => {
    it('@effect-atom/atom peer deps vs catalog', () => {
      expect(satisfiesRange('0.60.0', '^0.58.0')).toBe(false)
      expect(satisfiesRange('0.96.0', '^0.94.2')).toBe(false)
      expect(satisfiesRange('0.75.0', '^0.73.0')).toBe(false)
      expect(satisfiesRange('3.21.0', '^3.19.15')).toBe(true)
    })

    it('@effect/opentelemetry peer deps', () => {
      expect(satisfiesRange('0.208.0', '>=0.203.0 <0.300.0')).toBe(true)
      expect(satisfiesRange('1.9.0', '^1.9')).toBe(true)
    })

    it('@typescript-eslint peer deps', () => {
      expect(satisfiesRange('5.9.3', '>=4.8.4 <6.0.0')).toBe(true)
    })

    it('@effect-atom/atom-react peer deps', () => {
      expect(satisfiesRange('19.2.3', '>=18 <20')).toBe(true)
    })

    it('vitest peer deps', () => {
      expect(satisfiesRange('3.2.4', '^3.2.0')).toBe(true)
    })
  })
})
