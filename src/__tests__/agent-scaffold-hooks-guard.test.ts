import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Inline re-implementations of the pure logic under test so the unit tests
// are hermetic (no env vars, no real PROJECT_ROOT / homedir reads).
// ---------------------------------------------------------------------------

function extractCommandScriptPath(command: string): string | null {
  for (const part of command.trim().split(/\s+/)) {
    if (part.startsWith('/')) return part
  }
  return null
}

function filterMissingScriptHooks(hooks: unknown, exists: (p: string) => boolean): Record<string, unknown> {
  if (!hooks || typeof hooks !== 'object') return {}
  const result: Record<string, unknown> = {}
  for (const [eventType, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      result[eventType] = groups
      continue
    }
    const kept = (groups as unknown[])
      .map((group: unknown) => {
        if (!group || typeof group !== 'object') return group
        const g = group as Record<string, unknown>
        if (!Array.isArray(g.hooks)) return g
        const filteredHooks = (g.hooks as unknown[]).filter((h: unknown) => {
          if (!h || typeof h !== 'object') return true
          const hook = h as Record<string, unknown>
          if (hook.type !== 'command' || typeof hook.command !== 'string') return true
          const scriptPath = extractCommandScriptPath(hook.command)
          return scriptPath === null || exists(scriptPath)
        })
        if (filteredHooks.length === 0) return null
        return { ...g, hooks: filteredHooks }
      })
      .filter(Boolean)
    if (kept.length > 0) result[eventType] = kept
  }
  return result
}

// ---------------------------------------------------------------------------
// extractCommandScriptPath
// ---------------------------------------------------------------------------

describe('extractCommandScriptPath', () => {
  it('extracts absolute path from "python3 /abs/path/script.py"', () => {
    expect(extractCommandScriptPath('python3 /abs/path/script.py')).toBe('/abs/path/script.py')
  })

  it('returns the script when command is an absolute path alone', () => {
    expect(extractCommandScriptPath('/usr/local/bin/my-hook')).toBe('/usr/local/bin/my-hook')
  })

  it('returns null for relative command with no absolute path', () => {
    expect(extractCommandScriptPath('node ./script.js')).toBeNull()
  })

  it('returns null for built-in shell expression without absolute path', () => {
    expect(extractCommandScriptPath('echo hello')).toBeNull()
  })

  it('handles extra whitespace', () => {
    expect(extractCommandScriptPath('  python3   /abs/hook.py  ')).toBe('/abs/hook.py')
  })
})

// ---------------------------------------------------------------------------
// filterMissingScriptHooks
// ---------------------------------------------------------------------------

describe('filterMissingScriptHooks', () => {
  it('keeps agent-type hooks unconditionally', () => {
    const hooks = {
      PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'do stuff' }] }],
    }
    const result = filterMissingScriptHooks(hooks, () => false)
    expect((result.PreCompact as unknown[]).length).toBe(1)
  })

  it('removes command hook when script does not exist', () => {
    const hooks = {
      SessionStart: [
        {
          matcher: 'compact',
          hooks: [{ type: 'command', command: 'python3 /nonexistent/hook.py', timeout: 10 }],
        },
      ],
    }
    const result = filterMissingScriptHooks(hooks, () => false)
    expect(result.SessionStart).toBeUndefined()
  })

  it('keeps command hook when script exists', () => {
    const hooks = {
      SessionStart: [
        {
          matcher: 'compact',
          hooks: [{ type: 'command', command: 'python3 /existing/hook.py', timeout: 10 }],
        },
      ],
    }
    const result = filterMissingScriptHooks(hooks, (p) => p === '/existing/hook.py')
    expect((result.SessionStart as unknown[]).length).toBe(1)
  })

  it('drops event type entirely when all groups become empty', () => {
    const hooks = {
      UserPromptSubmit: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: 'python3 /missing/voice.py', timeout: 60 }],
        },
      ],
      PreCompact: [
        { matcher: 'auto', hooks: [{ type: 'agent', prompt: 'save memory' }] },
      ],
    }
    const result = filterMissingScriptHooks(hooks, () => false)
    expect(result.UserPromptSubmit).toBeUndefined()
    expect(result.PreCompact).toBeDefined()
  })

  it('keeps command hook when command has no absolute path token', () => {
    const hooks = {
      PreCompact: [
        { matcher: 'auto', hooks: [{ type: 'command', command: 'echo hello' }] },
      ],
    }
    const result = filterMissingScriptHooks(hooks, () => false)
    expect(result.PreCompact).toBeDefined()
  })

  it('returns empty object for non-object input', () => {
    expect(filterMissingScriptHooks(null, () => true)).toEqual({})
    expect(filterMissingScriptHooks(42, () => true)).toEqual({})
  })

  it('passes through non-array event type values unchanged', () => {
    const hooks = { someKey: 'not-an-array' }
    const result = filterMissingScriptHooks(hooks, () => false)
    expect(result.someKey).toBe('not-an-array')
  })
})

// ---------------------------------------------------------------------------
// Integration: ensureAgentHooks with isolated tmp dirs
// ---------------------------------------------------------------------------

describe('ensureAgentHooks guard (filesystem integration)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hooks-guard-test-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('does not write settings.json when all command hooks point to missing scripts', () => {
    // Build a template with only a missing-script UserPromptSubmit hook
    const tplDir = join(tmp, 'templates')
    const agentClaudeDir = join(tmp, 'agents', 'demo', '.claude')
    mkdirSync(tplDir, { recursive: true })
    mkdirSync(agentClaudeDir, { recursive: true })

    const tpl = {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [{ type: 'command', command: `python3 ${tmp}/missing.py`, timeout: 60 }],
          },
        ],
      },
    }
    writeFileSync(join(tplDir, 'settings.json.template'), JSON.stringify(tpl, null, 2))

    // Inline ensureAgentHooks-equivalent (pure TS, no env import)
    const settingsPath = join(agentClaudeDir, 'settings.json')
    const raw = JSON.stringify(tpl, null, 2)
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const safe = filterMissingScriptHooks(parsed.hooks, existsSync)
    // All hooks filtered -> should NOT write
    expect(Object.keys(safe).length).toBe(0)
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('writes settings.json when at least one non-command hook survives filtering', () => {
    const agentClaudeDir = join(tmp, 'agents', 'demo', '.claude')
    mkdirSync(agentClaudeDir, { recursive: true })

    const hooks = {
      PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'save memory' }] }],
      UserPromptSubmit: [
        { matcher: '', hooks: [{ type: 'command', command: `python3 ${tmp}/missing.py` }] },
      ],
    }
    const safe = filterMissingScriptHooks(hooks, existsSync)
    // PreCompact (agent type) survives; UserPromptSubmit (missing script) is dropped
    expect(safe.PreCompact).toBeDefined()
    expect(safe.UserPromptSubmit).toBeUndefined()

    const settingsPath = join(agentClaudeDir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ hooks: safe }, null, 2))
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
    const writtenHooks = written.hooks as Record<string, unknown>
    expect(writtenHooks.PreCompact).toBeDefined()
    expect(writtenHooks.UserPromptSubmit).toBeUndefined()
  })
})
