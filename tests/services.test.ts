import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { TempDir } from './helpers'
import { ProjectLinks, migrateFromProject } from '../src/main/services/links'
import { Skills, skillName } from '../src/main/services/skills'
import { Mcp } from '../src/main/services/mcp'
import { FileIndex, score } from '../src/main/services/search'
import { frontmatter, isValidSkillName } from '../src/shared/frontmatter'

describe('links', () => {
  const L = [{ path: '/x/api', role: 'API', readOnly: true }, { path: '/x/ds', role: '', readOnly: false }]

  it('keeps links in the app data and nothing in the project; launch files for claude', () => {
    const t = new TempDir()
    const app = join(t.path, 'userData'), root = join(t.path, 'front')
    t.write('front/src/a.ts', '')
    const links = new ProjectLinks(app)
    links.save(root, L)
    expect(existsSync(join(root, '.claude'))).toBe(false)
    expect(new ProjectLinks(app).load(root)).toEqual(L)
    expect(JSON.parse(readFileSync(links.settingsPath(root), 'utf8'))).toEqual({ permissions: { additionalDirectories: ['/x/api', '/x/ds'], deny: ['Edit(///x/api/**)'] } })
    expect(readFileSync(links.promptPath(root), 'utf8')).toContain('api (API) : /x/api [lecture seule')
    expect(links.claudeArgs(root)).toEqual(['--settings', links.settingsPath(root), '--append-system-prompt-file', links.promptPath(root)])
    expect(links.dir(root).startsWith(join(app, 'projects'))).toBe(true)
    expect(links.dir(root)).not.toBe(links.dir(root + '2'))
    // another project and no project: no arguments
    expect(links.claudeArgs(join(t.path, 'other'))).toEqual([])
    expect(links.claudeArgs(null)).toEqual([])
    // without read-only links: no deny; no links: launch files removed
    links.save(root, [L[1]])
    expect(JSON.parse(readFileSync(links.settingsPath(root), 'utf8'))).toEqual({ permissions: { additionalDirectories: ['/x/ds'] } })
    links.save(root, [])
    expect(existsSync(links.dir(root))).toBe(false)
    expect(links.load(root)).toEqual([])
    t.dispose()
  })

  it('moves the links an earlier version wrote in the project out of it, keeping the rest', () => {
    const t = new TempDir()
    const app = join(t.path, 'userData'), root = join(t.path, 'front')
    t.write('front/.claude/claudeterm.json', JSON.stringify({ links: L }))
    t.write('front/.claude/claudeterm-prompt.txt', 'x')
    t.write('front/.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash(ls)'], additionalDirectories: ['/keep', '/x/api', '/x/ds'], deny: ['Edit(///x/api/**)', 'Write(///x/api/**)', 'Read(./.env)'] }, other: 1 }))
    const links = new ProjectLinks(app)
    expect(links.load(root)).toEqual(L)
    expect(existsSync(join(root, '.claude', 'claudeterm.json'))).toBe(false)
    expect(existsSync(join(root, '.claude', 'claudeterm-prompt.txt'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'))).toEqual({ permissions: { allow: ['Bash(ls)'], additionalDirectories: ['/keep'], deny: ['Read(./.env)'] }, other: 1 })
    expect(new ProjectLinks(app).load(root)).toEqual(L)
    t.dispose()
  })

  it('migration removes what only we wrote: settings.local.json and .claude when nothing else is left', () => {
    const t = new TempDir()
    const root = join(t.path, 'p')
    t.write('p/.claude/claudeterm.json', JSON.stringify({ links: [L[0]] }))
    t.write('p/.claude/settings.local.json', JSON.stringify({ permissions: { additionalDirectories: ['/x/api'], deny: ['Edit(///x/api/**)', 'Write(///x/api/**)'] } }))
    expect(migrateFromProject(root)).toEqual([L[0]])
    expect(existsSync(join(root, '.claude'))).toBe(false)
    // nothing to migrate
    expect(migrateFromProject(join(t.path, 'none'))).toBeNull()
    // unreadable settings.local.json is left alone; our file still goes
    t.write('q/.claude/claudeterm.json', '{ broken')
    t.write('q/.claude/settings.local.json', '{ broken')
    expect(migrateFromProject(join(t.path, 'q'))).toEqual([])
    expect(readFileSync(join(t.path, 'q', '.claude', 'settings.local.json'), 'utf8')).toBe('{ broken')
    expect(existsSync(join(t.path, 'q', '.claude', 'claudeterm.json'))).toBe(false)
    t.dispose()
  })
})

describe('skills', () => {
  it('lists project skills and commands with front matter, creates and removes', () => {
    const t = new TempDir()
    const sk = new Skills(t.path)
    t.write('proj/.claude/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: "Déploie"\ndisable-model-invocation: true\n---\n# deploy\n')
    t.write('proj/.claude/commands/review.md', 'Relis le diff.\n')
    t.write('.claude/skills/perso/SKILL.md', '---\nname: perso\n---\n')
    t.write('.claude/plugins/cache/market/cf/skills/wrangler/SKILL.md', '---\nname: wrangler\ndescription: CLI\n---\n')
    const p = sk.project(join(t.path, 'proj'))
    expect(p.map((s) => [s.name, s.isCommand, s.manualOnly])).toEqual([['deploy', false, true], ['review', true, false]])
    expect(p[1].description).toBe('Relis le diff.')
    expect(sk.personal().map((s) => s.name)).toEqual(['perso'])
    expect(sk.plugins().map((s) => s.name)).toEqual(['cf:wrangler'])
    const created = sk.create('new-skill', 'desc', join(t.path, 'proj'))
    expect(readFileSync(created, 'utf8')).toContain('name: new-skill')
    expect(() => sk.create('new-skill', 'desc', join(t.path, 'proj'))).toThrow(/existe/)
    sk.remove(sk.project(join(t.path, 'proj')).find((s) => s.name === 'new-skill')!)
    expect(existsSync(created)).toBe(false)
    expect(isValidSkillName('a-b1')).toBe(true); expect(isValidSkillName('A b')).toBe(false)
    expect(frontmatter("---\nk: 'v'\n---\n")).toEqual({ k: 'v' })
    t.dispose()
  })

  it('copies skills and commands between a project and the personal ones, imports a file or a folder', () => {
    const t = new TempDir()
    const sk = new Skills(t.path)
    const proj = join(t.path, 'proj')
    t.write('proj/.claude/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Déploie\n---\n# deploy\n')
    t.write('proj/.claude/skills/deploy/script.sh', 'echo\n')
    t.write('proj/.claude/commands/review.md', 'Relis le diff.\n')
    const [deploy, review] = sk.project(proj)
    const copied = sk.copy(deploy, null)
    expect(copied).toBe(join(t.path, '.claude', 'skills', 'deploy', 'SKILL.md'))
    expect(readFileSync(join(t.path, '.claude', 'skills', 'deploy', 'script.sh'), 'utf8')).toBe('echo\n')   // the whole folder
    expect(() => sk.copy(deploy, null)).toThrow(/existe déjà/)
    expect(() => sk.copy(deploy, proj)).toThrow(/déjà là/)
    expect(sk.copy(review, null)).toBe(join(t.path, '.claude', 'commands', 'review.md'))
    expect(sk.personal().map((s) => s.name)).toEqual(['deploy', 'review'])

    // a folder with its SKILL.md, a plain Markdown file (front matter added), a SKILL.md (its folder's name)
    t.write('dl/lint-all/SKILL.md', '---\nname: lint-all\ndescription: Lint\n---\n')
    expect(sk.importFrom(join(t.path, 'dl', 'lint-all'), proj)).toBe(join(proj, '.claude', 'skills', 'lint-all', 'SKILL.md'))
    t.write('dl/Notes de Release.md', '# Titre\nRédige les notes de version.\n')
    const imported = sk.importFrom(join(t.path, 'dl', 'Notes de Release.md'), proj)
    expect(imported).toBe(join(proj, '.claude', 'skills', 'notes-de-release', 'SKILL.md'))
    expect(readFileSync(imported, 'utf8')).toBe('---\nname: notes-de-release\ndescription: Rédige les notes de version.\n---\n# Titre\nRédige les notes de version.\n')
    t.write('dl/x/SKILL.md', '---\nname: Été 2026\n---\nbody\n')
    expect(sk.importFrom(join(t.path, 'dl', 'x', 'SKILL.md'), null)).toBe(join(t.path, '.claude', 'skills', 'ete-2026', 'SKILL.md'))
    expect(() => sk.importFrom(join(t.path, 'dl', 'lint-all'), proj)).toThrow(/existe déjà/)
    t.write('dl/empty/readme.txt', '')
    expect(() => sk.importFrom(join(t.path, 'dl', 'empty'), proj)).toThrow(/SKILL\.md/)
    expect(() => sk.importFrom(join(t.path, 'dl', 'empty', 'readme.txt'), proj)).toThrow(/\.md/)

    expect(sk.knows(deploy.path, [proj])).toBe(true)
    expect(sk.knows(join(t.path, 'dl', 'x', 'SKILL.md'), [proj])).toBe(false)
    expect(sk.knows(join(proj, '.claude', 'skills', '..', '..', 'secret.md'), [proj])).toBe(false)
    expect(skillName('  Mon Skill_v2 ! ')).toBe('mon-skill-v2')
    t.dispose()
  })
})

describe('mcp', () => {
  it('reads and writes .mcp.json, keeps unknown keys, parses claude mcp list', () => {
    const t = new TempDir()
    const root = join(t.path, 'p')
    t.write('p/.mcp.json', JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'fs'] }, web: { type: 'http', url: 'https://x/mcp' } }, extra: true }))
    t.write('.claude.json', JSON.stringify({ mcpServers: { global: { command: 'g' } }, projects: { [root]: { mcpServers: { loc: { command: 'l' } }, disabledMcpjsonServers: ['web'] } } }))
    const m = new Mcp(t.path)
    const p = m.project(root)
    expect(p.map((s) => [s.name, s.transport, s.disabled])).toEqual([['fs', 'stdio', false], ['web', 'http', true]])
    expect(m.user().map((s) => s.name)).toEqual(['global'])
    expect(m.local(root).map((s) => s.name)).toEqual(['loc'])
    m.write({ ...p[0], name: 'fs2', args: ['a'] }, root, 'fs')
    const j = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))
    expect(Object.keys(j.mcpServers).sort()).toEqual(['fs2', 'web'])
    expect(j.mcpServers.fs2).toEqual({ type: 'stdio', command: 'npx', args: ['a'] })
    expect(j.extra).toBe(true)
    m.remove('web', root)
    expect(Object.keys(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers)).toEqual(['fs2'])
    expect(Mcp.parseList('Checking MCP server health...\n\nfs: npx -y fs - ✔ Connected\nweb: https://x/mcp (HTTP) - ✗ Needs authentication\nbad: x - ✗ Failed to connect')).toEqual([
      { name: 'fs', target: 'npx -y fs', health: 'connected' }, { name: 'web', target: 'https://x/mcp (HTTP)', health: 'needsAuth' }, { name: 'bad', target: 'x', health: 'failed' },
    ])
    expect(Mcp.addArgs({ ...p[0], env: { K: 'v' } }, 'user')).toEqual(['add', '-s', 'user', '-t', 'stdio', '-e', 'K=v', 'fs', '--', 'npx', '-y', 'fs'])
    t.write('p/.mcp.json', '{ broken')
    expect(() => m.write(p[0], root)).toThrow(/illisible/)
    t.dispose()
  })

  it("finds a project's entry whatever the slashes, copies from every known project, resolves refs to their source only", () => {
    const t = new TempDir()
    const a = join(t.path, 'a'), b = join(t.path, 'b'), c = join(t.path, 'c')
    const slashed = (p: string) => p.replace(/\\/g, '/')
    t.write('a/.mcp.json', JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['fs'] } } }))
    t.write('b/.mcp.json', JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['fs'] }, db: { command: 'db', env: { DB_PASSWORD: 'pw' } } } }))
    // Claude Code writes Windows keys with forward slashes; c is known only from there
    t.write('.claude.json', JSON.stringify({ projects: { [slashed(a)]: { mcpServers: { loc: { command: 'l' } }, disabledMcpjsonServers: ['fs'] }, [slashed(c)]: {} } }))
    t.write('c/.mcp.json', JSON.stringify({ mcpServers: { web: { type: 'http', url: 'https://x' } } }))
    const m = new Mcp(t.path)
    expect(m.local(a).map((s) => s.name)).toEqual(['loc'])
    expect(m.project(a)[0].disabled).toBe(true)
    expect(m.local(a)[0].ref).toEqual({ path: m.userConfigPath, root: a, name: 'loc' })
    const lib = m.library(a, [b])
    // fs is the same in a and b: once; a itself is left out but its local server is not from it either
    expect(lib.map((s) => [s.name, s.detail])).toEqual([['db', 'b'], ['fs', 'b'], ['web', 'c']])
    expect(m.find({ path: join(b, '.mcp.json'), name: 'db' }, [b])?.env).toEqual({ DB_PASSWORD: 'pw' })
    expect(m.find({ path: join(c, '.mcp.json'), name: 'web' }, [])?.url).toBe('https://x')   // known to Claude Code
    expect(m.find({ path: join(t.path, 'elsewhere', '.mcp.json'), name: 'x' }, [b])).toBeNull()
    expect(m.find({ path: join(b, 'package.json'), name: 'db' }, [b])).toBeNull()
    expect(m.find({ path: m.userConfigPath, root: a, name: 'loc' }, [])?.command).toBe('l')
    t.dispose()
  })
})

describe('search', () => {
  it('indexes files (ignoring node_modules/.git) and ranks basename matches first', () => {
    const t = new TempDir()
    t.write('src/components/Button.tsx', '')
    t.write('src/utils/button-helpers.ts', '')
    t.write('node_modules/x/button.js', '')
    t.write('.git/config', '')
    t.write('README.md', '')
    const idx = new FileIndex()
    expect(idx.files(t.path).sort()).toEqual(['README.md', 'src/components/Button.tsx', 'src/utils/button-helpers.ts'])
    const r = idx.search(t.path, 'button')
    expect(r[0]).toBe('src/components/Button.tsx')
    expect(r).toHaveLength(2)
    expect(idx.search(t.path, 'bttn').sort()).toEqual(['src/components/Button.tsx', 'src/utils/button-helpers.ts'])
    expect(idx.search(t.path, 'srcbtn')).toEqual([])
    expect(score('abc', 'zz')).toBe(0)
    expect(idx.search(t.path, 'zzz')).toEqual([])
    t.dispose()
  })
})
