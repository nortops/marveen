import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { exportFleet, importFleet, MIN_VAULT_PASSWORD_LEN } from '../fleet-transfer.js'
import type { RouteContext } from './types.js'

export async function tryHandleFleet(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path !== '/api/fleet/export' && path !== '/api/fleet/import') return false

  // H1: vault password via header, not query string (avoids access-log / proxy-log / browser-history leakage)
  const vaultPassword = req.headers['x-vault-password'] as string | undefined

  if (path === '/api/fleet/export' && method === 'GET') {
    if (vaultPassword !== undefined && vaultPassword.length < MIN_VAULT_PASSWORD_LEN) {
      json(res, { error: `X-Vault-Password must be at least ${MIN_VAULT_PASSWORD_LEN} characters.` }, 400)
      return true
    }
    try {
      const fleet = exportFleet({ vaultPassword: vaultPassword || undefined })
      const body = JSON.stringify(fleet)
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="fleet-export-${fleet.exportedAt.slice(0, 10)}.json"`,
        'Content-Length': Buffer.byteLength(body),
      })
      res.end(body)
    } catch (err: any) {
      logger.error({ err: err.message }, 'Fleet export failed')
      json(res, { error: `Export hiba: ${err.message}` }, 500)
    }
    return true
  }

  if (path === '/api/fleet/import' && method === 'POST') {
    const apply = ctx.url.searchParams.get('apply') === 'true'

    let rawBody: string
    try {
      const buf = await readBody(req)
      rawBody = buf.toString()
    } catch (err: any) {
      json(res, { error: `Kérés olvasási hiba: ${err.message}` }, 400)
      return true
    }

    // Basic JSON parse check before handing to importFleet (which does denormalize + parse internally)
    try {
      JSON.parse(rawBody)
    } catch (err: any) {
      json(res, { error: `Érvénytelen JSON: ${err.message}` }, 400)
      return true
    }

    try {
      const result = importFleet(rawBody, { vaultPassword: vaultPassword || undefined, apply })
      if ('dryRun' in result && result.errors.length > 0) {
        json(res, result, 400)
      } else {
        json(res, result, 200)
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Fleet import failed')
      json(res, { error: `Import hiba: ${err.message}` }, 500)
    }
    return true
  }

  return false
}
