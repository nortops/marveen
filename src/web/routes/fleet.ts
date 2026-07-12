import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { exportFleet, importFleet, type FleetJson } from '../fleet-transfer.js'
import type { RouteContext } from './types.js'

export async function tryHandleFleet(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path !== '/api/fleet/export' && path !== '/api/fleet/import') return false

  if (path === '/api/fleet/export' && method === 'GET') {
    const vaultPassword = url.searchParams.get('vault_password') ?? undefined
    try {
      const fleet = exportFleet({ vaultPassword })
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
    const apply = url.searchParams.get('apply') === 'true'
    const vaultPassword = url.searchParams.get('vault_password') ?? undefined

    let fleet: FleetJson
    try {
      const body = await readBody(req)
      fleet = JSON.parse(body.toString()) as FleetJson
    } catch (err: any) {
      json(res, { error: `Érvénytelen JSON: ${err.message}` }, 400)
      return true
    }

    try {
      const result = importFleet(fleet, { vaultPassword, apply })
      // If there are schema errors, return 400
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
