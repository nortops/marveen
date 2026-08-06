import { describe, it, expect } from 'vitest'
import { checkAgentPutFields, AGENT_PUT_WRITABLE_FIELDS, validateCustomProvider } from '../web/agent-put-fields.js'

// PUT /api/agents/:name answered 200 {ok:true} to fields it did not understand
// and quietly dropped them. A securityProfile was set that way four times on
// 2026-07-27, acknowledged each time, never applied -- the agent stayed in a
// mode where it stopped for approval on every tool call and was unusable for
// hours. The failure mode of this rule is silence, so it gets its own tests.
describe('checkAgentPutFields', () => {
  it('accepts the payloads the dashboard actually sends', () => {
    // taken from the real call sites in web/app.js -- if one of these ever
    // starts failing, the UI breaks, so they are pinned here deliberately
    expect(checkAgentPutFields('laci', { claudeMd: '...', soulMd: '...' }).ok).toBe(true)
    expect(checkAgentPutFields('laci', { model: 'claude-opus-5' }).ok).toBe(true)
    expect(checkAgentPutFields('laci', { claudePlan: '' }).ok).toBe(true)
    expect(checkAgentPutFields('laci', { authMode: 'shared' }).ok).toBe(true)
    expect(checkAgentPutFields('laci', { memoryIsolation: true }).ok).toBe(true)
    expect(checkAgentPutFields('laci', { customProvider: 'openai' }).ok).toBe(true)
    expect(checkAgentPutFields('laci', { customProvider: null }).ok).toBe(true)
    expect(checkAgentPutFields('laci', { modelProfile: 'balanced' }).ok).toBe(true)
    expect(checkAgentPutFields('laci', {}).ok).toBe(true)
  })

  it('refuses securityProfile and says where it belongs', () => {
    const r = checkAgentPutFields('vera', { securityProfile: 'researcher-permissive' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.rejected).toEqual(['securityProfile'])
    // the message has to carry the alternative: a bare refusal sends people
    // looking for a way around the check instead of at the right endpoint
    expect(r.message).toContain('/api/agents/vera/security')
    expect(r.message).toContain('profile')
  })

  it('refuses a field nobody has heard of, rather than ignoring it', () => {
    const r = checkAgentPutFields('laci', { claudeMd: 'ok', tipoField: 1 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.rejected).toEqual(['tipoField'])
  })

  it('names every offending field, not just the first', () => {
    const r = checkAgentPutFields('laci', { securityProfile: 'x', nonsense: true, model: 'ok' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.rejected).toEqual(['securityProfile', 'nonsense'])
    expect(r.rejected).not.toContain('model')
  })

  it('rejects a body that is not an object at all', () => {
    expect(checkAgentPutFields('laci', null).ok).toBe(false)
    expect(checkAgentPutFields('laci', 'securityProfile=x').ok).toBe(false)
    expect(checkAgentPutFields('laci', 42).ok).toBe(false)
  })

  it('does not quietly gain a writable field', () => {
    // A field added to this list widens what the endpoint can change, so the
    // list is pinned: growing it should require editing this test too.
    expect([...AGENT_PUT_WRITABLE_FIELDS]).toEqual([
      'claudeMd', 'soulMd', 'mcpJson', 'model',
      'authMode', 'apiKey', 'claudePlan', 'memoryIsolation',
      'customProvider', 'modelProfile',
    ])
    expect(AGENT_PUT_WRITABLE_FIELDS).not.toContain('securityProfile')
  })
})

describe('validateCustomProvider', () => {
  const known = ['openai', 'deepseek']

  it('accepts a known provider id', () => {
    expect(validateCustomProvider('openai', known).ok).toBe(true)
  })

  it('rejects an unknown provider id with a descriptive error', () => {
    const r = validateCustomProvider('bogus', known)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('bogus')
  })

  it('treats null as a clear operation (always valid)', () => {
    expect(validateCustomProvider(null, known).ok).toBe(true)
    expect(validateCustomProvider(null, []).ok).toBe(true)
  })

  it('treats empty string as a clear operation (always valid)', () => {
    expect(validateCustomProvider('', known).ok).toBe(true)
  })

  it('treats undefined as a clear operation (always valid)', () => {
    expect(validateCustomProvider(undefined, known).ok).toBe(true)
  })
})
