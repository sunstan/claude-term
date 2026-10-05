/**
 * What the title Claude Code gives its terminal says (pure, tested): a turning glyph while it works (◐ ◑ ◒ ◓, or
 * braille dots, the other usual terminal spinner), ✳ at rest. At rest covers a finished turn and a permission
 * waiting: the Notification hook tells the second. Any other title (a shell's) says nothing.
 */
export function claudeActivity(title: string): 'working' | 'idle' | undefined {
  const c = title.codePointAt(0)
  if (c === undefined) return undefined
  if (c === 0x2733) return 'idle'
  if ((c >= 0x25d0 && c <= 0x25d3) || (c >= 0x2800 && c <= 0x28ff)) return 'working'
  return undefined
}
