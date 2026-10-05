import { app, clipboard, nativeImage } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { encodePowershell, SNIP_SCRIPT } from '@shared/powershell'

/** Dropped, pasted or captured images become files under userData/drops; their path is typed into the prompt. */
export class Attachments {
  readonly dir: string
  constructor(base = app.getPath('userData')) {
    this.dir = join(base, 'drops')
    mkdirSync(this.dir, { recursive: true })
  }
  /** A free path named by date and time; several in the same second get -2, -3… (a burst of drops must not overwrite). */
  newPath(ext = 'png', now = new Date()): string {
    const d = now, p = (n: number) => String(n).padStart(2, '0')
    const base = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    for (let i = 1; ; i++) {
      const path = join(this.dir, `${base}${i > 1 ? '-' + i : ''}.${ext}`)
      if (!existsSync(path) && !this.reserved.has(path)) { this.reserved.add(path); setTimeout(() => this.reserved.delete(path), 5000).unref?.(); return path }
    }
  }
  /** paths handed out but maybe not written yet (async clipboard / capture) */
  private reserved = new Set<string>()
  /** Saves a data URL (image/*) and returns the file path. */
  saveDataUrl(dataUrl: string): string | null {
    const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/s)
    if (!m) return null
    const p = this.newPath(m[1] === 'jpeg' ? 'jpg' : m[1])
    writeFileSync(p, Buffer.from(m[2], 'base64'))
    return p
  }
  /** Clipboard image (when the clipboard holds no text) saved as PNG. Electron 44: async W3C-style API. */
  async clipboardImage(): Promise<string | null> {
    if ((await clipboard.readText()).trim()) return null
    for (const item of await clipboard.read()) {
      const type = item.types.find((x) => x.startsWith('image/'))
      if (!type) continue
      const blob = (await item.getType(type)) as Blob
      const buf = Buffer.from(await blob.arrayBuffer())
      const png = type === 'image/png' ? buf : nativeImage.createFromBuffer(buf).toPNG()
      const p = this.newPath()
      writeFileSync(p, png)
      return p
    }
    return null
  }
  /** Interactive screen capture (macOS: screencapture -i, Windows: the Snipping Tool). Resolves with the file, or null when cancelled. */
  captureScreen(): Promise<string | null> {
    if (process.platform === 'win32') return this.captureWindows()
    return new Promise((resolve) => {
      if (process.platform !== 'darwin') return resolve(null)
      const p = this.newPath()
      execFile('/usr/sbin/screencapture', ['-i', '-r', p], () => resolve(existsSync(p) ? p : null))
    })
  }

  private capturing: Promise<string | null> | null = null
  /** The Snipping Tool puts its capture on the clipboard: the helper waits for the clipboard to change, then the image is saved. */
  private captureWindows(): Promise<string | null> {
    this.capturing ??= new Promise<string | null>((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowershell(SNIP_SCRIPT)], { windowsHide: true, timeout: 130_000 }, (_e, out) => {
        resolve(String(out).includes('changed') ? this.clipboardImage() : null)
      })
    }).finally(() => { this.capturing = null })
    return this.capturing
  }
  static isImage(p: string) { return /\.(png|jpe?g|gif|webp|bmp)$/i.test(p) }
  static preview(p: string) { return nativeImage.createFromPath(p) }
}
