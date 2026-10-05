import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join, basename, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { frontmatter, firstLine } from '@shared/frontmatter'
import type { SkillInfo } from '@shared/ipc'
import { isInside } from '@shared/claude-format'

/** Skills (`.claude/skills/<name>/SKILL.md`) and legacy commands (`.claude/commands/*.md`). */
export class Skills {
  readonly personalSkills: string
  readonly personalCommands: string
  readonly pluginsCache: string

  constructor(home = homedir()) {
    this.personalSkills = join(home, '.claude', 'skills')
    this.personalCommands = join(home, '.claude', 'commands')
    this.pluginsCache = join(home, '.claude', 'plugins', 'cache')
  }

  project(root: string, source: SkillInfo['source'] = 'project'): SkillInfo[] {
    return [...skills(join(root, '.claude', 'skills'), source), ...commands(join(root, '.claude', 'commands'), source)]
  }
  personal(): SkillInfo[] {
    return [...skills(this.personalSkills, 'personal'), ...commands(this.personalCommands, 'personal')]
  }
  /** `<cache>/<marketplace>/<plugin>/**\/skills/<name>/SKILL.md` → "plugin:name" */
  plugins(): SkillInfo[] {
    const out: SkillInfo[] = []
    const walk = (dir: string, depth: number, plugin: string | null) => {
      if (depth > 8) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p, depth + 1, depth === 1 ? e.name : plugin)
        else if (e.name === 'SKILL.md' && /[\\/]skills[\\/]/.test(p)) {
          const fm = read(p)
          out.push(info(`${plugin ?? 'plugin'}:${fm['name'] ?? basename(dirname(p))}`, fm, p, 'plugin', false))
        }
      }
    }
    walk(this.pluginsCache, 0, null)
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Creates `<base>/.claude/skills/<name>/SKILL.md` (personal when no root) with a front matter skeleton. */
  create(name: string, description: string, root: string | null): string {
    const base = root ? join(root, '.claude', 'skills') : this.personalSkills
    const dir = join(base, name), path = join(dir, 'SKILL.md')
    if (existsSync(path)) throw new Error(`Le skill « ${name} » existe déjà`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n<!-- Instructions pour Claude : quand utiliser ce skill, étapes, contraintes. -->\n`)
    return path
  }

  /** Where skills and commands go: a project's `.claude`, or the personal one (no root). */
  private base(root: string | null) {
    return root ? { skills: join(root, '.claude', 'skills'), commands: join(root, '.claude', 'commands') } : { skills: this.personalSkills, commands: this.personalCommands }
  }

  /** Copies a skill (its whole folder) or a command into a project or the personal skills; never over one there. */
  copy(s: SkillInfo, root: string | null): string {
    const b = this.base(root)
    const src = s.isCommand ? s.path : dirname(s.path)
    const dest = join(s.isCommand ? b.commands : b.skills, basename(src))
    if (resolve(src) === resolve(dest)) throw new Error('Le skill est déjà là')
    if (existsSync(dest)) throw new Error(`« ${basename(src)} » existe déjà`)
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(src, dest, { recursive: true, errorOnExist: true, force: false })
    return s.isCommand ? dest : join(dest, 'SKILL.md')
  }

  /**
   * Imports a skill folder (with its SKILL.md) or a Markdown file into a project or the personal skills. A file
   * becomes `<name>/SKILL.md`, its name from the front matter or the file's; a front matter is added when it has
   * none, so that Claude Code lists it.
   */
  importFrom(src: string, root: string | null): string {
    const b = this.base(root)
    const st = statSync(src)
    if (st.isDirectory()) {
      if (!existsSync(join(src, 'SKILL.md'))) throw new Error('Pas de SKILL.md dans ce dossier')
      const dest = join(b.skills, basename(src))
      if (existsSync(dest)) throw new Error(`Le skill « ${basename(src)} » existe déjà`)
      mkdirSync(b.skills, { recursive: true })
      cpSync(src, dest, { recursive: true, errorOnExist: true, force: false })
      return join(dest, 'SKILL.md')
    }
    if (!/\.md$/i.test(src)) throw new Error('Un fichier .md ou un dossier de skill')
    const text = readFileSync(src, 'utf8')
    const fm = frontmatter(text)
    const stem = basename(src).toLowerCase() === 'skill.md' ? basename(dirname(src)) : basename(src).replace(/\.md$/i, '')
    const name = skillName(fm['name'] || stem)
    if (!name) throw new Error('Nom de skill introuvable')
    const dir = join(b.skills, name), path = join(dir, 'SKILL.md')
    if (existsSync(dir)) throw new Error(`Le skill « ${name} » existe déjà`)
    mkdirSync(dir, { recursive: true })
    const head = text.startsWith('---') ? '' : `---\nname: ${name}\ndescription: ${firstLine(text).replace(/\s+/g, ' ').trim().slice(0, 200)}\n---\n`
    writeFileSync(path, head + text, { flag: 'wx' })
    return path
  }

  /** Whether `path` is a skill or command file this service lists (project and linked roots given). */
  knows(path: string, roots: string[]): boolean {
    const bases = [this.personalSkills, this.personalCommands, this.pluginsCache, ...roots.flatMap((r) => [join(r, '.claude', 'skills'), join(r, '.claude', 'commands')])]
    return /\.md$/i.test(path) && bases.some((b) => isInside(resolve(path), resolve(b)))
  }

  remove(s: SkillInfo) {
    if (s.source === 'plugin') throw new Error('Skill de plugin : non modifiable')
    rmSync(s.isCommand ? s.path : dirname(s.path), { recursive: true, force: true })
  }
}

function read(p: string) { try { return frontmatter(readFileSync(p, 'utf8')) } catch { return {} } }
function info(name: string, fm: Record<string, string>, path: string, source: SkillInfo['source'], isCommand: boolean, desc?: string): SkillInfo {
  return { name, description: fm['description'] ?? desc ?? '', path, source, isCommand, manualOnly: fm['disable-model-invocation'] === 'true', autoOnly: fm['user-invocable'] === 'false' }
}
function skills(dir: string, source: SkillInfo['source']): SkillInfo[] {
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  return names.flatMap((n) => {
    const p = join(dir, n, 'SKILL.md')
    if (!existsSync(p)) return []
    const fm = read(p)
    return [info(fm['name'] ?? n, fm, p, source, false)]
  }).sort((a, b) => a.name.localeCompare(b.name))
}
function commands(dir: string, source: SkillInfo['source']): SkillInfo[] {
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  return names.filter((n) => n.endsWith('.md')).map((n) => {
    const p = join(dir, n)
    let text = ''
    try { text = readFileSync(p, 'utf8') } catch { /* unreadable */ }
    return info(n.slice(0, -3), frontmatter(text), p, source, true, firstLine(text))
  }).sort((a, b) => a.name.localeCompare(b.name))
}

/** A skill's name as Claude Code wants it: lowercase letters, digits and hyphens. */
export function skillName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}
