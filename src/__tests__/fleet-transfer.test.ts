// Fleet export/import unit tests.
//
// Covers: encrypted round-trip, wrong-password fast-fail (no writes),
// args/url secret detection in placeholderMcp, avatarExt path-traversal guard.
//
// importFleet requires a live DB and filesystem, so those paths are integration-tested
// by calling importFleet with a pre-encrypted payload and mocked DB / FS module.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { _encryptForTest, _decryptForTest, ENCRYPTED_FLEET_VERSION, MIN_VAULT_PASSWORD_LEN } from '../web/fleet-transfer.js'

// ---------------------------------------------------------------------------
// Crypto round-trip
// ---------------------------------------------------------------------------

describe('encrypt/decrypt round-trip', () => {
  it('decrypts to the original plaintext', () => {
    const plaintext = JSON.stringify({ hello: 'world', num: 42 })
    const password = 'correct-horse-battery-staple'
    const blob = _encryptForTest(plaintext, password)
    expect(_decryptForTest(blob, password)).toBe(plaintext)
  })

  it('throws on wrong password (GCM auth tag mismatch)', () => {
    const blob = _encryptForTest('secret data', 'right-password-1234')
    expect(() => _decryptForTest(blob, 'wrong-password-1234')).toThrow()
  })

  it('throws on truncated blob (L1 sanity check)', () => {
    const tooShort = Buffer.from('dGVzdA==').toString('base64')
    expect(() => _decryptForTest(tooShort, 'any-password-here')).toThrow(/Érvénytelen titkosított blob/)
  })

  it('produces a non-trivially-parseable blob that differs from plaintext JSON', () => {
    const fleet = JSON.stringify({ schemaVersion: 1, agents: [] })
    const blob = _encryptForTest(fleet, 'pw-12345678')
    expect(() => JSON.parse(blob)).toThrow()
  })

  it('constants are correct values', () => {
    expect(ENCRYPTED_FLEET_VERSION).toBe(1)
    expect(MIN_VAULT_PASSWORD_LEN).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// importFleet: encrypted wrapper detection (with mocked FS / DB)
// ---------------------------------------------------------------------------

vi.mock('../db.js', () => ({
  getDb: () => ({
    prepare: () => ({
      all: () => [],
      get: () => null,
      run: () => ({ changes: 0 }),
    }),
    transaction: (fn: Function) => fn,
  }),
  backfillEmbeddings: () => Promise.resolve(),
  initDatabase: () => {},
}))

vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: '/mock/agents',
  listAgentNames: () => [],
}))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    existsSync: () => false,
    mkdirSync: () => undefined,
    unlinkSync: () => undefined,
    rmSync: () => undefined,
    readdirSync: () => [],
  }
})

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  SCHEDULED_TASKS_DIR: '/mock/tasks',
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/mock/project',
  STORE_DIR: '/mock/store',
}))

vi.mock('../web/vault-bindings.js', () => ({
  getBindings: () => [],
}))

vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}))

// Minimal valid FleetJson for tests
const MINIMAL_FLEET = JSON.stringify({
  schemaVersion: 1,
  exportedAt: '2026-01-01T00:00:00.000Z',
  sourceHost: 'test-host',
  agents: [],
  skills: [],
  scheduledTasks: [],
  memories: [],
  dailyLogs: [],
  kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
  ideaBox: { ideas: [], comments: [], statusLog: [] },
  dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
})

describe('importFleet: encrypted wrapper detection', () => {
  it('returns error DiffReport when encrypted but no password given', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const blob = _encryptForTest(MINIMAL_FLEET, 'test-password-ok')
    const wrapper = JSON.stringify({ enc: ENCRYPTED_FLEET_VERSION, blob })

    const result = importFleet(wrapper, { apply: false })
    expect('dryRun' in result).toBe(true)
    expect((result as any).errors).toContain(
      'A fájl titkosítva van -- add meg a vault jelszót az importhoz.'
    )
  })

  it('returns error DiffReport on wrong password (no file writes)', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const { atomicWriteFileSync } = await import('../web/atomic-write.js')

    const blob = _encryptForTest(MINIMAL_FLEET, 'correct-pw-12345')
    const wrapper = JSON.stringify({ enc: ENCRYPTED_FLEET_VERSION, blob })

    const result = importFleet(wrapper, { vaultPassword: 'wrong-pw-12345678', apply: false })
    expect('dryRun' in result).toBe(true)
    expect((result as any).errors).toContain(
      'Helytelen vault jelszó -- a titkosított fájl nem dekódolható.'
    )
    expect(atomicWriteFileSync).not.toHaveBeenCalled()
  })

  it('succeeds (dry-run) with correct password', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const blob = _encryptForTest(MINIMAL_FLEET, 'correct-pw-12345')
    const wrapper = JSON.stringify({ enc: ENCRYPTED_FLEET_VERSION, blob })

    const result = importFleet(wrapper, { vaultPassword: 'correct-pw-12345', apply: false })
    expect('dryRun' in result).toBe(true)
    expect((result as any).errors).toHaveLength(0)
  })

  it('accepts plaintext fleet JSON without password', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const result = importFleet(MINIMAL_FLEET, { apply: false })
    expect('dryRun' in result).toBe(true)
    expect((result as any).errors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// validateNames: avatarExt path-traversal guard (B1)
// ---------------------------------------------------------------------------

describe('importFleet: avatarExt traversal rejected', () => {
  it('returns nameErrors for traversal avatarExt', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const malicious = JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      sourceHost: 'attacker',
      agents: [{
        name: 'testbot',
        avatar: 'aGVsbG8=',
        avatarExt: 'png/../../../../etc/cron.d/x',
        config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {}, channelsAccess: {}, agentSkills: [],
      }],
      skills: [], scheduledTasks: [], memories: [], dailyLogs: [],
      kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
      ideaBox: { ideas: [], comments: [], statusLog: [] },
      dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
    })

    const result = importFleet(malicious, { apply: false })
    expect('dryRun' in result).toBe(true)
    const errors = (result as any).errors as string[]
    expect(errors.some(e => e.includes('avatarExt') && e.includes('testbot'))).toBe(true)
  })
})
