/**
 * A dev server's address read from a command's output (the Exécuter panel's "Ouvrir dans le navigateur"). Pure, tested.
 * Complete lines only (a URL split across two chunks is read once whole), escape sequences removed, the echoed
 * command line skipped (it can hold a URL of its own), local hosts only (Vite prints Local before Network),
 * 0.0.0.0 and [::] read as localhost.
 */

// CSI (colours, cursor), OSC (titles, our shell integration) and the two-byte escapes
const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7)
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`, 'g')
const URL_RE = /\bhttps?:\/\/(?:localhost|[a-z0-9-]+\.localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"<>`]*)?/i
const MAX_REST = 4096

export function normalizeDevUrl(url: string): string {
  return url.replace(/:\/\/(?:0\.0\.0\.0|\[::\])(?=[:/]|$)/, '://localhost').replace(/[.,;:)\]]+$/, '')
}

export class DevUrlSniffer {
  private rest = ''
  url: string | null = null
  constructor(private command = '') {}

  /** Reads more output; the URL when these lines are the first to carry one, null otherwise. */
  feed(chunk: string): string | null {
    if (this.url) return null
    const lines = (this.rest + chunk).split(/\r\n|\n|\r/)
    this.rest = (lines.pop() ?? '').slice(-MAX_REST)
    for (const raw of lines) {
      const line = raw.replace(ANSI, '').trim()
      if (!line || (this.command && line.includes(this.command))) continue
      const m = line.match(URL_RE)
      if (m) return (this.url = normalizeDevUrl(m[0]))
    }
    return null
  }
}
