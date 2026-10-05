import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TempDir } from './helpers'
import { readPluginFiles } from '../src/main/services/plugins'

const SRC = readFileSync(join(__dirname, '..', 'resources', 'plugin-host', 'bootstrap.js'), 'utf8').replace(/;\s*$/, '')
const boot = new Function('return (' + SRC + '\n)')() as (bridge: any, manifest: any, files: Record<string, string>) => any

function fakeBridge(values: Record<string, unknown> = {}) {
  const calls: [string, any][] = [], sent: [string, any][] = []
  let emit: (ev: string, args: unknown[]) => void = () => {}
  const bridge = {
    call: (m: string, a: any) => { calls.push([m, a]); return m in values ? { value: values[m] } : m === 'fs.read' ? { error: 'denied' } : { value: m === 'fs.watch' ? 7 : undefined } },
    callAsync: async (m: string, a: any) => { calls.push([m, a]); return { value: { code: 0, stdout: 'ok', stderr: '' } } },
    send: (m: string, a: any) => sent.push([m, a]),
    onEvent: (cb: typeof emit) => { emit = cb },
  }
  return { bridge, calls, sent, emit: (ev: string, ...args: unknown[]) => emit(ev, args) }
}
const manifest = { id: 'acme.x', name: 'X', version: '1.0.0', main: 'main.js' }
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('plugin bootstrap (window side)', () => {
  it('requires the plugin files and routes the ctx API to the bridge', async () => {
    const f = fakeBridge({ 'plugin.dir': '/p', 'workspace.project': '/work' })
    const files = {
      'main.js': `const u = require('./lib/util'); const again = require('./lib/util.js');
        exports.activate = async (ctx) => {
          globalThis.__seen = { same: u === again, twice: u.twice(21), project: ctx.workspace.project, dir: ctx.plugin.dir }
          ctx.ui.view('main').set({ kind: 'empty', text: 'hi' })
          ctx.ui.view('main').onEvent((e) => { globalThis.__event = e })
          ctx.workspace.onDidChangeProject((r) => { globalThis.__project = r })
          const stop = ctx.workspace.fs.watch('/work', (name) => { globalThis.__watch = name })
          globalThis.__stop = stop
          ctx.terminal.run({ cwd: '/work', argv: [['git', 'status']] })
          globalThis.__exec = await ctx.process.exec('git', ['status'], { cwd: '/work' })
          try { ctx.workspace.fs.read('/etc/passwd') } catch (e) { globalThis.__denied = e.message }
          ctx.storage.set('k', 1); ctx.settings.get('s')
          const pop = ctx.ui.popover('main', { kind: 'empty', text: 'p' }); pop.close()
          console.log('hello', { a: 1 })
        }`,
      'lib/util.js': `exports.twice = (n) => n * 2`,
    }
    boot(f.bridge, manifest, files)
    await tick(); await tick()
    const g = globalThis as any
    expect(g.__seen).toEqual({ same: true, twice: 42, project: '/work', dir: '/p' })
    expect(g.__exec.stdout).toBe('ok')
    expect(g.__denied).toBe('denied')
    const methods = f.calls.map(([m]) => m)
    expect(methods).toEqual(expect.arrayContaining(['ui.viewSet', 'fs.watch', 'terminal.run', 'process.exec', 'fs.read', 'storage.set', 'settings.get', 'ui.popover', 'ui.popoverClose']))
    expect(f.calls.find(([m]) => m === 'ui.viewSet')![1]).toEqual({ viewId: 'acme.x:main', model: { kind: 'empty', text: 'hi' } })
    expect(f.calls.find(([m]) => m === 'terminal.run')![1]).toEqual({ cwd: '/work', argv: [['git', 'status']] })
    // host events reach the plugin's listeners
    f.emit('view:acme.x:main', { viewId: 'acme.x:main', type: 'select', itemId: 'a' })
    f.emit('project', '/other')
    f.emit('fs', 7, 'HEAD')
    expect(g.__event.itemId).toBe('a')
    expect(g.__project).toBe('/other')
    expect(g.__watch).toBe('HEAD')
    g.__stop()
    expect(f.calls.at(-1)).toEqual(['fs.unwatch', { wid: 7 }])
    expect(f.sent).toContainEqual(['console', ['log', ['hello', '{"a":1}']]])
  })

  it('projects, visibility, decorations, opening a project or a URL', async () => {
    const f = fakeBridge({ 'workspace.projects': [{ root: '/a', linked: ['/b'] }], 'workspace.visible': true })
    const files = {
      'main.js': `exports.activate = (ctx) => {
        globalThis.__ws = { projects: ctx.workspace.projects(), visible: ctx.workspace.visible }
        ctx.workspace.onDidChangeProjects((p) => { globalThis.__projects = p })
        ctx.workspace.onDidChangeVisibility((v) => { globalThis.__visible = v })
        ctx.ui.projectDecoration('/a', { text: 'main ↑1', tone: 'warn' })
        ctx.ui.projectDecoration('/b')
        ctx.workspace.openProject('/a.worktrees/x', { claude: true })
        ctx.workspace.openUrl('https://github.com/x/y/pull/1')
      }`,
    }
    boot(f.bridge, manifest, files)
    await tick()
    const g = globalThis as any
    expect(g.__ws).toEqual({ projects: [{ root: '/a', linked: ['/b'] }], visible: true })
    expect(f.calls.filter(([m]) => m === 'ui.projectDecoration').map(([, a]) => a)).toEqual([{ root: '/a', deco: { text: 'main ↑1', tone: 'warn' } }, { root: '/b', deco: null }])
    expect(f.calls.find(([m]) => m === 'workspace.openProject')![1]).toEqual({ path: '/a.worktrees/x', claude: true })
    expect(f.calls.find(([m]) => m === 'workspace.openUrl')![1]).toEqual({ url: 'https://github.com/x/y/pull/1' })
    f.emit('projects', [{ root: '/c', linked: [] }]); f.emit('visibility', false)
    expect(g.__projects).toEqual([{ root: '/c', linked: [] }])
    expect(g.__visible).toBe(false)
  })

  it('reports load failures and refuses requires outside the plugin', async () => {
    const run = async (files: Record<string, string>) => { const f = fakeBridge(); boot(f.bridge, manifest, files); await tick(); return f.sent.filter(([m]) => m === 'fail').map(([, a]) => a as string) }
    expect((await run({ 'main.js': 'exports.x = 1' }))[0]).toMatch(/no activate/)
    expect((await run({ 'main.js': "require('../../etc/x')" }))[0]).toMatch(/outside the plugin/)
    expect((await run({ 'main.js': "require('./nope')" }))[0]).toMatch(/module not found/)
    expect((await run({ 'main.js': "require('constructor')" }))[0]).toMatch(/module not found/)
    expect((await run({ 'main.js': 'exports.activate = async () => { throw new Error("boom") }' }))[0]).toMatch(/boom/)
    expect(await run({ 'main.js': 'exports.default = { activate() {} }' })).toEqual([])
  })

  it('routes prompts, the selection and commands to the bridge', async () => {
    const f = fakeBridge()
    boot(f.bridge, manifest, { 'main.js': `exports.activate = async (ctx) => {
      ctx.claude.insertPrompt('relis', { send: true }); ctx.claude.insertPrompt('à compléter')
      ctx.commands.set([{ id: 'review', title: 'Revue', shortcut: 'Mod+Alt+R' }])
      ctx.commands.onRun((id) => { globalThis.__cmd = id })
      await ctx.workspace.selection()
    }` })
    await tick()
    expect(f.calls).toEqual(expect.arrayContaining([
      ['claude.insertPrompt', { text: 'relis', send: true }], ['claude.insertPrompt', { text: 'à compléter', send: false }],
      ['commands.set', { list: [{ id: 'review', title: 'Revue', shortcut: 'Mod+Alt+R' }] }], ['workspace.selection', undefined],
    ]))
    f.emit('command', 'review')
    expect((globalThis as any).__cmd).toBe('review')
  })

  it('calls deactivate when the host stops the plugin', async () => {
    const f = fakeBridge()
    boot(f.bridge, manifest, { 'main.js': 'exports.activate = () => {}; exports.deactivate = () => { globalThis.__off = true }' })
    f.emit('deactivate')
    expect((globalThis as any).__off).toBe(true)
  })

  it('reads the plugin .js files with posix keys', () => {
    const t = new TempDir()
    t.write('main.js', 'a'); t.write('lib/x.js', 'b'); t.write('plugin.json', '{}'); t.write('.hidden/y.js', 'c'); t.write('node_modules/z/i.js', 'd')
    expect(readPluginFiles(t.path)).toEqual({ 'main.js': 'a', 'lib/x.js': 'b' })
    t.dispose()
  })

  it('the built-in plugins load under the bootstrap', async () => {
    for (const id of ['git']) {
      const dir = join(__dirname, '..', 'resources', 'plugins', id)
      const m = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
      const f = fakeBridge({ 'workspace.project': null })
      boot(f.bridge, m, readPluginFiles(dir))
      await tick(); await tick()
      expect(f.sent.filter(([x]) => x === 'fail')).toEqual([])
      expect(f.calls.some(([x]) => x === 'ui.viewSet')).toBe(true)
    }
  })
})
