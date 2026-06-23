# telegram-voice plugin fork

Minimal fork of the official `claude-plugins-official/telegram` plugin (v0.0.6).
Adds outbound TTS support: when an agent's voice-config is set to `voice` or `auto`,
replies are sent as Ogg/Opus voice messages via the marveen dashboard `/api/voice/tts`.

## Changes from upstream (3 hunks)

### 1. New import (line ~26)
```diff
+import { onInbound as voiceOnInbound, onReply as voiceOnReply } from './voice-hook.ts'
```

### 2. Inbound hook in `handleInbound` (after `imagePath` line)
```diff
+  // VOICE PATCH: track inbound modality so auto-mode knows when to reply with voice
+  if (attachment?.kind === 'voice') void voiceOnInbound(STATE_DIR, chat_id, 'voice')
```

### 3. Reply hook in `case 'reply'` (before text chunk loop)
```diff
+        // VOICE PATCH: if voice mode active, send TTS instead of text chunks
+        const voiceSent = files.length === 0 && await voiceOnReply(STATE_DIR, chat_id, text)
+        if (voiceSent) {
+          return { content: [{ type: 'text', text: 'sent (voice)' }] }
+        }
```

## Required env vars

Set these in the Claude Code session / tmux environment before starting the plugin:

```bash
export MARVEEN_API_URL=http://localhost:3420
export MARVEEN_API_TOKEN=$(cat /path/to/marveen/store/.dashboard-token)
```

## Fleet deployment (requires Norbert approval for restarts)

For each agent that should have voice outbound:

1. Copy the two files next to the installed plugin server:
   ```bash
   PLUGIN_DIR=~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6
   cp plugins/telegram-voice/server.ts "$PLUGIN_DIR/server.ts"
   cp plugins/telegram-voice/voice-hook.ts "$PLUGIN_DIR/voice-hook.ts"
   ```

2. Set env vars in the agent's tmux session (or add to its launch wrapper):
   ```bash
   MARVEEN_API_URL=http://localhost:3420
   MARVEEN_API_TOKEN=$(cat store/.dashboard-token)
   ```

3. Restart the channel plugin (requires Norbert approval):
   ```bash
   # Claude Code Channels will reload the plugin on next session start
   ```

## Reverting

Restore the original from the plugin registry:
```bash
claude plugin remove telegram && claude plugin install claude-plugins-official/telegram
```
Or manually copy back the original `server.ts` from git history.

## Voice config

Set per-agent via the dashboard (Ágensek → hang ikon) or API:
```bash
curl -s -X PUT http://localhost:3420/api/agents/AGENT_NAME/voice-config \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -H "Content-Type: application/json" \
  -d '{"responseMode":"voice","voiceModel":"hu_HU-imre-medium"}'
```

Modes:
- `text` (default): always text reply
- `voice`: always TTS reply (unless files attached)
- `auto`: TTS only if the last inbound was a voice message (10 min TTL)
