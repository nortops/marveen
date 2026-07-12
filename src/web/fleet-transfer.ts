// Fleet export / import.
//
// Builds a single portable JSON snapshot of fleet content (agents, skills,
// scheduled tasks, DB tables, dashboard settings, optional vault) so it can
// be loaded into a freshly-installed, clean-git dashboard on another machine.
//
// Source code, build artefacts, OAuth tokens, and machine-specific paths are
// NOT included -- those come from a normal `npm ci && npm run build` install.

import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync,
} from 'node:fs'
import { join, basename } from 'node:path'
import { homedir, hostname } from 'node:os'
import { createHash, randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { AGENTS_BASE_DIR, listAgentNames, readFileOr } from './agent-config.js'
import { SCHEDULED_TASKS_DIR, listScheduledTasks, writeScheduledTask } from './scheduled-tasks-io.js'
import { getBindings } from './vault-bindings.js'
import { getDb } from '../db.js'
import { logger } from '../logger.js'

// ---------------------------------------------------------------------------
// Schema version -- bump when the JSON shape changes incompatibly.
// ---------------------------------------------------------------------------
export const FLEET_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FleetJson {
  schemaVersion: 1
  exportedAt: string
  sourceHost: string
  agents: AgentExport[]
  skills: SkillExport[]
  scheduledTasks: ScheduledTaskExport[]
  kanban: KanbanExport
  ideaBox: IdeaBoxExport
  dashboardSettings: DashboardSettingsExport
  vault?: VaultExport
}

export interface AgentExport {
  name: string
  config: Record<string, unknown>
  claudeMd: string
  soulMd: string
  mcp: Record<string, unknown>
  settings: Record<string, unknown>
  channelsAccess: Record<string, unknown>
  avatar: string | null  // base64 PNG
  agentSkills: SkillExport[]
  memories: MemoryRow[]
  dailyLogs: DailyLogRow[]
}

export interface SkillExport {
  name: string
  skillMd: string
}

export interface ScheduledTaskExport {
  dirName: string
  skillMd: string
  config: Record<string, unknown>
}

export interface KanbanExport {
  cards: Record<string, unknown>[]
  comments: Record<string, unknown>[]
  cardEvents: Record<string, unknown>[]
  labels: Record<string, unknown>[]
  cardLabels: Record<string, unknown>[]
}

export interface IdeaBoxExport {
  ideas: Record<string, unknown>[]
  comments: Record<string, unknown>[]
  statusLog: Record<string, unknown>[]
}

export interface DashboardSettingsExport {
  autonomy: Record<string, unknown>
  autoRestart: Record<string, unknown>
  agentsDesired: Record<string, unknown>
  norbertPersonal: Record<string, unknown>
}

export interface MemoryRow {
  agent_id: string
  content: string
  sector: string
  salience: number
  created_at: number
  accessed_at: number
  category: string
  auto_generated: number
  keywords: string | null
}

export interface DailyLogRow {
  agent_id: string
  date: string
  content: string
  created_at: number
}

export interface VaultExport {
  // The .vault-key (base64 string) re-encrypted with the user-supplied password.
  // Format: base64(scrypt-salt[32] || iv[16] || gcm-tag[16] || ciphertext)
  encryptedKey: string
  // Vault entries unchanged -- already AES-256-GCM encrypted with the vault-key.
  entries: Record<string, unknown>[]
  // vault-bindings.json verbatim.
  bindings: Record<string, unknown>[]
  // Channel .env files (bot tokens) encrypted with the same password+scrypt.
  channelEnvs: EncryptedChannelEnv[]
}

export interface EncryptedChannelEnv {
  provider: string
  encrypted: string  // base64(scrypt-salt[32] || iv[16] || gcm-tag[16] || ciphertext)
}

export interface DiffReport {
  dryRun: true
  wouldCreate: {
    agents: string[]
    globalSkills: number
    scheduledTasks: number
    memories: number
    kanbanCards: number
    kanbanComments: number
    labels: number
    dailyLogs: number
    ideaBox: number
  }
  warnings: string[]
  errors: string[]
}

export interface ImportResult {
  ok: true
  imported: {
    agents: string[]
    globalSkills: number
    scheduledTasks: number
    memories: number
    kanbanCards: number
    labels: number
    dailyLogs: number
    ideaBox: number
  }
}

// ---------------------------------------------------------------------------
// Crypto helpers (scrypt + AES-256-GCM, same algorithm as vault.ts)
// ---------------------------------------------------------------------------

const SCRYPT_SALT_LEN = 32
const AES_IV_LEN = 16
const AES_TAG_LEN = 16

function encryptWithPassword(plaintext: string, password: string): string {
  const salt = randomBytes(SCRYPT_SALT_LEN)
  const key = scryptSync(password, salt, 32)
  const iv = randomBytes(AES_IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([salt, iv, tag, enc]).toString('base64')
}

function decryptWithPassword(packed: string, password: string): string {
  const buf = Buffer.from(packed, 'base64')
  const salt = buf.subarray(0, SCRYPT_SALT_LEN)
  const iv = buf.subarray(SCRYPT_SALT_LEN, SCRYPT_SALT_LEN + AES_IV_LEN)
  const tag = buf.subarray(SCRYPT_SALT_LEN + AES_IV_LEN, SCRYPT_SALT_LEN + AES_IV_LEN + AES_TAG_LEN)
  const ciphertext = buf.subarray(SCRYPT_SALT_LEN + AES_IV_LEN + AES_TAG_LEN)
  const key = scryptSync(password, salt, 32)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext) + decipher.final('utf-8')
}

// ---------------------------------------------------------------------------
// Path normalization (export: absolute -> placeholders, import: reverse)
// ---------------------------------------------------------------------------

const PROJECT_ROOT_PLACEHOLDER = '{{PROJECT_ROOT}}'
const HOME_PLACEHOLDER = '{{HOME}}'

function normalizePaths(text: string): string {
  // Replace longer path first to avoid partial replacement (HOME is a prefix of PROJECT_ROOT on typical installs).
  return text
    .replaceAll(PROJECT_ROOT, PROJECT_ROOT_PLACEHOLDER)
    .replaceAll(homedir(), HOME_PLACEHOLDER)
}

function denormalizePaths(text: string): string {
  return text
    .replaceAll(PROJECT_ROOT_PLACEHOLDER, PROJECT_ROOT)
    .replaceAll(HOME_PLACEHOLDER, homedir())
}

// ---------------------------------------------------------------------------
// .mcp.json placeholder handling
// ---------------------------------------------------------------------------

// Build a lookup: mcpFilePath -> serverName -> envVar -> vaultSecretId
function buildBindingLookup(): Map<string, Map<string, Map<string, string>>> {
  const lookup = new Map<string, Map<string, Map<string, string>>>()
  for (const binding of getBindings()) {
    for (const target of binding.targets) {
      if (!lookup.has(target.mcpFilePath)) lookup.set(target.mcpFilePath, new Map())
      const byServer = lookup.get(target.mcpFilePath)!
      if (!byServer.has(target.serverName)) byServer.set(target.serverName, new Map())
      byServer.get(target.serverName)!.set(binding.envVar, binding.vaultSecretId)
    }
  }
  return lookup
}

// Replace literal env values with {{VAULT:<id>}} placeholders for export.
// vault:<id> references (already synced) are also normalized to {{VAULT:<id>}}
// so import always sees the same format.
function placeholderMcp(
  mcpObj: Record<string, unknown>,
  mcpFilePath: string,
  lookup: Map<string, Map<string, Map<string, string>>>,
): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(mcpObj)) as Record<string, unknown>
  const byServer = lookup.get(mcpFilePath)
  const servers = result.mcpServers as Record<string, Record<string, unknown>> | undefined
  if (!servers) return result
  for (const [serverName, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue
    const env = (cfg as Record<string, unknown>).env as Record<string, string> | undefined
    if (!env) continue
    const byEnv = byServer?.get(serverName)
    for (const [envVar, envVal] of Object.entries(env)) {
      if (typeof envVal !== 'string') continue
      if (envVal.startsWith('vault:')) {
        env[envVar] = `{{VAULT:${envVal.slice(6)}}}`
      } else if (byEnv?.has(envVar)) {
        env[envVar] = `{{VAULT:${byEnv.get(envVar)!}}}`
      }
      // Non-bound literals pass through without warning -- they may be non-secret
      // config values. The scanMcpConfigs() route already surfaces unbound secrets.
    }
  }
  return result
}

// Reverse: {{VAULT:<id>}} -> vault:<id> (vault-env-wrapper.sh resolves at runtime)
function deplaceholderMcp(mcpObj: Record<string, unknown>): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(mcpObj)) as Record<string, unknown>
  const servers = result.mcpServers as Record<string, Record<string, unknown>> | undefined
  if (!servers) return result
  for (const [, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== 'object') continue
    const env = (cfg as Record<string, unknown>).env as Record<string, string> | undefined
    if (!env) continue
    for (const [envVar, envVal] of Object.entries(env)) {
      if (typeof envVal === 'string' && envVal.startsWith('{{VAULT:') && envVal.endsWith('}}')) {
        env[envVar] = `vault:${envVal.slice(8, -2)}`
      }
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function safeReadJson(path: string): Record<string, unknown> {
  try { return JSON.parse(readFileSync(path, 'utf-8')) } catch { return {} }
}

function safeReadText(path: string): string {
  try { return readFileSync(path, 'utf-8') } catch { return '' }
}

function safeReadBase64(path: string): string | null {
  try { return readFileSync(path).toString('base64') } catch { return null }
}

function listSkillsInDir(dir: string): SkillExport[] {
  if (!existsSync(dir)) return []
  const skills: SkillExport[] = []
  for (const entry of readdirSync(dir)) {
    const skillMdPath = join(dir, entry, 'SKILL.md')
    if (existsSync(skillMdPath)) {
      skills.push({ name: entry, skillMd: safeReadText(skillMdPath) })
    }
  }
  return skills
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportAgent(
  name: string,
  bindingLookup: Map<string, Map<string, Map<string, string>>>,
  db: ReturnType<typeof getDb>,
): AgentExport {
  const dir = join(AGENTS_BASE_DIR, name)
  const claudeDir = join(dir, '.claude')

  const configPath = join(dir, 'agent-config.json')
  const mcpPath = join(dir, '.mcp.json')
  const settingsPath = join(claudeDir, 'settings.json')

  const rawMcp = safeReadJson(mcpPath)
  const mcpNormalized = placeholderMcp(rawMcp, mcpPath, bindingLookup)
  // Path-normalize the mcp JSON (vault-env-wrapper.sh path etc.)
  const mcpStr = normalizePaths(JSON.stringify(mcpNormalized))
  const mcp = JSON.parse(mcpStr) as Record<string, unknown>

  const settingsRaw = safeReadText(settingsPath)
  const settingsNormalized = settingsRaw ? JSON.parse(normalizePaths(settingsRaw)) : {}

  // channels/access.json per provider (not .env -- that's vault-gated)
  const channelsDir = join(claudeDir, 'channels')
  const channelsAccess: Record<string, unknown> = {}
  if (existsSync(channelsDir)) {
    for (const provider of readdirSync(channelsDir)) {
      const accessPath = join(channelsDir, provider, 'access.json')
      if (existsSync(accessPath)) {
        channelsAccess[provider] = safeReadJson(accessPath)
      }
    }
  }

  // avatar
  const avatar = safeReadBase64(join(dir, 'avatar.png'))
    ?? safeReadBase64(join(dir, 'avatar.jpg'))

  // agent-local skills
  const agentSkills = listSkillsInDir(join(claudeDir, 'skills'))

  // memories (no embedding column)
  const memories = db.prepare(
    `SELECT agent_id, content, sector, salience, created_at, accessed_at,
            category, auto_generated, keywords
     FROM memories WHERE agent_id = ? ORDER BY created_at ASC`
  ).all(name) as MemoryRow[]

  // daily logs
  const dailyLogs = db.prepare(
    'SELECT agent_id, date, content, created_at FROM daily_logs WHERE agent_id = ? ORDER BY date ASC'
  ).all(name) as DailyLogRow[]

  return {
    name,
    config: safeReadJson(configPath),
    claudeMd: safeReadText(join(dir, 'CLAUDE.md')),
    soulMd: safeReadText(join(dir, 'SOUL.md')),
    mcp,
    settings: settingsNormalized as Record<string, unknown>,
    channelsAccess,
    avatar,
    agentSkills,
    memories,
    dailyLogs,
  }
}

function exportScheduledTasks(): ScheduledTaskExport[] {
  if (!existsSync(SCHEDULED_TASKS_DIR)) return []
  const result: ScheduledTaskExport[] = []
  for (const dirName of readdirSync(SCHEDULED_TASKS_DIR)) {
    const dir = join(SCHEDULED_TASKS_DIR, dirName)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch { continue }
    const skillMd = safeReadText(join(dir, 'SKILL.md'))
    const configRaw = safeReadJson(join(dir, 'task-config.json'))
    // Force enabled=false on export so tasks don't fire on fresh import
    const config = { ...configRaw, enabled: false }
    result.push({ dirName, skillMd, config })
  }
  return result
}

function exportDashboardSettings(): DashboardSettingsExport {
  const read = (name: string) => safeReadJson(join(STORE_DIR, name))
  return {
    autonomy: read('autonomy-config.json'),
    autoRestart: read('auto-restart.json'),
    agentsDesired: read('agents-desired.json'),
    norbertPersonal: read('norbert-personal.json'),
  }
}

function exportVault(password: string): VaultExport | null {
  const vaultPath = join(STORE_DIR, 'vault.json')
  const vaultKeyPath = join(STORE_DIR, '.vault-key')
  const bindingsPath = join(STORE_DIR, 'vault-bindings.json')

  if (!existsSync(vaultKeyPath)) return null

  const vaultKeyBase64 = readFileSync(vaultKeyPath, 'utf-8').trim()
  const encryptedKey = encryptWithPassword(vaultKeyBase64, password)

  const vaultStore = safeReadJson(vaultPath)
  const entries = (vaultStore.entries as Record<string, unknown>[]) ?? []

  const bindingsStore = safeReadJson(bindingsPath)
  const bindings = (bindingsStore.bindings as Record<string, unknown>[]) ?? []

  // Channel .env files (bot tokens)
  const channelEnvs: EncryptedChannelEnv[] = []
  const channelsBase = join(homedir(), '.claude', 'channels')
  if (existsSync(channelsBase)) {
    for (const provider of readdirSync(channelsBase)) {
      const envPath = join(channelsBase, provider, '.env')
      if (existsSync(envPath)) {
        const envContent = readFileSync(envPath, 'utf-8')
        channelEnvs.push({ provider, encrypted: encryptWithPassword(envContent, password) })
      }
    }
  }

  return { encryptedKey, entries, bindings, channelEnvs }
}

export function exportFleet(options: { vaultPassword?: string } = {}): FleetJson {
  const db = getDb()
  const bindingLookup = buildBindingLookup()

  const agents = listAgentNames().map(name => exportAgent(name, bindingLookup, db))

  const globalSkillsDir = join(homedir(), '.claude', 'skills')
  const skills = listSkillsInDir(globalSkillsDir)

  const scheduledTasks = exportScheduledTasks()

  // DB export
  const kanban: KanbanExport = {
    cards: db.prepare('SELECT * FROM kanban_cards').all() as Record<string, unknown>[],
    comments: db.prepare('SELECT * FROM kanban_comments').all() as Record<string, unknown>[],
    cardEvents: db.prepare('SELECT * FROM kanban_card_events').all() as Record<string, unknown>[],
    labels: db.prepare('SELECT * FROM labels').all() as Record<string, unknown>[],
    cardLabels: db.prepare('SELECT * FROM kanban_card_labels').all() as Record<string, unknown>[],
  }

  const ideaBox: IdeaBoxExport = {
    ideas: db.prepare('SELECT * FROM idea_box').all() as Record<string, unknown>[],
    comments: db.prepare('SELECT * FROM idea_comments').all() as Record<string, unknown>[],
    statusLog: db.prepare('SELECT * FROM idea_status_log').all() as Record<string, unknown>[],
  }

  const dashboardSettings = exportDashboardSettings()

  const vault = options.vaultPassword ? exportVault(options.vaultPassword) : undefined

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sourceHost: hostname(),
    agents,
    skills,
    scheduledTasks,
    kanban,
    ideaBox,
    dashboardSettings,
    ...(vault ? { vault } : {}),
  }
}

// ---------------------------------------------------------------------------
// Import -- dry-run (validate + diff) and apply
// ---------------------------------------------------------------------------

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function validateSchema(fleet: unknown): string[] {
  const errors: string[] = []
  if (!fleet || typeof fleet !== 'object') {
    errors.push('Érvénytelen JSON: a gyökér nem objektum.')
    return errors
  }
  const f = fleet as Record<string, unknown>
  if (f.schemaVersion === undefined || f.schemaVersion === null) {
    errors.push('schemaVersion hiányzik -- az export nem kompatibilis vagy pre-v1 build hozta létre.')
    return errors
  }
  if (f.schemaVersion !== FLEET_SCHEMA_VERSION) {
    errors.push(
      `Az export schema v${f.schemaVersion}, a telepített dashboard v${FLEET_SCHEMA_VERSION}-t támogat. ` +
      (Number(f.schemaVersion) > FLEET_SCHEMA_VERSION
        ? 'Frissítsd a dashboardot az import előtt.'
        : 'Az export túl régi.')
    )
    return errors
  }
  if (!Array.isArray(f.agents)) errors.push('agents mező hiányzik vagy nem tömb.')
  return errors
}

function buildDiffReport(fleet: FleetJson): DiffReport {
  const db = getDb()
  const warnings: string[] = []

  // Count what would be created
  const existingAgents = new Set(listAgentNames())
  const newAgents = (fleet.agents ?? []).map(a => a.name).filter(n => !existingAgents.has(n))

  // memories -- count non-duplicate rows (full content equality check)
  let newMemories = 0
  for (const agent of fleet.agents ?? []) {
    for (const mem of agent.memories ?? []) {
      const exists = db.prepare(
        'SELECT 1 FROM memories WHERE agent_id = ? AND content = ?'
      ).get(mem.agent_id, mem.content)
      if (!exists) newMemories++
    }
  }

  // kanban cards
  let newCards = 0
  for (const card of fleet.kanban?.cards ?? []) {
    const exists = db.prepare('SELECT 1 FROM kanban_cards WHERE id = ?').get((card as any).id)
    if (!exists) newCards++
  }

  // labels
  let newLabels = 0
  for (const label of fleet.kanban?.labels ?? []) {
    const exists = db.prepare('SELECT 1 FROM labels WHERE id = ?').get((label as any).id)
    if (!exists) newLabels++
  }

  // daily logs (rough count)
  let newDailyLogs = 0
  for (const agent of fleet.agents ?? []) {
    for (const log of agent.dailyLogs ?? []) {
      const exists = db.prepare(
        'SELECT 1 FROM daily_logs WHERE agent_id = ? AND date = ?'
      ).get(log.agent_id, log.date)
      if (!exists) newDailyLogs++
    }
  }

  if (!fleet.vault) {
    warnings.push('vault szekció hiányzik -- az MCP szerverek token nélkül indulnak el, manuális re-auth szükséges.')
  }

  return {
    dryRun: true,
    wouldCreate: {
      agents: newAgents,
      globalSkills: (fleet.skills ?? []).length,
      scheduledTasks: (fleet.scheduledTasks ?? []).length,
      memories: newMemories,
      kanbanCards: newCards,
      kanbanComments: (fleet.kanban?.comments ?? []).length,
      labels: newLabels,
      dailyLogs: newDailyLogs,
      ideaBox: (fleet.ideaBox?.ideas ?? []).length,
    },
    warnings,
    errors: [],
  }
}

function writeAgentFiles(
  agent: AgentExport,
  globalSkillsDir: string,
): void {
  const dir = join(AGENTS_BASE_DIR, agent.name)
  const claudeDir = join(dir, '.claude')
  mkdirSync(claudeDir, { recursive: true })

  atomicWriteFileSync(join(dir, 'agent-config.json'), JSON.stringify(agent.config, null, 2))
  if (agent.claudeMd) atomicWriteFileSync(join(dir, 'CLAUDE.md'), agent.claudeMd)
  if (agent.soulMd) atomicWriteFileSync(join(dir, 'SOUL.md'), agent.soulMd)

  // .mcp.json -- de-placeholder vault refs, then path-denormalize
  const mcpDeplaceholdered = deplaceholderMcp(agent.mcp)
  const mcpStr = denormalizePaths(JSON.stringify(mcpDeplaceholdered, null, 2))
  atomicWriteFileSync(join(dir, '.mcp.json'), mcpStr)

  // settings.json -- path-denormalize hooks
  const settingsStr = denormalizePaths(JSON.stringify(agent.settings, null, 2))
  mkdirSync(join(claudeDir), { recursive: true })
  atomicWriteFileSync(join(claudeDir, 'settings.json'), settingsStr)

  // channels/access.json per provider
  for (const [provider, access] of Object.entries(agent.channelsAccess ?? {})) {
    const provDir = join(claudeDir, 'channels', provider)
    mkdirSync(provDir, { recursive: true })
    atomicWriteFileSync(join(provDir, 'access.json'), JSON.stringify(access, null, 2))
  }

  // avatar
  if (agent.avatar) {
    const avatarBuf = Buffer.from(agent.avatar, 'base64')
    atomicWriteFileSync(join(dir, 'avatar.png'), avatarBuf as unknown as string)
  }

  // agent-local skills
  for (const skill of agent.agentSkills ?? []) {
    const skillDir = join(claudeDir, 'skills', skill.name)
    mkdirSync(skillDir, { recursive: true })
    atomicWriteFileSync(join(skillDir, 'SKILL.md'), skill.skillMd)
  }
}

function importVault(vault: VaultExport, password: string): void {
  // Decrypt and restore .vault-key
  const vaultKeyBase64 = decryptWithPassword(vault.encryptedKey, password)
  atomicWriteFileSync(join(STORE_DIR, '.vault-key'), vaultKeyBase64, { mode: 0o600 })

  // vault.json entries (already encrypted with vault-key)
  atomicWriteFileSync(
    join(STORE_DIR, 'vault.json'),
    JSON.stringify({ entries: vault.entries }, null, 2),
    { mode: 0o600 },
  )

  // vault-bindings.json
  atomicWriteFileSync(
    join(STORE_DIR, 'vault-bindings.json'),
    JSON.stringify({ bindings: vault.bindings }, null, 2),
  )

  // Channel .env files (bot tokens)
  const channelsBase = join(homedir(), '.claude', 'channels')
  for (const { provider, encrypted } of vault.channelEnvs ?? []) {
    const envContent = decryptWithPassword(encrypted, password)
    const provDir = join(channelsBase, provider)
    mkdirSync(provDir, { recursive: true })
    atomicWriteFileSync(join(provDir, '.env'), envContent, { mode: 0o600 })
  }
}

export function importFleet(
  fleet: FleetJson,
  options: { vaultPassword?: string; apply: boolean },
): DiffReport | ImportResult {
  const validationErrors = validateSchema(fleet)
  if (validationErrors.length > 0) {
    const report: DiffReport = {
      dryRun: true,
      wouldCreate: { agents: [], globalSkills: 0, scheduledTasks: 0, memories: 0, kanbanCards: 0, kanbanComments: 0, labels: 0, dailyLogs: 0, ideaBox: 0 },
      warnings: [],
      errors: validationErrors,
    }
    return report
  }

  if (!options.apply) {
    return buildDiffReport(fleet)
  }

  // -------------------------------------------------------------------------
  // Apply phase
  // -------------------------------------------------------------------------
  const db = getDb()
  const globalSkillsDir = join(homedir(), '.claude', 'skills')
  const createdAgentDirs: string[] = []

  try {
    // 1. Write agent files
    for (const agent of fleet.agents ?? []) {
      const dir = join(AGENTS_BASE_DIR, agent.name)
      const isNew = !existsSync(dir)
      writeAgentFiles(agent, globalSkillsDir)
      if (isNew) createdAgentDirs.push(dir)
    }

    // 2. Global skills
    let globalSkillCount = 0
    for (const skill of fleet.skills ?? []) {
      const skillDir = join(globalSkillsDir, skill.name)
      mkdirSync(skillDir, { recursive: true })
      atomicWriteFileSync(join(skillDir, 'SKILL.md'), skill.skillMd)
      globalSkillCount++
    }

    // 3. Scheduled tasks (all paused -- enabled=false already set at export time)
    for (const task of fleet.scheduledTasks ?? []) {
      const dir = join(SCHEDULED_TASKS_DIR, task.dirName)
      mkdirSync(dir, { recursive: true })
      if (task.skillMd) atomicWriteFileSync(join(dir, 'SKILL.md'), task.skillMd)
      atomicWriteFileSync(join(dir, 'task-config.json'), JSON.stringify({ ...task.config, enabled: false }, null, 2))
    }

    // 4. Dashboard settings
    const s = fleet.dashboardSettings ?? {}
    if (s.autonomy && Object.keys(s.autonomy).length)
      atomicWriteFileSync(join(STORE_DIR, 'autonomy-config.json'), JSON.stringify(s.autonomy, null, 2))
    if (s.autoRestart && Object.keys(s.autoRestart).length)
      atomicWriteFileSync(join(STORE_DIR, 'auto-restart.json'), JSON.stringify(s.autoRestart, null, 2))
    if (s.agentsDesired && Object.keys(s.agentsDesired).length)
      atomicWriteFileSync(join(STORE_DIR, 'agents-desired.json'), JSON.stringify(s.agentsDesired, null, 2))
    if (s.norbertPersonal && Object.keys(s.norbertPersonal).length)
      atomicWriteFileSync(join(STORE_DIR, 'norbert-personal.json'), JSON.stringify(s.norbertPersonal, null, 2))

    // 5. Vault (optional)
    if (fleet.vault && options.vaultPassword) {
      importVault(fleet.vault, options.vaultPassword)
    }

    // 6. DB -- single transaction for all-or-nothing
    const importTx = db.transaction(() => {
      // labels first (kanban_card_labels FK)
      for (const label of fleet.kanban?.labels ?? []) {
        db.prepare(
          'INSERT OR IGNORE INTO labels (id, name, color, created_at) VALUES (?, ?, ?, ?)'
        ).run((label as any).id, (label as any).name, (label as any).color, (label as any).created_at)
      }

      // kanban cards
      for (const card of fleet.kanban?.cards ?? []) {
        const c = card as any
        db.prepare(
          `INSERT OR IGNORE INTO kanban_cards
           (id, title, description, status, assignee, priority, project,
            due_date, sort_order, created_at, updated_at, archived_at, parent_id, dispatched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(c.id, c.title, c.description ?? null, c.status, c.assignee ?? null,
          c.priority, c.project ?? null, c.due_date ?? null, c.sort_order,
          c.created_at, c.updated_at, c.archived_at ?? null, c.parent_id ?? null, c.dispatched_at ?? null)
      }

      // kanban comments (idempotent: skip if card_id + content already present)
      for (const comment of fleet.kanban?.comments ?? []) {
        const c = comment as any
        const exists = db.prepare(
          'SELECT 1 FROM kanban_comments WHERE card_id = ? AND content = ?'
        ).get(c.card_id, c.content)
        if (!exists) {
          db.prepare(
            'INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, ?, ?, ?)'
          ).run(c.card_id, c.author, c.content, c.created_at)
        }
      }

      // kanban card events (INTEGER PK autoincrement -- no idempotency key, insert all)
      for (const ev of fleet.kanban?.cardEvents ?? []) {
        const e = ev as any
        db.prepare(
          `INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(e.card_id, e.from_status ?? null, e.to_status, e.actor, e.created_at)
      }

      // kanban card labels
      for (const cl of fleet.kanban?.cardLabels ?? []) {
        const c = cl as any
        db.prepare(
          'INSERT OR IGNORE INTO kanban_card_labels (card_id, label_id, created_at) VALUES (?, ?, ?)'
        ).run(c.card_id, c.label_id, c.created_at)
      }

      // memories (idempotent: agent_id + content)
      const now = Math.floor(Date.now() / 1000)
      for (const agent of fleet.agents ?? []) {
        for (const mem of agent.memories ?? []) {
          const exists = db.prepare(
            'SELECT 1 FROM memories WHERE agent_id = ? AND content = ?'
          ).get(mem.agent_id, mem.content)
          if (!exists) {
            db.prepare(
              `INSERT INTO memories
               (chat_id, topic_key, content, sector, salience, created_at, accessed_at,
                agent_id, category, auto_generated, keywords)
               VALUES ('', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(mem.content, mem.sector, mem.salience, mem.created_at, mem.accessed_at ?? now,
              mem.agent_id, mem.category, mem.auto_generated ?? 0, mem.keywords ?? null)
          }
        }
      }

      // daily logs (idempotent: agent_id + date)
      let logCount = 0
      for (const agent of fleet.agents ?? []) {
        for (const log of agent.dailyLogs ?? []) {
          const exists = db.prepare(
            'SELECT 1 FROM daily_logs WHERE agent_id = ? AND date = ?'
          ).get(log.agent_id, log.date)
          if (!exists) {
            db.prepare(
              'INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)'
            ).run(log.agent_id, log.date, log.content, log.created_at)
            logCount++
          }
        }
      }

      // idea_box
      for (const idea of fleet.ideaBox?.ideas ?? []) {
        const i = idea as any
        db.prepare(
          `INSERT OR IGNORE INTO idea_box
           (id, title, description, category, status, source, kanban_id, impact, effort, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(i.id, i.title, i.description ?? null, i.category, i.status, i.source ?? '',
          i.kanban_id ?? null, i.impact ?? null, i.effort ?? null, i.created_at, i.updated_at)
      }

      for (const comment of fleet.ideaBox?.comments ?? []) {
        const c = comment as any
        db.prepare(
          'INSERT OR IGNORE INTO idea_comments (idea_id, author, content, created_at) VALUES (?, ?, ?, ?)'
        ).run(c.idea_id, c.author, c.content, c.created_at)
      }

      for (const log of fleet.ideaBox?.statusLog ?? []) {
        const l = log as any
        db.prepare(
          `INSERT OR IGNORE INTO idea_status_log
           (idea_id, from_status, to_status, actor, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(l.idea_id, l.from_status ?? null, l.to_status, l.actor, l.note ?? null, l.created_at)
      }

      // FTS rebuild after all memory inserts
      db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')").run()
    })

    importTx()

    logger.info({ agents: (fleet.agents ?? []).map(a => a.name) }, 'Fleet import completed')

    return {
      ok: true,
      imported: {
        agents: (fleet.agents ?? []).map(a => a.name),
        globalSkills: globalSkillCount,
        scheduledTasks: (fleet.scheduledTasks ?? []).length,
        memories: (fleet.agents ?? []).reduce((s, a) => s + (a.memories?.length ?? 0), 0),
        kanbanCards: (fleet.kanban?.cards ?? []).length,
        labels: (fleet.kanban?.labels ?? []).length,
        dailyLogs: (fleet.agents ?? []).reduce((s, a) => s + (a.dailyLogs?.length ?? 0), 0),
        ideaBox: (fleet.ideaBox?.ideas ?? []).length,
      },
    }
  } catch (err: any) {
    // Partial cleanup: remove agent directories that were freshly created
    for (const dir of createdAgentDirs) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
    logger.error({ err: err.message }, 'Fleet import failed, partial state cleaned up')
    throw err
  }
}
