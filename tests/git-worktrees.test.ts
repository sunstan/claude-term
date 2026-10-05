import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TempDir } from './helpers'

// Git plugin: worktrees, what a switch sets aside, PR / MR, "pull all", the project tab chip
const require = createRequire(import.meta.url)
const { parseStatus, parseLog, parseRefs, parseWorktrees, parseStashes, parsePr, classifyPull, worktreePath, branchChip, stashFor, stashMessage, LOG_FORMAT, REF_FORMAT, STASH_FORMAT } = require('../resources/plugins/git/git.js')
const M = require('../resources/plugins/git/model.js')

const env = (cwd: string) => ({ ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x', HOME: cwd })
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: env(cwd), stdio: ['ignore', 'pipe', 'pipe'] })
const status = (r: string) => parseStatus(git(r, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'))
const refs = (r: string) => parseRefs(git(r, 'for-each-ref', '--format=' + REF_FORMAT, 'refs/heads', 'refs/remotes'))
const log = (r: string) => parseLog(git(r, 'log', '--all', '--topo-order', '--format=' + LOG_FORMAT))
const stashes = (r: string) => parseStashes(git(r, 'stash', 'list', '--format=' + STASH_FORMAT))
const worktrees = (r: string) => parseWorktrees(git(r, 'worktree', 'list', '--porcelain'))

/** A repo with a remote (bare) and one commit on main. */
function repo() {
  const t = new TempDir(); const r = join(t.path, 'work'); const bare = join(t.path, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', bare])
  execFileSync('git', ['init', '-q', '-b', 'main', r])
  t.write('work/a.txt', 'a\n'); git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'first')
  git(r, 'remote', 'add', 'origin', bare); git(r, 'push', '-q', '-u', 'origin', 'main')
  return { t, r }
}
// a seq runs like the terminal chain: in order, stopping at the first failure (execFileSync throws)
const runEffects = (r: string, effects: any[]) => effects.filter((f) => f.type === 'run').flatMap((f) => (f.seq ?? [f.args]).map((a: string[]) => git(r, ...a)))
// the plugin's root is git's spelling of the repository (long names, forward slashes), as rev-parse prints it
const top = (r: string) => git(r, 'rev-parse', '--show-toplevel').trim()
const stateOf = (r: string, extra = {}) => M.withData(M.initialState(), top(r), status(r), log(r), refs(r), extra)
const ev = (type: string, extra = {}) => ({ viewId: 'claudeterm.git:branches', type, ...extra })
const slash = (p: string) => p.replace(/\\/g, '/').toLowerCase()

describe('git plugin parsers: worktrees, stashes, PR / MR, pull, chip', { timeout: 30_000 }, () => {
  it('reads git worktree list --porcelain, real and every flag', () => {
    const { t, r } = repo()
    git(r, 'branch', 'feature')
    const wt = join(t.path, 'work.worktrees', 'feature')
    git(r, 'worktree', 'add', '-q', wt, 'feature')
    git(r, 'worktree', 'add', '-q', '--detach', join(t.path, 'det'))
    const list = worktrees(r)
    expect(list.map((w: any) => [w.branch, w.detached]).sort()).toEqual([[null, true], ['feature', false], ['main', false]])
    expect(list.some((w: any) => slash(w.path) === slash(top(wt)))).toBe(true)
    expect(list[0].head).toMatch(/^[0-9a-f]{40}$/)
    const flags = parseWorktrees('stray line\nworktree /r\nbare\n\nworktree /w\nHEAD 1\nbranch refs/heads/x\nlocked\nprunable\n\nworktree /v\nlocked by me\nprunable gitdir points nowhere\n')
    expect(flags).toEqual([
      { path: '/r', head: null, branch: null, detached: false, bare: true, locked: false, prunable: false },
      { path: '/w', head: '1', branch: 'x', detached: false, bare: false, locked: true, prunable: true },
      { path: '/v', head: null, branch: null, detached: false, bare: false, locked: true, prunable: true },
    ])
    t.dispose()
  })

  it('reads the stash list and finds what a switch set aside for a branch', () => {
    const { t, r } = repo()
    t.write('work/a.txt', 'changed\n')
    git(r, 'stash', 'push', '-u', '-m', stashMessage('main'))
    t.write('work/a.txt', 'other\n')
    git(r, 'stash', 'push', '-m', 'mine')
    const list = stashes(r)
    expect(list).toEqual([{ ref: 'stash@{0}', message: 'On main: mine' }, { ref: 'stash@{1}', message: 'On main: ClaudeTerm: main' }])
    expect(stashFor(list, 'main')).toEqual(list[1])
    expect(stashFor(list, 'other')).toBeNull()
    expect(stashFor(list, null)).toBeNull()
    expect(stashFor([{ ref: 's', message: 'ClaudeTerm: x' }], 'x')).toEqual({ ref: 's', message: 'ClaudeTerm: x' })
    expect(parseStashes('')).toEqual([])
    t.dispose()
  })

  it('reads gh and glab answers: state, checks, review', () => {
    const gh = (o: object) => parsePr(JSON.stringify({ number: 12, url: 'https://github.com/o/r/pull/12', title: 'T', state: 'OPEN', ...o }), 'gh')
    expect(gh({})).toEqual({ number: 12, url: 'https://github.com/o/r/pull/12', title: 'T', state: 'open', checks: null, review: null })
    expect(gh({ isDraft: true }).state).toBe('draft')
    expect(gh({ state: 'MERGED' }).state).toBe('merged')
    expect(gh({ state: 'CLOSED' }).state).toBe('closed')
    expect(gh({ title: undefined }).title).toBe('')
    const run = (status: string, conclusion: string) => ({ __typename: 'CheckRun', status, conclusion })
    expect(gh({ statusCheckRollup: [run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED'), { __typename: 'StatusContext', state: 'SUCCESS' }, run('COMPLETED', 'NEUTRAL')] }).checks).toBe('pass')
    expect(gh({ statusCheckRollup: [run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS', '')] }).checks).toBe('pending')
    expect(gh({ statusCheckRollup: [{ state: 'PENDING' }] }).checks).toBe('pending')
    expect(gh({ statusCheckRollup: [run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'FAILURE'), run('QUEUED', '')] }).checks).toBe('fail')
    expect(gh({ statusCheckRollup: [{ state: 'ERROR' }] }).checks).toBe('fail')
    expect(gh({ reviewDecision: 'APPROVED' }).review).toBe('approved')
    expect(gh({ reviewDecision: 'CHANGES_REQUESTED' }).review).toBe('changes')
    expect(gh({ reviewDecision: 'REVIEW_REQUIRED' }).review).toBe('required')
    const glab = (o: object) => parsePr(JSON.stringify({ iid: 7, web_url: 'https://gitlab.com/o/r/-/merge_requests/7', title: 'M', state: 'opened', ...o }), 'glab')
    expect(glab({})).toEqual({ number: 7, url: 'https://gitlab.com/o/r/-/merge_requests/7', title: 'M', state: 'open', checks: null, review: null })
    expect(glab({ draft: true }).state).toBe('draft')
    expect(glab({ work_in_progress: true }).state).toBe('draft')
    expect(glab({ state: 'merged' }).state).toBe('merged')
    expect(glab({ state: 'closed', title: '' }).state).toBe('closed')
    expect(glab({ head_pipeline: { status: 'success' } }).checks).toBe('pass')
    expect(glab({ pipeline: { status: 'failed' } }).checks).toBe('fail')
    expect(glab({ head_pipeline: { status: 'canceled' } }).checks).toBe('fail')
    expect(glab({ pipeline: { status: 'running' } }).checks).toBe('pending')
    expect(glab({ approved: true }).review).toBe('approved')
    expect(glab({ state: undefined }).state).toBe('open')
    expect(parsePr('no json', 'gh')).toBeNull()
    expect(parsePr('null', 'gh')).toBeNull()
    expect(parsePr('"text"', 'glab')).toBeNull()
    expect(parsePr(JSON.stringify({ number: 1 }), 'gh')).toMatchObject({ state: 'open', checks: null })
  })

  it('classifies what a pull --ff-only did', () => {
    expect(classifyPull({ dirty: true, upstream: 'origin/main' })).toEqual({ kind: 'changes' })
    expect(classifyPull({ dirty: false, upstream: null })).toEqual({ kind: 'noUpstream' })
    expect(classifyPull({ upstream: 'o/m', code: 0, before: 'a', after: 'a' })).toEqual({ kind: 'upToDate' })
    expect(classifyPull({ upstream: 'o/m', code: 0, before: 'a', after: 'b', count: 3 })).toEqual({ kind: 'pulled', count: 3 })
    expect(classifyPull({ upstream: 'o/m', code: 0, before: 'a', after: 'b' })).toEqual({ kind: 'pulled', count: 0 })
    expect(classifyPull({ upstream: 'o/m', code: 128, ahead: 1, behind: 2 })).toEqual({ kind: 'diverged' })
    expect(classifyPull({ upstream: 'o/m', code: 1, ahead: 0, behind: 2, stderr: 'hint: x\nfatal: could not read Username\n' })).toEqual({ kind: 'error', error: 'fatal: could not read Username' })
    expect(classifyPull({ upstream: 'o/m', code: 1, ahead: 0, behind: 0 })).toEqual({ kind: 'error', error: 'git pull a échoué' })
  })

  it('pull --ff-only against a real remote: pulled, up to date, diverged', () => {
    const { t, r } = repo()
    const other = join(t.path, 'other')
    execFileSync('git', ['clone', '-q', join(t.path, 'origin.git'), other], { stdio: 'ignore' })
    t.write('other/b.txt', 'b\n'); git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'b'); git(other, 'push', '-q')
    const pull = (dir: string) => {
      const before = git(dir, 'rev-parse', 'HEAD').trim()
      let code = 0, stderr = ''
      try { git(dir, 'pull', '-q', '--ff-only') } catch (e: any) { code = e.status ?? 1; stderr = String(e.stderr ?? '') }
      const after = git(dir, 'rev-parse', 'HEAD').trim()
      const [ahead, behind] = code ? git(dir, 'rev-list', '--left-right', '--count', 'HEAD...@{u}').trim().split(/\s+/).map(Number) : [0, 0]
      const count = before !== after ? +git(dir, 'rev-list', '--count', `${before}..${after}`).trim() : 0
      return classifyPull({ dirty: false, upstream: status(dir).upstream, code, before, after, count, ahead, behind, stderr })
    }
    expect(pull(r)).toEqual({ kind: 'pulled', count: 1 })
    expect(pull(r)).toEqual({ kind: 'upToDate' })
    t.write('other/c.txt', 'c\n'); git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'c'); git(other, 'push', '-q')
    t.write('work/d.txt', 'd\n'); git(r, 'add', '.'); git(r, 'commit', '-q', '-m', 'd')
    git(r, 'fetch', '-q')
    expect(pull(r)).toEqual({ kind: 'diverged' })
    t.dispose()
  })

  it('puts worktrees next to the repository, the branch as a folder name', () => {
    expect(worktreePath('/home/me/app', 'feat/login')).toBe('/home/me/app.worktrees/feat-login')
    expect(worktreePath('C:/Projets/app/', 'fix: "x" <y>')).toBe('C:/Projets/app.worktrees/fix-x-y')
    expect(worktreePath('C:\\Projets\\app', 'main')).toBe('C:\\Projets\\app.worktrees\\main')
  })

  it("draws a project tab's chip: branch, ahead, behind, changes; a dot on conflicts or a divergence", () => {
    const st = (o: object) => ({ branch: 'main', detached: false, ahead: 0, behind: 0, upstream: 'origin/main', entries: [], ...o })
    const e = (o: object = {}) => ({ path: 'a', staged: null, unstaged: 'M', untracked: false, conflict: false, ...o })
    expect(branchChip(st({}))).toEqual({ text: 'main', tooltip: 'Branche main' })
    expect(branchChip(st({ ahead: 2, entries: [e()] }))).toEqual({ text: 'main ↑2 ●', tooltip: 'Branche main · 2 commits à pousser · 1 fichier modifié' })
    expect(branchChip(st({ ahead: 1, behind: 3, entries: [e(), e()] }))).toEqual({ text: 'main ↑1 ↓3 ●', tone: 'warn', tooltip: 'Branche main · 1 commit à pousser · 3 commits à récupérer · 2 fichiers modifiés' })
    expect(branchChip(st({ behind: 1, entries: [e({ conflict: true }), e({ conflict: true })] }))).toEqual({ text: 'main ↓1 ●', tone: 'error', tooltip: 'Branche main · 1 commit à récupérer · 2 conflits' })
    expect(branchChip(st({ entries: [e({ conflict: true })] })).tooltip).toBe('Branche main · 1 conflit')
    expect(branchChip(st({ branch: null, detached: true }))).toEqual({ text: 'HEAD', tooltip: 'HEAD détachée' })
    expect(branchChip(st({ branch: null })).text).toBe('?')
    // a long name is cut on the tab, whole in the tooltip
    expect(branchChip(st({ branch: 'aqn/feat/hn-13344-slot-window-at-plan-time', ahead: 1 }))).toEqual({ text: 'aqn/feat/hn-13344-slot-… ↑1', tooltip: 'Branche aqn/feat/hn-13344-slot-window-at-plan-time · 1 commit à pousser' })
  })
})

describe('git plugin model: switching with changes, set aside, worktrees, PR, pull all', { timeout: 30_000 }, () => {
  it('asks before switching with changes: set aside then switch, carry them, cancel', () => {
    const { t, r } = repo()
    git(r, 'branch', 'feature')
    expect(M.reduce(stateOf(r), ev('menu', { itemId: 'local:feature', actionId: 'switch' })).effects).toEqual([{ type: 'run', args: ['switch', 'feature'] }])
    t.write('work/a.txt', 'changed\n')
    const s = stateOf(r)
    const asked = M.reduce(s, ev('menu', { itemId: 'local:feature', actionId: 'switch' })).effects
    expect(asked).toEqual([{ type: 'prompt', req: expect.objectContaining({ choice: true, options: [M.SET_ASIDE, M.CARRY] }), then: { type: 'promptResult', action: 'switchChoice', target: 'feature' } }])
    // the same question from the popover, a double click and a remote branch
    expect(M.reduce(s, { viewId: 'popover:1', type: 'select', itemId: 'local:feature' }).effects[1].type).toBe('prompt')
    expect(M.reduce(s, ev('open', { itemId: 'local:feature' })).effects[0].type).toBe('prompt')
    expect(M.reduce(s, ev('menu', { itemId: 'remote:origin/main', actionId: 'switchRemote' })).effects[0].then.target).toBe('main')
    expect(M.reduce(s, { viewId: 'popover:1', type: 'select', itemId: 'remote:origin/x' }).effects[1].then.target).toBe('x')
    const choose = (value: string | null) => M.reduce(s, { ...asked[0].then, value }).effects
    expect(choose(M.CARRY)).toEqual([{ type: 'run', args: ['switch', 'feature'] }])
    expect(choose(null)).toEqual([])
    expect(choose('autre')).toEqual([])
    // no branch (detached): what is set aside is labelled HEAD
    expect(M.reduce({ ...s, status: { ...s.status, branch: null } }, { ...asked[0].then, value: M.SET_ASIDE }).effects[0].seq[0]).toEqual(['stash', 'push', '-u', '-m', 'ClaudeTerm: HEAD'])
    const aside = choose(M.SET_ASIDE)
    expect(aside).toEqual([{ type: 'run', seq: [['stash', 'push', '-u', '-m', 'ClaudeTerm: main'], ['switch', 'feature']] }])
    runEffects(r, aside)
    expect(status(r)).toMatchObject({ branch: 'feature', entries: [] })
    // back on main: the offer to put them back, then pop
    git(r, 'switch', '-q', 'main')
    const back = stateOf(r, { stashes: stashes(r) })
    const offer = M.branchesView(back).items.find((i: any) => i.id.startsWith('stash:'))
    expect(offer).toMatchObject({ id: 'stash:stash@{0}', actions: [{ id: 'pop', primary: true }] })
    const pop = M.reduce(back, ev('action', { itemId: offer.id, actionId: 'pop' })).effects
    expect(pop).toEqual([{ type: 'run', args: ['stash', 'pop', 'stash@{0}'] }])
    expect(M.reduce(back, ev('open', { itemId: offer.id })).effects).toEqual(pop)
    expect(M.reduce(back, ev('select', { itemId: offer.id })).effects).toEqual([])
    expect(M.reduce(back, ev('action', { itemId: offer.id, actionId: 'other' })).effects).toEqual([])
    runEffects(r, pop)
    expect(readFileSync(join(r, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('changed\n')   // autocrlf on Windows
    // untracked files alone do not ask
    git(r, 'checkout', '-q', '--', 'a.txt'); t.write('work/new.txt', 'n')
    expect(M.reduce(stateOf(r), ev('menu', { itemId: 'local:feature', actionId: 'switch' })).effects[0].type).toBe('run')
    t.dispose()
  })

  it('lists the other worktrees, opens one, creates one next to the repository, removes one', () => {
    const { t, r } = repo()
    git(r, 'branch', 'feature'); git(r, 'branch', 'other')
    git(r, 'worktree', 'add', '-q', join(t.path, 'wt-feature'), 'feature')
    const s = stateOf(r, { worktrees: worktrees(r) })
    const group = M.branchesView(s).items.find((i: any) => i.id === 'g:worktrees')
    expect(group.children.map((c: any) => [c.label, c.detail])).toEqual([['wt-feature', 'feature']])
    const id = group.children[0].id, path = id.slice(3)
    expect(M.reduce(s, ev('action', { itemId: id, actionId: 'openWorktree' })).effects).toEqual([{ type: 'openProject', path }])
    expect(M.reduce(s, ev('open', { itemId: id })).effects).toEqual([{ type: 'openProject', path }])
    expect(M.reduce(s, ev('select', { itemId: id })).effects).toEqual([])
    expect(M.reduce(s, ev('menu', { itemId: id, actionId: 'removeWorktree' })).effects).toEqual([{ type: 'run', args: ['worktree', 'remove', path] }])
    expect(M.reduce(s, ev('menu', { itemId: id, actionId: 'x' })).effects).toEqual([])
    // a branch with a worktree opens it; another gets one next to the repository
    expect(M.reduce(s, ev('menu', { itemId: 'local:feature', actionId: 'worktree' })).effects).toEqual([{ type: 'openProject', path: s.worktrees.find((w: any) => w.branch === 'feature').path }])
    const made = M.reduce(s, ev('menu', { itemId: 'local:other', actionId: 'worktree' })).effects
    expect(made).toEqual([{ type: 'runThenOpen', seq: [['worktree', 'add', worktreePath(top(r), 'other'), 'other']], path: worktreePath(top(r), 'other') }])
    runEffects(r, [{ type: 'run', seq: made[0].seq }])
    expect(worktrees(r).some((w: any) => w.branch === 'other')).toBe(true)
    expect(M.reduce(s, ev('menu', { itemId: 'remote:origin/main', actionId: 'worktree' })).effects).toEqual([])
    // a new branch in a worktree: asked, then created with -b
    const ask = M.reduce(s, ev('toolbar', { actionId: 'newWorktree' })).effects[0]
    expect(ask.then).toEqual({ type: 'promptResult', action: 'newWorktree' })
    expect(M.reduce(s, { ...ask.then, value: ' feat/new ' }).effects).toEqual([{ type: 'runThenOpen', seq: [['worktree', 'add', worktreePath(top(r), 'feat/new'), '-b', 'feat/new']], path: worktreePath(top(r), 'feat/new') }])
    expect(M.reduce({ ...s, root: null }, { ...ask.then, value: 'x' }).effects).toEqual([])
    expect(M.reduce({ ...s, root: null }, ev('menu', { itemId: 'local:other', actionId: 'worktree' })).effects).toEqual([])
    // the current worktree and bare entries are not listed; no group without others
    expect(M.branchesView({ ...s, worktrees: [{ path: top(r), bare: false }, { path: '/b', bare: true }] }).items.some((i: any) => i.id === 'g:worktrees')).toBe(false)
    expect(M.branchesView({ ...s, worktrees: [{ path: '/x', branch: null, locked: true, prunable: true }] }).items.find((i: any) => i.id === 'g:worktrees').children[0]).toMatchObject({ detail: 'HEAD détachée', badges: ['verrouillé', 'introuvable'] })
    t.dispose()
  })

  it('shows the PR / MR of the branch and opens it; kept while the branch is', () => {
    const { t, r } = repo()
    const pr = { number: 3, url: 'https://github.com/o/r/pull/3', title: 'Login', state: 'open', checks: 'fail', review: 'approved' }
    let s = M.withPr(stateOf(r), 'main', pr)
    expect(M.withPr(s, 'other', null).pr).toBe(pr)   // another branch's answer is ignored
    expect(M.branchesView(s).items.find((i: any) => i.id === 'pr')).toMatchObject({ label: 'PR #3 · ouverte', detail: 'Login', color: 'badge.error', badges: ['checks ✗', 'approuvée'] })
    expect(M.reduce(s, ev('action', { itemId: 'pr', actionId: 'openPr' })).effects).toEqual([{ type: 'openUrl', url: pr.url }])
    expect(M.reduce(s, ev('select', { itemId: 'pr' })).effects).toEqual([{ type: 'openUrl', url: pr.url }])
    expect(M.reduce(s, ev('action', { itemId: 'pr', actionId: 'x' })).effects).toEqual([])
    expect(M.reduce({ ...s, pr: null }, ev('select', { itemId: 'pr' })).effects).toEqual([])
    const mr = M.branchesView(M.withPr(s, 'main', { ...pr, url: 'https://gitlab.com/o/r/-/merge_requests/3', state: 'merged', checks: null, review: null })).items.find((i: any) => i.id === 'pr')
    expect(mr).toMatchObject({ label: 'MR !3 · fusionnée', color: 'badge.ok', badges: [] })
    expect(M.branchesView(M.withPr(s, 'main', { ...pr, url: '', state: 'odd', checks: 'pending', review: 'required' })).items.find((i: any) => i.id === 'pr')).toMatchObject({ label: 'PR #3 · odd', badges: ['checks …', 'revue attendue'] })
    // a refresh on the same branch keeps it, another branch drops it
    s = M.withData(s, top(r), status(r), log(r), refs(r))
    expect(s.pr).toBe(pr)
    git(r, 'switch', '-q', '-c', 'next')
    expect(M.withData(s, top(r), status(r), log(r), refs(r)).pr).toBeNull()
    t.dispose()
  })

  it('pulls every open project from the toolbar and reports each one', () => {
    const s = M.initialState()
    expect(M.reduce(s, ev('toolbar', { actionId: 'pullAll' })).effects).toEqual([{ type: 'pullAll' }])
    expect(M.branchesView({ ...s, root: '/r', status: { branch: 'main', entries: [] } }).toolbar.map((a: any) => a.id)).toEqual(['fetch', 'pullAll', 'newWorktree', 'newBranch'])
    expect(M.pullReport([])).toBe('Aucun dépôt git parmi les projets ouverts.')
    expect(M.pullReport([
      { repo: 'C:/p/app', kind: 'upToDate' }, { repo: '/p/api', kind: 'pulled', count: 1 }, { repo: '/p/web/', kind: 'pulled', count: 4 },
      { repo: '/p/a', kind: 'diverged' }, { repo: '/p/b', kind: 'changes' }, { repo: '/p/c', kind: 'noUpstream' }, { repo: '/p/d', kind: 'error', error: 'fatal: x' },
    ]).split('\n')).toEqual(['**git pull --ff-only**', '', '- **app** : à jour', '- **api** : 1 commit récupéré', '- **web** : 4 commits récupérés',
      '- **a** : divergé : fusionner ou rebaser à la main', '- **b** : modifications en cours : rien fait', '- **c** : pas de branche suivie', '- **d** : erreur : fatal: x'])
  })
})
