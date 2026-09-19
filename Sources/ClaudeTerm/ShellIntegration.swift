import Foundation

/// Installs a private ZDOTDIR whose rc files source the user's own files, then add
/// preexec/precmd hooks that report command start/end via a private OSC sequence.
enum ShellIntegration {
    static let oscCode = 7770
    static let dir: String = NSHomeDirectory() + "/Library/Application Support/ClaudeTerm/zsh"

    static func install() {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let files: [String: String] = [
            ".zshenv": """
            # ClaudeTerm shell integration — load the user's real files
            [ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv"
            """,
            ".zprofile": """
            [ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile"
            """,
            ".zlogin": """
            [ -f "$HOME/.zlogin" ] && source "$HOME/.zlogin"
            """,
            ".zshrc": """
            [ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"
            unset ZDOTDIR
            autoload -Uz add-zsh-hook
            __ct_preexec() { printf '\\e]\(oscCode);start;%s\\a' "${1//[[:cntrl:]]/ }" }
            __ct_precmd()  { local c=$?; printf '\\e]\(oscCode);end;%s\\a' "$c"; printf '\\e]7;file://%s%s\\a' "$HOST" "$PWD" }
            add-zsh-hook preexec __ct_preexec
            add-zsh-hook precmd  __ct_precmd
            # `claude` typed in a ClaudeTerm shell: add the linked-projects context if the project has one
            claude() {
              local f="$CLAUDETERM_ROOT/.claude/claudeterm-prompt.txt"
              if [ -n "$CLAUDETERM_ROOT" ] && [ -s "$f" ]; then
                command claude --append-system-prompt-file "$f" "$@"
              else
                command claude "$@"
              fi
            }
            """,
        ]
        for (name, body) in files {
            let p = dir + "/" + name
            if fm.contents(atPath: p).flatMap({ String(data: $0, encoding: .utf8) }) != body {
                try? body.write(toFile: p, atomically: true, encoding: .utf8)
            }
        }
    }
}
