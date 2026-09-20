// Unit tests for readSkillAccessConfig() exported from src/web/routes/skills.ts,
// and for the gate-logic exports from scripts/hooks/skill-access-gate.mjs.
//
// STORE_DIR is never reached because readFileSync is stubbed; no config mock needed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

let _mockFsContent: string | null = null

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (): string => {
      if (_mockFsContent !== null) return _mockFsContent
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  }
})

import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, existsSync, unlinkSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSkillAccessConfig } from '../web/routes/skills.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
// @ts-expect-error -- plain .mjs hook script, no types
import { deriveAgentIdFromCwd, gateDecision } from '../../scripts/hooks/skill-access-gate.mjs'

describe('readSkillAccessConfig', () => {
  beforeEach(() => {
    _mockFsContent = null
  })

  it('returns an empty Record when the file is missing', () => {
    const result = readSkillAccessConfig()
    expect(result).toEqual({})
  })

  it('returns an empty Record for malformed JSON', () => {
    _mockFsContent = 'not json{{'
    const result = readSkillAccessConfig()
    expect(result).toEqual({})
  })

  it('returns an empty Record for a non-object root value (array)', () => {
    _mockFsContent = '[]'
    const result = readSkillAccessConfig()
    expect(result).toEqual({})
  })

  it('builds the correct Record for a valid config', () => {
    _mockFsContent = JSON.stringify({ alpha: ['agent-a', 'agent-b'], beta: ['agent-c'] })
    const result = readSkillAccessConfig()
    expect(result['alpha']).toContain('agent-a')
    expect(result['alpha']).toContain('agent-b')
    expect(result['beta']).toContain('agent-c')
  })

  it('always includes MAIN_AGENT_ID in restricted lists (fail-safe)', () => {
    _mockFsContent = JSON.stringify({ 'secret-skill': ['agent-a'] })
    const result = readSkillAccessConfig()
    expect(result['secret-skill']).toContain(MAIN_AGENT_ID)
  })

  it('skips entries with non-array values', () => {
    _mockFsContent = JSON.stringify({ good: ['agent-a'], bad_string: 'oops', bad_number: 42 })
    const result = readSkillAccessConfig()
    expect('bad_string' in result).toBe(false)
    expect('bad_number' in result).toBe(false)
    expect(result['good']).toContain(MAIN_AGENT_ID)
  })
})

// --- gate-script exports: agent identity derivation (FIX 1: nested cwd) ---

describe('deriveAgentIdFromCwd', () => {
  it('identifies a sub-agent from a direct agents/<name> path', () => {
    expect(deriveAgentIdFromCwd('/home/user/marveen/agents/agent-a')).toBe('agent-a')
    expect(deriveAgentIdFromCwd('/home/user/marveen/agents/agent-a/')).toBe('agent-a')
  })

  it('identifies a sub-agent from a nested path inside agents/<name> (FIX 1: no end-anchor bypass)', () => {
    expect(deriveAgentIdFromCwd('/home/user/marveen/agents/agent-a/workspace')).toBe('agent-a')
    expect(deriveAgentIdFromCwd('/home/user/marveen/agents/agent-a/workspace/some-project')).toBe('agent-a')
    expect(deriveAgentIdFromCwd('/home/user/marveen/agents/agent-b/.claude/worktree-abc')).toBe('agent-b')
  })

  it('returns null for the repo root (main agent)', () => {
    expect(deriveAgentIdFromCwd('/home/user/marveen')).toBeNull()
    expect(deriveAgentIdFromCwd('/home/user/marveen/')).toBeNull()
  })

  it('returns null for paths that happen to contain "agents" as a directory prefix in an unrelated segment', () => {
    // A path like /home/agents-backup/marveen must not match
    expect(deriveAgentIdFromCwd('/home/user/projects/marveen')).toBeNull()
  })
})

// --- gate-script exports: access decision (known-positive control) ---

describe('gateDecision', () => {
  it('allows non-Skill tool calls unconditionally', () => {
    expect(gateDecision('Bash', { command: 'ls' }, 'agent-a', {})).toEqual({ allow: true })
    expect(gateDecision('WebFetch', { url: 'https://x.com' }, 'agent-a', { 'web-skill': ['main-agent'] })).toEqual({ allow: true })
  })

  it('allows a main agent (agentId null) regardless of config', () => {
    const config = { 'secret-skill': ['agent-a'] }
    expect(gateDecision('Skill', { skill: 'secret-skill' }, null, config)).toEqual({ allow: true })
  })

  it('allows a skill that is not in the config', () => {
    expect(gateDecision('Skill', { skill: 'unknown-skill' }, 'agent-b', {})).toEqual({ allow: true })
  })

  it('allows a listed agent to call a restricted skill', () => {
    const config = { 'restricted-skill': ['agent-a', 'main-agent'] }
    expect(gateDecision('Skill', { skill: 'restricted-skill' }, 'agent-a', config)).toEqual({ allow: true })
  })

  it('DENIES an unlisted agent calling a restricted skill (known-positive control)', () => {
    const config = { 'restricted-skill': ['main-agent'] }
    const result = gateDecision('Skill', { skill: 'restricted-skill' }, 'agent-b', config)
    expect(result.deny).toBe(true)
    expect(result.reason).toContain('"restricted-skill"')
    expect(result.reason).toContain('"agent-b"')
  })

  it('DENIES any sub-agent when config is null (corrupt config fail-closed, FIX 2)', () => {
    const result = gateDecision('Skill', { skill: 'any-skill' }, 'agent-a', null)
    expect(result.deny).toBe(true)
    expect(result.reason).toContain('corrupt or unreadable')
  })

  it('fails open for a malformed (non-array) allow-list entry', () => {
    const config = { 'bad-entry': 'not-an-array' }
    expect(gateDecision('Skill', { skill: 'bad-entry' }, 'agent-b', config)).toEqual({ allow: true })
  })

  it('handles a missing skill name as allow', () => {
    expect(gateDecision('Skill', {}, 'agent-b', { '': ['main-agent'] })).toEqual({ allow: true })
    expect(gateDecision('Skill', null, 'agent-b', {})).toEqual({ allow: true })
  })
})

// End-to-end: the hook script as Claude Code actually invokes it (Szotasz
// upstream review on #1368, point 5a). Everything above tests the exported
// gate-logic functions in isolation; this runs the real script file with a
// real stdin payload and a real cwd, so a wiring mistake between them (wrong
// stdin field name, wrong stdout shape, wrong exit path) would fail here even
// if every unit test above stayed green.
describe('skill-access-gate.mjs end-to-end (real process, real stdin, real cwd)', () => {
  const agentDir = join(PROJECT_ROOT, 'agents', 'e2e-skill-gate-test-agent')
  const configPath = join(PROJECT_ROOT, 'store', 'skill-access.json')
  const backupPath = `${configPath}.e2e-test-backup`
  const restrictedSkill = '__e2e_test_restricted_skill__'
  let hadConfig = false

  beforeEach(() => {
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
    hadConfig = existsSync(configPath)
    // copyFileSync, not readFileSync: this suite's top-level vi.mock('node:fs')
    // stubs readFileSync globally (for the readSkillAccessConfig tests above),
    // so reading the real file back for restore must go through a call the
    // mock leaves untouched.
    if (hadConfig) copyFileSync(configPath, backupPath)
    writeFileSync(configPath, JSON.stringify({ [restrictedSkill]: [MAIN_AGENT_ID] }))
  })

  afterEach(() => {
    if (hadConfig) { copyFileSync(backupPath, configPath); unlinkSync(backupPath) }
    else unlinkSync(configPath)
    rmSync(agentDir, { recursive: true, force: true })
  })

  it('DENIES with a permissionDecision JSON on stdout for a restricted skill called from a non-listed cwd-derived agent', () => {
    const payload = JSON.stringify({ tool_name: 'Skill', tool_input: { skill: restrictedSkill } })
    const result = spawnSync(process.execPath, [join(PROJECT_ROOT, 'scripts', 'hooks', 'skill-access-gate.mjs')], {
      cwd: agentDir,
      input: payload,
      encoding: 'utf-8',
    })

    expect(result.status).toBe(0) // deny is communicated via stdout JSON, not the exit code
    const out = JSON.parse(result.stdout)
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(restrictedSkill)
  })
})
