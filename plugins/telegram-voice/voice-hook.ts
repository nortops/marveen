// voice-hook.ts -- outbound TTS hook for the marveen Telegram plugin fork.
//
// Drop this file next to server.ts in the plugin cache dir, then apply the
// two-line patch described in PATCH.md.
//
// Required env vars (set in the agent's plugin env or systemd/tmux session):
//   MARVEEN_API_URL   -- e.g. http://localhost:3420  (default: http://localhost:3420)
//   MARVEEN_API_TOKEN -- dashboard Bearer token (cat store/.dashboard-token)
//
// How it works:
//   onInbound(stateDir, chatId, kind) -- call when a message arrives;
//     if kind === 'voice', POSTs to /api/voice/modality/set so the dashboard
//     knows the last inbound was voice (drives 'auto' mode).
//   onReply(stateDir, chatId, text) -- call before sending a text reply;
//     reads the agent's voice-config via API and, if TTS should fire,
//     POSTs to /api/voice/tts. Returns true if voice was sent (caller should
//     skip the text reply).

const API_URL = (process.env['MARVEEN_API_URL'] ?? 'http://localhost:3420').replace(/\/$/, '')
const API_TOKEN = process.env['MARVEEN_API_TOKEN'] ?? ''

// Derive agent ID from STATE_DIR path.
// ~/.claude/channels/<provider>/            -> 'atlas'
// <base>/agents/<name>/.claude/channels/..  -> '<name>'
function agentIdFromStateDir(stateDir: string): string {
  const m = stateDir.replace(/\/$/, '').match(/\/agents\/([a-zA-Z0-9_-]+)\/\.claude\/channels\//)
  return m ? m[1] : 'atlas'
}

function authHeader(): Record<string, string> {
  return API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}
}

// Call on every inbound message. Fire-and-forget; never throws.
export async function onInbound(stateDir: string, chatId: string, kind: string): Promise<void> {
  if (!API_TOKEN || kind !== 'voice') return
  const agentId = agentIdFromStateDir(stateDir)
  await fetch(`${API_URL}/api/voice/modality/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ agent_id: agentId, chat_id: chatId, modality: 'voice' }),
  }).catch(() => {})
}

// Call before sending a text reply. Returns true if voice was sent.
// On any error, returns false (caller falls through to text reply).
export async function onReply(stateDir: string, chatId: string, text: string): Promise<boolean> {
  if (!API_TOKEN || !text.trim()) return false
  const agentId = agentIdFromStateDir(stateDir)

  // Fetch voice config
  let responseMode = 'text'
  let voiceModel = 'hu_HU-imre-medium'
  try {
    const r = await fetch(`${API_URL}/api/agents/${agentId}/voice-config`, {
      headers: authHeader(),
    })
    if (r.ok) {
      const cfg = await r.json() as { responseMode?: string; voiceModel?: string }
      responseMode = cfg.responseMode ?? 'text'
      voiceModel = cfg.voiceModel ?? 'hu_HU-imre-medium'
    }
  } catch {
    return false
  }

  if (responseMode === 'text') return false

  if (responseMode === 'auto') {
    // Only send voice if the last inbound was also voice
    try {
      const mr = await fetch(
        `${API_URL}/api/voice/modality?agent=${encodeURIComponent(agentId)}&chat=${encodeURIComponent(chatId)}`,
        { headers: authHeader() },
      )
      if (!mr.ok) return false
      const mm = await mr.json() as { modality: string | null }
      if (mm.modality !== 'voice') return false
    } catch {
      return false
    }
  }

  // Send TTS -- dashboard synthesizes + sends sendVoice via bot token in stateDir
  try {
    const tr = await fetch(`${API_URL}/api/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ text, voice_model: voiceModel, chat_id: chatId, state_dir: stateDir }),
    })
    if (!tr.ok) return false
    const tj = await tr.json() as { ok?: boolean }
    return tj.ok === true
  } catch {
    return false
  }
}
