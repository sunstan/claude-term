/**
 * PowerShell shell integration (pure, tested): the script an integrated PowerShell tab runs after the user's
 * profile, and how it is passed. It reports what zsh and bash report through their rc files:
 * `OSC <code> ; start;<command>` once a line is accepted, `OSC <code> ; end;<exit code>` and OSC 7 (cwd) at each
 * prompt. Works with Windows PowerShell 5.1 and pwsh 7.
 */

/** Typed by the app to clear the pending line: Ctrl+Shift+F12, bound to RevertLine by the script in every edit mode. */
export const PS_CLEAR_LINE = '\x1b[24;6~'

export function powershellIntegration(osc: number): string {
  return [
    '$global:__ct = @{ E = [string][char]27; B = [string][char]7; Exit = $global:LASTEXITCODE; Prompt = $function:prompt }',
    'function global:__ct_osc([string]$s) { [Console]::Write($global:__ct.E + "]" + $s + $global:__ct.B) }',
    // the exit code: a native program's own code when it set a new one, else 0 / 1 from $?
    'function global:prompt {',
    '  $ok = $global:?',
    '  $code = 0',
    '  if (-not $ok) { $code = 1; if ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0 -and $global:LASTEXITCODE -ne $global:__ct.Exit) { $code = $global:LASTEXITCODE } }',
    '  $global:__ct.Exit = $global:LASTEXITCODE',
    `  __ct_osc ("${osc};end;" + $code)`,
    '  $p = (Get-Location -PSProvider FileSystem).ProviderPath',
    '  if ($p -match "^[A-Za-z]:\\\\") { __ct_osc ("7;" + [System.Uri]::new($p).AbsoluteUri) }',
    // the user's prompt (oh-my-posh & co) reads $? for the last status: put the failure back first
    '  if (-not $ok) { Write-Error "failure" -ErrorAction Ignore }',
    '  & $global:__ct.Prompt',
    '}',
    // PSReadLine reads the line through this function: the accepted line is the command that starts
    'if (Test-Path Function:\\PSConsoleHostReadLine) {',
    '  $global:__ct.ReadLine = $function:PSConsoleHostReadLine',
    '  function global:PSConsoleHostReadLine {',
    '    $line = & $global:__ct.ReadLine',
    `    if ($line -and $line.Trim()) { __ct_osc ("${osc};start;" + ($line -replace "[\\x00-\\x1f\\x7f]", " ")) }`,
    '    $line',
    '  }',
    '}',
    'if (Get-Command Set-PSReadLineKeyHandler -ErrorAction Ignore) {',
    '  if ((Get-PSReadLineOption).EditMode -eq "Vi") {',
    '    Set-PSReadLineKeyHandler -ViMode Insert -Chord Ctrl+Shift+F12 -Function RevertLine',
    '    Set-PSReadLineKeyHandler -ViMode Command -Chord Ctrl+Shift+F12 -ScriptBlock { [Microsoft.PowerShell.PSConsoleReadLine]::RevertLine(); [Microsoft.PowerShell.PSConsoleReadLine]::ViInsertMode() }',
    '  } else { Set-PSReadLineKeyHandler -Chord Ctrl+Shift+F12 -Function RevertLine }',
    '}',
    // `claude` typed in the tab: adds the project's linked folders (kept in the app's data) when it has some
    'if ($env:CLAUDETERM_LINKS) {',
    '  function global:claude {',
    '    $exe = Get-Command claude -CommandType Application -ErrorAction Ignore | Select-Object -First 1',
    '    if (-not $exe) { Write-Error "claude introuvable dans le PATH"; return }',
    '    $s = Join-Path $env:CLAUDETERM_LINKS "settings.json"; $t = Join-Path $env:CLAUDETERM_LINKS "prompt.txt"',
    '    if ((Test-Path -LiteralPath $s) -and (Test-Path -LiteralPath $t)) { & $exe.Source --settings $s --append-system-prompt-file $t @args }',
    '    else { & $exe.Source @args }',
    '  }',
    '}',
  ].join('\r\n')
}

/** `-EncodedCommand` takes the script as base64 UTF-16LE: no quoting, and no script file for the execution policy to block. */
export function encodePowershell(script: string): string {
  let bytes = ''
  for (let i = 0; i < script.length; i++) { const c = script.charCodeAt(i); bytes += String.fromCharCode(c & 0xff, c >> 8) }
  return btoa(bytes)
}

/** Arguments of an integrated PowerShell: the user's profile loads first, then the script, then the prompt. */
export const powershellArgs = (osc: number): string[] => ['-NoLogo', '-NoExit', '-EncodedCommand', encodePowershell(powershellIntegration(osc))]
