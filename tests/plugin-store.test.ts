import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { TempDir } from './helpers'
import { readTarGz, safePath, stripTopFolder } from '../src/main/services/tar'
import { PluginStore, type ApprovalRequest, type StoreHost } from '../src/main/services/plugin-store'
import { allowedUrl, catalogueItems, checkCandidate, compareVersions, missingPermissions, parseRegistry, satisfiesEngine, type RegistryEntry } from '../src/shared/plugin-registry'
import type { PluginInfo } from '../src/shared/plugins'

// MARK: a minimal tar writer to craft archives (including hostile ones)

function header(name: string, size: number, type = '0', linkname = ''): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100)
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116)
  h.write(size.toString(8).padStart(11, '0') + '\0', 124)
  h.write('00000000000\0', 136)
  h.write(type, 156); h.write(linkname, 157, 100)
  h.write('ustar\0', 257); h.write('00', 263)
  h.fill(32, 148, 156)
  let sum = 0; for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return h
}
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)])
type Entry = { name: string; data?: string; type?: string; link?: string }
function tgz(entries: Entry[]): Buffer {
  const parts: Buffer[] = []
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '')
    parts.push(header(e.name, data.length, e.type ?? '0', e.link ?? ''), pad(data))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}
const paxRecord = (k: string, v: string) => { let len = k.length + v.length + 3; len += String(len).length; if (String(len).length !== String(len - String(len).length).length) len++; return `${len} ${k}=${v}\n` }

const LIMITS = { maxBytes: 1 << 20, maxFiles: 100 }
const manifest = (o: object = {}) => JSON.stringify({ id: 'acme.hello', name: 'Hello', version: '1.0.0', main: 'main.js', permissions: ['network'], ...o })
const pluginTgz = (o: object = {}, top = 'hello-1.0.0/') => tgz([{ name: top, type: '5' }, { name: top + 'plugin.json', data: manifest(o) }, { name: top + 'main.js', data: 'exports.activate = () => {}' }, { name: top + 'lib/util.js', data: '//' }])
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

describe('tar reader', () => {
  it('reads files, folders implied, strips a single top folder holding plugin.json', () => {
    const files = stripTopFolder(readTarGz(pluginTgz(), LIMITS))
    expect(files.map((f) => f.path).sort()).toEqual(['lib/util.js', 'main.js', 'plugin.json'])
    expect(JSON.parse(files.find((f) => f.path === 'plugin.json')!.data.toString()).id).toBe('acme.hello')
    // plugin.json at the root: nothing stripped
    expect(stripTopFolder(readTarGz(pluginTgz({}, ''), LIMITS)).map((f) => f.path)).toContain('plugin.json')
    // several top folders: nothing stripped
    const two = [{ path: 'a/plugin.json', data: Buffer.from('') }, { path: 'b/x', data: Buffer.from('') }]
    expect(stripTopFolder(two)).toBe(two)
    expect(stripTopFolder([{ path: 'a/x', data: Buffer.from('') }])[0].path).toBe('a/x')
  })

  it('honours pax paths and sizes and GNU long names, skips AppleDouble files', () => {
    const long = 'd/' + 'x'.repeat(150) + '.js'
    const pax = Buffer.from(paxRecord('path', long))
    const gnu = 'e/' + 'y'.repeat(120) + '.js'
    const raw = Buffer.concat([
      header('pax_global', 0, 'g'),
      header('PaxHeader', pax.length, 'x'), pad(pax), header('short', 3), pad(Buffer.from('abc')),
      header('././@LongLink', gnu.length + 1, 'L'), pad(Buffer.from(gnu + '\0')), header('trunc', 2), pad(Buffer.from('hi')),
      header('./._main.js', 1), pad(Buffer.from('x')), header('__MACOSX/a', 1), pad(Buffer.from('x')),
      Buffer.alloc(1024),
    ])
    const files = readTarGz(gzipSync(raw), LIMITS)
    expect(files.map((f) => [f.path, f.data.toString()])).toEqual([[long, 'abc'], [gnu, 'hi']])
  })

  it('reads an archive made by the system tar', () => {
    const t = new TempDir()
    t.write('p/plugin.json', manifest()); t.write('p/main.js', '//'); t.write('p/' + 'n'.repeat(120) + '.txt', 'long')
    const out = join(t.path, 'p.tgz')
    // relative paths: GNU tar (Git for Windows) reads "C:" in a path as a remote host
    execFileSync('tar', ['-czf', 'p.tgz', 'p'], { cwd: t.path, env: { ...process.env, COPYFILE_DISABLE: '1' } })
    const files = stripTopFolder(readTarGz(readFileSync(out), LIMITS))
    expect(files.map((f) => f.path).sort()).toEqual(['main.js', 'n'.repeat(120) + '.txt', 'plugin.json'])
    t.dispose()
  })

  it('refuses links, special files, escaping paths, corrupt and oversized archives', () => {
    expect(() => readTarGz(tgz([{ name: 'l', type: '2', link: '/etc/passwd' }]), LIMITS)).toThrow(/liens/)
    expect(() => readTarGz(tgz([{ name: 'h', type: '1', link: 'x' }]), LIMITS)).toThrow(/liens/)
    expect(() => readTarGz(tgz([{ name: '../evil.js', data: 'x' }]), LIMITS)).toThrow(/chemin refusé/)
    expect(() => readTarGz(tgz([{ name: '/abs.js', data: 'x' }]), LIMITS)).toThrow(/chemin refusé/)
    expect(() => readTarGz(tgz([{ name: 'a/../../x/', type: '5' }]), LIMITS)).toThrow(/chemin refusé/)
    expect(() => readTarGz(Buffer.from('not gzip'), LIMITS)).toThrow(/illisible/)
    const bad = header('x', 1); bad[0] = 'y'.charCodeAt(0)
    expect(() => readTarGz(gzipSync(Buffer.concat([bad, pad(Buffer.from('x')), Buffer.alloc(1024)])), LIMITS)).toThrow(/corrompue/)
    expect(() => readTarGz(gzipSync(header('x', 4096)), LIMITS)).toThrow(/tronquée/)
    expect(() => readTarGz(tgz([{ name: 'a', data: 'x'.repeat(600) }]), { maxBytes: 500, maxFiles: 10 })).toThrow(/trop grande/)
    expect(() => readTarGz(gzipSync(Buffer.alloc(4 << 20)), { maxBytes: 1024, maxFiles: 10 })).toThrow(/trop grande/)
    expect(() => readTarGz(tgz([{ name: 'a' }, { name: 'b' }]), { maxBytes: 500, maxFiles: 1 })).toThrow(/trop de fichiers/)
  })

  it('normalizes safe paths', () => {
    expect(safePath('./a/./b/')).toBe('a/b')
    expect(safePath('a\\b')).toBe('a/b')
    expect(safePath('.')).toBe('')
    expect(() => safePath('C:/x')).toThrow()
    expect(() => safePath('a\\..\\..\\x')).toThrow()
  })
})

describe('registry', () => {
  const entry = (o: object = {}) => ({ id: 'acme.hello', name: 'Hello', version: '1.0.0', permissions: ['network'], url: 'https://x.dev/h.tgz', sha256: 'A'.repeat(64), ...o })

  it('parses entries, lowercases checksums, skips invalid or duplicated entries', () => {
    const r = parseRegistry(JSON.stringify({ version: 1, plugins: [entry(), entry(), entry({ id: 'b', url: 'http://evil.com/x.tgz' }), entry({ id: 'c', sha256: 'zz' }), entry({ id: 'd', permissions: ['root'] }), entry({ id: 'e', version: 'x' }), entry({ id: 'f', engine: '>=nope' }), { id: 'Bad' }, entry({ id: 'g', name: '' }), null, entry({ id: 'h', permissions: 'network' })] }))
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0].sha256).toBe('a'.repeat(64))
    expect(r.skipped).toEqual(['acme.hello : id en double', 'b : url refusée', 'c : sha256 invalide', 'd : permissions invalides', 'e : version invalide', 'f : engine invalide', 'Bad : id invalide', 'g : name manquant', '? : entrée invalide', 'h : permissions invalides'])
    expect(parseRegistry(JSON.stringify({ version: 1, plugins: [{ ...entry(), permissions: undefined }] })).entries[0].permissions).toEqual([])
    expect(() => parseRegistry('{')).toThrow(/illisible/)
    expect(() => parseRegistry(JSON.stringify({ version: 2, plugins: [] }))).toThrow(/format/)
  })

  it('allows https, local http and file urls only', () => {
    expect(allowedUrl('https://github.com/a/b.tgz')).toBe(true)
    expect(allowedUrl('file:///tmp/registry.json')).toBe(true)
    expect(allowedUrl('http://localhost:8080/r.json')).toBe(true)
    expect(allowedUrl('http://127.0.0.1/r.json')).toBe(true)
    expect(allowedUrl('http://example.com/r.json')).toBe(false)
    expect(allowedUrl('ftp://x/y')).toBe(false)
    expect(allowedUrl('not a url')).toBe(false)
  })

  it('compares versions and engines', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1)
    expect(compareVersions('2.0', '2.0.0')).toBe(0)
    expect(compareVersions('v2.1.0', '2.0.9')).toBe(1)
    expect(compareVersions('2.0.0-beta', '2.0.0')).toBe(-1)
    expect(compareVersions('2.0.0', '2.0.0-beta')).toBe(1)
    expect(compareVersions('2.0.0-alpha', '2.0.0-beta')).toBe(-1)
    expect(compareVersions('2.0.0-beta', '2.0.0-alpha')).toBe(1)
    expect(compareVersions('x', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', 'x')).toBe(1)
    expect(compareVersions('x', 'y')).toBe(0)
    expect(satisfiesEngine(undefined, '2.0.0')).toBe(true)
    expect(satisfiesEngine('>=2.0.0', '2.0.0')).toBe(true)
    expect(satisfiesEngine('2.1.0', '2.0.0')).toBe(false)
    expect(missingPermissions(['process', 'network'], ['process'])).toEqual(['network'])
    expect(missingPermissions(undefined, undefined)).toEqual([])
  })

  it('derives the catalogue state from the installed plugins', () => {
    const info = (id: string, version: string, builtin = false) => ({ manifest: { id, name: id, version, main: 'm.js' }, dir: '', builtin, enabled: true }) as PluginInfo
    const entries = parseRegistry(JSON.stringify({ version: 1, plugins: [entry({ id: 'a' }), entry({ id: 'b', version: '1.1.0' }), entry({ id: 'c' }), entry({ id: 'git' }), entry({ id: 'd', engine: '>=9.0.0' })] })).entries
    const items = catalogueItems(entries, [info('b', '1.0.0'), info('c', '1.0.0'), info('git', '1.0.0', true)], '2.0.0')
    expect(items.map((i) => [i.id, i.state, i.installedVersion])).toEqual([['a', 'available', undefined], ['b', 'update', '1.0.0'], ['c', 'installed', '1.0.0'], ['git', 'builtin', '1.0.0'], ['d', 'incompatible', undefined]])
  })

  it('checks a candidate manifest against the entry, the built-ins and the engine', () => {
    const e = parseRegistry(JSON.stringify({ version: 1, plugins: [entry()] })).entries[0]
    const ctx = { entry: e, builtinIds: ['git'], appVersion: '2.0.0' }
    const m = (o: object = {}) => JSON.parse(manifest(o))
    expect(checkCandidate(m(), ctx)).toBeNull()
    expect(checkCandidate(m({ id: 'Bad' }), ctx)).toMatch(/id/)
    expect(checkCandidate(m({ version: undefined }), ctx)).toMatch(/version/)
    expect(checkCandidate(m({ id: 'git' }), ctx)).toMatch(/intégré/)
    expect(checkCandidate(m({ id: 'other' }), ctx)).toMatch(/≠ catalogue/)
    expect(checkCandidate(m({ version: '1.0.1' }), ctx)).toMatch(/version 1.0.1/)
    expect(checkCandidate(m({ permissions: ['network', 'process'] }), ctx)).toMatch(/non annoncées par le catalogue : process/)
    expect(checkCandidate(m({ engine: '>=3.0.0' }), ctx)).toMatch(/demande ClaudeTerm/)
    expect(checkCandidate(m({ engine: 3 }), ctx)).toMatch(/engine/)
    expect(checkCandidate(m({ permissions: ['anything'] }), { builtinIds: [], appVersion: '2.0.0' })).toMatch(/permissions/)
    expect(checkCandidate(m({ id: 'x', permissions: ['process'] }), { builtinIds: [], appVersion: '2.0.0' })).toBeNull()
  })
})

describe('plugin store', () => {
  function setup(archives: Record<string, Buffer>, opts: { approve?: boolean; installed?: Record<string, string>; approved?: Record<string, string[]> } = {}) {
    const t = new TempDir()
    const userDir = join(t.path, 'plugins')
    const log: string[] = []
    const asked: ApprovalRequest[] = []
    const approved: Record<string, string[]> = { ...opts.approved }
    const installed: Record<string, string> = { ...opts.installed }
    const host: StoreHost = {
      download: async (url, max) => { const b = archives[url]; if (!b) throw new Error('HTTP 404'); if (b.length > max) throw new Error('fichier trop grand'); return b },
      builtinIds: () => ['git'],
      installedVersion: (id) => installed[id],
      approved: (id) => approved[id],
      approve: async (r) => { asked.push(r); return opts.approve ?? true },
      setApproved: (id, p) => { if (p) approved[id] = p; else delete approved[id]; log.push(`approved ${id} ${p?.join(',') ?? 'null'}`) },
      unload: (id) => log.push(`unload ${id}`),
      load: (dir) => { log.push(`load /${basename(dir)}`); installed[JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')).id] = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')).version },
    }
    const store = new PluginStore(userDir, '2.0.0', host)
    return { t, userDir, store, log, asked, approved }
  }
  const entryFor = (url: string, b: Buffer, o: Partial<RegistryEntry> = {}): RegistryEntry => ({ id: 'acme.hello', name: 'Hello', version: '1.0.0', permissions: ['network'], url, sha256: sha(b), ...o })

  it('installs from the catalogue: verify, approve, unpack into <id>, activate', async () => {
    const gz = pluginTgz()
    const { t, userDir, store, log, asked } = setup({ 'https://x.dev/h.tgz': gz })
    const r = await store.install({ entry: entryFor('https://x.dev/h.tgz', gz) })
    expect(r).toEqual({ ok: true, id: 'acme.hello' })
    expect(readdirSync(join(userDir, 'acme.hello')).sort()).toEqual(['lib', 'main.js', 'plugin.json'])
    expect(asked[0]).toMatchObject({ id: 'acme.hello', version: '1.0.0', permissions: ['network'], verified: true, update: undefined, sha256: sha(gz) })
    expect(log).toEqual(['unload acme.hello', 'approved acme.hello network', 'load /acme.hello'])
    expect(readdirSync(join(userDir, '.staging'))).toEqual([])
    t.dispose()
  })

  it('updates in place, asking again only when permissions grow', async () => {
    const v1 = pluginTgz(), v2 = pluginTgz({ version: '1.1.0' }), v3 = pluginTgz({ version: '1.2.0', permissions: ['network', 'process'] })
    const { t, userDir, store, asked } = setup({ 'https://x/1': v1, 'https://x/2': v2, 'https://x/3': v3 })
    await store.install({ entry: entryFor('https://x/1', v1) })
    expect((await store.install({ entry: entryFor('https://x/2', v2, { version: '1.1.0' }) })).ok).toBe(true)
    expect(asked).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(userDir, 'acme.hello', 'plugin.json'), 'utf8')).version).toBe('1.1.0')
    expect((await store.install({ entry: entryFor('https://x/3', v3, { version: '1.2.0', permissions: ['network', 'process'] }) })).ok).toBe(true)
    expect(asked).toHaveLength(2)
    expect(asked[1]).toMatchObject({ update: '1.1.0', permissions: ['network', 'process'] })
    t.dispose()
  })

  it('refuses a checksum mismatch, a cancelled approval, bad archives and manifests, and keeps the installed version', async () => {
    const gz = pluginTgz()
    const noMain = tgz([{ name: 'plugin.json', data: manifest() }])
    const noManifest = tgz([{ name: 'main.js', data: '' }])
    const badJson = tgz([{ name: 'plugin.json', data: '{' }, { name: 'main.js', data: '' }])
    const builtin = pluginTgz({ id: 'git' })
    const { t, userDir, store, log } = setup({ 'https://x/h': gz, 'https://x/nomain': noMain, 'https://x/nomanifest': noManifest, 'https://x/bad': badJson, 'https://x/git': builtin, 'https://x/big': Buffer.alloc(21 * 1024 * 1024) }, { approve: false })
    const err = async (p: Promise<any>) => { const r = await p; expect(r.ok).toBe(false); return r.error as string }
    expect(await err(store.install({ entry: { ...entryFor('https://x/h', gz), sha256: 'b'.repeat(64) } }))).toMatch(/sha256 différent/)
    expect(await store.install({ entry: entryFor('https://x/h', gz) })).toEqual({ ok: false, error: 'installation annulée', cancelled: true })
    expect(await err(store.install({ url: 'https://x/nomain' }))).toMatch(/main.js absent/)
    expect(await err(store.install({ url: 'https://x/nomanifest' }))).toMatch(/plugin.json absent/)
    expect(await err(store.install({ url: 'https://x/bad' }))).toMatch(/illisible/)
    expect(await err(store.install({ url: 'https://x/git' }))).toMatch(/intégré/)
    expect(await err(store.install({ url: 'https://x/big' }))).toMatch(/trop grand/)
    expect(await err(store.install({ url: 'https://x/404' }))).toMatch(/404/)
    expect(await err(store.install({ url: 'http://evil.com/x.tgz' }))).toMatch(/adresse refusée/)
    expect(log).toEqual([])
    expect(existsSync(join(userDir, 'acme.hello'))).toBe(false)
    t.dispose()
  })

  it('installs from a URL (unverified) and uninstalls user plugins only', async () => {
    const gz = pluginTgz({}, '')
    const { t, userDir, store, asked, approved } = setup({ 'file:///p.tgz': gz })
    expect((await store.install({ url: ' file:///p.tgz ' })).ok).toBe(true)
    expect(asked[0]).toMatchObject({ verified: false, sha256: sha(gz), source: 'file:///p.tgz' })
    expect(approved['acme.hello']).toEqual(['network'])
    expect(store.uninstall('git', join(userDir, 'git'))).toMatchObject({ ok: false })
    expect(store.uninstall('acme.hello', '/elsewhere/acme.hello')).toMatchObject({ ok: false })
    expect(store.uninstall('acme.hello', join(userDir, 'acme.hello'))).toEqual({ ok: true, id: 'acme.hello' })
    expect(existsSync(join(userDir, 'acme.hello'))).toBe(false)
    expect(approved['acme.hello']).toBeUndefined()
    t.dispose()
  })

  it('reads the registry through the host, refusing unsafe addresses', async () => {
    const { t, store } = setup({ 'https://r/registry.json': Buffer.from(JSON.stringify({ version: 1, plugins: [] })) })
    expect(await store.registry('https://r/registry.json')).toEqual({ entries: [], skipped: [] })
    await expect(store.registry('http://evil.com/r.json')).rejects.toThrow(/refusée/)
    store.cleanStaging()
    t.dispose()
  })
})
