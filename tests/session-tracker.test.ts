import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { appendFileSync } from 'node:fs'
import { TempDir, jsonl, sleep } from './helpers'
import { ClaudeData } from '../src/main/services/claude-data'
import { SessionTracker } from '../src/main/services/session-tracker'
import { encodeProjectPath } from '../src/shared/claude-format'
import type { SessionState } from '../src/shared/ipc'

describe('SessionTracker', () => {
  it('finds the transcript created after start, tails it and derives the state', async () => {
    const t = new TempDir()
    const cwd = join(t.path, 'proj')
    const dir = join(t.path, '.claude', 'projects', encodeProjectPath(cwd))
    const data = new ClaudeData(t.path)
    const updates: { state: SessionState; n: number }[] = []
    const claimed = new Set<string>()
    const tracker = new SessionTracker('tab1', cwd, data, claimed, (_id, state, ev) => updates.push({ state: structuredClone(state), n: ev.length }))
    await sleep(50)
    // Claude starts and writes its transcript
    const p = t.write(join(dir, 'sess.jsonl'), jsonl([
      { type: 'user', cwd, timestamp: 't1', message: { content: 'corrige le bug' } },
      { type: 'assistant', timestamp: 't2', message: { usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'x1', name: 'Edit', input: { file_path: join(cwd, 'a.ts') } }] } },
    ]))
    await sleep(1800)   // watcher or the 1.5 s poll
    expect(updates.length).toBeGreaterThan(0)
    let last = updates.at(-1)!.state
    expect(last.sessionId).toBe('sess')
    expect(last.events.map((e) => e.kind)).toEqual(['user', 'Edit'])
    expect(last.files[join(cwd, 'a.ts')]).toBe(1)
    expect(last.runningTools.map((r) => r.id)).toEqual(['x1'])
    expect(claimed.has(p)).toBe(true)
    // partial line then completion: only complete lines are parsed
    appendFileSync(p, '{"type":"user","timestamp":"t3","message":{"content":[{"type":"tool_result","tool_use_id":"x1"}]}}')
    await sleep(1800)
    expect(updates.at(-1)!.state.runningTools).toHaveLength(1)
    appendFileSync(p, '\n')
    await sleep(1800)
    last = updates.at(-1)!.state
    expect(last.runningTools).toHaveLength(0)
    tracker.stop()
    expect(claimed.has(p)).toBe(false)
    t.dispose()
  }, 10_000)

  it('moves to the session the hooks name after /clear, even before its transcript exists; ignores a nested startup', async () => {
    const t = new TempDir()
    const cwd = join(t.path, 'proj')
    const dir = join(t.path, '.claude', 'projects', encodeProjectPath(cwd))
    const data = new ClaudeData(t.path)
    t.write(join(dir, 'a.jsonl'), jsonl([{ type: 'user', cwd, timestamp: 't1', message: { content: 'avant /clear' } }]))
    const claimed = new Set<string>()
    const states: SessionState[] = []
    const tracker = new SessionTracker('tab1', cwd, data, claimed, (_id, s) => states.push(structuredClone(s)), { resume: 'a' })
    await sleep(100)
    expect(states.at(-1)?.sessionId).toBe('a')
    // /clear: the new session's transcript is written with its first message
    const b = join(dir, 'b.jsonl')
    tracker.sessionStarted(b, 'clear')
    expect(states.at(-1)?.events).toEqual([])
    expect(tracker.transcriptPath).toBe(b)
    expect(claimed.has(b)).toBe(true)
    expect(claimed.has(join(dir, 'a.jsonl'))).toBe(false)
    // a claude that Claude runs in its shell inherits the tab: its startup must not take the tab
    tracker.sessionStarted(join(dir, 'nested.jsonl'), 'startup')
    expect(tracker.transcriptPath).toBe(b)
    t.write(b, jsonl([{ type: 'user', cwd, timestamp: 't2', message: { content: 'après /clear' } }]))
    await sleep(1800)
    expect(states.at(-1)?.sessionId).toBe('b')
    expect(states.at(-1)?.events.map((e) => e.detail)).toEqual(['après /clear'])
    tracker.stop()
    expect(claimed.size).toBe(0)
    t.dispose()
  }, 10_000)

  it('follows a plan file and reloads it when it changes', async () => {
    const t = new TempDir()
    const cwd = join(t.path, 'proj')
    const dir = join(t.path, '.claude', 'projects', encodeProjectPath(cwd))
    const data = new ClaudeData(t.path)
    const plan = t.write('.claude/plans/p.md', '# Plan\n- [ ] a\n')
    t.write(join(dir, 'sess.jsonl'), jsonl([{ type: 'attachment', attachment: { type: 'plan_mode', planFilePath: plan } }]))
    const states: SessionState[] = []
    const tracker = new SessionTracker('tab1', cwd, data, new Set(), (_id, s) => states.push(structuredClone(s)), { resume: 'sess' })
    await sleep(100)
    expect(states.at(-1)?.planMode).toBe(true)
    expect(states.at(-1)?.planText).toContain('- [ ] a')
    await sleep(20)
    t.write('.claude/plans/p.md', '# Plan\n- [x] a\n')
    await sleep(1800)
    expect(states.at(-1)?.planText).toContain('- [x] a')
    tracker.stop()
    t.dispose()
  }, 10_000)

  it('resumes on the transcript path as the platform spells it; files under the plans folder are not the session ones', async () => {
    const t = new TempDir()
    const cwd = join(t.path, 'proj')
    const dir = join(t.path, '.claude', 'projects', encodeProjectPath(cwd))
    const data = new ClaudeData(t.path)
    const plan = join(data.plansDir, 'p.md')
    t.write(join(dir, 'sess.jsonl'), jsonl([
      { type: 'assistant', timestamp: 't1', message: { content: [
        { type: 'tool_use', id: 'x1', name: 'Write', input: { file_path: plan } },
        { type: 'tool_use', id: 'x2', name: 'Edit', input: { file_path: join(cwd, 'a.ts') } },
      ] } },
    ]))
    const claimed = new Set<string>()
    const states: SessionState[] = []
    const tracker = new SessionTracker('tab1', cwd, data, claimed, (_id, s) => states.push(structuredClone(s)), { resume: 'sess' })
    await sleep(100)
    // the path hooks report (join: backslashes on Windows), so attention reaches this tab
    expect(tracker.transcriptPath).toBe(join(dir, 'sess.jsonl'))
    expect(claimed.has(join(dir, 'sess.jsonl'))).toBe(true)
    expect(Object.keys(states.at(-1)!.files)).toEqual([join(cwd, 'a.ts')])
    tracker.stop()
    t.dispose()
  }, 10_000)
})
