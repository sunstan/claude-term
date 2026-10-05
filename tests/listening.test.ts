import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { discoverServers, parseLsof, parseNetstat, parseSs, shortCommand } from '../src/shared/listening'
import { runnablesTree } from '../src/shared/runnables'
import { devServers } from '../src/main/services/dev-servers'
import type { ProcRow } from '../src/shared/processes'

describe('listening sockets', () => {
  it('reads netstat whatever the language of its states', () => {
    const text = [
      'Connexions actives', '',
      '  Proto  Adresse locale         Adresse distante       État',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1260',
      '  TCP    127.0.0.1:5173         0.0.0.0:0              ÉCOUTE          4242',
      '  TCP    192.168.1.10:8080      0.0.0.0:0              LISTENING       77',
      '  TCP    127.0.0.1:5173         127.0.0.1:50000        ESTABLISHED     4242',
      '  TCP    [::1]:3000             [::]:0                 LISTENING       99',
      '  TCP    [::]:4000              [::]:0                 LISTENING       98',
      '  UDP    0.0.0.0:500            *:*                                    3',
      '  TCP    0.0.0.0:1              0.0.0.0:0              LISTENING       0',
    ].join('\r\n')
    expect(parseNetstat(text)).toEqual([
      { address: '0.0.0.0', port: 135, pid: 1260 },
      { address: '127.0.0.1', port: 5173, pid: 4242 },
      { address: '[::1]', port: 3000, pid: 99 },
      { address: '[::]', port: 4000, pid: 98 },
    ])
  })

  it('reads lsof and ss', () => {
    expect(parseLsof('p4242\nf21\nn127.0.0.1:5173\nf22\nn[::1]:5173\np99\nf3\nn*:3000\nf4\nn10.0.0.2:22\n')).toEqual([
      { address: '127.0.0.1', port: 5173, pid: 4242 }, { address: '[::1]', port: 5173, pid: 4242 }, { address: '*', port: 3000, pid: 99 },
    ])
    expect(parseSs([
      'LISTEN 0      511          127.0.0.1:5173       0.0.0.0:*    users:(("node",pid=4242,fd=21))',
      'LISTEN 0      511              [::1]:3000          [::]:*    users:(("node",pid=99,fd=20))',
      'LISTEN 0      4096                 *:8080             *:*    users:(("go",pid=7,fd=3))',
      'LISTEN 0      128            0.0.0.0:22         0.0.0.0:*',
      'LISTEN 0      128      10.0.0.2%eth0:9000       0.0.0.0:*    users:(("x",pid=8,fd=3))',
    ].join('\n'))).toEqual([
      { address: '127.0.0.1', port: 5173, pid: 4242 }, { address: '[::1]', port: 3000, pid: 99 }, { address: '*', port: 8080, pid: 7 },
    ])
  })

  it('keeps the servers under the app\'s terminals, one per port, MCP servers left out', () => {
    const row = (pid: number, ppid: number, cmd: string): ProcRow => ({ pid, ppid, started: 0, cmd })
    const rows = [
      row(10, 1, 'pwsh'), row(11, 10, 'claude'), row(12, 11, 'node vite.js'), row(13, 11, 'node chrome-devtools-mcp'),
      row(20, 1, 'zsh'), row(21, 20, 'python -m http.server'), row(30, 1, 'other'),
    ]
    const sockets = [
      { address: '[::1]', port: 5173, pid: 12 }, { address: '127.0.0.1', port: 5173, pid: 12 },
      { address: '127.0.0.1', port: 9222, pid: 13 }, { address: '[::1]', port: 8000, pid: 21 }, { address: '0.0.0.0', port: 7000, pid: 30 },
    ]
    expect(discoverServers(sockets, rows, new Map([[10, 'pty1'], [20, 'pty2']]))).toEqual([
      { url: 'http://localhost:5173/', probe: 'http://127.0.0.1:5173/', port: 5173, pid: 12, command: 'node vite.js', ptyId: 'pty1' },
      { url: 'http://localhost:8000/', probe: 'http://[::1]:8000/', port: 8000, pid: 21, command: 'python -m http.server', ptyId: 'pty2' },
    ])
    expect(discoverServers(sockets, rows, new Map())).toEqual([])
  })

  it('makes a command line readable', () => {
    expect(shortCommand('"C:\\Program Files\\nodejs\\node.exe" C:\\Projets\\app\\node_modules\\vite\\bin\\vite.js --port 5173')).toBe('node vite.js --port 5173')
    expect(shortCommand('/usr/local/bin/python3 -m http.server 8000')).toBe('python3 -m http.server 8000')
    expect(shortCommand('npm run dev')).toBe('npm run dev')
    expect(shortCommand('x'.repeat(100), 10)).toBe('xxxxxxxxx…')
  })

  it('shows the servers no script showed in a group of their own', () => {
    const servers = [{ port: 5173, url: 'http://localhost:5173/', command: 'node vite.js', tab: 'Claude' }, { port: 3000, url: 'http://localhost:3000/', command: 'node server.js', tab: 'dev' }]
    const running = [{ runId: 'r1', command: 'npm run dev', started: true, url: 'http://localhost:3000/' }]
    const items = runnablesTree([], running, [], servers)
    expect(items.map((g) => g.id)).toEqual(['g:running', 'g:servers'])
    expect(items[1]).toMatchObject({ label: 'Serveurs · 1', expanded: true })
    expect(items[1].children![0]).toMatchObject({ id: 'srv:5173', label: 'localhost:5173', detail: 'node vite.js', badges: ['Claude'] })
    expect(items[1].children![0].actions!.map((a) => a.id)).toEqual(['open-server', 'show-tab'])
    expect(runnablesTree([], [], [], []).length).toBe(0)
  })
})

describe('dev servers on this machine', () => {
  it('finds a page served by a process under a terminal, and not an API', async () => {
    const serve = (type: string) => spawn(process.execPath, ['-e', `require('http').createServer((q, r) => { r.setHeader('content-type', '${type}'); r.end('x') }).listen(0, '127.0.0.1', function () { console.log(this.address().port) })`])
    const page = serve('text/html; charset=utf-8'), api = serve('application/json')
    const port = (p: ReturnType<typeof spawn>) => new Promise<number>((res) => p.stdout!.once('data', (d) => res(Number(String(d).trim()))))
    try {
      const [pagePort, apiPort] = await Promise.all([port(page), port(api)])
      // this test process stands for the terminal both descend from
      const found = await devServers(new Map([[process.pid, 'pty-test']]))
      expect(found.find((s) => s.port === pagePort)).toMatchObject({ url: `http://localhost:${pagePort}/`, pid: page.pid, ptyId: 'pty-test' })
      expect(found.some((s) => s.port === apiPort)).toBe(false)
    } finally { page.kill(); api.kill() }
  }, 60_000)
})
