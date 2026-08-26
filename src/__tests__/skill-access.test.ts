// Unit tests for readSkillAccessConfig() exported from src/web/routes/skills.ts.
// Tests cover: missing file, malformed JSON, non-array values, valid config,
// and the MAIN_AGENT_ID fail-safe.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Point STORE_DIR at a temp directory so the helper reads our fixture files.
const tmpRoot = join(tmpdir(), 'skill-access-test')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, STORE_DIR: tmpRoot }
})

// Stub readFileSync so tests control what the helper sees.
// Override readFileSync globally; each test restores and re-mocks as needed.
let _mockFsContent: string | null = null
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (p: unknown, opts?: unknown): string => {
      if (_mockFsContent !== null) return _mockFsContent
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  }
})

import { readSkillAccessConfig } from '../web/routes/skills.js'
import { MAIN_AGENT_ID } from '../config.js'

describe('readSkillAccessConfig', () => {
  beforeEach(() => {
    _mockFsContent = null
  })

  it('returns an empty object when the file is missing', () => {
    _mockFsContent = null // readFileSync throws
    const result = readSkillAccessConfig()
    expect(result).toEqual({})
  })

  it('returns an empty object for malformed JSON', () => {
    _mockFsContent = 'not json{{'
    const result = readSkillAccessConfig()
    expect(result).toEqual({})
  })

  it('returns an empty object for a non-object root value (array)', () => {
    _mockFsContent = '[]'
    const result = readSkillAccessConfig()
    expect(result).toEqual({})
  })

  it('builds the correct Record for a valid config', () => {
    _mockFsContent = JSON.stringify({ alpha: ['atlas', 'daidalosz'], beta: ['talosz'] })
    const result = readSkillAccessConfig()
    expect(result['alpha']).toContain('atlas')
    expect(result['alpha']).toContain('daidalosz')
    expect(result['beta']).toContain('talosz')
  })

  it('always includes MAIN_AGENT_ID in restricted lists (fail-safe)', () => {
    _mockFsContent = JSON.stringify({ 'secret-skill': ['talosz'] })
    const result = readSkillAccessConfig()
    expect(result['secret-skill']).toContain(MAIN_AGENT_ID)
  })

  it('skips entries with non-array values', () => {
    _mockFsContent = JSON.stringify({ good: ['atlas'], bad_string: 'oops', bad_number: 42 })
    const result = readSkillAccessConfig()
    expect('bad_string' in result).toBe(false)
    expect('bad_number' in result).toBe(false)
    expect(result['good']).toContain(MAIN_AGENT_ID)
  })
})
