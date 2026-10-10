import { describe, it, expect } from 'vitest'
import { encodeProjectPath, parseTranscript, completeLines, diffStats, unifiedDiff, firstUserText, lastAiTitle, isEmptyUpdate, joinPath, isInside, entryDetail } from '../src/shared/claude-format'

const opts = { plansDir: '/Users/j/.claude/plans', home: '/Users/j' }
const jsonl = (objs: object[]) => objs.map((o) => JSON.stringify(o))

describe('project path encoding', () => {
  it('replaces every non-alphanumeric byte', () => {
    expect(encodeProjectPath('/Users/jerome')).toBe('-Users-jerome')
    expect(encodeProjectPath('/Users/jerome/dev/turf-v2')).toBe('-Users-jerome-dev-turf-v2')
    expect(encodeProjectPath('/a b.c_d')).toBe('-a-b-c-d')
    expect(encodeProjectPath('C:\\Users\\j')).toBe('C--Users-j')
  })
})

describe('transcript parsing', () => {
  it('parses tools, usage and metadata', () => {
    const u = parseTranscript(jsonl([
      { type: 'user', timestamp: 't1', message: { role: 'user', content: 'fais un truc' } },
      { type: 'assistant', timestamp: 't2', message: { role: 'assistant', usage: { input_tokens: 100, output_tokens: 20 }, content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/p/a.ts' } },
        { type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'ls -la' } },
      ] } },
      { type: 'user', timestamp: 't3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1' }] } },
      { type: 'permission-mode', permissionMode: 'plan' },
      { type: 'attachment', attachment: { type: 'plan_mode', planFilePath: '/Users/j/.claude/plans/x.md' } },
      { type: 'ai-title', aiTitle: 'Un titre' },
    ]), opts)
    expect(u.events.map((e) => e.kind)).toEqual(['user', 'text', 'Edit', 'Bash'])
    expect(u.events[2].file).toBe('/p/a.ts')
    expect(u.events[3].detail).toBe('ls -la')
    expect(u.inputTokens).toBe(100); expect(u.outputTokens).toBe(20)
    expect(u.startedTools.map((t) => t.id)).toEqual(['tu1', 'tu2'])
    expect(u.finishedTools).toEqual(['tu1'])
    expect(u.permissionMode).toBe('plan')
    expect(u.planMode).toBe(true); expect(u.planPath).toBe('/Users/j/.claude/plans/x.md')
    expect(u.aiTitle).toBe('Un titre')
  })
  it('reads the permission mode from the prompts too (a session started by /clear has no permission-mode record)', () => {
    const u = parseTranscript(jsonl([
      { type: 'system', subtype: 'local_command', content: '/clear' },
      { type: 'user', permissionMode: 'auto', timestamp: 't1', message: { role: 'user', content: 'salut' } },
    ]), opts)
    expect(u.permissionMode).toBe('auto')
    // a switch after the prompt (shift+tab) wins
    expect(parseTranscript(jsonl([
      { type: 'user', permissionMode: 'auto', timestamp: 't1', message: { role: 'user', content: 'salut' } },
      { type: 'permission-mode', permissionMode: 'plan' },
    ]), opts).permissionMode).toBe('plan')
  })
  it('keeps the model and the context of the last main-thread message', () => {
    const u = parseTranscript(jsonl([
      { type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 2_000, output_tokens: 5 }, content: [] } },
      { type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-4-5', usage: { input_tokens: 900_000, output_tokens: 1 }, content: [] } },
      { type: 'assistant', message: { model: '<synthetic>', content: [] } },
    ]), opts)
    expect(u.model).toBe('claude-opus-5-5')
    expect(u.contextTokens).toBe(52_010)
    expect(isEmptyUpdate(parseTranscript(jsonl([{ type: 'assistant', message: { model: 'claude-fable-5-1', content: [] } }]), opts))).toBe(false)
  })
  it('ignores system-style user messages and partial lines', () => {
    const u = parseTranscript(jsonl([{ type: 'user', message: { content: '<command-name>/clear</command-name>' } }]), opts)
    expect(u.events).toHaveLength(0)
    expect(completeLines('{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], rest: '{"b"' })
    expect(isEmptyUpdate(parseTranscript(['{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x"}]}}'], opts))).toBe(false)
  })
  it('keeps the earliest backup version per file', () => {
    const u = parseTranscript(jsonl([
      { type: 'file-history-snapshot', snapshot: { trackedFileBackups: { 'p/a.ts': { backupFileName: 'a@v2', version: 2, realParentDir: '/x/p' } } } },
      { type: 'file-history-snapshot', snapshot: { trackedFileBackups: { 'p/a.ts': { backupFileName: 'a@v1', version: 1, realParentDir: '/x/p' } } } },
    ]), opts)
    expect(u.backups['/x/p/a.ts']).toEqual({ name: 'a@v1', version: 1 })
  })
  it('keeps Windows backup paths as Claude Code writes them', () => {
    const win = { plansDir: 'C:\\Users\\j\\.claude\\plans', home: 'C:\\Users\\j' }
    const u = parseTranscript(jsonl([
      { type: 'file-history-snapshot', snapshot: { trackedFileBackups: {
        'docs\\PLAN.md': { backupFileName: 'p@v1', version: 1, realParentDir: 'C:\\Projets\\app\\docs' },
        'top.md': { backupFileName: 't@v1', version: 1, realParentDir: 'C:\\' },
        'src\\old.ts': { backupFileName: 'o@v1', version: 1 },
      } } },
    ]), win)
    expect(Object.keys(u.backups).sort()).toEqual(['C:\\Projets\\app\\docs\\PLAN.md', 'C:\\Users\\j\\src\\old.ts', 'C:\\top.md'])
  })
  it('resolves a backup without realParentDir from the home folder', () => {
    const u = parseTranscript(jsonl([{ type: 'file-history-snapshot', snapshot: { trackedFileBackups: { 'a.ts': { backupFileName: 'a@v1', version: 1 } } } }]), opts)
    expect(Object.keys(u.backups)).toEqual(['/Users/j/a.ts'])
  })
  it('recognises plan files with either separator', () => {
    const win = { plansDir: 'C:\\Users\\j\\.claude\\plans', home: 'C:\\Users\\j' }
    const plan = (file: string) => parseTranscript(jsonl([{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Write', input: { file_path: file } }] } }]), win).planPath
    expect(plan('C:\\Users\\j\\.claude\\plans\\x.md')).toBe('C:\\Users\\j\\.claude\\plans\\x.md')
    expect(plan('c:/Users/j/.claude/plans/y.md')).toBe('c:/Users/j/.claude/plans/y.md')
    expect(plan('C:\\Users\\j\\.claude\\plans-old\\z.md')).toBeUndefined()
  })
  it('reads the effort of replies and of a /effort typed before the next one', () => {
    const reply = (effort: string, sidechain = false) => ({ type: 'assistant', effort, isSidechain: sidechain, message: { model: 'claude-opus-5-5', content: [] } })
    expect(parseTranscript(jsonl([reply('xhigh')]), opts).effort).toBe('xhigh')
    expect(parseTranscript(jsonl([reply('medium', true)]), opts).effort).toBeUndefined()
    const typed = { type: 'user', message: { role: 'user', content: '<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>high</command-args>' } }
    const u = parseTranscript(jsonl([reply('xhigh'), typed]), opts)
    expect(u.effort).toBe('high')
    expect(u.events).toHaveLength(0)
    expect(parseTranscript(jsonl([{ type: 'user', message: { content: '<command-name>/model</command-name><command-args>fable</command-args>' } }]), opts).effort).toBeUndefined()
  })
  it('keeps where entries are and the sub-agents calls start', () => {
    const u = parseTranscript(jsonl([
      { type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: 'regarde' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] } },
      { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'explore' } }] } },
      { type: 'user', uuid: 'u2', toolUseResult: { agentId: 'abc123', description: 'explore', status: 'async_launched' }, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BB' } }] }] } },
    ]), opts)
    expect(u.events.map((e) => [e.kind, e.ref, e.toolId])).toEqual([['user', 'u1', undefined], ['text', 'a1:0', undefined], ['Agent', 'a1:1', 'tu1']])
    expect(u.agents).toEqual({ tu1: { agentId: 'abc123', description: 'explore' } })
  })
  it('shows a sub-agent hand-back as its report, not as a prompt', () => {
    const body = '[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n  Root:\n  .git\n  apps'
    const rec = { type: 'user', uuid: 'h1', isMeta: true, promptSource: 'system', origin: { kind: 'peer', name: 'Explore', handback: true, body }, message: { content: 'Another Claude session sent a message:\n<agent-message from="x">' + body } }
    const u = parseTranscript(jsonl([rec]), opts)
    expect(u.events.map((e) => [e.kind, e.agent, e.detail])).toEqual([['handback', 'Explore', 'Root: ⏎ .git ⏎ apps']])
    expect(entryDetail(jsonl([rec]), 'h1')).toEqual({ kind: 'text', text: 'Root:\n.git\napps' })
  })
  it('reads an entry in full: a tool call with its result, a text, a prompt', () => {
    const lines = jsonl([
      { type: 'user', uuid: 'u1', message: { content: 'corrige\nle bug' } },
      { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: '# Plan\n- a' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } },
      { type: 'user', uuid: 'u2', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: [{ type: 'text', text: '1 failed' }] }] } },
    ])
    expect(entryDetail(lines, 'u1')).toEqual({ kind: 'user', text: 'corrige\nle bug' })
    expect(entryDetail(lines, 'a1:0')).toEqual({ kind: 'text', text: '# Plan\n- a' })
    expect(entryDetail(lines, 'a1:1')).toEqual({ kind: 'tool', name: 'Bash', input: '{\n  "command": "npm test"\n}', output: '1 failed', isError: true, truncated: false })
    expect(entryDetail(lines.slice(0, 2), 'a1:1')).toMatchObject({ kind: 'tool', output: '' })
    expect(entryDetail(lines, 'nope:0')).toBeNull()
  })
  it('reads file-history deltas, files created by the session included', () => {
    const win = { plansDir: 'C:\\Users\\j\\.claude\\plans', home: 'C:\\Users\\j' }
    const u = parseTranscript(jsonl([
      { type: 'file-history-delta', trackingPath: 'docs\\NEW.md', backup: { backupFileName: null, version: 1, realParentDir: 'C:\\p\\docs' } },
      { type: 'file-history-delta', trackingPath: 'docs\\OLD.md', backup: { backupFileName: 'o@v2', version: 2, realParentDir: 'C:\\p\\docs' } },
      { type: 'file-history-delta', trackingPath: 'docs\\OLD.md', backup: { backupFileName: 'o@v1', version: 1, realParentDir: 'C:\\p\\docs' } },
      { type: 'file-history-delta', trackingPath: 'x.md', backup: { version: 1 } },
    ]), win)
    expect(u.backups).toEqual({ 'C:\\p\\docs\\NEW.md': { name: null, version: 1 }, 'C:\\p\\docs\\OLD.md': { name: 'o@v1', version: 1 } })
  })
  it('parses bash edit diffs', () => {
    const u = parseTranscript(jsonl([{ type: 'user', message: { content: 'x' }, toolUseResult: { bashEditDiff: { files: [{ filePath: '/p/f', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] }] } } }]), opts)
    expect(u.bashDiffs['/p/f'][0]).toBe('@@ -1,1 +1,1 @@\n-a\n+b\n')
    expect(u.events.find((e) => e.kind === 'Edit (bash)')?.file).toBe('/p/f')
  })
  it('titles', () => {
    expect(firstUserText(jsonl([{ type: 'user', message: { content: '<local-command>' } }, { type: 'user', message: { content: 'hello\nworld' } }]))).toBe('hello world')
    expect(lastAiTitle(jsonl([{ type: 'ai-title', aiTitle: 'A' }, { type: 'ai-title', aiTitle: 'B' }]))).toBe('B')
  })
})

describe('paths', () => {
  it('joins with the separator of the base', () => {
    expect(joinPath('/x/p', ['a.ts'])).toBe('/x/p/a.ts')
    expect(joinPath('C:\\x\\', ['src', 'a.ts'])).toBe('C:\\x\\src\\a.ts')
    expect(joinPath('/', ['a'])).toBe('/a')
  })
  it('tells whether a path is inside a folder', () => {
    expect(isInside('/a/b/c', '/a/b')).toBe(true)
    expect(isInside('/a/bc', '/a/b')).toBe(false)
    expect(isInside('/a/b', '/a/b')).toBe(false)
    expect(isInside('C:\\A\\b.md', 'c:/a')).toBe(true)
    expect(isInside('/A/b', '/a')).toBe(false)
  })
})

describe('diffs', () => {
  it('unified diff and stats', () => {
    const d = unifiedDiff('a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nc\nX\ne\nf\ng\n')
    expect(d).toContain('@@ -1,7 +1,7 @@')
    expect(d).toContain('-d\n+X')
    expect(diffStats(d)).toEqual([1, 1])
    expect(unifiedDiff('same\n', 'same\n')).toBe('')
    expect(diffStats(unifiedDiff('', 'new\nfile\n'))).toEqual([2, 0])
  })
})
