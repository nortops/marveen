import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..', '..')
const testEnvPath = join(PROJECT_ROOT, '.env')

let hadExistingEnv = false
let existingContent = ''

beforeEach(() => {
  if (existsSync(testEnvPath)) {
    hadExistingEnv = true
    existingContent = require('fs').readFileSync(testEnvPath, 'utf-8')
  }
})

afterEach(() => {
  if (hadExistingEnv) {
    writeFileSync(testEnvPath, existingContent)
  } else {
    try { unlinkSync(testEnvPath) } catch {}
  }
})

describe('readEnvFile', () => {
  it('ures objektumot ad vissza ha nincs .env', async () => {
    try { unlinkSync(testEnvPath) } catch {}
    // Friss import
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result).toEqual({})
  })

  it('kulcs-ertek parokat parszol', async () => {
    writeFileSync(testEnvPath, 'FOO=bar\nBAZ=qux\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result['FOO']).toBe('bar')
    expect(result['BAZ']).toBe('qux')
  })

  it('idezojeleket kezel', async () => {
    writeFileSync(testEnvPath, 'KEY="value with spaces"\nKEY2=\'single\'\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result['KEY']).toBe('value with spaces')
    expect(result['KEY2']).toBe('single')
  })

  it('kommenteket atugorja', async () => {
    writeFileSync(testEnvPath, '# komment\nKEY=val\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile()
    expect(result['KEY']).toBe('val')
    expect(Object.keys(result)).toHaveLength(1)
  })

  it('szurt kulcsokat ad vissza ha megadva', async () => {
    writeFileSync(testEnvPath, 'A=1\nB=2\nC=3\n')
    const { readEnvFile } = await import('../env.js')
    const result = readEnvFile(['A', 'C'])
    expect(result['A']).toBe('1')
    expect(result['C']).toBe('3')
    expect(result['B']).toBeUndefined()
  })
})

describe('updateEnvFile', () => {
  it('meglevo kulcsot lecserel, a tobbi sort es kommentet megorzi', async () => {
    writeFileSync(testEnvPath, '# fej\nMAIN_AGENT_ID=marveen\nOTHER=keep\n')
    const { updateEnvFile } = await import('../env.js')
    updateEnvFile({ MAIN_AGENT_ID: 'atlas' })
    const out = readFileSync(testEnvPath, 'utf-8')
    expect(out).toContain('# fej')
    expect(out).toContain('MAIN_AGENT_ID=atlas')
    expect(out).not.toContain('MAIN_AGENT_ID=marveen')
    expect(out).toContain('OTHER=keep')
  })

  it('hianyzo kulcsot hozzafuz', async () => {
    writeFileSync(testEnvPath, 'OTHER=keep\n')
    const { updateEnvFile } = await import('../env.js')
    updateEnvFile({ BOT_NAME: 'Atlas' })
    const out = readFileSync(testEnvPath, 'utf-8')
    expect(out).toContain('OTHER=keep')
    expect(out).toContain('BOT_NAME=Atlas')
  })

  it('a teljes identitas-keszletet irja, unquoted (channels.sh cut-kompatibilis)', async () => {
    writeFileSync(testEnvPath, 'MAIN_AGENT_ID=marveen\n')
    const { updateEnvFile } = await import('../env.js')
    updateEnvFile({
      MAIN_AGENT_ID: 'atlas',
      BOT_NAME: 'Atlas',
      BRAND_NAME: 'Atlas',
      OWNER_NAME: 'Norbert',
      CHANNEL_PROVIDER: 'telegram',
    })
    const out = readFileSync(testEnvPath, 'utf-8')
    expect(out).toContain('MAIN_AGENT_ID=atlas')
    expect(out).toContain('CHANNEL_PROVIDER=telegram')
    // no quotes around values -- channels.sh parses with `cut -d= -f2-`
    expect(out).not.toContain('MAIN_AGENT_ID="atlas"')
  })

  it('ures update eseten nem ir (no-op)', async () => {
    writeFileSync(testEnvPath, 'A=1\n')
    const { updateEnvFile } = await import('../env.js')
    updateEnvFile({})
    updateEnvFile({ EMPTY: '' })
    const out = readFileSync(testEnvPath, 'utf-8')
    expect(out).toBe('A=1\n')
  })
})
