#!/usr/bin/env node
// Resolve the MAIN channels-agent's custom provider and print the shell env
// prefix for channels.sh to inject into the tmux launch command.
//
// Output contract (consumed by scripts/channels.sh):
//   - Nothing (empty) when no customProvider is set for the main agent, the
//     definition is missing, the vault key is absent, or any other guard fails.
//     channels.sh treats an empty result as "no custom provider, carry on".
//   - A single line of shell statements ending with " && " when the provider is
//     fully resolved. channels.sh prepends this to the claude invocation inside
//     the tmux new-session command string.
//
// Side effect: for x-api-key providers the API key is pre-stamped into the
// config dir's .claude.json (stampCustomApiKeyApproval) so the "Detected a
// custom API key" TUI approval dialog never blocks --channels startup.
//
// Usage: node scripts/main-agent-custom-provider.mjs [claude-config-dir]
//   claude-config-dir: optional path to an isolated CLAUDE_CONFIG_DIR
//     (the stamped approval lands there instead of ~/.claude.json)

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

const { MAIN_AGENT_ID } = await import(join(projectRoot, 'dist', 'config.js'))
const { readAgentCustomProvider, readAgentModel } = await import(
  join(projectRoot, 'dist', 'web', 'agent-config.js')
)
const { loadCustomProvider } = await import(
  join(projectRoot, 'dist', 'web', 'custom-providers.js')
)
const { getSecret } = await import(join(projectRoot, 'dist', 'web', 'vault.js'))
const { stampCustomApiKeyApproval } = await import(
  join(projectRoot, 'dist', 'web', 'agent-process.js')
)

const customProviderId = readAgentCustomProvider(MAIN_AGENT_ID)
if (!customProviderId) process.exit(0)

const def = loadCustomProvider(customProviderId)
if (!def) {
  process.stderr.write(
    `main-agent-custom-provider: provider "${customProviderId}" not found in store -- add it in Settings > Providers\n`,
  )
  process.exit(0)
}

// readAgentModel always returns a non-empty string (falls back to
// DISTRIBUTION_DEFAULT_AGENT_MODEL when the field is absent), so there is no
// "no model" guard here -- the value is always usable.
const model = readAgentModel(MAIN_AGENT_ID)

// Resolve auth credential from the vault.
let headerExport = ''
let apiKeyForStamp = null

if (def.authHeader === 'none') {
  headerExport = 'export ANTHROPIC_AUTH_TOKEN=ollama && '
} else {
  const key = getSecret(def.vaultKey ?? '') ?? ''
  if (!key) {
    process.stderr.write(
      `main-agent-custom-provider: vault key "${def.vaultKey}" missing for provider "${customProviderId}" -- add it in the Vault tab\n`,
    )
    process.exit(0)
  }
  if (def.authHeader === 'x-api-key') {
    headerExport = `export ANTHROPIC_API_KEY="${key}" && `
    apiKeyForStamp = key
  } else {
    // Bearer
    headerExport = `export ANTHROPIC_AUTH_TOKEN="${key}" && `
  }
}

// Pre-stamp x-api-key approval into .claude.json so the TUI approval gate
// never fires at startup in --channels mode.
const claudeConfigDir = process.argv[2] || ''
const dotClaudePath = claudeConfigDir
  ? join(claudeConfigDir, '.claude.json')
  : join(homedir(), '.claude.json')

if (apiKeyForStamp) {
  try {
    stampCustomApiKeyApproval(dotClaudePath, apiKeyForStamp)
  } catch (e) {
    process.stderr.write(
      `main-agent-custom-provider: stampCustomApiKeyApproval failed (${e.message}) -- the TUI may show an approval dialog\n`,
    )
  }
}

// POSIX single-quote-escape the model id so values like `oc/gpt-5.6-luna`
// survive the tmux command string round-trip without shell expansion.
const safeModel = "'" + model.replace(/'/g, "'\\''") + "'"

// Output the env prefix:
//   1. Unset the inherited fleet OAuth token FIRST. The tmux server carries it
//      in the global env, every new session inherits it. The Claude CLI prefers
//      CLAUDE_CODE_OAUTH_TOKEN over ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN,
//      so the inherited token would be sent to the custom endpoint -> 401, even
//      though we export the correct credential right after. An active `unset`
//      at launch strips the inherited value before claude exec.
//   2. Export the Anthropic-SDK triple: base URL, auth credential, model.
//      ANTHROPIC_MODEL is authoritative for non-Claude model ids: the TUI
//      validates --model against the Anthropic catalog and silently falls back
//      for unknown values, but ANTHROPIC_MODEL bypasses that gate entirely.
process.stdout.write(
  `unset CLAUDE_CODE_OAUTH_TOKEN && export ANTHROPIC_BASE_URL="${def.baseUrl}" && ${headerExport}export ANTHROPIC_MODEL=${safeModel} && `,
)
