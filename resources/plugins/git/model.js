// Pure model of the git plugin: state + event → new state, effects (git commands, views, prompts).
// No I/O here. main.js executes the effects. Every write is a plain git command; nothing destructive.
const { LABELS, stashFor, stashMessage, worktreePath } = require('./git')
const { layout } = require('./graph')

const RUN = (args) => ({ type: 'run', args })
const initialState = () => ({ root: null, status: null, commits: [], refs: { local: [], remote: [] }, checked: {}, message: '', amend: false, detail: null, groupByDir: false,
  selectedCommit: null, commitFiles: null, commitInfo: null, stashes: [], worktrees: [], pr: null })

// the choices offered when switching branch with changes in progress
const SET_ASIDE = 'Les mettre de côté (git stash), puis changer'
const CARRY = 'Changer en les gardant'
const samePath = (a, b) => !!a && !!b && a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop()

/** Files grouped by directory, single-child chains compacted ("src/main/services"), like JetBrains. */
function dirTree(entries, checked, group) {
  const root = { dirs: {}, files: [] }
  for (const e of entries) {
    const parts = e.path.split('/'); let node = root
    for (const d of parts.slice(0, -1)) node = node.dirs[d] = node.dirs[d] || { dirs: {}, files: [] }
    node.files.push(e)
  }
  const build = (node, prefix) => {
    const items = []
    for (const name of Object.keys(node.dirs).sort()) {
      let label = name, child = node.dirs[name], path = prefix ? `${prefix}/${name}` : name
      while (child.files.length === 0 && Object.keys(child.dirs).length === 1) { const only = Object.keys(child.dirs)[0]; label += '/' + only; path += '/' + only; child = child.dirs[only] }
      const id = `dir:${group}:${path}`
      items.push({ id, label, folder: path, checked: false, children: build(child, path) })
    }
    for (const e of node.files) items.push({ ...fileItem(e, checked, group), label: e.path.split('/').pop(), detail: '' })
    return items
  }
  return build(root, '')
}

function fileItem(e, checked, group) {
  // no badge for what the group already says (modified in "Modifications", untracked in "Non versionnés")
  const code = e.conflict ? 'U' : e.untracked ? 'M' : (e.unstaged || e.staged)
  return {
    id: `file:${e.path}`, label: e.path.split('/').pop(), detail: e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '',
    file: e.path, checked: !!checked[e.path], badges: e.conflict ? ['conflit'] : e.from ? ['renommé'] : code !== 'M' && LABELS[code] ? [LABELS[code]] : [],
    contextMenu: [
      { id: 'diff', title: 'Diff côte à côte', icon: 'columns' },
      { id: 'openFile', title: 'Ouvrir le fichier', icon: 'file' },
      'sep',
      ...(group === 'untracked' ? [{ id: 'add', title: 'Suivre (git add)', icon: 'plus' }] : []),
      ...(e.staged && !e.conflict ? [{ id: 'unstage', title: "Retirer de l'index (git restore --staged)", icon: 'minus' }] : []),
    ],
  }
}

/** Changes island: checkbox tree + commit footer. */
function changesView(s) {
  if (!s.root) return { kind: 'empty', text: 'Ouvre un projet' }
  if (!s.status) return { kind: 'empty', text: 'Pas un dépôt git' }
  const entries = s.status.entries
  const conflicts = entries.filter((e) => e.conflict), tracked = entries.filter((e) => !e.conflict && !e.untracked), untracked = entries.filter((e) => e.untracked)
  const items = []
  const kids = (es, group) => (s.groupByDir ? dirTree(es, s.checked, group) : es.map((e) => fileItem(e, s.checked, group)))
  if (conflicts.length) items.push({ id: 'g:conflicts', label: `Conflits`, detail: `${conflicts.length}`, children: kids(conflicts, 'conflicts') })
  items.push({ id: 'g:changes', label: 'Modifications', detail: `${tracked.length} fichier${tracked.length > 1 ? 's' : ''}`, children: kids(tracked, 'changes') })
  if (untracked.length) items.push({ id: 'g:untracked', label: 'Non versionnés', detail: `${untracked.length} fichier${untracked.length > 1 ? 's' : ''}`, children: kids(untracked, 'untracked') })
  const head = s.status.detached ? 'HEAD détachée' : (s.status.branch || '?')
  const ab = (s.status.ahead ? ` ↑${s.status.ahead}` : '') + (s.status.behind ? ` ↓${s.status.behind}` : '')
  const nChecked = Object.keys(s.checked).filter((p) => s.checked[p]).length
  // folding is the app's (foldAll): kept per project, a folder without changes forgets it
  return {
    kind: 'tree', items, foldAll: true,
    toolbar: [
      { id: 'branch', title: `Branche : ${head}${ab}`, icon: 'git' },
      { id: 'refresh', title: 'Actualiser', icon: 'activity' },
      { id: 'groupDirs', title: s.groupByDir ? 'Liste à plat' : 'Grouper par dossier', icon: s.groupByDir ? 'list' : 'folder' },
    ],
    footer: {
      fields: [{ id: 'message', placeholder: 'Message du commit', value: s.message, multiline: true }],
      checks: [{ id: 'amend', label: 'Amend', checked: s.amend }],
      buttons: [
        { id: 'commit', title: nChecked ? `Commit (${nChecked})` : 'Commit', icon: 'check', primary: true, disabled: !nChecked || !s.message.trim() },
        { id: 'commitPush', title: 'Commit + push', disabled: !nChecked || !s.message.trim() },
      ],
    },
  }
}

const branchMenu = (b) => [
  { id: 'switch', title: `Basculer sur ${b.name} (git switch)`, icon: 'git', disabled: b.current },
  { id: 'worktree', title: 'Ouvrir dans un worktree (projet + Claude)', icon: 'columns', disabled: b.current },
  { id: 'newFrom', title: `Nouvelle branche depuis ${b.name}…`, icon: 'plus' },
  { id: 'diffWorkTree', title: "Diff avec l'arbre de travail", icon: 'columns' },
  'sep',
  { id: 'update', title: 'Mettre à jour (git pull)', icon: 'arrowUp', disabled: !b.current },
  { id: 'push', title: 'Push (git push)', icon: 'arrowUp', disabled: !b.current },
  'sep',
  { id: 'rename', title: 'Renommer…', icon: 'list' },
  { id: 'delete', title: 'Supprimer (git branch -d, refusé si non fusionnée)', icon: 'x', disabled: b.current },
]

/** Branches island: HEAD, local, remote by remote. */
function branchesView(s) {
  if (!s.root || !s.status) return { kind: 'empty', text: '' }
  const cur = s.status.detached ? 'HEAD détachée' : (s.status.branch || '?')
  const local = s.refs.local.map((b) => ({
    id: `local:${b.name}`, label: b.name, icon: 'git', color: b.current ? 'accent' : undefined,
    extra: (b.ahead ? `↑${b.ahead} ` : '') + (b.behind ? `↓${b.behind}` : ''), detail: b.upstream ? (b.gone ? `${b.upstream} (disparue)` : b.upstream) : '',
    badges: b.current ? ['HEAD'] : [], contextMenu: branchMenu(b),
  }))
  const byRemote = {}
  for (const r of s.refs.remote) (byRemote[r.remote] = byRemote[r.remote] || []).push({ id: `remote:${r.full}`, label: r.name, icon: 'git', muted: true, contextMenu: [
    { id: 'switchRemote', title: `Basculer sur ${r.name} (git switch, suit ${r.full})`, icon: 'git' },
    { id: 'newFrom', title: `Nouvelle branche depuis ${r.full}…`, icon: 'plus' },
    { id: 'diffWorkTree', title: "Diff avec l'arbre de travail", icon: 'columns' },
  ] })
  const aside = stashFor(s.stashes, s.status.branch)
  const others = s.worktrees.filter((w) => !w.bare && !samePath(w.path, s.root))
  const items = [
    { id: 'head', label: `HEAD (${cur})`, icon: 'git', color: 'accent' },
    ...(s.pr ? [prItem(s.pr)] : []),
    ...(aside ? [{ id: `stash:${aside.ref}`, label: 'Réappliquer les modifications mises de côté', detail: aside.ref, icon: 'arrowUp', actions: [{ id: 'pop', title: `Réappliquer (git stash pop ${aside.ref})`, icon: 'check', primary: true }] }] : []),
    { id: 'g:local', label: 'Local', detail: `${local.length}`, children: local },
    ...Object.keys(byRemote).sort().map((r) => ({ id: `g:remote:${r}`, label: r, detail: `${byRemote[r].length}`, children: byRemote[r] })),
    ...(others.length ? [{ id: 'g:worktrees', label: 'Worktrees', detail: `${others.length}`, children: others.map((w) => ({
      id: `wt:${w.path}`, label: baseName(w.path), detail: w.branch || 'HEAD détachée', icon: 'columns', badges: [...(w.locked ? ['verrouillé'] : []), ...(w.prunable ? ['introuvable'] : [])],
      actions: [{ id: 'openWorktree', title: 'Ouvrir (projet + Claude)', icon: 'external', primary: true }],
      contextMenu: [{ id: 'openWorktree', title: 'Ouvrir (projet + Claude)', icon: 'external' }, 'sep', { id: 'removeWorktree', title: "Supprimer le worktree (git worktree remove, refusé s'il a des modifications)", icon: 'x' }],
    })) }] : []),
  ]
  return {
    kind: 'tree', items,
    toolbar: [
      { id: 'fetch', title: 'Récupérer (git fetch --all --prune)', icon: 'activity' },
      { id: 'pullAll', title: 'Mettre à jour tous les projets ouverts (git pull --ff-only)', icon: 'download' },
      { id: 'newWorktree', title: 'Nouvelle branche dans un worktree…', icon: 'columns' },
      { id: 'newBranch', title: 'Nouvelle branche…', icon: 'plus' },
    ],
  }
}

const PR_STATE = { open: 'ouverte', draft: 'brouillon', merged: 'fusionnée', closed: 'fermée' }
const CHECKS = { pass: 'checks ✓', fail: 'checks ✗', pending: 'checks …' }
const REVIEW = { approved: 'approuvée', changes: 'changements demandés', required: 'revue attendue' }
function prItem(pr) {
  return {
    id: 'pr', label: `${pr.url && /gitlab/i.test(pr.url) ? 'MR !' : 'PR #'}${pr.number} · ${PR_STATE[pr.state] || pr.state}`, detail: pr.title, icon: 'external',
    color: pr.checks === 'fail' ? 'badge.error' : pr.state === 'merged' ? 'badge.ok' : undefined,
    badges: [...(pr.checks ? [CHECKS[pr.checks]] : []), ...(pr.review ? [REVIEW[pr.review]] : [])],
    actions: [{ id: 'openPr', title: 'Ouvrir dans le navigateur', icon: 'external', primary: true }],
  }
}

const PULL_TEXT = {
  upToDate: () => 'à jour', pulled: (r) => `${r.count} commit${r.count > 1 ? 's' : ''} récupéré${r.count > 1 ? 's' : ''}`,
  diverged: () => 'divergé : fusionner ou rebaser à la main', changes: () => 'modifications en cours : rien fait',
  noUpstream: () => 'pas de branche suivie', error: (r) => `erreur : ${r.error}`,
}
/** The report of "Mettre à jour tous les projets": one line per repository. */
function pullReport(results) {
  if (!results.length) return 'Aucun dépôt git parmi les projets ouverts.'
  return ['**git pull --ff-only**', '', ...results.map((r) => `- **${baseName(r.repo)}** : ${PULL_TEXT[r.kind](r)}`)].join('\n')
}

/** Tracked changes (or conflicts) that a switch would carry or refuse. */
const hasChanges = (s) => !!s.status && s.status.entries.some((e) => !e.untracked)
/** Switching branch: with changes in progress, the user chooses first (set them aside, carry them, cancel). */
function switchTo(s, target) {
  if (!hasChanges(s)) return [RUN(['switch', target])]
  return [{ type: 'prompt', req: { title: `Basculer sur ${target}`, placeholder: 'Des modifications sont en cours.', options: [SET_ASIDE, CARRY], choice: true }, then: { type: 'promptResult', action: 'switchChoice', target } }]
}
/** A branch's worktree: opened when it exists, else created next to the repository then opened. */
function openWorktree(s, branch, create) {
  const wt = s.worktrees.find((w) => w.branch === branch)
  if (wt && !create) return [{ type: 'openProject', path: wt.path }]
  const path = worktreePath(s.root, branch)
  return [{ type: 'runThenOpen', seq: [['worktree', 'add', path, ...(create ? ['-b', branch] : [branch])]], path }]
}

const TONES = { A: 'added', D: 'deleted', R: 'renamed', C: 'renamed', M: 'modified', T: 'modified' }
const refBadges = (refs) => refs.map((r) => (r.kind === 'tag' ? `🏷 ${r.name}` : r.name))

/** Files of the selected commit, grouped by directory (compacted), colored by change. */
function commitFilesView(s) {
  if (!s.selectedCommit) return { kind: 'empty', text: 'Sélectionne un commit' }
  if (!s.commitFiles) return { kind: 'empty', text: 'Chargement…' }
  if (!s.commitFiles.length) return { kind: 'empty', text: 'Aucun fichier modifié' }
  const root = { dirs: {}, files: [] }
  for (const f of s.commitFiles) {
    let node = root
    for (const d of f.path.split('/').slice(0, -1)) node = node.dirs[d] = node.dirs[d] || { dirs: {}, files: [] }
    node.files.push(f)
  }
  const build = (node, prefix) => {
    const items = []
    for (const name of Object.keys(node.dirs).sort()) {
      let label = name, child = node.dirs[name], path = prefix ? `${prefix}/${name}` : name
      while (child.files.length === 0 && Object.keys(child.dirs).length === 1) { const only = Object.keys(child.dirs)[0]; label += '/' + only; path += '/' + only; child = child.dirs[only] }
      items.push({ id: `cdir:${path}`, label, folder: path, expanded: true, children: build(child, path) })
    }
    for (const f of node.files) items.push({ id: `cfile:${f.path}`, label: f.path.split('/').pop(), file: f.path, tone: TONES[f.status] || 'modified', detail: f.from ? `← ${f.from}` : '',
      contextMenu: [{ id: 'diffCommitFile', title: 'Diff côte à côte', icon: 'columns' }, { id: 'openFile', title: 'Ouvrir la version actuelle', icon: 'file' }] })
    return items
  }
  return { kind: 'tree', items: build(root, ''), title: `${s.commitFiles.length} fichier${s.commitFiles.length > 1 ? 's' : ''}` }
}

/** Details of the selected commit. */
function commitInfoView(s) {
  const i = s.commitInfo
  if (!i) return { kind: 'empty', text: '' }
  return {
    kind: 'detail', body: i.message,
    fields: [
      { label: 'Auteur', value: `${i.author} <${i.email}>` }, { label: 'Date', value: i.authorDate },
      ...(i.committer !== i.author ? [{ label: 'Commité par', value: `${i.committer} · ${i.commitDate}` }] : []),
      { label: 'Hash', value: i.hash, mono: true },
      ...(i.parents.length ? [{ label: i.parents.length > 1 ? 'Parents' : 'Parent', value: i.parents.map((p) => p.slice(0, 8)).join(' '), mono: true }] : []),
      ...(i.refs.length ? [{ label: 'Références', value: i.refs.map((r) => r.name).join(', ') }] : []),
    ],
  }
}

/** Commits (bottom block): graph list on the left, files over details on the right. */
function commitsView(s) {
  if (!s.root || !s.status) return { kind: 'empty', text: 'Pas un dépôt git' }
  if (!s.commits.length) return { kind: 'empty', text: 'Aucun commit' }
  const graph = layout(s.commits)
  return {
    kind: 'list', search: true, graph: true,
    items: s.commits.map((c, i) => ({ id: `commit:${c.hash}`, label: c.subject, detail: `${c.author} · ${c.when}`, extra: c.short, graph: graph[i], badges: refBadges(c.refs), selected: c.hash === s.selectedCommit,
      contextMenu: [
        { id: 'diffCommit', title: 'Diff du commit (onglet)', icon: 'columns' },
        { id: 'copyHash', title: 'Copier le hash', icon: 'list' },
        'sep',
        { id: 'newFromCommit', title: 'Nouvelle branche ici…', icon: 'plus' },
        { id: 'checkoutCommit', title: 'Checkout (HEAD détachée)', icon: 'git' },
      ] })),
    detail: { kind: 'stack', panes: [commitFilesView(s), commitInfoView(s)] },
  }
}

/** Branch popover: actions then recent / local / remote branches. */
function branchPopover(s) {
  const local = [...s.refs.local].sort((a, b) => b.date - a.date)
  const recent = local.slice(0, 5)
  const b = (x, id) => ({ id, label: x.name, icon: 'git', color: x.current ? 'accent' : undefined, extra: (x.ahead ? `↑${x.ahead} ` : '') + (x.behind ? `↓${x.behind}` : ''), detail: x.upstream || '' })
  return {
    kind: 'tree', search: true,
    items: [
      { id: 'g:actions', label: 'Actions', expanded: true, children: [
        { id: 'update', label: 'Mettre à jour le projet (git pull)', icon: 'arrowUp' },
        { id: 'push', label: 'Push (git push)', icon: 'arrowUp' },
        { id: 'fetch', label: 'Récupérer (git fetch --all --prune)', icon: 'activity' },
        { id: 'newBranch', label: 'Nouvelle branche…', icon: 'plus' },
        { id: 'checkoutRev', label: 'Checkout tag ou révision…', icon: 'clock' },
      ] },
      { id: 'g:recent', label: 'Récentes', expanded: true, children: recent.map((x) => b(x, `local:${x.name}`)) },
      { id: 'g:local', label: 'Locales', expanded: false, children: local.map((x) => b(x, `local:${x.name}`)) },
      { id: 'g:remote', label: 'Distantes', expanded: false, children: s.refs.remote.map((r) => ({ id: `remote:${r.full}`, label: r.full, icon: 'git', muted: true })) },
    ].filter((g) => g.children.length),
  }
}

const checkedPaths = (s) => Object.keys(s.checked).filter((p) => s.checked[p])
const setChecked = (s, paths, on) => { const checked = { ...s.checked }; for (const p of paths) checked[p] = on; return { ...s, checked } }
const groupPaths = (s, gid) => {
  const es = s.status ? s.status.entries : []
  if (gid.startsWith('dir:')) { const [, group, dir] = gid.split(/:(.*?):(.*)$/s); return groupPaths(s, 'g:' + group).filter((p) => p.startsWith(dir + '/')) }
  if (gid === 'g:conflicts') return es.filter((e) => e.conflict).map((e) => e.path)
  if (gid === 'g:untracked') return es.filter((e) => e.untracked).map((e) => e.path)
  return es.filter((e) => !e.conflict && !e.untracked).map((e) => e.path)
}
const localName = (fullRemote) => fullRemote.slice(fullRemote.indexOf('/') + 1)

/** Commit of the checked files as one chained run: add (untracked) → commit → push, each only if the previous succeeded. */
function commitCommands(s, push) {
  const files = checkedPaths(s)
  const untracked = files.filter((p) => s.status.entries.some((e) => e.path === p && e.untracked))
  const seq = []
  if (untracked.length) seq.push(['add', '--', ...untracked])
  seq.push(['commit', ...(s.amend ? ['--amend'] : []), '-m', s.message.trim(), '--', ...files])
  if (push) seq.push(['push'])
  return [{ type: 'run', seq }]
}

/**
 * Reduces an event. Returns { state, effects }. Effects:
 *  run {args} or {seq: args[]} (chained on success) · refresh · detailFile {path} · detailCommit {hash} · diffFile {path} · diffRef {ref} · diffCommit {hash}
 *  openFile {path} · prompt {req, then} (then: event to dispatch with value) · popover {model} · closePopover · notify {title, body} · copy {text}
 *  openUrl {url} · openProject {path} (with a Claude tab) · runThenOpen {seq, path} (the project opens once git made it) · pullAll
 */
function reduce(s, e) {
  const ef = []
  const view = e.viewId ? e.viewId.split(':').pop() : ''
  const pop = e.viewId && e.viewId.startsWith('popover:')
  // footer / checks
  if (e.type === 'input' && e.fieldId === 'message') return { state: { ...s, message: String(e.value) }, effects: ef }
  if (e.type === 'check' && e.itemId === 'amend') return { state: { ...s, amend: !!e.value }, effects: ef }
  if (e.type === 'check' && e.itemId) {
    const paths = e.itemId.startsWith('g:') || e.itemId.startsWith('dir:') ? groupPaths(s, e.itemId) : [e.itemId.slice(5)]
    return { state: setChecked(s, paths, !!e.value), effects: ef }
  }
  if (e.type === 'button') {
    if (!s.status) return { state: s, effects: ef }
    if (!checkedPaths(s).length) return { state: s, effects: [{ type: 'notify', title: 'Git', body: 'Coche les fichiers à committer.' }] }
    if (!s.message.trim()) return { state: s, effects: [{ type: 'notify', title: 'Git', body: 'Écris un message de commit.' }] }
    if (e.actionId === 'commit' || e.actionId === 'commitPush') return { state: { ...s, message: '', amend: false, checked: {} }, effects: commitCommands(s, e.actionId === 'commitPush') }
    return { state: s, effects: ef }
  }
  if (e.type === 'toolbar') {
    if (e.actionId === 'refresh') return { state: s, effects: [{ type: 'refresh' }] }
    if (e.actionId === 'fetch') return { state: s, effects: [RUN(['fetch', '--all', '--prune'])] }
    if (e.actionId === 'newBranch') return { state: s, effects: [{ type: 'prompt', req: { title: 'Nouvelle branche (git switch -c)', placeholder: 'nom' }, then: { type: 'promptResult', action: 'newBranch' } }] }
    if (e.actionId === 'branch') return { state: s, effects: [{ type: 'popover', view: 'changes', model: branchPopover(s) }] }
    if (e.actionId === 'pullAll') return { state: s, effects: [{ type: 'pullAll' }] }
    if (e.actionId === 'newWorktree') return { state: s, effects: [{ type: 'prompt', req: { title: 'Nouvelle branche dans un worktree (à côté du dépôt)', placeholder: 'nom de la branche' }, then: { type: 'promptResult', action: 'newWorktree' } }] }
    if (e.actionId === 'groupDirs') return { state: { ...s, groupByDir: !s.groupByDir }, effects: [{ type: 'persist', key: 'groupByDir', value: !s.groupByDir }] }
    return { state: s, effects: ef }
  }
  if (e.type === 'promptResult') {
    const v = e.value == null ? '' : String(e.value).trim()
    if (!v) return { state: s, effects: ef }
    if (e.action === 'newBranch') return { state: s, effects: [RUN(['switch', '-c', v, ...(e.from ? [e.from] : [])])] }
    if (e.action === 'rename') return { state: s, effects: [RUN(['branch', '-m', e.from, v])] }
    if (e.action === 'checkoutRev') return { state: s, effects: [RUN(['switch', '--detach', v])] }
    if (e.action === 'newWorktree') return { state: s, effects: s.root ? openWorktree(s, v, true) : ef }
    if (e.action === 'switchChoice') {
      if (v === CARRY) return { state: s, effects: [RUN(['switch', e.target])] }
      if (v === SET_ASIDE) return { state: s, effects: [{ type: 'run', seq: [['stash', 'push', '-u', '-m', stashMessage(s.status && s.status.branch || 'HEAD')], ['switch', e.target]] }] }
    }
    return { state: s, effects: ef }
  }
  const id = e.itemId || ''
  if (e.type === 'select' || e.type === 'open') {
    if (pop) {
      const effects = [{ type: 'closePopover' }]
      if (id === 'update') effects.push(RUN(['pull']))
      else if (id === 'push') effects.push(RUN(['push']))
      else if (id === 'fetch') effects.push(RUN(['fetch', '--all', '--prune']))
      else if (id === 'newBranch') effects.push({ type: 'prompt', req: { title: 'Nouvelle branche (git switch -c)', placeholder: 'nom' }, then: { type: 'promptResult', action: 'newBranch' } })
      else if (id === 'checkoutRev') effects.push({ type: 'prompt', req: { title: 'Checkout tag ou révision (git switch --detach)', placeholder: 'v1.2.0, abc123…' }, then: { type: 'promptResult', action: 'checkoutRev' } })
      else if (id.startsWith('local:')) { const b = s.refs.local.find((x) => x.name === id.slice(6)); if (b && !b.current) effects.push(...switchTo(s, b.name)) }
      else if (id.startsWith('remote:')) effects.push(...switchTo(s, localName(id.slice(7))))
      return { state: s, effects }
    }
    if (id === 'pr') return { state: s, effects: s.pr && s.pr.url ? [{ type: 'openUrl', url: s.pr.url }] : ef }
    if (id.startsWith('stash:')) return { state: s, effects: e.type === 'open' ? [RUN(['stash', 'pop', id.slice(6)])] : ef }
    if (id.startsWith('wt:')) return { state: s, effects: e.type === 'open' ? [{ type: 'openProject', path: id.slice(3) }] : ef }
    if (id.startsWith('file:')) return { state: s, effects: [e.type === 'open' ? { type: 'diffFile', path: id.slice(5) } : { type: 'detailFile', path: id.slice(5) }] }
    if (id.startsWith('commit:')) {
      const hash = id.slice(7)
      if (e.type === 'open') return { state: s, effects: [{ type: 'diffCommit', hash }] }
      return { state: { ...s, selectedCommit: hash, commitFiles: null, commitInfo: null }, effects: [{ type: 'loadCommit', hash }] }
    }
    if (id.startsWith('cfile:')) {
      const f = (s.commitFiles || []).find((x) => x.path === id.slice(6))
      return { state: s, effects: f && s.commitInfo ? [{ type: 'diffCommitFile', hash: s.commitInfo.hash, parent: s.commitInfo.parents[0] || null, file: f }] : ef }
    }
    if (id.startsWith('local:') && e.type === 'open') { const b = s.refs.local.find((x) => x.name === id.slice(6)); return { state: s, effects: b && !b.current ? switchTo(s, b.name) : ef } }
    return { state: s, effects: ef }
  }
  // a row's buttons (action) and its right-click menu (menu) do the same
  if (e.type === 'menu' || e.type === 'action') {
    const a = e.actionId
    if (id === 'pr') return { state: s, effects: a === 'openPr' && s.pr && s.pr.url ? [{ type: 'openUrl', url: s.pr.url }] : ef }
    if (id.startsWith('stash:')) return { state: s, effects: a === 'pop' ? [RUN(['stash', 'pop', id.slice(6)])] : ef }
    if (id.startsWith('wt:')) {
      const path = id.slice(3)
      if (a === 'openWorktree') return { state: s, effects: [{ type: 'openProject', path }] }
      if (a === 'removeWorktree') return { state: s, effects: [RUN(['worktree', 'remove', path])] }
      return { state: s, effects: ef }
    }
    if (id.startsWith('cfile:')) {
      const f = (s.commitFiles || []).find((x) => x.path === id.slice(6))
      if (a === 'openFile') return { state: s, effects: [{ type: 'openFile', path: id.slice(6) }] }
      if (a === 'diffCommitFile' && f && s.commitInfo) return { state: s, effects: [{ type: 'diffCommitFile', hash: s.commitInfo.hash, parent: s.commitInfo.parents[0] || null, file: f }] }
      return { state: s, effects: ef }
    }
    if (id.startsWith('file:')) {
      const p = id.slice(5)
      if (a === 'diff') return { state: s, effects: [{ type: 'diffFile', path: p }] }
      if (a === 'openFile') return { state: s, effects: [{ type: 'openFile', path: p }] }
      if (a === 'add') return { state: s, effects: [RUN(['add', '--', p])] }
      if (a === 'unstage') return { state: s, effects: [RUN(['restore', '--staged', '--', p])] }
      return { state: s, effects: ef }
    }
    if (id.startsWith('commit:')) {
      const h = id.slice(7)
      if (a === 'diffCommit') return { state: s, effects: [{ type: 'diffCommit', hash: h }] }
      if (a === 'copyHash') return { state: s, effects: [{ type: 'copy', text: h }] }
      if (a === 'checkoutCommit') return { state: s, effects: [RUN(['switch', '--detach', h])] }
      if (a === 'newFromCommit') return { state: s, effects: [{ type: 'prompt', req: { title: `Nouvelle branche depuis ${h.slice(0, 8)}`, placeholder: 'nom' }, then: { type: 'promptResult', action: 'newBranch', from: h } }] }
      return { state: s, effects: ef }
    }
    const isRemote = id.startsWith('remote:')
    const name = isRemote ? id.slice(7) : id.slice(6)
    if (a === 'switch') return { state: s, effects: switchTo(s, name) }
    if (a === 'switchRemote') return { state: s, effects: switchTo(s, localName(name)) }
    if (a === 'worktree' && !isRemote) return { state: s, effects: s.root ? openWorktree(s, name, false) : ef }
    if (a === 'newFrom') return { state: s, effects: [{ type: 'prompt', req: { title: `Nouvelle branche depuis ${name}`, placeholder: 'nom' }, then: { type: 'promptResult', action: 'newBranch', from: name } }] }
    if (a === 'diffWorkTree') return { state: s, effects: [{ type: 'diffRef', ref: name }] }
    if (a === 'update') return { state: s, effects: [RUN(['pull'])] }
    if (a === 'push') return { state: s, effects: [RUN(['push'])] }
    if (a === 'rename') return { state: s, effects: [{ type: 'prompt', req: { title: `Renommer ${name}`, placeholder: 'nouveau nom' }, then: { type: 'promptResult', action: 'rename', from: name } }] }
    if (a === 'delete') return { state: s, effects: [RUN(['branch', '-d', name])] }
    return { state: s, effects: ef }
  }
  return { state: s, effects: ef }
}

/**
 * After a refresh: keeps checked paths that still exist, and the selected commit if it is still listed. `extra`:
 * the stashes and worktrees read with it. The PR stays while the branch does (withPr replaces it).
 */
function withData(s, root, status, commits, refs, extra = {}) {
  const checked = {}
  if (status) for (const e of status.entries) if (s.checked[e.path]) checked[e.path] = true
  const keep = commits.some((c) => c.hash === s.selectedCommit)
  const sameBranch = s.root === root && s.status && status && s.status.branch === status.branch
  return { ...s, root, status, commits, refs, checked, stashes: extra.stashes || [], worktrees: extra.worktrees || [], pr: sameBranch ? s.pr : null,
    ...(keep ? {} : { selectedCommit: null, commitFiles: null, commitInfo: null }) }
}

/** The PR / MR of `branch` (ignored if the branch changed meanwhile). */
function withPr(s, branch, pr) {
  return s.status && s.status.branch === branch ? { ...s, pr } : s
}

/** Loaded data of the selected commit (ignored if the selection changed meanwhile). */
function withCommit(s, hash, files, info) {
  return s.selectedCommit === hash ? { ...s, commitFiles: files, commitInfo: info } : s
}

module.exports = { initialState, changesView, branchesView, commitsView, commitFilesView, commitInfoView, branchPopover, reduce, withData, withCommit, withPr, commitCommands, checkedPaths, dirTree, pullReport, switchTo, SET_ASIDE, CARRY }
