import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const OSC_CODE = 7770

/**
 * Shell hooks reporting command start/end through a private OSC sequence (`ESC ] 7770 ; start;<cmd> BEL`
 * and `ESC ] 7770 ; end;<exit> BEL`), plus OSC 7 for the cwd. zsh: a private ZDOTDIR whose rc files
 * source the user's own. bash: a rc file passed with --rcfile.
 */
export class ShellIntegration {
  readonly dir: string

  constructor(base = app.getPath('userData')) {
    this.dir = join(base, 'shell')
    mkdirSync(join(this.dir, 'zsh'), { recursive: true })
    this.write('zsh/.zshenv', `# ClaudeTerm shell integration — load the user's real files\n[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv"\n`)
    this.write('zsh/.zprofile', `[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"\n`)
    this.write('zsh/.zlogin', `[ -f "$HOME/.zlogin" ] && source "$HOME/.zlogin"\n`)
    this.write('zsh/.zshrc', `[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"
unset ZDOTDIR
autoload -Uz add-zsh-hook
__ct_preexec() { printf '\\e]${OSC_CODE};start;%s\\a' "\${1//[[:cntrl:]]/ }" }
__ct_precmd()  { local c=$?; printf '\\e]${OSC_CODE};end;%s\\a' "$c"; printf '\\e]7;file://%s%s\\a' "$HOST" "$PWD" }
add-zsh-hook preexec __ct_preexec
add-zsh-hook precmd  __ct_precmd
${claudeFunction()}
`)
    this.write('bash.rc', `[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"
__ct_preexec() { [ -n "$COMP_LINE" ] && return; [ "$BASH_COMMAND" = "__ct_precmd" ] && return; printf '\\e]${OSC_CODE};start;%s\\a' "$BASH_COMMAND"; }
__ct_precmd()  { local c=$?; printf '\\e]${OSC_CODE};end;%s\\a' "$c"; printf '\\e]7;file://%s%s\\a' "$HOSTNAME" "$PWD"; }
PROMPT_COMMAND="__ct_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
trap '__ct_preexec' DEBUG
${claudeFunction()}
`)
  }

  private write(rel: string, body: string) {
    const p = join(this.dir, rel)
    if (!existsSync(p) || readFileSync(p, 'utf8') !== body) writeFileSync(p, body)
  }

  /** Spawn spec and env additions for an integrated interactive shell. */
  shell(userShell: string): { file: string; args: string[]; env: Record<string, string> } {
    const name = userShell.split(/[\\/]/).pop() ?? ''
    if (name === 'bash') return { file: userShell, args: ['--rcfile', join(this.dir, 'bash.rc'), '-i'], env: {} }
    if (name === 'zsh' || name === '') return { file: userShell || '/bin/zsh', args: ['-il'], env: { ZDOTDIR: join(this.dir, 'zsh') } }
    return { file: userShell, args: ['-il'], env: {} }   // fish & co: no hooks yet
  }

  /**
   * Arguments after `wsl.exe --cd <dir>` and env for an integrated shell of the distribution: the user's login shell
   * (zsh or bash) on these same rc files. WSLENV hands the folder over as a Linux path (/p), so the command run there
   * carries no Windows path to quote.
   */
  wslShell(): { args: string[]; env: Record<string, string> } {
    const script = wslShellScript()
    // --exec, not --: with --, wsl.exe runs the rest through the user's shell, which expands the script's $… first
    return { args: ['--exec', 'sh', '-c', script], env: { CT_SHELL_DIR: this.dir, WSLENV: [process.env.WSLENV, 'CT_SHELL_DIR/p'].filter(Boolean).join(':') } }
  }
}

/** Run by `sh` inside WSL: the account's login shell with the integration rc files, or that shell as is. */
export function wslShellScript(): string {
  return 's=$(getent passwd "$(id -un)" | cut -d: -f7); case "${s##*/}" in '
    + 'zsh) ZDOTDIR="$CT_SHELL_DIR/zsh" exec "$s" -il;; '
    + 'bash) exec "$s" --rcfile "$CT_SHELL_DIR/bash.rc" -i;; '
    + '*) exec "${s:-/bin/sh}" -l;; esac'
}

/** `claude` typed in an integrated shell: adds the project's linked folders (kept in the app's data) when it has some. */
function claudeFunction() {
  return `claude() {
  local d="$CLAUDETERM_LINKS"
  if [ -n "$d" ] && [ -s "$d/settings.json" ] && [ -s "$d/prompt.txt" ]; then
    command claude --settings "$d/settings.json" --append-system-prompt-file "$d/prompt.txt" "$@"
  else
    command claude "$@"
  fi
}`
}
