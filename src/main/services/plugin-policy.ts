import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { PluginPermission } from '@shared/plugins'

/**
 * What a plugin may do through the host bridge (DESIGN.md §7). Built-ins are trusted (shipped and reviewed with the
 * app); a user plugin only gets what its approved permissions allow:
 * - process: process.exec, and terminal.run (typing into a shell is running a command)
 * - fs: its own folder and the open project; fs:home widens reads / watches to the home folder
 * - prompt: claude.insertPrompt (typing into Claude's input is asking Claude to act)
 * - network: nothing yet (the sandbox session blocks every request)
 */
export interface PolicyCtx {
  builtin: boolean
  permissions: ReadonlySet<string>
  pluginDir: string
  projectRoot: string | null
  home: string
  /** resolves symlinks of an existing path (a link inside the project must not reach outside) */
  real: (p: string) => string
}

const NEEDS: Record<string, PluginPermission> = { 'process.exec': 'process', 'terminal.run': 'process', 'terminal.stop': 'process', 'claude.insertPrompt': 'prompt' }

export function permissionError(method: string, ctx: PolicyCtx): string | null {
  const need = NEEDS[method]
  if (!need || ctx.builtin || ctx.permissions.has(need)) return null
  return `permission "${need}" not declared in plugin.json`
}

export const inside = (child: string, parent: string) => { const r = relative(parent, child); return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r)) }

/** null when the plugin may read / list / watch `path`, else the reason. */
export function fsError(path: unknown, ctx: PolicyCtx): string | null {
  if (typeof path !== 'string' || !path) return 'invalid path'
  if (ctx.builtin) return null
  if (!isAbsolute(path)) return 'absolute path expected'
  const p = realish(resolve(path), ctx.real)
  const roots = [ctx.pluginDir, ...(ctx.projectRoot ? [ctx.projectRoot] : []), ...(ctx.permissions.has('fs:home') ? [ctx.home] : [])]
  return roots.some((r) => { try { return inside(p, ctx.real(r)) } catch { return inside(p, r) } }) ? null : `access to ${path} requires the "fs:home" permission or a path inside the project`
}

/** realpath of the path, or of its nearest existing ancestor + the rest (a file about to be created) */
function realish(p: string, real: (p: string) => string): string {
  const tail: string[] = []
  for (let cur = p; ; ) {
    try { return join(real(cur), ...tail) } catch { /* not there */ }
    const up = dirname(cur)
    if (up === cur) return p
    tail.unshift(basename(cur)); cur = up
  }
}
