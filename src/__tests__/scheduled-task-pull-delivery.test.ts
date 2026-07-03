import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initDatabase,
  insertPendingScheduledIfNew,
  claimPendingScheduledForAgent,
} from '../db.js'

// Tests for the scheduled-task PULL delivery path (fix for v1.18.5 regression).
//
// Root cause: the main agent's channel session (MAIN_CHANNELS_SESSION) is
// always-busy from isSessionReadyForPrompt's perspective, causing 444+
// "busy or has pending input" retries overnight (dream-engine, napindito).
//
// Fix: for the main agent, the schedule-runner writes the pre-formatted prompt
// into pending_scheduled_inbox instead of tmux-injecting. The drain-inbox
// UserPromptSubmit hook claims it on the next turn, bypassing the
// isSessionReadyForPrompt gate entirely.

beforeAll(() => { initDatabase(':memory:') })

const AGENT = 'atlas'
const TASK = 'test-scheduled-task-pull-' + Date.now()
const NOW = Math.floor(Date.now() / 1000)

describe('insertPendingScheduledIfNew', () => {
  it('inserts when no pending row exists, returns true', () => {
    const inserted = insertPendingScheduledIfNew(TASK + '-a', AGENT, 'prompt-A', NOW)
    expect(inserted).toBe(true)
  })

  it('is idempotent: returns false when a pending row already exists', () => {
    const taskName = TASK + '-b'
    const first = insertPendingScheduledIfNew(taskName, AGENT, 'prompt-B', NOW)
    const second = insertPendingScheduledIfNew(taskName, AGENT, 'prompt-B-dup', NOW)
    expect(first).toBe(true)
    expect(second).toBe(false) // duplicate cron tick: no new row
  })

  it('allows a new insert after the existing row is delivered (claimed)', () => {
    const taskName = TASK + '-c'
    insertPendingScheduledIfNew(taskName, AGENT, 'prompt-C', NOW)
    // drain it
    const claimed = claimPendingScheduledForAgent(AGENT, 10)
    expect(claimed.some(r => r.task_name === taskName)).toBe(true)
    // now a new cron tick should succeed
    const inserted = insertPendingScheduledIfNew(taskName, AGENT, 'prompt-C2', NOW + 3600)
    expect(inserted).toBe(true)
  })
})

describe('claimPendingScheduledForAgent', () => {
  const CLAIM_AGENT = AGENT + '-claim-' + Date.now()

  it('returns empty array when no pending rows', () => {
    expect(claimPendingScheduledForAgent(CLAIM_AGENT, 10)).toEqual([])
  })

  it('claims FIFO up to the cap and marks delivered', () => {
    const taskA = TASK + '-claim-a'
    const taskB = TASK + '-claim-b'
    const taskC = TASK + '-claim-c'
    insertPendingScheduledIfNew(taskA, CLAIM_AGENT, 'pa', NOW)
    insertPendingScheduledIfNew(taskB, CLAIM_AGENT, 'pb', NOW + 1)
    insertPendingScheduledIfNew(taskC, CLAIM_AGENT, 'pc', NOW + 2)

    const batch1 = claimPendingScheduledForAgent(CLAIM_AGENT, 2)
    expect(batch1.map(r => r.task_name)).toEqual([taskA, taskB])
    expect(batch1.every(r => r.status === 'delivered')).toBe(true)

    const batch2 = claimPendingScheduledForAgent(CLAIM_AGENT, 10)
    expect(batch2.map(r => r.task_name)).toEqual([taskC])
    // inbox empty after two drains
    expect(claimPendingScheduledForAgent(CLAIM_AGENT, 10)).toEqual([])
  })

  it('does NOT double-claim (concurrent drain idempotency)', () => {
    const taskD = TASK + '-claim-d'
    insertPendingScheduledIfNew(taskD, CLAIM_AGENT, 'pd', NOW + 3)

    const b1 = claimPendingScheduledForAgent(CLAIM_AGENT, 10)
    const b2 = claimPendingScheduledForAgent(CLAIM_AGENT, 10)
    // exactly one drain gets the row
    const total = [...b1, ...b2].filter(r => r.task_name === taskD)
    expect(total).toHaveLength(1)
  })
})

describe('schedule-runner: main-agent tasks use PULL delivery', () => {
  const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

  it('attemptFireTask return type includes "queued"', () => {
    const sig = SRC.slice(SRC.indexOf('function attemptFireTask'))
    expect(sig.slice(0, 300)).toMatch(/'queued'/)
  })

  it('main-agent PULL path calls insertPendingScheduledIfNew instead of tmux-injecting', () => {
    const pullIdx = SRC.indexOf('insertPendingScheduledIfNew')
    expect(pullIdx).toBeGreaterThan(0)
    // The PULL block must appear inside attemptFireTask (before any session check)
    const fnIdx = SRC.indexOf('function attemptFireTask')
    const nextFnIdx = SRC.indexOf('\nfunction ', fnIdx + 1)
    const fnBody = SRC.slice(fnIdx, nextFnIdx)
    expect(fnBody).toMatch(/insertPendingScheduledIfNew/)
    expect(fnBody).toMatch(/isMainAgent/)
  })

  it('PULL path uses waitForIdle:false wakeup -- bypasses isSessionReadyForPrompt for main agent', () => {
    const fnIdx = SRC.indexOf('function attemptFireTask')
    const nextFnIdx = SRC.indexOf('\nfunction ', fnIdx + 1)
    const fnBody = SRC.slice(fnIdx, nextFnIdx)
    // The isMainAgent block must use sendPromptToSession with waitForIdle:false
    const wakeupIdx = fnBody.indexOf('waitForIdle: false')
    expect(wakeupIdx).toBeGreaterThan(0)
    // The FUNCTIONAL isSessionReadyForPrompt call (not the comment mention)
    // must come AFTER the main-agent early return ('return \'queued\'')
    const pullReturnIdx = fnBody.indexOf("return 'queued'")
    // Use '!isSessionReadyForPrompt(' to skip comment references
    const sessionCheckIdx = fnBody.indexOf('!isSessionReadyForPrompt(')
    expect(pullReturnIdx).toBeGreaterThan(0)
    expect(sessionCheckIdx).toBeGreaterThan(0)
    expect(pullReturnIdx).toBeLessThan(sessionCheckIdx)
  })

  it('wakeup targets MAIN_CHANNELS_SESSION inside the isMainAgent block', () => {
    const fnIdx = SRC.indexOf('function attemptFireTask')
    const nextFnIdx = SRC.indexOf('\nfunction ', fnIdx + 1)
    const fnBody = SRC.slice(fnIdx, nextFnIdx)
    const isMainAgentBlockIdx = fnBody.indexOf('if (isMainAgent)')
    expect(isMainAgentBlockIdx).toBeGreaterThan(0)
    // Search for MAIN_CHANNELS_SESSION AFTER the if (isMainAgent) statement
    const afterBlock = fnBody.slice(isMainAgentBlockIdx)
    expect(afterBlock).toMatch(/MAIN_CHANNELS_SESSION/)
    // And it must appear in the same block as sendPromptToSession
    const sendPromptIdx = afterBlock.indexOf('sendPromptToSession(')
    const channelSessionIdx = afterBlock.indexOf('MAIN_CHANNELS_SESSION')
    expect(sendPromptIdx).toBeGreaterThan(0)
    // MAIN_CHANNELS_SESSION is the first arg to sendPromptToSession -- appears after the call start
    expect(Math.abs(channelSessionIdx - sendPromptIdx)).toBeLessThan(100)
  })

  it('pending-retry loop deletes the retry row when result is "queued"', () => {
    expect(SRC).toMatch(/'queued'\)/)
    // The deletion branch must include 'queued'
    const deleteIdx = SRC.indexOf("result === 'queued'")
    expect(deleteIdx).toBeGreaterThan(0)
    const deleteBlock = SRC.slice(deleteIdx - 200, deleteIdx + 100)
    expect(deleteBlock).toMatch(/deletePendingTaskRetry/)
  })
})

describe('drain-inbox: includes scheduled-task inbox', () => {
  const AGENTS_SRC = readFileSync(join(__dirname, '../web/routes/agents.ts'), 'utf-8')

  it('drain-inbox handler calls claimPendingScheduledForAgent', () => {
    expect(AGENTS_SRC).toMatch(/claimPendingScheduledForAgent/)
  })

  it('scheduled task blocks are added after inter-agent blocks inside the drain handler', () => {
    // Anchor on the drain-inbox route match declaration (unique in the file)
    const handlerIdx = AGENTS_SRC.indexOf("const drainMatch = path.match")
    expect(handlerIdx).toBeGreaterThan(0)
    // Look far enough to cover the full handler (inter-agent loop + scheduled drain)
    const handlerBlock = AGENTS_SRC.slice(handlerIdx, handlerIdx + 2000)
    const scheduledIdx = handlerBlock.indexOf('claimPendingScheduledForAgent')
    const interAgentIdx = handlerBlock.indexOf('claimPendingForAgent(')
    expect(scheduledIdx).toBeGreaterThan(0)
    expect(interAgentIdx).toBeGreaterThan(0)
    expect(scheduledIdx).toBeGreaterThan(interAgentIdx)
  })
})
