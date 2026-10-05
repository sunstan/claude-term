import { describe, it, expect } from 'vitest'
import { MASK, isSecretName, maskServer, unmaskServer } from '../src/shared/mcp-secrets'
import type { MCPServer } from '../src/shared/ipc'

const server = (o: Partial<MCPServer>): MCPServer => ({ name: 'x', transport: 'stdio', command: 'npx', args: [], url: '', env: {}, headers: {}, scope: 'project', sourcePath: '/p/.mcp.json', disabled: false, ...o })

describe('MCP secrets', () => {
  it('knows secrets by their name', () => {
    for (const n of ['GITHUB_TOKEN', 'API_KEY', 'apiKey', 'Authorization', 'client_secret', 'PASSWORD', 'x-api-key', 'key', 'AWS_SECRET_ACCESS_KEY']) expect(isSecretName(n), n).toBe(true)
    for (const n of ['PATH', 'NODE_ENV', 'Accept', 'REGION', 'keyboard', 'monkey']) expect(isSecretName(n), n).toBe(false)
  })

  it('masks env, headers, arguments and URLs, counting them', () => {
    const s = server({
      args: ['-y', '@x/server', '--api-key=sk-123', '--token', 'ghp_abc', '--port', '3000'],
      env: { GITHUB_TOKEN: 'ghp_abc', NODE_ENV: 'production', EMPTY_TOKEN: '' },
      headers: { Authorization: 'Bearer abc', 'X-Trace': 'Bearer looks-like-one', Accept: 'json' },
      url: 'https://u:pw@mcp.example.com/sse?api_key=k1&region=eu',
    })
    const m = maskServer(s)
    expect(m.args).toEqual(['-y', '@x/server', `--api-key=${MASK}`, '--token', MASK, '--port', '3000'])
    expect(m.env).toEqual({ GITHUB_TOKEN: MASK, NODE_ENV: 'production', EMPTY_TOKEN: '' })
    expect(m.headers).toEqual({ Authorization: MASK, 'X-Trace': MASK, Accept: 'json' })
    expect(m.url).toBe(`https://u:${MASK}@mcp.example.com/sse?api_key=${MASK}&region=eu`)
    expect(m.secrets).toBe(7)
    expect(JSON.stringify(m)).not.toMatch(/ghp_abc|sk-123|Bearer abc|k1|:pw@/)
    expect(maskServer(server({ env: { A: '1' } })).secrets).toBeUndefined()
  })

  it('puts the stored values back where the mask stayed, keeps what was typed anew', () => {
    const stored = server({ args: ['--token', 'T1', '--api-key=K1'], env: { GITHUB_TOKEN: 'G1', A: '1' }, headers: { Authorization: 'Bearer B1' }, url: 'https://h/x?token=U1' })
    const m = maskServer(stored)
    // untouched: everything back as it was
    expect(unmaskServer({ ...m, ref: { path: '/p/.mcp.json', name: 'x' } }, stored)).toEqual(stored)
    // edited: a secret typed anew, another variable added, the order of arguments changed
    const edited = { ...m, env: { ...m.env, GITHUB_TOKEN: 'G2', B: '2' }, args: [m.args[2], m.args[0], m.args[1]], headers: { Authorization: MASK } }
    expect(unmaskServer(edited, stored)).toMatchObject({ env: { GITHUB_TOKEN: 'G2', A: '1', B: '2' }, args: ['--api-key=K1', '--token', 'T1'], headers: { Authorization: 'Bearer B1' }, url: 'https://h/x?token=U1' })
    // a mask with nothing behind it is refused, never written
    expect(() => unmaskServer({ ...m, env: { NEW_TOKEN: MASK } }, stored)).toThrow(/sans source/)
    expect(() => unmaskServer(m, null)).toThrow()
    expect(() => unmaskServer({ ...m, url: `https://other/x?token=${MASK}` }, stored)).toThrow(/retape/)
    expect(unmaskServer({ ...m, url: 'https://h/x?token=U9' }, stored).url).toBe('https://h/x?token=U9')
  })
})
