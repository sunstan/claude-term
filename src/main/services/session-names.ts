import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The name of the tab each Claude session ran in, by session id (`userData/session-names.json`): History shows it, and
 * resuming the session reopens its tab under that name. The newest names are kept when there are too many.
 */
export class SessionNames {
  private cache: Record<string, string> | null = null
  constructor(private file: string, private max = 2000) {}

  private read(): Record<string, string> {
    if (this.cache) return this.cache
    try {
      const o = JSON.parse(readFileSync(this.file, 'utf8'))
      this.cache = o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {}
    } catch { this.cache = {} }
    return this.cache
  }

  get(id: string): string | null { return this.read()[id] ?? null }

  /** null or an empty name forgets it */
  set(id: string, name: string | null) {
    const all = { ...this.read() }
    const v = name?.trim().slice(0, 80)
    if (!v && !(id in all)) return
    if (all[id] === v) return
    delete all[id]
    if (v) all[id] = v
    const entries = Object.entries(all)
    this.cache = Object.fromEntries(entries.slice(Math.max(0, entries.length - this.max)))
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.cache, null, 1))
    renameSync(tmp, this.file)
  }
}
