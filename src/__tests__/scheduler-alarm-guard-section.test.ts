// Functional test for ensureSchedulerAlarmGuardSection() -- mirrors
// skills-path-trap-section.test.ts. Injected on every respawn so Hestia
// (and any other sub-agent that might speculate about scheduler loops)
// always carries the "verify before alerting" rule even after an in-place
// CLAUDE.md edit that removes it manually.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-schedalarm-test-'))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  agentConfigRoot: () => join(tmpRoot, 'agents'),
  listAgentNames: () => ['agent-a', 'agent-b'],
  readAgentCapabilities: () => [],
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureSchedulerAlarmGuardSection } = await import('../web/agent-scaffold.js')

const MARKER_BEGIN = '<!-- BEGIN GENERATED: scheduler-alarm-guard (auto-generated, do not edit by hand) -->'
const MARKER_END = '<!-- END GENERATED: scheduler-alarm-guard -->'

function setup(agentName: string, content: string) {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}

function read(agentName: string): string {
  return readFileSync(join(tmpRoot, 'agents', agentName, 'CLAUDE.md'), 'utf-8')
}

describe('ensureSchedulerAlarmGuardSection', () => {
  it('appends the guard block to a CLAUDE.md that lacks it', () => {
    setup('agent-b', '# Agent B\n\nMonitoring persona.\n')
    ensureSchedulerAlarmGuardSection('agent-b')
    const out = read('agent-b')
    expect(out).toContain(MARKER_BEGIN)
    expect(out).toContain(MARKER_END)
    expect(out).toContain('verify-scheduler-loop-alarm')
    expect(out).toContain('MILLISZEKUNDUMBAN')
    expect(out).toContain('Spekulatív riasztás tilos')
    // Existing content untouched.
    expect(out).toContain('Monitoring persona.')
  })

  it('is idempotent: a second call changes nothing', () => {
    setup('agent-b', '# Agent B\n')
    ensureSchedulerAlarmGuardSection('agent-b')
    const first = read('agent-b')
    ensureSchedulerAlarmGuardSection('agent-b')
    expect(read('agent-b')).toBe(first)
    // Exactly one block, not stacked.
    expect(first.split(MARKER_BEGIN).length - 1).toBe(1)
  })

  it('replaces ONLY the marked block, preserving hand-written text around it', () => {
    setup('agent-b', `# Agent B\n\n${MARKER_BEGIN}\nSTALE CONTENT\n${MARKER_END}\n\nKézzel írt lábjegyzet.\n`)
    ensureSchedulerAlarmGuardSection('agent-b')
    const out = read('agent-b')
    expect(out).not.toContain('STALE CONTENT')
    expect(out).toContain('Kézzel írt lábjegyzet.')
    expect(out).toContain('verify-scheduler-loop-alarm')
  })

  it('skips silently when there is no CLAUDE.md', () => {
    expect(() => ensureSchedulerAlarmGuardSection('agent-nonexistent')).not.toThrow()
  })

  it('skips the main agent (sub-agents only)', () => {
    // The main agent's CLAUDE.md lives at PROJECT_ROOT directly; ensure*
    // for sub-agents writes to agents/<name>/CLAUDE.md.  The guard must
    // NOT touch the main agent's file because the main agent's CLAUDE.md
    // is maintained separately.
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main Agent\n', 'utf-8')
    ensureSchedulerAlarmGuardSection('agent-a')
    const mainContent = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')
    expect(mainContent).not.toContain(MARKER_BEGIN)
  })
})

describe('wiring contracts', () => {
  it('startAgentProcess calls ensureSchedulerAlarmGuardSection on every respawn', () => {
    const src = readFileSync(join(__dirname, '../../src/web/agent-process.ts'), 'utf-8')
    const trap = src.indexOf('ensureSkillsPathTrapSection(name)')
    const guard = src.indexOf('ensureSchedulerAlarmGuardSection(name)')
    expect(guard).toBeGreaterThan(0)
    // guard follows trap in the ensure chain
    expect(guard).toBeGreaterThan(trap)
  })

  it('ensureSchedulerAlarmGuardSection is exported from agent-scaffold', () => {
    const src = readFileSync(join(__dirname, '../../src/web/agent-scaffold.ts'), 'utf-8')
    expect(src).toContain('export function ensureSchedulerAlarmGuardSection(')
  })
})
