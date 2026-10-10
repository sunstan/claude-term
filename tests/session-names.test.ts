import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TempDir } from './helpers'
import { SessionNames } from '../src/main/services/session-names'

describe('session tab names', () => {
  it('keeps the name of the tab each session ran in, across restarts; an empty name forgets it', () => {
    const t = new TempDir()
    const file = join(t.path, 'data', 'session-names.json')
    const a = new SessionNames(file)
    expect(a.get('s1')).toBeNull()
    a.set('s1', '  revue badge  ')
    a.set('s2', 'api')
    expect(a.get('s1')).toBe('revue badge')
    // read again by another start of the app
    expect(new SessionNames(file).get('s2')).toBe('api')
    a.set('s1', '')
    a.set('s3', null)
    expect(new SessionNames(file).get('s1')).toBeNull()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ s2: 'api' })
    a.set('s2', 'x'.repeat(200))
    expect(a.get('s2')).toHaveLength(80)
    t.dispose()
  })

  it('reads a damaged file as empty and keeps the newest names when there are too many', () => {
    const t = new TempDir()
    const file = t.write('session-names.json', '{ broken')
    const n = new SessionNames(file)
    expect(n.get('x')).toBeNull()
    writeFileSync(file, JSON.stringify(['not', 'an', 'object']))
    expect(new SessionNames(file).get('0')).toBeNull()
    writeFileSync(file, JSON.stringify({ ok: 'yes', bad: 3 }))
    expect(new SessionNames(file).get('bad')).toBeNull()
    const many = new SessionNames(join(t.path, 'many.json'), 20)
    for (let i = 0; i < 25; i++) many.set('s' + i, 'n' + i)
    const kept = JSON.parse(readFileSync(join(t.path, 'many.json'), 'utf8'))
    expect(Object.keys(kept)).toHaveLength(20)
    expect(kept.s4).toBeUndefined()
    expect(kept.s24).toBe('n24')
    t.dispose()
  })
})
