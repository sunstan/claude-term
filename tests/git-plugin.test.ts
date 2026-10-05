import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { TempDir } from './helpers'

const require = createRequire(import.meta.url)
const { parseStatus, parseLog, parseRefs, parseDecorations, parseNameStatus, parseCommitInfo, LOG_FORMAT, REF_FORMAT, INFO_FORMAT, LABELS } = require('../resources/plugins/git/git.js')
const { layout } = require('../resources/plugins/git/graph.js')
const M = require('../resources/plugins/git/model.js')

const env = (cwd: string) => ({ ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x', HOME: cwd })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: env(cwd) })
const status = (r: string) => parseStatus(git(r, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'))
const refs = (r: string) => parseRefs(git(r, 'for-each-ref', '--format=' + REF_FORMAT, 'refs/heads', 'refs/remotes'))
const log = (r: string) => parseLog(git(r, 'log', '--all', '--topo-order', '--format=' + LOG_FORMAT))

/** A repo with a remote (bare) and one commit on main. */
function repo() {
  const t = new TempDir(); const r = join(t.path, 'work'); const bare = join(t.path, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', bare])
  execFileSync('git', ['init', '-q', '-b', 'main', r])
  t.write('work/a.txt', 'a\n'); git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'first')
  git(r, 'remote', 'add', 'origin', bare); git(r, 'push', '-q', '-u', 'origin', 'main')
  return { t, r }
}
/** Runs the `run` effects of a reduce result against the repo (what the shell tab would do). */
// a seq runs like the terminal chain: in order, stopping at the first failure (execFileSync throws)
const runEffects = (r: string, effects: any[]) => effects.filter((f) => f.type === 'run').flatMap((f) => (f.seq ?? [f.args]).map((a: string[]) => git(r, ...a)))
const stateOf = (r: string, extra = {}) => M.withData({ ...M.initialState(), ...extra }, r, status(r), log(r), refs(r))

// each case spawns a few dozen git processes: slow on Windows while the whole suite runs
describe('parsers against real repositories', { timeout: 30_000 }, () => {
  it('status: staged, unstaged, untracked, renamed, ahead', () => {
    const { t, r } = repo()
    t.write('work/b.txt', 'b\n'); t.write('work/c.txt', 'c\n'); git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'second')
    t.write('work/a.txt', 'a2\n')                                // unstaged
    t.write('work/b.txt', 'b2\n'); git(r, 'add', 'b.txt')        // staged
    t.write('work/new.txt', 'n\n')                               // untracked
    git(r, 'mv', 'c.txt', 'd.txt')                               // renamed
    const s = status(r)
    expect(s).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 1, behind: 0, detached: false })
    const by = Object.fromEntries(s.entries.map((e: any) => [e.path, e]))
    expect(by['a.txt']).toMatchObject({ staged: null, unstaged: 'M', untracked: false, conflict: false })
    expect(by['b.txt']).toMatchObject({ staged: 'M', unstaged: null })
    expect(by['new.txt']).toMatchObject({ untracked: true })
    expect(by['d.txt']).toMatchObject({ staged: 'R', from: 'c.txt' })
    expect(LABELS.R).toBe('renommé')
    t.dispose()
  })
  it('status: conflict, detached head, empty and comment-only input', () => {
    const { t, r } = repo()
    git(r, 'switch', '-q', '-c', 'other'); t.write('work/a.txt', 'other\n'); git(r, 'commit', '-q', '-am', 'o')
    git(r, 'switch', '-q', 'main'); t.write('work/a.txt', 'main\n'); git(r, 'commit', '-q', '-am', 'm')
    try { git(r, 'merge', 'other') } catch { /* conflict expected */ }
    expect(status(r).entries.find((e: any) => e.path === 'a.txt')).toMatchObject({ conflict: true, unstaged: 'UU' })
    git(r, 'merge', '--abort')
    git(r, 'switch', '-q', '--detach')
    expect(status(r)).toMatchObject({ detached: true, branch: null })
    expect(parseStatus('')).toEqual({ branch: null, upstream: null, ahead: 0, behind: 0, detached: false, entries: [] })
    expect(parseStatus('# branch.oid abc\0# branch.ab garbage\0! ignored.txt\0').entries).toEqual([])
    expect(parseStatus('1 bad\0').entries).toEqual([])
    expect(parseStatus('2 bad\0orig\0').entries).toEqual([])
    expect(parseStatus('u bad\0').entries).toEqual([])
    t.dispose()
  })
  it('log and refs (local with tracking, remote, gone upstream, detached)', () => {
    const { t, r } = repo()
    t.write('work/x', 'x'); git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'second')
    const l = log(r)
    expect(l.map((c: any) => c.subject)).toEqual(['second', 'first'])
    expect(l[0]).toMatchObject({ author: 'T' }); expect(l[0].hash).toHaveLength(40); expect(l[0].short.length).toBeGreaterThanOrEqual(7)
    expect(parseLog('')).toEqual([])
    git(r, 'branch', 'feature')
    git(r, 'branch', '-q', '--track', 'ghost', 'origin/main'); git(r, 'push', '-q', 'origin', 'ghost'); git(r, 'branch', '-q', '-u', 'origin/ghost', 'ghost'); git(r, 'push', '-q', 'origin', '--delete', 'ghost')
    const rf = refs(r)
    const main = rf.local.find((b: any) => b.name === 'main')
    expect(main).toMatchObject({ current: true, upstream: 'origin/main', ahead: 1, behind: 0, gone: false })
    expect(rf.local.find((b: any) => b.name === 'feature')).toMatchObject({ current: false, upstream: null, ahead: 0 })
    expect(rf.local.find((b: any) => b.name === 'ghost')).toMatchObject({ gone: true })
    expect(rf.remote).toEqual([expect.objectContaining({ remote: 'origin', name: 'main', full: 'origin/main' })])
    expect(parseRefs('')).toEqual({ local: [], remote: [] })
    expect(parseRefs('refs/remotes/origin/HEAD\tabc\t\t\t \t1\nrefs/tags/v1\tabc\t\t\t \t1\n')).toEqual({ local: [], remote: [] })
    expect(parseRefs('refs/heads/x\tabc\torigin/x\t[behind 2]\t \tnope\n').local[0]).toMatchObject({ behind: 2, ahead: 0, date: 0 })
    t.dispose()
  })
})

describe('model: views', { timeout: 30_000 }, () => {
  it('changes view: empty states, groups, badges, footer state', () => {
    expect(M.changesView(M.initialState())).toEqual({ kind: 'empty', text: 'Ouvre un projet' })
    expect(M.changesView({ ...M.initialState(), root: '/p' })).toEqual({ kind: 'empty', text: 'Pas un dépôt git' })
    const { t, r } = repo()
    t.write('work/a.txt', 'a2\n'); t.write('work/sub/new.txt', 'n\n'); t.write('work/gone.txt', 'g\n'); git(r, 'add', 'gone.txt'); git(r, 'commit', '-q', '-m', 'g'); git(r, 'rm', '-q', 'gone.txt')
    git(r, 'switch', '-q', '-c', 'other'); t.write('work/a.txt', 'other\n'); git(r, 'commit', '-q', '-am', 'o'); git(r, 'switch', '-q', 'main'); t.write('work/a.txt', 'main\n'); git(r, 'commit', '-q', '-am', 'm')
    try { git(r, 'merge', 'other') } catch { /* conflict */ }
    let s = stateOf(r, { checked: { 'a.txt': true }, message: 'msg', amend: true })
    const v = M.changesView(s)
    expect(v.kind).toBe('tree')
    expect(v.items.map((g: any) => g.id)).toEqual(['g:conflicts', 'g:changes', 'g:untracked'])
    const conflict = v.items[0].children[0]
    expect(conflict).toMatchObject({ id: 'file:a.txt', checked: true, badges: ['conflit'] })
    expect(conflict.contextMenu.map((m: any) => m.id || m)).toEqual(['diff', 'openFile', 'sep'])
    const gone = v.items[1].children.find((c: any) => c.id === 'file:gone.txt')
    expect(gone.badges).toEqual(['supprimé'])
    expect(gone.contextMenu.map((m: any) => m.id || m)).toEqual(['diff', 'openFile', 'sep', 'unstage'])
    const nw = v.items[2].children[0]
    expect(nw).toMatchObject({ id: 'file:sub/new.txt', label: 'new.txt', detail: 'sub', badges: [], checked: false })
    expect(nw.contextMenu.map((m: any) => m.id || m)).toEqual(['diff', 'openFile', 'sep', 'add'])
    expect(v.toolbar[0].title).toContain('main')
    expect(v.footer.fields[0].value).toBe('msg'); expect(v.footer.checks[0].checked).toBe(true)
    expect(v.footer.buttons[0]).toMatchObject({ title: 'Commit (1)', disabled: false })
    git(r, 'merge', '--abort')
    // plain modified file: no badge; nothing checked and empty message: buttons disabled
    t.write('work/a.txt', 'zz\n')
    s = stateOf(r)
    const v2 = M.changesView(s)
    expect(v2.items.find((g: any) => g.id === 'g:changes').children.find((c: any) => c.id === 'file:a.txt').badges).toEqual([])
    expect(v2.footer.buttons[0]).toMatchObject({ title: 'Commit', disabled: true })
    expect(v2.items.some((g: any) => g.id === 'g:conflicts')).toBe(false)
    // collapsed groups and detached/ahead-behind labels
    const v3 = M.changesView({ ...s, collapsed: { 'g:changes': true }, status: { ...s.status, detached: true, ahead: 2, behind: 1 } })
    expect(v3.items.find((g: any) => g.id === 'g:changes').expanded).toBe(false)
    expect(v3.toolbar[0].title).toBe('Branche : HEAD détachée ↑2 ↓1')
    expect(M.changesView({ ...s, status: { ...s.status, branch: null, detached: false, ahead: 0, behind: 0 } }).toolbar[0].title).toBe('Branche : ?')
    t.dispose()
  })
  it('branches, commits and popover views', () => {
    expect(M.branchesView(M.initialState())).toEqual({ kind: 'empty', text: '' })
    expect(M.commitsView(M.initialState())).toEqual({ kind: 'empty', text: 'Pas un dépôt git' })
    const { t, r } = repo()
    git(r, 'branch', 'feature')
    let s = stateOf(r)
    const b = M.branchesView(s)
    expect(b.items[0].label).toBe('HEAD (main)')
    const local = b.items[1].children
    expect(local.find((x: any) => x.label === 'main')).toMatchObject({ color: 'accent', badges: ['HEAD'], detail: 'origin/main' })
    expect(local.find((x: any) => x.label === 'feature')).toMatchObject({ badges: [], detail: '' })
    expect(local.find((x: any) => x.label === 'main').contextMenu.find((m: any) => m.id === 'switch').disabled).toBe(true)
    expect(local.find((x: any) => x.label === 'feature').contextMenu.find((m: any) => m.id === 'update').disabled).toBe(true)
    expect(b.items[2]).toMatchObject({ id: 'g:remote:origin', label: 'origin' })
    expect(b.items[2].children[0]).toMatchObject({ id: 'remote:origin/main', muted: true })
    // gone upstream label, detached head label, collapsed
    const b2 = M.branchesView({ ...s, collapsed: { 'g:local': true }, status: { ...s.status, detached: true }, refs: { local: [{ name: 'x', upstream: 'origin/x', gone: true, ahead: 1, behind: 2, current: false, date: 1 }], remote: [] } })
    expect(b2.items[0].label).toBe('HEAD (HEAD détachée)')
    expect(b2.items[1]).toMatchObject({ expanded: false })
    expect(b2.items[1].children[0]).toMatchObject({ detail: 'origin/x (disparue)', extra: '↑1 ↓2' })
    expect(M.branchesView({ ...s, status: { ...s.status, branch: null } }).items[0].label).toBe('HEAD (?)')
    const c = M.commitsView(s)
    expect(c).toMatchObject({ kind: 'list', graph: true, search: true })
    expect(c.items[0]).toMatchObject({ label: 'first', selected: false, graph: { node: 0 } })
    expect(c.items[0].badges).toEqual(['main', 'origin/main', 'feature'])
    expect(c.detail).toEqual({ kind: 'stack', panes: [{ kind: 'empty', text: 'Sélectionne un commit' }, { kind: 'empty', text: '' }] })
    expect(M.commitsView({ ...s, commits: [] })).toEqual({ kind: 'empty', text: 'Aucun commit' })
    const p = M.branchPopover(s)
    expect(p.items.map((g: any) => g.id)).toEqual(['g:actions', 'g:recent', 'g:local', 'g:remote'])
    expect(M.branchPopover({ ...s, refs: { local: [], remote: [] } }).items.map((g: any) => g.id)).toEqual(['g:actions'])
    expect(p.items[1].children.map((x: any) => x.id)).toContain('local:main')
    expect(p.items[3].children[0]).toMatchObject({ id: 'remote:origin/main', muted: true })
    t.dispose()
  })
})

describe('model: reduce (events → state and effects)', () => {
  const ev = (type: string, extra = {}) => ({ viewId: 'claudeterm.git:changes', type, ...extra })
  it('footer edits and checks, group tri-state, refresh after data keeps existing checks', () => {
    const { t, r } = repo()
    t.write('work/a.txt', 'a2\n'); t.write('work/n1.txt', '1'); t.write('work/n2.txt', '2')
    let s = stateOf(r)
    s = M.reduce(s, ev('input', { fieldId: 'message', value: 'hello' })).state; expect(s.message).toBe('hello')
    s = M.reduce(s, ev('check', { itemId: 'amend', value: true })).state; expect(s.amend).toBe(true)
    s = M.reduce(s, ev('check', { itemId: 'file:a.txt', value: true })).state; expect(M.checkedPaths(s)).toEqual(['a.txt'])
    s = M.reduce(s, ev('check', { itemId: 'g:untracked', value: true })).state; expect(M.checkedPaths(s).sort()).toEqual(['a.txt', 'n1.txt', 'n2.txt'])
    s = M.reduce(s, ev('check', { itemId: 'g:changes', value: false })).state; expect(M.checkedPaths(s).sort()).toEqual(['n1.txt', 'n2.txt'])
    expect(M.reduce({ ...s, status: null }, ev('check', { itemId: 'g:conflicts', value: true })).state.checked).toEqual(s.checked)
    expect(M.reduce(s, ev('input', { fieldId: 'other', value: 'x' })).effects).toEqual([])
    // after a refresh, a checked path that disappeared is dropped
    git(r, 'add', 'n1.txt'); git(r, 'commit', '-q', '-m', 'n1')
    s = M.withData(s, r, status(r), log(r), refs(r)); expect(M.checkedPaths(s)).toEqual(['n2.txt'])
    expect(M.withData(s, r, null, [], { local: [], remote: [] }).checked).toEqual({})
    // toggle all groups
    s = M.reduce(s, ev('toolbar', { actionId: 'toggleAll' })).state; expect(s.collapsed['g:changes']).toBe(true)
    s = M.reduce(s, ev('toolbar', { actionId: 'toggleAll' })).state; expect(s.collapsed['g:changes']).toBe(false)
    t.dispose()
  })
  it('commit: validation, commands (untracked add, --amend, push), and the commands work on the repo', () => {
    const { t, r } = repo()
    t.write('work/a.txt', 'a2\n'); t.write('work/b.txt', 'b\n'); t.write('work/new.txt', 'n\n'); git(r, 'add', 'b.txt')
    let s = stateOf(r)
    expect(M.reduce({ ...s, status: null }, ev('button', { actionId: 'commit' })).effects).toEqual([])
    expect(M.reduce(s, ev('button', { actionId: 'commit' })).effects[0]).toMatchObject({ type: 'notify', body: 'Coche les fichiers à committer.' })
    s = { ...s, checked: { 'a.txt': true, 'new.txt': true } }
    expect(M.reduce(s, ev('button', { actionId: 'commit' })).effects[0]).toMatchObject({ type: 'notify', body: 'Écris un message de commit.' })
    s = { ...s, message: ' feat: x ' }
    expect(M.reduce(s, ev('button', { actionId: 'other' })).effects).toEqual([])
    const res = M.reduce(s, ev('button', { actionId: 'commitPush' }))
    expect(res.effects).toEqual([{ type: 'run', seq: [['add', '--', 'new.txt'], ['commit', '-m', 'feat: x', '--', 'a.txt', 'new.txt'], ['push']] }])
    expect(res.state).toMatchObject({ message: '', amend: false, checked: {} })
    runEffects(r, res.effects)
    expect(log(r)[0].subject).toBe('feat: x')
    expect(git(r, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['a.txt', 'new.txt'])
    expect(status(r).entries.map((e: any) => e.path)).toEqual(['b.txt'])   // b.txt (staged before) was not committed
    expect(status(r).ahead).toBe(0)                                        // pushed
    // amend without untracked and without push
    s = { ...stateOf(r), checked: { 'b.txt': true }, message: 'feat: x amended', amend: true }
    const res2 = M.reduce(s, ev('button', { actionId: 'commit' }))
    expect(res2.effects).toEqual([{ type: 'run', seq: [['commit', '--amend', '-m', 'feat: x amended', '--', 'b.txt']] }])
    runEffects(r, res2.effects)
    expect(parseLog(git(r, 'log', '--format=' + LOG_FORMAT)).map((c: any) => c.subject)).toEqual(['feat: x amended', 'first'])
    t.dispose()
  })
  it('toolbar and prompt flows: refresh, fetch, new branch, rename, checkout revision, popover', () => {
    const { t, r } = repo()
    const s = stateOf(r)
    expect(M.reduce(s, ev('toolbar', { actionId: 'refresh' })).effects).toEqual([{ type: 'refresh' }])
    expect(M.reduce(s, ev('toolbar', { actionId: 'fetch' })).effects).toEqual([{ type: 'run', args: ['fetch', '--all', '--prune'] }])
    expect(M.reduce(s, ev('toolbar', { actionId: 'unknown' })).effects).toEqual([])
    const nb = M.reduce(s, ev('toolbar', { actionId: 'newBranch' })).effects[0]
    expect(nb.type).toBe('prompt')
    const created = M.reduce(s, { ...nb.then, value: ' feat/x ' })
    expect(created.effects).toEqual([{ type: 'run', args: ['switch', '-c', 'feat/x'] }])
    runEffects(r, created.effects); expect(status(r).branch).toBe('feat/x')
    expect(M.reduce(s, { ...nb.then, value: null }).effects).toEqual([])
    expect(M.reduce(s, { type: 'promptResult', action: 'other', value: 'x' }).effects).toEqual([])
    const renamed = M.reduce(s, { type: 'promptResult', action: 'rename', from: 'feat/x', value: 'feat/y' })
    runEffects(r, renamed.effects); expect(status(r).branch).toBe('feat/y')
    const detach = M.reduce(s, { type: 'promptResult', action: 'checkoutRev', value: 'main' })
    expect(detach.effects).toEqual([{ type: 'run', args: ['switch', '--detach', 'main'] }])
    runEffects(r, detach.effects); expect(status(r).detached).toBe(true)
    const pop = M.reduce(s, ev('toolbar', { actionId: 'branch' })).effects[0]
    expect(pop).toMatchObject({ type: 'popover', view: 'changes' }); expect(pop.model.kind).toBe('tree')
    t.dispose()
  })
  it('popover selections', () => {
    const { t, r } = repo()
    git(r, 'branch', 'feature')
    const s = stateOf(r)
    const pe = (itemId: string) => ({ viewId: 'popover:1', type: 'select', itemId })
    const eff = (id: string) => M.reduce(s, pe(id)).effects
    expect(eff('update')).toEqual([{ type: 'closePopover' }, { type: 'run', args: ['pull'] }])
    expect(eff('push')).toEqual([{ type: 'closePopover' }, { type: 'run', args: ['push'] }])
    expect(eff('fetch')).toEqual([{ type: 'closePopover' }, { type: 'run', args: ['fetch', '--all', '--prune'] }])
    expect(eff('newBranch')[1]).toMatchObject({ type: 'prompt' })
    expect(eff('checkoutRev')[1]).toMatchObject({ type: 'prompt', then: { action: 'checkoutRev' } })
    expect(eff('local:feature')).toEqual([{ type: 'closePopover' }, { type: 'run', args: ['switch', 'feature'] }])
    expect(eff('local:main')).toEqual([{ type: 'closePopover' }])              // current branch: nothing to do
    expect(eff('local:nope')).toEqual([{ type: 'closePopover' }])
    expect(eff('remote:origin/main')).toEqual([{ type: 'closePopover' }, { type: 'run', args: ['switch', 'main'] }])
    expect(eff('g:actions')).toEqual([{ type: 'closePopover' }])
    t.dispose()
  })
  it('selections, opens, context menus on files, commits and branches', () => {
    const { t, r } = repo()
    git(r, 'branch', 'feature')
    const s = stateOf(r)
    const hash = log(r)[0].hash
    expect(M.reduce(s, ev('select', { itemId: 'file:a.txt' })).effects).toEqual([{ type: 'detailFile', path: 'a.txt' }])
    expect(M.reduce(s, ev('open', { itemId: 'file:a.txt' })).effects).toEqual([{ type: 'diffFile', path: 'a.txt' }])
    const sel = M.reduce(s, ev('select', { itemId: 'commit:' + hash }))
    expect(sel.effects).toEqual([{ type: 'loadCommit', hash }])
    expect(sel.state).toMatchObject({ selectedCommit: hash, commitFiles: null, commitInfo: null })
    expect(M.reduce(s, ev('open', { itemId: 'commit:' + hash })).effects).toEqual([{ type: 'diffCommit', hash }])
    expect(M.reduce(s, ev('open', { itemId: 'local:feature' })).effects).toEqual([{ type: 'run', args: ['switch', 'feature'] }])
    expect(M.reduce(s, ev('open', { itemId: 'local:main' })).effects).toEqual([])
    expect(M.reduce(s, ev('select', { itemId: 'local:feature' })).effects).toEqual([])
    expect(M.reduce(s, ev('select', {})).effects).toEqual([])
    const menu = (itemId: string, actionId: string) => M.reduce(s, ev('menu', { itemId, actionId })).effects
    expect(menu('file:a.txt', 'diff')).toEqual([{ type: 'diffFile', path: 'a.txt' }])
    expect(menu('file:a.txt', 'openFile')).toEqual([{ type: 'openFile', path: 'a.txt' }])
    expect(menu('file:a.txt', 'add')).toEqual([{ type: 'run', args: ['add', '--', 'a.txt'] }])
    expect(menu('file:a.txt', 'unstage')).toEqual([{ type: 'run', args: ['restore', '--staged', '--', 'a.txt'] }])
    expect(menu('file:a.txt', 'nope')).toEqual([])
    expect(menu('commit:' + hash, 'diffCommit')).toEqual([{ type: 'diffCommit', hash }])
    expect(menu('commit:' + hash, 'copyHash')).toEqual([{ type: 'copy', text: hash }])
    expect(menu('commit:' + hash, 'nope')).toEqual([])
    expect(menu('local:feature', 'switch')).toEqual([{ type: 'run', args: ['switch', 'feature'] }])
    expect(menu('remote:origin/main', 'switchRemote')).toEqual([{ type: 'run', args: ['switch', 'main'] }])
    const nf = menu('remote:origin/main', 'newFrom')[0]
    expect(nf).toMatchObject({ type: 'prompt', then: { action: 'newBranch', from: 'origin/main' } })
    const created = M.reduce(s, { ...nf.then, value: 'from-remote' })
    expect(created.effects).toEqual([{ type: 'run', args: ['switch', '-c', 'from-remote', 'origin/main'] }])
    runEffects(r, created.effects); expect(status(r).branch).toBe('from-remote')
    expect(menu('local:feature', 'diffWorkTree')).toEqual([{ type: 'diffRef', ref: 'feature' }])
    expect(menu('local:main', 'update')).toEqual([{ type: 'run', args: ['pull'] }])
    expect(menu('local:main', 'push')).toEqual([{ type: 'run', args: ['push'] }])
    expect(menu('local:feature', 'rename')[0]).toMatchObject({ type: 'prompt', then: { action: 'rename', from: 'feature' } })
    expect(menu('local:feature', 'delete')).toEqual([{ type: 'run', args: ['branch', '-d', 'feature'] }])
    runEffects(r, menu('local:feature', 'delete')); expect(refs(r).local.map((b: any) => b.name)).not.toContain('feature')
    expect(menu('local:main', 'nope')).toEqual([])
    expect(M.reduce(s, ev('unknown')).effects).toEqual([])
    t.dispose()
  })
})

describe('model and parsers: remaining branches', () => {
  it('rename with a worktree edit, remote ref with a bad date, unknown status code, singular/plural counts, popover extras', () => {
    const { t, r } = repo()
    t.write('work/c.txt', 'c\n'); git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'c')
    git(r, 'mv', 'c.txt', 'd.txt'); t.write('work/d.txt', 'c2\n')
    expect(status(r).entries.find((e: any) => e.path === 'd.txt')).toMatchObject({ staged: 'R', unstaged: 'M', from: 'c.txt' })
    const renamed = M.changesView(stateOf(r)).items.find((g: any) => g.id === 'g:changes').children.find((c: any) => c.id === 'file:d.txt')
    expect(renamed.badges).toEqual(['renommé'])
    // plural counts
    const plural = M.changesView({ ...stateOf(r), status: { branch: 'main', upstream: null, ahead: 0, behind: 0, detached: false, entries: [
      { path: 'x.txt', staged: null, unstaged: 'M', untracked: false, conflict: false }, { path: 'y.txt', staged: 'M', unstaged: null, untracked: false, conflict: false },
      { path: 'u.txt', staged: null, unstaged: null, untracked: true, conflict: false }, { path: 'v.txt', staged: null, unstaged: null, untracked: true, conflict: false },
    ] } })
    expect(plural.items[0].detail).toBe('2 fichiers'); expect(plural.items[1].detail).toBe('2 fichiers')
    expect(parseRefs('refs/remotes/origin/x\tabc\t\t\t \tnope\n').remote[0]).toMatchObject({ remote: 'origin', name: 'x', date: 0 })
    // unknown status code → no badge; single tracked and single untracked file → singular labels
    const s = { ...stateOf(r), status: { branch: 'main', upstream: null, ahead: 0, behind: 0, detached: false, entries: [
      { path: 'x.txt', staged: null, unstaged: 'X', untracked: false, conflict: false },
      { path: 'u.txt', staged: null, unstaged: null, untracked: true, conflict: false },
    ] } }
    const v = M.changesView(s)
    expect(v.items[0]).toMatchObject({ detail: '1 fichier' }); expect(v.items[0].children[0].badges).toEqual([])
    expect(v.items[1]).toMatchObject({ detail: '1 fichier' })
    const p = M.branchPopover({ ...s, refs: { local: [
      { name: 'main', current: true, ahead: 2, behind: 0, upstream: 'origin/main', date: 2 },
      { name: 'old', current: false, ahead: 0, behind: 3, upstream: null, date: 1 },
    ], remote: [] } })
    expect(p.items[1].children[0]).toMatchObject({ color: 'accent', extra: '↑2 ', detail: 'origin/main' })
    expect(p.items[1].children[1]).toMatchObject({ color: undefined, extra: '↓3', detail: '' })
    t.dispose()
  })
})

describe('model: group by directory', () => {
  it('builds a compacted directory tree, checks whole directories, toggles and persists the mode', () => {
    const { t, r } = repo()
    for (const f of ['src/main/services/a.ts', 'src/main/services/b.ts', 'src/renderer/c.tsx', 'README.md']) t.write('work/' + f, 'x')
    let s = { ...stateOf(r), groupByDir: true }
    const v = M.changesView(s)
    const un = v.items.find((g: any) => g.id === 'g:untracked')
    expect(un.children.map((c: any) => c.label)).toEqual(['src', 'README.md'])
    const src = un.children[0]
    expect(src).toMatchObject({ id: 'dir:untracked:src', folder: 'src', checked: false, expanded: true })
    expect(src.children.map((c: any) => c.label)).toEqual(['main/services', 'renderer'])
    expect(src.children[0]).toMatchObject({ id: 'dir:untracked:src/main/services' })
    expect(src.children[0].children.map((c: any) => c.id)).toEqual(['file:src/main/services/a.ts', 'file:src/main/services/b.ts'])
    expect(src.children[0].children[0].detail).toBe('')
    // collapsed directory nodes
    expect(M.changesView({ ...s, collapsed: { 'dir:untracked:src': true } }).items.find((g: any) => g.id === 'g:untracked').children[0].expanded).toBe(false)
    // checking a directory checks every file under it; checking the group checks all
    s = M.reduce(s, { viewId: 'v', type: 'check', itemId: 'dir:untracked:src/main/services', value: true }).state
    expect(M.checkedPaths(s).sort()).toEqual(['src/main/services/a.ts', 'src/main/services/b.ts'])
    s = M.reduce(s, { viewId: 'v', type: 'check', itemId: 'dir:untracked:src', value: false }).state
    expect(M.checkedPaths(s)).toEqual([])
    // toggle → persist effect, toolbar title follows
    const res = M.reduce(s, { viewId: 'v', type: 'toolbar', actionId: 'groupDirs' })
    expect(res.state.groupByDir).toBe(false); expect(res.effects).toEqual([{ type: 'persist', key: 'groupByDir', value: false }])
    expect(M.changesView(res.state).toolbar.find((a: any) => a.id === 'groupDirs')).toMatchObject({ title: 'Grouper par dossier', icon: 'folder' })
    expect(M.changesView(s).toolbar.find((a: any) => a.id === 'groupDirs')).toMatchObject({ title: 'Liste à plat', icon: 'list' })
    expect(M.dirTree([], {}, 'changes', {})).toEqual([])
    t.dispose()
  })
})

describe('commit graph', () => {
  it('linear history: one lane, no line above the tip nor below the root', () => {
    const rows = layout([{ hash: 'c', parents: ['b'] }, { hash: 'b', parents: ['a'] }, { hash: 'a', parents: [] }])
    expect(rows.map((r: any) => r.node)).toEqual([0, 0, 0])
    expect(rows[0]).toMatchObject({ up: [], down: [[0, 0, 0]], width: 1 })
    expect(rows[1]).toMatchObject({ up: [[0, 0, 0]], down: [[0, 0, 0]] })
    expect(rows[2]).toMatchObject({ up: [[0, 0, 0]], down: [] })
  })
  it('merge: the second parent opens a lane, both lanes converge on the base', () => {
    const rows = layout([{ hash: 'm', parents: ['a1', 'b1'] }, { hash: 'a1', parents: ['r'] }, { hash: 'b1', parents: ['r'] }, { hash: 'r', parents: [] }])
    expect(rows[0]).toMatchObject({ node: 0, up: [], down: [[0, 0, 0], [0, 1, 1]], width: 2 })
    expect(rows[1]).toMatchObject({ node: 0, up: [[0, 0, 0], [1, 1, 1]], down: [[0, 0, 0], [1, 1, 1]] })
    expect(rows[2]).toMatchObject({ node: 1, color: 1, down: [[0, 0, 0], [1, 0, 0]] })
    expect(rows[3]).toMatchObject({ node: 0, up: [[0, 0, 0]], down: [], width: 1 })
  })
  it('two branch tips, a merge into an existing lane, a lane freed in the middle, colors cycle', () => {
    // x and y are two tips; y's parent p is also x's second parent (joins an existing lane)
    const rows = layout([{ hash: 'x', parents: ['q', 'p'] }, { hash: 'y', parents: ['p'] }, { hash: 'q', parents: ['p'] }, { hash: 'p', parents: [] }])
    expect(rows[1]).toMatchObject({ node: 2, up: [[0, 0, 0], [1, 1, 1]] })
    expect(rows[1].down).toEqual([[0, 0, 0], [1, 1, 1], [2, 1, 1]])
    expect(rows[3]).toMatchObject({ node: 1, up: [[1, 1, 1]] })   // q and y joined p's lane
    // a freed middle lane is reused by the next tip
    const r2 = layout([{ hash: 'a', parents: ['c'] }, { hash: 'b', parents: ['d'] }, { hash: 'e1', parents: ['e'] }, { hash: 'd', parents: [] }, { hash: 'f', parents: ['g'] }, { hash: 'c', parents: [] }, { hash: 'e', parents: [] }, { hash: 'g', parents: [] }])
    expect(r2.map((r: any) => r.node)).toEqual([0, 1, 2, 1, 1, 0, 2, 1])   // lane 1 freed by d, reused by f
    const many = layout(Array.from({ length: 10 }, (_, i) => ({ hash: 't' + i, parents: [] })))
    expect(many.map((r: any) => r.color)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 0, 1])
  })
  it('real repository with a merge', () => {
    const { t, r } = repo()
    git(r, 'switch', '-q', '-c', 'feat'); t.write('work/f.txt', 'f'); git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'feat')
    git(r, 'switch', '-q', 'main'); t.write('work/m.txt', 'm'); git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'main work')
    git(r, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat')
    const l = log(r)
    expect(l[0]).toMatchObject({ subject: 'merge feat' }); expect(l[0].parents).toHaveLength(2)
    expect(l[0].refs).toEqual([{ name: 'main', kind: 'head' }])
    const rows = layout(l)
    expect(rows[0].down.length).toBe(2)
    expect(Math.max(...rows.map((x: any) => x.width))).toBe(2)
    expect(rows.at(-1).down).toEqual([])
    t.dispose()
  })
})

describe('commit files and details', () => {
  it('parsers: decorations, name-status (-z, renames), commit info', () => {
    expect(parseDecorations('HEAD -> main, origin/main, tag: v1.0, feature, HEAD')).toEqual([
      { name: 'main', kind: 'head' }, { name: 'origin/main', kind: 'remote' }, { name: 'v1.0', kind: 'tag' }, { name: 'feature', kind: 'local' }, { name: 'HEAD', kind: 'head' }])
    expect(parseDecorations('')).toEqual([])
    expect(parseNameStatus('M\0a.txt\0R100\0old.txt\0new.txt\0A\0b/c.ts\0D\0gone\0')).toEqual([
      { status: 'M', path: 'a.txt' }, { status: 'R', from: 'old.txt', path: 'new.txt' }, { status: 'A', path: 'b/c.ts' }, { status: 'D', path: 'gone' }])
    expect(parseNameStatus('')).toEqual([])
    const { t, r } = repo()
    t.write('work/src/x.ts', 'x'); git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'add x', '-m', 'body line')
    const hash = log(r)[0].hash
    const info = parseCommitInfo(git(r, 'show', '-s', '--date=format:%d/%m/%Y', '--format=' + INFO_FORMAT, hash))
    expect(info).toMatchObject({ hash, author: 'T', email: 't@x', committer: 'T', message: 'add x\n\nbody line' })
    expect(info.parents).toHaveLength(1); expect(info.refs).toEqual([{ name: 'main', kind: 'head' }])
    expect(parseCommitInfo('h\x1fa\x1fe\x1fd\x1fc\x1fcd')).toMatchObject({ parents: [], refs: [], message: '' })
    const files = parseNameStatus(git(r, 'diff-tree', '--no-commit-id', '-r', '-z', '--name-status', '-M', info.parents[0], hash))
    expect(files).toEqual([{ status: 'A', path: 'src/x.ts' }])
    const root = log(r).at(-1).hash
    expect(parseNameStatus(git(r, 'diff-tree', '--no-commit-id', '-r', '-z', '--name-status', '-M', '--root', root))).toEqual([{ status: 'A', path: 'a.txt' }])
    t.dispose()
  })
  it('views: files tree (compacted, tones, rename detail), details fields, loading states', () => {
    const base = { ...M.initialState(), root: '/p', status: { entries: [] }, commits: [{ hash: 'h1', short: 'h1', author: 'T', when: 'now', subject: 's', parents: [], refs: [] }] }
    expect(M.commitFilesView(base)).toEqual({ kind: 'empty', text: 'Sélectionne un commit' })
    expect(M.commitFilesView({ ...base, selectedCommit: 'h1' })).toEqual({ kind: 'empty', text: 'Chargement…' })
    expect(M.commitFilesView({ ...base, selectedCommit: 'h1', commitFiles: [] })).toEqual({ kind: 'empty', text: 'Aucun fichier modifié' })
    const nested = M.commitFilesView({ ...base, selectedCommit: 'h1', commitFiles: [{ status: 'M', path: 'src/x.ts' }, { status: 'M', path: 'src/main/y.ts' }] })
    expect(nested.items[0].label).toBe('src'); expect(nested.items[0].children[0]).toMatchObject({ id: 'cdir:src/main', label: 'main' })
    const files = [{ status: 'A', path: 'src/main/a.ts' }, { status: 'R', from: 'src/old.ts', path: 'src/main/b.ts' }, { status: 'D', path: 'README.md' }, { status: 'X', path: 'odd' }]
    const v = M.commitFilesView({ ...base, selectedCommit: 'h1', commitFiles: files })
    expect(v.title).toBe('4 fichiers')
    expect(v.items.map((i: any) => i.label)).toEqual(['src/main', 'README.md', 'odd'])
    expect(v.items[0]).toMatchObject({ id: 'cdir:src/main', folder: 'src/main' })
    expect(v.items[0].children.map((c: any) => [c.label, c.tone, c.detail])).toEqual([['a.ts', 'added', ''], ['b.ts', 'renamed', '← src/old.ts']])
    expect(v.items[1].tone).toBe('deleted'); expect(v.items[2].tone).toBe('modified')
    expect(M.commitFilesView({ ...base, selectedCommit: 'h1', commitFiles: [files[0]] }).title).toBe('1 fichier')
    expect(M.commitInfoView(base)).toEqual({ kind: 'empty', text: '' })
    const info = { hash: 'h1', author: 'A', email: 'a@x', authorDate: 'd', committer: 'C', commitDate: 'cd', parents: ['p1', 'p2'], refs: [{ name: 'main', kind: 'head' }], message: 'msg' }
    const d = M.commitInfoView({ ...base, commitInfo: info })
    expect(d.kind).toBe('detail'); expect(d.body).toBe('msg')
    expect(d.fields.map((f: any) => f.label)).toEqual(['Auteur', 'Date', 'Commité par', 'Hash', 'Parents', 'Références'])
    const d2 = M.commitInfoView({ ...base, commitInfo: { ...info, committer: 'A', parents: ['p1'], refs: [] } })
    expect(d2.fields.map((f: any) => f.label)).toEqual(['Auteur', 'Date', 'Hash', 'Parent'])
    expect(M.commitInfoView({ ...base, commitInfo: { ...info, committer: 'A', parents: [], refs: [] } }).fields.map((f: any) => f.label)).toEqual(['Auteur', 'Date', 'Hash'])
    const cv = M.commitsView({ ...base, selectedCommit: 'h1', commits: [{ ...base.commits[0], refs: [{ name: 'v1', kind: 'tag' }] }] })
    expect(cv.items[0]).toMatchObject({ selected: true, badges: ['🏷 v1'] })
  })
  it('reduce: commit file selection and menus, withCommit ignores stale loads, withData drops a vanished selection', () => {
    const ev = (type: string, extra = {}) => ({ viewId: 'claudeterm.git:commits', type, ...extra })
    const info = { hash: 'h1', parents: ['p0'], author: 'T', email: '', authorDate: '', committer: 'T', commitDate: '', refs: [], message: '' }
    const f = { status: 'M', path: 'a.txt' }
    let s = { ...M.initialState(), selectedCommit: 'h1', commitFiles: [f], commitInfo: info }
    expect(M.reduce(s, ev('select', { itemId: 'cfile:a.txt' })).effects).toEqual([{ type: 'diffCommitFile', hash: 'h1', parent: 'p0', file: f }])
    expect(M.reduce({ ...s, commitInfo: { ...info, parents: [] } }, ev('open', { itemId: 'cfile:a.txt' })).effects[0].parent).toBeNull()
    expect(M.reduce(s, ev('select', { itemId: 'cfile:nope' })).effects).toEqual([])
    expect(M.reduce({ ...s, commitFiles: null }, ev('select', { itemId: 'cfile:a.txt' })).effects).toEqual([])
    expect(M.reduce(s, ev('menu', { itemId: 'cfile:a.txt', actionId: 'diffCommitFile' })).effects[0].type).toBe('diffCommitFile')
    expect(M.reduce({ ...s, commitInfo: { ...info, parents: [] } }, ev('menu', { itemId: 'cfile:a.txt', actionId: 'diffCommitFile' })).effects[0].parent).toBeNull()
    expect(M.reduce(s, ev('menu', { itemId: 'cfile:a.txt', actionId: 'openFile' })).effects).toEqual([{ type: 'openFile', path: 'a.txt' }])
    expect(M.reduce(s, ev('menu', { itemId: 'cfile:nope', actionId: 'diffCommitFile' })).effects).toEqual([])
    expect(M.reduce({ ...s, commitFiles: null }, ev('menu', { itemId: 'cfile:a.txt', actionId: 'diffCommitFile' })).effects).toEqual([])
    expect(M.reduce(s, ev('menu', { itemId: 'commit:h1', actionId: 'checkoutCommit' })).effects).toEqual([{ type: 'run', args: ['switch', '--detach', 'h1'] }])
    const nb = M.reduce(s, ev('menu', { itemId: 'commit:h1', actionId: 'newFromCommit' })).effects[0]
    expect(nb).toMatchObject({ type: 'prompt', then: { action: 'newBranch', from: 'h1' } })
    // stale load (selection moved on) is ignored
    expect(M.withCommit(s, 'other', [], info)).toBe(s)
    expect(M.withCommit({ ...s, commitFiles: null }, 'h1', [f], info).commitFiles).toEqual([f])
    // selection kept when still listed, dropped otherwise
    expect(M.withData(s, '/p', null, [{ hash: 'h1' }], { local: [], remote: [] }).selectedCommit).toBe('h1')
    expect(M.withData(s, '/p', null, [{ hash: 'h2' }], { local: [], remote: [] })).toMatchObject({ selectedCommit: null, commitFiles: null, commitInfo: null })
  })
})
