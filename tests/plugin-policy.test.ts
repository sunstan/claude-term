import { describe, it, expect } from 'vitest'
import { symlinkSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { TempDir } from './helpers'
import { fsError, inside, permissionError, type PolicyCtx } from '../src/main/services/plugin-policy'

const ctx = (o: Partial<PolicyCtx> = {}): PolicyCtx => ({ builtin: false, permissions: new Set(), pluginDir: '/data/plugins/x', projectRoot: '/work/proj', home: '/home/me', real: (p) => p, ...o })

describe('plugin policy', () => {
  it('requires "process" for exec and terminal runs of user plugins', () => {
    expect(permissionError('process.exec', ctx())).toMatch(/"process"/)
    expect(permissionError('terminal.run', ctx())).toMatch(/"process"/)
    expect(permissionError('process.exec', ctx({ permissions: new Set(['process']) }))).toBeNull()
    expect(permissionError('process.exec', ctx({ builtin: true }))).toBeNull()
    expect(permissionError('ui.viewSet', ctx())).toBeNull()
  })

  it('limits fs to the plugin folder and the project, the home folder with fs:home', () => {
    expect(fsError('/work/proj/src/a.ts', ctx())).toBeNull()
    expect(fsError('/work/proj', ctx())).toBeNull()
    expect(fsError('/data/plugins/x/lib.js', ctx())).toBeNull()
    expect(fsError('/work/proj/../other/secret', ctx())).toMatch(/fs:home/)
    expect(fsError('/work/project-2/a', ctx())).toMatch(/fs:home/)
    expect(fsError('/home/me/.ssh/id_rsa', ctx())).toMatch(/fs:home/)
    expect(fsError('/home/me/.ssh/id_rsa', ctx({ permissions: new Set(['fs:home']) }))).toBeNull()
    expect(fsError('/etc/passwd', ctx({ permissions: new Set(['fs:home']) }))).toMatch(/fs:home/)
    expect(fsError('/work/proj/a', ctx({ projectRoot: null }))).toMatch(/fs:home/)
    expect(fsError('relative/a', ctx())).toMatch(/absolute/)
    expect(fsError('', ctx())).toMatch(/invalid/)
    expect(fsError(42, ctx())).toMatch(/invalid/)
    expect(fsError('/anything', ctx({ builtin: true }))).toBeNull()
  })

  it('follows symlinks: a link in the project to outside is refused', () => {
    const t = new TempDir()
    const proj = join(t.path, 'proj'), secret = join(t.path, 'secret')
    mkdirSync(proj); mkdirSync(secret); t.write('secret/key', 'k'); t.write('proj/ok.txt', 'x')
    symlinkSync(secret, join(proj, 'link'), 'junction')   // a junction: Windows needs no privilege for it, others ignore the type
    const c = ctx({ projectRoot: proj, pluginDir: join(t.path, 'plug'), home: '/nowhere', real: realpathSync })
    expect(fsError(join(proj, 'ok.txt'), c)).toBeNull()
    expect(fsError(join(proj, 'link', 'key'), c)).toMatch(/fs:home/)
    expect(fsError(join(proj, 'new-file'), c)).toBeNull()
    t.dispose()
  })

  it('inside', () => {
    expect(inside('/a/b', '/a')).toBe(true)
    expect(inside('/a', '/a')).toBe(true)
    expect(inside('/ab', '/a')).toBe(false)
    expect(inside('/', '/a')).toBe(false)
  })
})
