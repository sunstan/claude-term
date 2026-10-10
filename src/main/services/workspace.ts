import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isScrollbackKey, type SavedWorkspace } from '@shared/workspace'

const MAX_SCROLLBACK = 400_000

/**
 * The tabs of each open project, reopened at the next launch: `userData/workspace.json`, and the shells' last lines in
 * `userData/scrollback/<key>.txt` (only the files the workspace still names are kept).
 */
export class WorkspaceStore {
  readonly file: string
  readonly dir: string
  constructor(base: string) { this.file = join(base, 'workspace.json'); this.dir = join(base, 'scrollback') }

  load(): SavedWorkspace {
    try {
      const w = JSON.parse(readFileSync(this.file, 'utf8'))
      return { projects: Array.isArray(w?.projects) ? w.projects : [], active: typeof w?.active === 'string' ? w.active : null }
    } catch { return { projects: [], active: null } }
  }

  /** Saves the layout; `scrollbacks` adds or replaces shells' lines by key. */
  save(w: SavedWorkspace, scrollbacks: Record<string, string> = {}) {
    mkdirSync(this.dir, { recursive: true })
    for (const [key, text] of Object.entries(scrollbacks)) {
      if (isScrollbackKey(key) && typeof text === 'string') writeFileSync(join(this.dir, key + '.txt'), text.slice(-MAX_SCROLLBACK))
    }
    writeFileSync(this.file, JSON.stringify(w, null, 2))
    const named = new Set(w.projects.flatMap((p) => p.tabs.map((t) => t.scrollback)).filter(Boolean))
    for (const f of readdirSync(this.dir)) if (f.endsWith('.txt') && !named.has(f.slice(0, -4))) { try { unlinkSync(join(this.dir, f)) } catch { /* gone */ } }
  }

  scrollback(key: string): string {
    if (!isScrollbackKey(key)) return ''
    try { return readFileSync(join(this.dir, key + '.txt'), 'utf8') } catch { return '' }
  }
}
