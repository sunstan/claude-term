// Git plugin glue: runs git (read), executes the model's effects (writes go through a visible shell tab).
const { parseStatus, parseLog, parseRefs, parseNameStatus, parseCommitInfo, parseWorktrees, parseStashes, parsePr, classifyPull, branchChip, LOG_FORMAT, REF_FORMAT, INFO_FORMAT, STASH_FORMAT } = require('./git')
const M = require('./model')

const CHIP_EVERY = 15000, PR_TTL = 60000
const samePath = (a, b) => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

exports.activate = (ctx) => {
  const changes = ctx.ui.view('changes'), branches = ctx.ui.view('branches'), commits = ctx.ui.view('commits')
  let s = { ...M.initialState(), groupByDir: !!ctx.storage.get('groupByDir') }, popover = null, unwatch = [], timer = null
  // reads never take .git/index.lock: a status refresh would otherwise fire the .git watcher, which refreshes again
  const git = (args) => ctx.process.exec('git', ['--no-optional-locks', ...args], { cwd: s.root || ctx.workspace.project || undefined })
  const render = () => { changes.set(M.changesView(s)); branches.set(M.branchesView(s)); commits.set(M.commitsView(s)) }

  async function refresh() {
    const root = ctx.workspace.project
    if (!root) { s = M.withData(s, null, null, [], { local: [], remote: [] }); return render() }
    const top = await ctx.process.exec('git', ['rev-parse', '--show-toplevel'], { cwd: root })
    if (top.code !== 0) { s = M.withData(s, root, null, [], { local: [], remote: [] }); return render() }
    // porcelain paths are relative to the repository, which may be above the project folder (monorepo package)
    const repo = top.stdout.trim()
    if (repo !== s.root) { s = { ...s, root: repo }; watchRepo() }
    const [st, lg, rf, sl, wl] = await Promise.all([
      git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']), git(['log', '--all', '--topo-order', '-n', '400', '--format=' + LOG_FORMAT]),
      git(['for-each-ref', '--format=' + REF_FORMAT, 'refs/heads', 'refs/remotes']), git(['stash', 'list', '--format=' + STASH_FORMAT]), git(['worktree', 'list', '--porcelain']),
    ])
    if (st.code !== 0) { changes.set({ kind: 'empty', text: 'git status a échoué : ' + st.stderr.trim() }); return }
    const status = parseStatus(st.stdout)
    s = M.withData(s, repo, status, lg.code === 0 ? parseLog(lg.stdout) : [], rf.code === 0 ? parseRefs(rf.stdout) : { local: [], remote: [] },
      { stashes: sl.code === 0 ? parseStashes(sl.stdout) : [], worktrees: wl.code === 0 ? parseWorktrees(wl.stdout) : [] })
    render()
    // the chip of this project follows what was just read
    for (const root of rootsOf(repo)) ctx.ui.projectDecoration(root, branchChip(status))
    if (status.branch) prFor(repo, status.branch).then((pr) => { const before = s.pr; s = M.withPr(s, status.branch, pr); if (s.pr !== before) branches.set(M.branchesView(s)) })
  }

  // MARK: PR / MR of the current branch, through gh or glab when they are installed (60 s cache)
  const prCache = new Map(), clis = {}
  const hasCli = async (name) => { if (!(name in clis)) clis[name] = (await ctx.process.exec(name, ['--version']).catch(() => ({ code: 1 }))).code === 0; return clis[name] }
  async function prFor(repo, branch) {
    const key = repo + '|' + branch, hit = prCache.get(key)
    if (hit && Date.now() - hit.at < PR_TTL) return hit.pr
    const url = (await ctx.process.exec('git', ['remote', 'get-url', 'origin'], { cwd: repo })).stdout.trim()
    const cli = /github/i.test(url) ? 'gh' : /gitlab/i.test(url) ? 'glab' : null
    let pr = null
    if (cli && await hasCli(cli)) {
      const r = cli === 'gh' ? await ctx.process.exec('gh', ['pr', 'view', '--json', 'number,url,state,isDraft,title,statusCheckRollup,reviewDecision'], { cwd: repo })
        : await ctx.process.exec('glab', ['mr', 'view', '-F', 'json'], { cwd: repo })
      if (r.code === 0) pr = parsePr(r.stdout, cli)
    }
    prCache.set(key, { at: Date.now(), pr })
    return pr
  }

  // MARK: chips on project tabs and linked folders: one git status per repository, paused while the window is hidden
  const tops = new Map()   // folder → repository top level (null: not in one)
  let decorated = new Set(), chipsBusy = false
  const rootsOf = (repo) => [...decorated].filter((r) => tops.get(r) === repo)
  async function chips() {
    if (chipsBusy || !ctx.workspace.visible) return
    chipsBusy = true
    try {
      const folders = [...new Set(ctx.workspace.projects().flatMap((p) => [p.root, ...p.linked]))]
      for (const r of decorated) if (!folders.includes(r)) ctx.ui.projectDecoration(r, null)
      decorated = new Set(folders)
      const byRepo = new Map()
      for (const f of folders) {
        if (!tops.has(f)) { const r = await ctx.process.exec('git', ['rev-parse', '--show-toplevel'], { cwd: f }); tops.set(f, r.code === 0 ? r.stdout.trim() : null) }
        const top = tops.get(f)
        if (!top) { ctx.ui.projectDecoration(f, null); continue }
        if (!byRepo.has(top)) byRepo.set(top, [])
        byRepo.get(top).push(f)
      }
      for (const [repo, fs] of byRepo) {
        const st = await ctx.process.exec('git', ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd: repo })
        const chip = st.code === 0 ? branchChip(parseStatus(st.stdout)) : null
        for (const f of fs) ctx.ui.projectDecoration(f, chip)
      }
    } finally { chipsBusy = false }
  }
  setInterval(chips, CHIP_EVERY)
  ctx.workspace.onDidChangeProjects(() => chips())
  ctx.workspace.onDidChangeVisibility((v) => { if (v) chips() })

  // MARK: "Mettre à jour tous les projets": git pull --ff-only per repository, a report at the end
  async function pullAll() {
    const repos = []
    for (const p of ctx.workspace.projects()) {
      const r = await ctx.process.exec('git', ['rev-parse', '--show-toplevel'], { cwd: p.root })
      const top = r.code === 0 ? r.stdout.trim() : null
      if (top && !repos.some((x) => samePath(x, top))) repos.push(top)
    }
    ctx.ui.notify('Git', `Mise à jour de ${repos.length} dépôt${repos.length > 1 ? 's' : ''}…`)
    const results = []
    for (const repo of repos) {
      const ex = (args) => ctx.process.exec('git', args, { cwd: repo })
      const st = parseStatus((await ex(['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '-unormal'])).stdout)
      const r = { dirty: st.entries.some((e) => !e.untracked), upstream: st.upstream }
      if (!r.dirty && r.upstream) {
        r.before = (await ex(['rev-parse', 'HEAD'])).stdout.trim()
        const p = await ex(['pull', '--ff-only'])
        r.code = p.code; r.stderr = p.stderr
        r.after = (await ex(['rev-parse', 'HEAD'])).stdout.trim()
        if (p.code === 0 && r.before !== r.after) r.count = +(await ex(['rev-list', '--count', `${r.before}..${r.after}`])).stdout.trim() || 0
        if (p.code !== 0) { const [ahead, behind] = (await ex(['rev-list', '--left-right', '--count', 'HEAD...@{u}'])).stdout.trim().split(/\s+/).map(Number); r.ahead = ahead || 0; r.behind = behind || 0 }
      }
      results.push({ repo, ...classifyPull(r) })
    }
    if (popover) popover.close()
    popover = ctx.ui.popover('branches', { kind: 'markdown', text: M.pullReport(results) })
    popover.onEvent(dispatch)
    chips(); refresh()
  }

  /** Runs git in a visible tab; once that run ended, opens the worktree it made (with a Claude tab). */
  function runThenOpen(seq, path) {
    const runId = ctx.terminal.run({ cwd: s.root, argv: seq.map((a) => ['git', ...a]), tab: 'reuse' })
    let seen = false, finished = false
    const done = async () => {
      if (finished) return
      finished = true; off(); clearTimeout(timer)
      const r = await git(['worktree', 'list', '--porcelain'])
      if (r.code === 0 && parseWorktrees(r.stdout).some((w) => samePath(w.path, path))) ctx.workspace.openProject(path, { claude: true })
    }
    const off = ctx.terminal.onDidChangeRuns((runs) => { const here = runs.some((x) => x.id === runId); if (here) seen = true; else if (seen) done() })
    // a run too short to be seen still gets its check
    const timer = setTimeout(done, 60000)
  }

  async function effect(f) {
    if (f.type === 'run') return ctx.terminal.run({ cwd: s.root, argv: (f.seq || [f.args]).map((a) => ['git', ...a]), tab: 'reuse' })
    if (f.type === 'refresh') return refresh()
    if (f.type === 'openUrl') return ctx.workspace.openUrl(f.url)
    if (f.type === 'openProject') return ctx.workspace.openProject(f.path, { claude: true })
    if (f.type === 'runThenOpen') return runThenOpen(f.seq, f.path)
    if (f.type === 'pullAll') return pullAll()
    if (f.type === 'persist') return ctx.storage.set(f.key, f.value)
    if (f.type === 'notify') return ctx.ui.notify(f.title, f.body)
    if (f.type === 'copy') return ctx.ui.notify('Git', f.text)
    if (f.type === 'openFile') return ctx.workspace.openFile(s.root + '/' + f.path)
    if (f.type === 'closePopover') { if (popover) { popover.close(); popover = null } return }
    if (f.type === 'popover') { popover = ctx.ui.popover(f.view, f.model); popover.onEvent(dispatch); return }
    if (f.type === 'prompt') { const v = await ctx.ui.prompt(f.req); return dispatch({ ...f.then, value: v }) }
    if (f.type === 'detailFile') { const r = await git(['diff', 'HEAD', '--', f.path]); const alt = r.stdout.trim() ? r.stdout : (await git(['diff', '--no-index', '--', '/dev/null', f.path])).stdout; s = { ...s, detail: alt.trim() }; return commits.set(M.commitsView(s)) }
    if (f.type === 'loadCommit') {
      commits.set(M.commitsView(s))
      const info = parseCommitInfo((await git(['show', '-s', '--date=format:%d/%m/%Y %H:%M', '--format=' + INFO_FORMAT, f.hash])).stdout)
      const base = info.parents[0]
      const ns = await git(base ? ['diff-tree', '--no-commit-id', '-r', '-z', '--name-status', '-M', base, f.hash] : ['diff-tree', '--no-commit-id', '-r', '-z', '--name-status', '-M', '--root', f.hash])
      s = M.withCommit(s, f.hash, parseNameStatus(ns.stdout), info)
      return commits.set(M.commitsView(s))
    }
    if (f.type === 'diffCommitFile') {
      const orig = f.parent && f.file.status !== 'A' ? await git(['show', `${f.parent}:${f.file.from || f.file.path}`]) : { code: 0, stdout: '' }
      const mod = f.file.status !== 'D' ? await git(['show', `${f.hash}:${f.file.path}`]) : { code: 0, stdout: '' }
      return ctx.workspace.openDiff({ title: `${f.file.path.split('/').pop()} @ ${f.hash.slice(0, 7)}`, path: s.root + '/' + f.file.path, original: orig.stdout, modified: mod.stdout })
    }
    if (f.type === 'diffFile') {
      const head = await git(['show', 'HEAD:' + f.path])
      let modified = ''
      try { modified = ctx.workspace.fs.read(s.root + '/' + f.path) } catch { modified = '' }
      return ctx.workspace.openDiff({ title: f.path.split('/').pop() + ' (diff)', path: s.root + '/' + f.path, original: head.code === 0 ? head.stdout : '', modified })
    }
    if (f.type === 'diffRef') { const r = await git(['diff', f.ref]); return ctx.workspace.openDiff({ title: `diff ${f.ref}`, unified: r.stdout || '(aucune différence)' }) }
    if (f.type === 'diffCommit') { const r = await git(['show', f.hash]); return ctx.workspace.openDiff({ title: `commit ${f.hash.slice(0, 7)}`, unified: r.stdout }) }
  }

  async function dispatch(e) {
    const { state, effects } = M.reduce(s, e)
    s = state
    if (e.type === 'check' || e.type === 'input' || (e.type === 'toolbar' && (e.actionId === 'toggleAll' || e.actionId === 'groupDirs'))) changes.set(M.changesView(s))
    if (e.type === 'button') render()
    for (const f of effects) await effect(f)
  }

  changes.onEvent(dispatch); branches.onEvent(dispatch); commits.onEvent(dispatch)
  function watchRepo() {
    unwatch.forEach((u) => u()); unwatch = []
    if (!s.root) return
    // lock files come and go with every git command (ours included): they are not changes
    const bump = (name) => { if (name && /\.lock$/.test(name)) return; clearTimeout(timer); timer = setTimeout(refresh, 500) }
    for (const p of [s.root, s.root + '/.git', s.root + '/.git/refs/heads']) if (ctx.workspace.fs.exists(p)) unwatch.push(ctx.workspace.fs.watch(p, bump))
  }
  ctx.workspace.onDidChangeProject(async () => { unwatch.forEach((u) => u()); unwatch = []; s = { ...M.initialState(), groupByDir: s.groupByDir }; await refresh(); watchRepo() })
  ctx.terminal.onCommandEnd(() => { if (s.root) { clearTimeout(timer); timer = setTimeout(refresh, 300) } })
  refresh().then(watchRepo).then(chips)
}
