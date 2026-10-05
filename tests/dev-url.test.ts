import { describe, it, expect } from 'vitest'
import { DevUrlSniffer, normalizeDevUrl } from '../src/shared/dev-url'

const ESC = String.fromCharCode(27)

describe('dev server address', () => {
  it('reads the first local URL of a complete line, colours removed', () => {
    const s = new DevUrlSniffer('npm run dev')
    expect(s.feed('PS C:\\app> npm run dev\r\n\r\n> app@1.0.0 dev\r\n> vite\r\n\r\n')).toBeNull()
    expect(s.feed(`  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m\r\n`)).toBe('http://localhost:5173/')
    expect(s.url).toBe('http://localhost:5173/')
    // once found, the rest is ignored
    expect(s.feed('  ➜  Network: http://localhost:9999/\r\n')).toBeNull()
  })

  it('waits for the end of the line, skips the echoed command, keeps local hosts only', () => {
    const cmd = "Write-Host ('  Local:   http://localhost:' + (5000 + 173) + '/'); Start-Sleep 1 # http://localhost:9999/"
    const s = new DevUrlSniffer(cmd)
    expect(s.feed(`PS C:\\x> ${cmd}\r\n`)).toBeNull()
    expect(s.feed('  Network: http://192.168.1.20:5173/\r\n')).toBeNull()
    expect(s.feed('  Local:   http://local')).toBeNull()
    expect(s.feed('host:5173/')).toBeNull()
    expect(s.feed('\r\n')).toBe('http://localhost:5173/')
  })

  it('reads 0.0.0.0 and [::] as localhost and drops trailing punctuation', () => {
    expect(normalizeDevUrl('http://0.0.0.0:8000')).toBe('http://localhost:8000')
    expect(normalizeDevUrl('http://[::]:3000/')).toBe('http://localhost:3000/')
    expect(normalizeDevUrl('http://127.0.0.1:8080/).')).toBe('http://127.0.0.1:8080/')
    expect(new DevUrlSniffer().feed('Starting development server at http://0.0.0.0:8000/\n')).toBe('http://localhost:8000/')
    expect(new DevUrlSniffer().feed('ready on http://app.localhost:3000\n')).toBe('http://app.localhost:3000')
    expect(new DevUrlSniffer().feed('see https://example.com:443/docs\n')).toBeNull()
    // a progress bar redrawn with \r ends its line too
    expect(new DevUrlSniffer().feed('building 40%\rbuilding 100%\rserving http://localhost:4000\r')).toBe('http://localhost:4000')
  })
})
