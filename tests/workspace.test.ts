import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TempDir } from './helpers'
import { lastLines, savedTab, type TabLike } from '../src/shared/workspace'
import { WorkspaceStore } from '../src/main/services/workspace'

const tab = (x: Partial<TabLike>): TabLike => ({ id: 't1', kind: 'shell', cwd: '/p', title: 'p', busy: false, lastCommand: '', claudeRunning: false, ...x })

describe('workspace tabs', () => {
  it('saves what each tab reopens with', () => {
    expect(savedTab(tab({ kind: 'claude', title: 'Corrige le bug', session: { sessionId: 's1' }, customTitle: 'revue' })))
      .toEqual({ kind: 'claude', cwd: '/p', title: 'Corrige le bug', customTitle: 'revue', session: 's1' })
    // a Claude tab with no session yet reopens as a new one
    expect(savedTab(tab({ kind: 'claude' }))).toEqual({ kind: 'claude', cwd: '/p', title: 'p' })
    expect(savedTab(tab({ kind: 'file', path: '/p/a.ts', title: 'a.ts' }))).toEqual({ kind: 'file', cwd: '/p', title: 'a.ts', path: '/p/a.ts' })
    expect(savedTab(tab({ kind: 'diff' }))).toBeNull()
    // a shell: its lines' key, and the command running at quit (typed again, not run)
    expect(savedTab(tab({ busy: true, lastCommand: 'npm run dev ' }), 'k1')).toEqual({ kind: 'shell', cwd: '/p', title: 'p', scrollback: 'k1', input: 'npm run dev' })
    expect(savedTab(tab({ lastCommand: 'ls' }))).toEqual({ kind: 'shell', cwd: '/p', title: 'p' })
    // a tab not shown since the last launch keeps what it had
    expect(savedTab(tab({ dormant: { scrollback: 'old', input: 'make watch' } }), 'new')).toEqual({ kind: 'shell', cwd: '/p', title: 'p', scrollback: 'old', input: 'make watch' })
    expect(savedTab(tab({ kind: 'claude', dormant: { session: 's0' } }))).toMatchObject({ session: 's0' })
  })
  it('keeps the last lines of a terminal, trailing blanks dropped', () => {
    expect(lastLines(['a  ', 'b', '', '  '])).toBe('a\nb')
    expect(lastLines(['1', '2', '3', '4'], 2)).toBe('3\n4')
    expect(lastLines(['', ''])).toBe('')
  })
})

describe('WorkspaceStore', () => {
  it('saves the layout and the shells lines, keeps only the files still named', () => {
    const t = new TempDir()
    const store = new WorkspaceStore(t.path)
    expect(store.load()).toEqual({ projects: [], active: null })
    const w = { projects: [{ root: '/p', current: 0, tabs: [{ kind: 'shell' as const, cwd: '/p', title: 'p', scrollback: 'a1' }] }], active: '/p' }
    store.save(w, { a1: 'hello\nworld', '../evil': 'x' })
    expect(store.load()).toEqual(w)
    expect(store.scrollback('a1')).toBe('hello\nworld')
    expect(store.scrollback('../evil')).toBe('')
    expect(existsSync(join(t.path, 'evil.txt'))).toBe(false)
    // the next launch names a new key: the old file goes
    store.save({ ...w, projects: [{ ...w.projects[0], tabs: [{ kind: 'shell', cwd: '/p', title: 'p', scrollback: 'b2' }] }] }, { b2: 'next' })
    expect(readdirSync(store.dir)).toEqual(['b2.txt'])
    t.dispose()
  })
})
