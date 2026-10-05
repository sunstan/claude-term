import { describe, it, expect } from 'vitest'
import { claudeActivity } from '../src/shared/claude-title'

describe('Claude terminal title', () => {
  it('reads working, idle or nothing from the first glyph', () => {
    expect(claudeActivity('✳ Refactor the parser')).toBe('idle')
    expect(claudeActivity('◐ Refactor the parser')).toBe('working')
    expect(claudeActivity('◓ x')).toBe('working')
    expect(claudeActivity('⠋ x')).toBe('working')
    expect(claudeActivity('PS C:\\Projets')).toBeUndefined()
    expect(claudeActivity('')).toBeUndefined()
  })
})
