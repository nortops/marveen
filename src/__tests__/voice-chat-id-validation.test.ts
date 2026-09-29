// Regression test for negative (group/supergroup) chat_ids on the voice routes.
//
// Telegram group and supergroup chat_ids are negative integers (e.g.
// -1004417391961), but the /api/voice/* routes validated chat_id with
// /^\d+$/ -- digits only -- so a directive, modality, or TTS call aimed at a
// chat group was rejected with 400 "Invalid chat_id" even though sendVoice
// itself accepts the value. The fix widened the regex to /^-?\d+$/ on all
// three validation arms (routes/voice.ts).
import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { RouteContext } from '../web/routes/types.js'

// Voice calls as if the toolkit and every fixture existed, so the handler
// walks through validation instead of bailing at install checks or missing
// .env / .onnx paths. Only existsSync is forced true; reads still hit the
// real filesystem (a missing token/onnx just returns null/false, which the
// happy-path assertions don't depend on).
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return { ...actual, existsSync: () => true }
})

// POST /api/voice/tts runs `piper` via runProc; replace the spawn with a
// deterministic fake that reports a successful sendVoice so the TTS arm can
// be exercised end-to-end without a real subprocess or network call.
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>()
  const fakeProc = () => ({
    stdout: {
      on(ev: string, cb: (d: Buffer) => void) {
        if (ev === 'data') setImmediate(() => cb(Buffer.from('ok=True id=9876')))
      },
    },
    stderr: { on() {} },
    stdin: { write() {}, end() {} },
    on(ev: string, cb: (code: number) => void) {
      if (ev === 'close') setImmediate(() => cb(0))
    },
  })
  return { ...actual, spawn: () => fakeProc() }
})

const { tryHandleVoice } = await import('../web/routes/voice.js')

const GROUP_CHAT_ID = '-1004417391961'
const POSITIVE_CHAT_ID = '8027010441'
// Valid channel dir under ~/.claude/channels (existsSync is mocked true, so
// the .env presence check passes); the /tmp prefixed fixtures were rejected
// by isSafeStateDir before reaching sendVoice.
const STATE_DIR = join(homedir(), '.claude', 'channels', 'telegram')

function getCtx(path: string): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: {} as any, res, path: url.pathname, method: 'GET', url } as RouteContext
  return { ctx, out }
}

function postCtx(path: string, payload: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const req = Readable.from(Buffer.from(JSON.stringify(payload)))
  const ctx = { req: req as any, res, path: url.pathname, method: 'POST', url } as RouteContext
  return { ctx, out }
}

describe('voice routes: negative chat_id (Telegram group)', () => {
  it('GET /api/voice/directive accepts a negative chat_id', async () => {
    const { ctx, out } = getCtx(`/api/voice/directive?agent=zz-test-agent&chat=${GROUP_CHAT_ID}`)
    expect(await tryHandleVoice(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toHaveProperty('directive')
  })

  it('GET /api/voice/directive still rejects a non-numeric chat_id', async () => {
    const { ctx, out } = getCtx('/api/voice/directive?agent=zz-test-agent&chat=not-a-number')
    expect(await tryHandleVoice(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('POST /api/voice/modality/set accepts a negative chat_id', async () => {
    const { ctx, out } = postCtx('/api/voice/modality/set', {
      agent_id: 'zz-test-agent',
      chat_id: GROUP_CHAT_ID,
      modality: 'voice',
    })
    expect(await tryHandleVoice(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true })
  })

  it('POST /api/voice/tts accepts a negative chat_id and proceeds to sendVoice', async () => {
    const { ctx, out } = postCtx('/api/voice/tts', {
      text: 'Teszt',
      chat_id: GROUP_CHAT_ID,
      state_dir: STATE_DIR,
    })
    expect(await tryHandleVoice(ctx)).toBe(true)
    // 200 (not 400 "Invalid chat_id") proves the negative id passed validation
    // and flowed through to the sendVoice subprocess.
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, message_id: 9876 })
  })

  it('POST /api/voice/tts keeps accepting the positive chat_id path', async () => {
    const { ctx, out } = postCtx('/api/voice/tts', {
      text: 'Teszt',
      chat_id: POSITIVE_CHAT_ID,
      state_dir: STATE_DIR,
    })
    expect(await tryHandleVoice(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true })
  })
})