// Pure parsers over git's tool-oriented outputs. No git logic of our own: the binary is the truth.

/** `git status --porcelain=v2 --branch -z` */
function parseStatus(text) {
  const out = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false, entries: [] }
  const records = text.split('\0')
  for (let i = 0; i < records.length; i++) {
    const line = records[i]
    if (!line) continue
    if (line.startsWith('# branch.head ')) { const b = line.slice(14); out.branch = b === '(detached)' ? null : b; out.detached = b === '(detached)'; continue }
    if (line.startsWith('# branch.upstream ')) { out.upstream = line.slice(18); continue }
    if (line.startsWith('# branch.ab ')) { const m = line.match(/\+(\d+) -(\d+)/); if (m) { out.ahead = +m[1]; out.behind = +m[2] } continue }
    if (line.startsWith('# ')) continue
    const kind = line[0]
    if (kind === '1') {
      // "1 XY sub mH mI mW hH hI path"
      const m = line.match(/^1 (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/)
      if (m) out.entries.push({ path: m[3], staged: m[1] === '.' ? null : m[1], unstaged: m[2] === '.' ? null : m[2], untracked: false, conflict: false })
    } else if (kind === '2') {
      // "2 XY sub mH mI mW hH hI Xscore path\0origPath"
      const m = line.match(/^2 (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/)
      const orig = records[++i]
      // renames are index-only in porcelain v2, so X is never "."
      if (m) out.entries.push({ path: m[3], from: orig, staged: m[1], unstaged: m[2] === '.' ? null : m[2], untracked: false, conflict: false })
    } else if (kind === 'u') {
      // "u XY sub m1 m2 m3 mW h1 h2 h3 path"
      const m = line.match(/^u (.)(.) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.+)$/)
      if (m) out.entries.push({ path: m[3], staged: null, unstaged: m[1] + m[2], untracked: false, conflict: true })
    } else if (kind === '?') {
      out.entries.push({ path: line.slice(2), staged: null, unstaged: null, untracked: true, conflict: false })
    }
  }
  return out
}

const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ar%x1f%s%x1f%P%x1f%D%x1e'
/** `git log --format=<LOG_FORMAT>` */
function parseLog(text) {
  return text.split('\x1e').map((r) => r.replace(/^\n/, '')).filter((r) => r.trim()).map((r) => {
    const [hash, short, author, when, subject, parents = '', refs = ''] = r.split('\x1f')
    return { hash, short, author, when, subject, parents: parents.split(' ').filter(Boolean), refs: parseDecorations(refs) }
  })
}

/** "%D" decorations: "HEAD -> main, origin/main, tag: v1" → [{ name, kind }] */
function parseDecorations(text) {
  return text.split(', ').map((d) => d.trim()).filter(Boolean).map((d) => {
    if (d.startsWith('HEAD -> ')) return { name: d.slice(8), kind: 'head' }
    if (d === 'HEAD') return { name: 'HEAD', kind: 'head' }
    if (d.startsWith('tag: ')) return { name: d.slice(5), kind: 'tag' }
    return { name: d, kind: d.includes('/') ? 'remote' : 'local' }
  })
}

/** `git diff-tree -r -z --name-status -M …` → [{ status, path, from? }] */
function parseNameStatus(text) {
  const out = [], f = text.split('\0')
  for (let i = 0; i < f.length; i++) {
    const st = f[i]
    if (!st) continue
    const code = st[0]
    if (code === 'R' || code === 'C') { out.push({ status: code, from: f[i + 1], path: f[i + 2] }); i += 2 }
    else { out.push({ status: code, path: f[i + 1] }); i += 1 }
  }
  return out
}

const INFO_FORMAT = '%H%x1f%an%x1f%ae%x1f%ad%x1f%cn%x1f%cd%x1f%P%x1f%D%x1f%B'
/** `git show -s --date=format:%d/%m/%Y %H:%M --format=<INFO_FORMAT>` */
function parseCommitInfo(text) {
  const [hash, author, email, authorDate, committer, commitDate, parents = '', refs = '', ...body] = text.split('\x1f')
  const message = body.join('\x1f').replace(/\s+$/, '')
  return { hash, author, email, authorDate, committer, commitDate, parents: parents.split(' ').filter(Boolean), refs: parseDecorations(refs), message }
}

const REF_FORMAT = '%(refname)%09%(objectname:short)%09%(upstream:short)%09%(upstream:track)%09%(HEAD)%09%(committerdate:unix)'
/** `git for-each-ref --format=<REF_FORMAT> refs/heads refs/remotes` → { local: [...], remote: [...] } */
function parseRefs(text) {
  const local = [], remote = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const [refname, short, upstream, track, head, date] = line.split('\t')
    const ahead = +(track.match(/ahead (\d+)/) || [0, 0])[1], behind = +(track.match(/behind (\d+)/) || [0, 0])[1]
    if (refname.startsWith('refs/heads/')) local.push({ name: refname.slice(11), hash: short, upstream: upstream || null, ahead, behind, gone: /gone/.test(track), current: head === '*', date: +date || 0 })
    else if (refname.startsWith('refs/remotes/')) {
      const full = refname.slice(13)
      if (full.endsWith('/HEAD')) continue
      const slash = full.indexOf('/')
      remote.push({ remote: full.slice(0, slash), name: full.slice(slash + 1), full, hash: short, date: +date || 0 })
    }
  }
  return { local, remote }
}

const LABELS = { M: 'modifié', A: 'ajouté', D: 'supprimé', R: 'renommé', C: 'copié', T: 'type', U: 'conflit' }

/** `git worktree list --porcelain` → [{ path, head, branch, detached, bare, locked, prunable }] */
function parseWorktrees(text) {
  const out = []
  let cur = null
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false }; out.push(cur); continue }
    if (!cur) continue
    if (line.startsWith('HEAD ')) cur.head = line.slice(5)
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
    else if (line === 'detached') cur.detached = true
    else if (line === 'bare') cur.bare = true
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true
  }
  return out
}

const STASH_FORMAT = '%gd%x1f%s'
/** `git stash list --format=<STASH_FORMAT>` → [{ ref, message }] */
function parseStashes(text) {
  return text.split('\n').filter((l) => l.includes('\x1f')).map((l) => { const [ref, ...rest] = l.split('\x1f'); return { ref, message: rest.join('\x1f') } })
}

/** The message our switch puts on what it sets aside, and the stash holding it for `branch` (newest first). */
const stashMessage = (branch) => `ClaudeTerm: ${branch}`
const stashFor = (stashes, branch) => (branch ? stashes.find((x) => x.message.endsWith(': ' + stashMessage(branch)) || x.message === stashMessage(branch)) || null : null)

/**
 * `gh pr view --json number,url,state,isDraft,title,statusCheckRollup,reviewDecision` or `glab mr view -F json` →
 * { number, url, title, state: open | draft | merged | closed, checks: pass | fail | pending | null, review: approved | changes | required | null }
 */
function parsePr(text, cli) {
  let j
  try { j = JSON.parse(text) } catch (e) { return null }
  if (!j || typeof j !== 'object') return null
  if (cli === 'glab') {
    const st = String(j.state || '').toLowerCase()
    const pipe = String((j.head_pipeline && j.head_pipeline.status) || (j.pipeline && j.pipeline.status) || '').toLowerCase()
    return {
      number: j.iid, url: j.web_url, title: j.title || '',
      state: st === 'merged' ? 'merged' : st === 'closed' ? 'closed' : j.draft || j.work_in_progress ? 'draft' : 'open',
      checks: !pipe ? null : pipe === 'success' ? 'pass' : ['failed', 'canceled'].includes(pipe) ? 'fail' : 'pending',
      review: j.approved === true ? 'approved' : null,
    }
  }
  const st = String(j.state || '').toUpperCase()
  const rollup = Array.isArray(j.statusCheckRollup) ? j.statusCheckRollup : []
  const verdicts = rollup.map((c) => {
    const v = String(c.conclusion || c.state || '').toUpperCase()
    if (c.status && String(c.status).toUpperCase() !== 'COMPLETED') return 'pending'
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(v)) return 'pass'
    if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', ''].includes(v)) return 'pending'
    return 'fail'
  })
  const review = String(j.reviewDecision || '').toUpperCase()
  return {
    number: j.number, url: j.url, title: j.title || '',
    state: st === 'MERGED' ? 'merged' : st === 'CLOSED' ? 'closed' : j.isDraft ? 'draft' : 'open',
    checks: !verdicts.length ? null : verdicts.includes('fail') ? 'fail' : verdicts.includes('pending') ? 'pending' : 'pass',
    review: review === 'APPROVED' ? 'approved' : review === 'CHANGES_REQUESTED' ? 'changes' : review === 'REVIEW_REQUIRED' ? 'required' : null,
  }
}

/**
 * What `git pull --ff-only` did to one repository, from what was read around it:
 * { dirty, upstream, code, before, after, count, ahead, behind, stderr } → { kind, count?, error? }
 * kinds: changes (tracked changes, nothing done), noUpstream, upToDate, pulled, diverged, error
 */
function classifyPull(r) {
  if (r.dirty) return { kind: 'changes' }
  if (!r.upstream) return { kind: 'noUpstream' }
  if (r.code === 0) return r.before && r.after && r.before !== r.after ? { kind: 'pulled', count: r.count || 0 } : { kind: 'upToDate' }
  if (r.ahead > 0 && r.behind > 0) return { kind: 'diverged' }
  return { kind: 'error', error: String(r.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'git pull a échoué' }
}

/** A branch's worktree next to the repository, never inside it: `<repo>.worktrees/<branch>` (slashes as dashes). */
function worktreePath(repo, branch) {
  const base = repo.replace(/[\\/]+$/, '')
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base}.worktrees${sep}${branch.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')}`
}

const CHIP_NAME = 24
/** The chip of a project tab: branch ↑ahead ↓behind ● (changes), with a dot on conflicts or a divergence. */
function branchChip(st) {
  const name = st.detached ? 'HEAD' : st.branch || '?'
  const conflicts = st.entries.filter((e) => e.conflict).length
  const changed = st.entries.length
  // a long branch name is cut on the tab, whole in the tooltip
  const short = name.length > CHIP_NAME ? name.slice(0, CHIP_NAME - 1) + '…' : name
  const text = short + (st.ahead ? ` ↑${st.ahead}` : '') + (st.behind ? ` ↓${st.behind}` : '') + (changed ? ' ●' : '')
  const tip = [st.detached ? 'HEAD détachée' : `Branche ${name}`]
  if (st.ahead) tip.push(`${st.ahead} commit${st.ahead > 1 ? 's' : ''} à pousser`)
  if (st.behind) tip.push(`${st.behind} commit${st.behind > 1 ? 's' : ''} à récupérer`)
  if (conflicts) tip.push(`${conflicts} conflit${conflicts > 1 ? 's' : ''}`)
  else if (changed) tip.push(`${changed} fichier${changed > 1 ? 's' : ''} modifié${changed > 1 ? 's' : ''}`)
  const tone = conflicts ? 'error' : st.ahead && st.behind ? 'warn' : undefined
  return { text, ...(tone ? { tone } : {}), tooltip: tip.join(' · ') }
}

module.exports = {
  parseStatus, parseLog, parseRefs, parseDecorations, parseNameStatus, parseCommitInfo, parseWorktrees, parseStashes, parsePr,
  classifyPull, worktreePath, branchChip, stashMessage, stashFor, LOG_FORMAT, REF_FORMAT, INFO_FORMAT, STASH_FORMAT, LABELS,
}
