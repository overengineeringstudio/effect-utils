/**
 * Tests for OutputMode service
 */

import { Effect, Layer } from 'effect'
import { describe, test, expect } from 'vitest'
import {
  OutputModeTag,
  // Presets
  tty,
  ci,
  pipe,
  log,
  fullscreen,
  json,
  ndjson,
  // Detection
  detectOutputMode,
  isAgentEnv,
  // Type guards
  isReact,
  isJson,
  isProgressive,
  isFinal,
  isAnimated,
  hasColors,
  isAlternate,
  // Layers
  layer,
  ttyLayer,
  jsonLayer,
} from '../../src/effect/OutputMode.tsx'

import { resolveOutputMode } from '../../src/effect/cli.tsx'

describe('OutputMode presets', () => {
  test('tty preset has correct config', () => {
    expect(tty._tag).toBe('react')
    expect(tty.timing).toBe('progressive')
    if (tty._tag === 'react') {
      expect(tty.render.animation).toBe(true)
      expect(tty.render.colors).toBe(true)
      expect(tty.render.alternate).toBe(false)
    }
  })

  test('ci preset has correct config', () => {
    expect(ci._tag).toBe('react')
    expect(ci.timing).toBe('progressive')
    if (ci._tag === 'react') {
      expect(ci.render.animation).toBe(false)
      expect(ci.render.colors).toBe(true)
      expect(ci.render.alternate).toBe(false)
    }
  })

  test('pipe preset has correct config', () => {
    expect(pipe._tag).toBe('react')
    expect(pipe.timing).toBe('final')
    if (pipe._tag === 'react') {
      expect(pipe.render.animation).toBe(false)
      expect(pipe.render.colors).toBe(true)
    }
  })

  test('log preset has correct config', () => {
    expect(log._tag).toBe('react')
    expect(log.timing).toBe('final')
    if (log._tag === 'react') {
      expect(log.render.animation).toBe(false)
      expect(log.render.colors).toBe(false)
    }
  })

  test('fullscreen preset has correct config', () => {
    expect(fullscreen._tag).toBe('react')
    expect(fullscreen.timing).toBe('progressive')
    if (fullscreen._tag === 'react') {
      expect(fullscreen.render.animation).toBe(true)
      expect(fullscreen.render.colors).toBe(true)
      expect(fullscreen.render.alternate).toBe(true)
    }
  })

  test('json preset has correct config', () => {
    expect(json._tag).toBe('json')
    expect(json.timing).toBe('final')
  })

  test('ndjson preset has correct config', () => {
    expect(ndjson._tag).toBe('json')
    expect(ndjson.timing).toBe('progressive')
  })
})

describe('isAgentEnv', () => {
  const agentVars = ['AGENT', 'CLAUDE_PROJECT_DIR', 'CLAUDECODE', 'OPENCODE', 'CLINE_ACTIVE', 'CODEX_SANDBOX'] as const

  // Save and clear all agent env vars before each test
  let savedEnv: Record<string, string | undefined> = {}

  const clearAgentEnv = () => {
    savedEnv = {}
    for (const key of agentVars) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  }

  const restoreAgentEnv = () => {
    for (const key of agentVars) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
  }

  test('returns false when no agent env vars are set', () => {
    clearAgentEnv()
    try {
      expect(isAgentEnv()).toBe(false)
    } finally {
      restoreAgentEnv()
    }
  })

  test('detects AGENT=1 (OpenCode)', () => {
    clearAgentEnv()
    try {
      process.env.AGENT = '1'
      expect(isAgentEnv()).toBe(true)
    } finally {
      restoreAgentEnv()
    }
  })

  test('detects AGENT=amp (Amp)', () => {
    clearAgentEnv()
    try {
      process.env.AGENT = 'amp'
      expect(isAgentEnv()).toBe(true)
    } finally {
      restoreAgentEnv()
    }
  })

  test('ignores AGENT=0 and AGENT=false', () => {
    clearAgentEnv()
    try {
      process.env.AGENT = '0'
      expect(isAgentEnv()).toBe(false)
      process.env.AGENT = 'false'
      expect(isAgentEnv()).toBe(false)
      process.env.AGENT = ''
      expect(isAgentEnv()).toBe(false)
    } finally {
      restoreAgentEnv()
    }
  })

  test('detects CLAUDE_PROJECT_DIR (Claude Code)', () => {
    clearAgentEnv()
    try {
      process.env.CLAUDE_PROJECT_DIR = '/some/path'
      expect(isAgentEnv()).toBe(true)
    } finally {
      restoreAgentEnv()
    }
  })

  test('detects CLAUDECODE (Amp)', () => {
    clearAgentEnv()
    try {
      process.env.CLAUDECODE = '1'
      expect(isAgentEnv()).toBe(true)
    } finally {
      restoreAgentEnv()
    }
  })

  test('detects OPENCODE (OpenCode)', () => {
    clearAgentEnv()
    try {
      process.env.OPENCODE = '1'
      expect(isAgentEnv()).toBe(true)
    } finally {
      restoreAgentEnv()
    }
  })

  test('detects CLINE_ACTIVE (Cline)', () => {
    clearAgentEnv()
    try {
      process.env.CLINE_ACTIVE = 'true'
      expect(isAgentEnv()).toBe(true)
    } finally {
      restoreAgentEnv()
    }
  })

  test('detects CODEX_SANDBOX (Codex CLI)', () => {
    clearAgentEnv()
    try {
      process.env.CODEX_SANDBOX = 'seatbelt'
      expect(isAgentEnv()).toBe(true)
    } finally {
      restoreAgentEnv()
    }
  })
})

describe('detectOutputMode', () => {
  const agentVars = ['AGENT', 'CLAUDE_PROJECT_DIR', 'CLAUDECODE', 'OPENCODE', 'CLINE_ACTIVE', 'CODEX_SANDBOX'] as const
  let savedEnv: Record<string, string | undefined> = {}

  const clearAgentEnv = () => {
    savedEnv = {}
    for (const key of agentVars) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  }

  const restoreAgentEnv = () => {
    for (const key of agentVars) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
  }

  test('in non-TTY non-agent environment defaults to pipe mode', () => {
    clearAgentEnv()
    try {
      const mode = detectOutputMode()
      expect(mode._tag).toBe('react')
      expect(mode.timing).toBe('final')
    } finally {
      restoreAgentEnv()
    }
  })

  test('in agent environment defaults to json mode', () => {
    clearAgentEnv()
    try {
      process.env.AGENT = '1'
      const mode = detectOutputMode()
      expect(mode._tag).toBe('json')
      expect(mode.timing).toBe('final')
    } finally {
      restoreAgentEnv()
    }
  })

  test('TUI_VISUAL=1 overrides agent detection', () => {
    clearAgentEnv()
    const savedVisual = process.env.TUI_VISUAL
    try {
      process.env.AGENT = '1'
      process.env.TUI_VISUAL = '1'
      const mode = detectOutputMode()
      // TUI_VISUAL forces React mode, overriding agent detection
      expect(mode._tag).toBe('react')
    } finally {
      restoreAgentEnv()
      if (savedVisual !== undefined) {
        process.env.TUI_VISUAL = savedVisual
      } else {
        delete process.env.TUI_VISUAL
      }
    }
  })
})

describe('resolveOutputMode', () => {
  test('auto resolves based on environment', () => {
    const mode = resolveOutputMode('auto')
    // In test environment, auto resolves via detectOutputMode
    // (may be 'json' if agent env vars are set, or 'react' pipe mode otherwise)
    expect(['react', 'json']).toContain(mode._tag)
  })

  test('json returns json mode', () => {
    const mode = resolveOutputMode('json')
    expect(mode._tag).toBe('json')
    expect(mode.timing).toBe('final')
  })

  test('ndjson returns ndjson mode', () => {
    const mode = resolveOutputMode('ndjson')
    expect(mode._tag).toBe('json')
    expect(mode.timing).toBe('progressive')
  })

  test('tty returns tty mode', () => {
    const mode = resolveOutputMode('tty')
    expect(mode._tag).toBe('react')
    expect(mode.timing).toBe('progressive')
    expect(isReact(mode) && mode.render.animation).toBe(true)
  })

  test('ci returns ci mode', () => {
    const mode = resolveOutputMode('ci')
    expect(mode._tag).toBe('react')
    expect(mode.timing).toBe('progressive')
    expect(isReact(mode) && mode.render.animation).toBe(false)
  })

  test('pipe returns pipe mode', () => {
    const mode = resolveOutputMode('pipe')
    expect(mode._tag).toBe('react')
    expect(mode.timing).toBe('final')
  })

  test('log returns log mode', () => {
    const mode = resolveOutputMode('log')
    expect(mode._tag).toBe('react')
    expect(mode.timing).toBe('final')
    expect(isReact(mode) && mode.render.colors).toBe(false)
  })

  test('alt-screen returns alt-screen mode', () => {
    const mode = resolveOutputMode('alt-screen')
    expect(mode._tag).toBe('react')
    expect(isReact(mode) && mode.render.alternate).toBe(true)
  })

  test('ci-plain returns ci-plain mode', () => {
    const mode = resolveOutputMode('ci-plain')
    expect(mode._tag).toBe('react')
    expect(mode.timing).toBe('progressive')
    expect(isReact(mode) && mode.render.animation).toBe(false)
    expect(isReact(mode) && mode.render.colors).toBe(false)
  })
})

describe('type guards', () => {
  test('isReact returns true for react modes', () => {
    expect(isReact(tty)).toBe(true)
    expect(isReact(ci)).toBe(true)
    expect(isReact(pipe)).toBe(true)
    expect(isReact(log)).toBe(true)
    expect(isReact(fullscreen)).toBe(true)
    expect(isReact(json)).toBe(false)
    expect(isReact(ndjson)).toBe(false)
  })

  test('isJson returns true for JSON modes', () => {
    expect(isJson(tty)).toBe(false)
    expect(isJson(ci)).toBe(false)
    expect(isJson(json)).toBe(true)
    expect(isJson(ndjson)).toBe(true)
  })

  test('isProgressive returns true for progressive modes', () => {
    expect(isProgressive(tty)).toBe(true)
    expect(isProgressive(ci)).toBe(true)
    expect(isProgressive(pipe)).toBe(false)
    expect(isProgressive(log)).toBe(false)
    expect(isProgressive(json)).toBe(false)
    expect(isProgressive(ndjson)).toBe(true)
  })

  test('isFinal returns true for final modes', () => {
    expect(isFinal(tty)).toBe(false)
    expect(isFinal(ci)).toBe(false)
    expect(isFinal(pipe)).toBe(true)
    expect(isFinal(log)).toBe(true)
    expect(isFinal(json)).toBe(true)
    expect(isFinal(ndjson)).toBe(false)
  })

  test('isAnimated returns true for animated modes', () => {
    expect(isAnimated(tty)).toBe(true)
    expect(isAnimated(ci)).toBe(false)
    expect(isAnimated(fullscreen)).toBe(true)
    expect(isAnimated(json)).toBe(false)
  })

  test('hasColors returns true for colored modes', () => {
    expect(hasColors(tty)).toBe(true)
    expect(hasColors(ci)).toBe(true)
    expect(hasColors(log)).toBe(false)
    expect(hasColors(json)).toBe(false)
  })

  test('isAlternate returns true for alternate buffer modes', () => {
    expect(isAlternate(tty)).toBe(false)
    expect(isAlternate(fullscreen)).toBe(true)
    expect(isAlternate(json)).toBe(false)
  })
})

describe('layers', () => {
  test('layer creates a valid layer', async () => {
    const mode = await OutputModeTag.pipe(Effect.provide(layer(json)), Effect.runPromise)

    expect(mode._tag).toBe('json')
    expect(mode.timing).toBe('final')
  })

  test('ttyLayer provides tty mode', async () => {
    const mode = await OutputModeTag.pipe(Effect.provide(ttyLayer), Effect.runPromise)

    expect(mode._tag).toBe('react')
    expect(mode.timing).toBe('progressive')
  })

  test('jsonLayer provides json mode', async () => {
    const mode = await OutputModeTag.pipe(Effect.provide(jsonLayer), Effect.runPromise)

    expect(mode._tag).toBe('json')
    expect(mode.timing).toBe('final')
  })
})

describe('OutputModeTag service', () => {
  test('can be yielded in Effect.gen', async () => {
    const program = Effect.gen(function* () {
      const mode = yield* OutputModeTag
      return mode._tag
    })

    const result = await program.pipe(
      Effect.provide(Layer.succeed(OutputModeTag, ndjson)),
      Effect.runPromise,
    )

    expect(result).toBe('json')
  })
})
