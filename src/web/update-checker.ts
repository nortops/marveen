import { execFileSync } from 'node:child_process'
import { PROJECT_ROOT } from '../config.js'

const GIT = '/usr/bin/git'

// Upstream (Szotasz) release branch we integrate from. The deploy branch
// (main_atlas) tracks this channel via dev-clone merges, never the bleeding
// edge develop branch.
const RELEASE_CHANNEL_BRANCH = 'main'

export interface UpdateCommit {
  sha: string
  short: string
  message: string
  author: string
  date: string
}

export interface UpdateStatus {
  current: string
  latest: string
  behind: number
  commits: UpdateCommit[]
  remote: string
  lastChecked: number
  // How many upstream (Szotasz) release commits are NOT yet integrated into
  // our deploy branch. This is the "van mit integralni" signal: it does not
  // drive the dashboard button (which only fast-forwards the fork), it tells
  // the maintainer agent that a dev-clone merge run is due. Absent when
  // upstream is in sync or unreachable.
  upstreamBehind?: number
  upstreamRemote?: string
  error?: string
}

let updateStatusCache: UpdateStatus = {
  current: '',
  latest: '',
  behind: 0,
  commits: [],
  remote: '',
  lastChecked: 0,
}

export function getUpdateStatus(): UpdateStatus {
  return updateStatusCache
}

function git(args: string[], timeout = 15000): string {
  return execFileSync(GIT, args, { cwd: PROJECT_ROOT, timeout, encoding: 'utf-8' }).trim()
}

function gitSafe(args: string[], timeout = 15000): string | null {
  try {
    return git(args, timeout)
  } catch {
    return null
  }
}

export function currentGitHead(): string {
  return gitSafe(['rev-parse', 'HEAD'], 3000) ?? ''
}

// "git@github.com:Owner/Repo.git" | "https://github.com/Owner/Repo.git" -> "Owner/Repo"
function remoteSlug(remote: string): string {
  const url = gitSafe(['config', '--get', `remote.${remote}.url`], 3000)
  if (!url) return remote
  const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i)
  return m ? m[1] : remote
}

// git log records: field sep \x1f, record sep \x1e, newest-first (log default).
function parseCommits(raw: string): UpdateCommit[] {
  if (!raw) return []
  return raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha = '', author = '', date = '', ...rest] = rec.split('\x1f')
      return { sha, short: sha.slice(0, 7), author, date, message: rest.join('\x1f') }
    })
}

export async function refreshUpdateStatus(): Promise<UpdateStatus> {
  const branch = gitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], 3000) ?? ''
  const current = currentGitHead()
  const status: UpdateStatus = {
    current,
    latest: '',
    behind: 0,
    commits: [],
    remote: `${remoteSlug('origin')} (${branch || '?'})`,
    lastChecked: Date.now(),
  }

  if (!current) {
    status.error = 'Not a git checkout'
    updateStatusCache = status
    return status
  }
  if (!branch || branch === 'HEAD') {
    status.error = 'Detached HEAD -- check out the deploy branch (main_atlas)'
    updateStatusCache = status
    return status
  }

  // 1) Fork channel: what "Frissites most" would fast-forward in. The button
  //    pulls origin/<branch>; an agent has already merged upstream and resolved
  //    any conflicts in the dev clone, so this is always a clean fast-forward.
  try {
    git(['fetch', '--quiet', 'origin', branch])
    const remoteRef = `origin/${branch}`
    status.latest = git(['rev-parse', remoteRef], 5000)
    if (status.latest !== current) {
      status.behind = Number.parseInt(git(['rev-list', '--count', `${current}..${remoteRef}`], 5000), 10) || 0
      const raw = git(['log', `${current}..${remoteRef}`, '--format=%H%x1f%an%x1f%aI%x1f%s%x1e'], 5000)
      status.commits = parseCommits(raw)
    }
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err)
  }

  // 2) Upstream channel (informational): Szotasz releases not yet integrated
  //    into the deploy branch. Best-effort -- a fetch failure here never fails
  //    the fork-channel result above.
  try {
    git(['fetch', '--quiet', 'upstream', RELEASE_CHANNEL_BRANCH])
    const upRef = `upstream/${RELEASE_CHANNEL_BRANCH}`
    status.upstreamBehind = Number.parseInt(git(['rev-list', '--count', `${current}..${upRef}`], 5000), 10) || 0
    status.upstreamRemote = `${remoteSlug('upstream')} (${RELEASE_CHANNEL_BRANCH})`
  } catch {
    /* upstream unreachable: leave upstreamBehind undefined */
  }

  updateStatusCache = status
  return status
}

// Polls the fork's deploy branch (and the upstream release branch) and caches
// the result so the dashboard shows a "new version ready" badge without anyone
// SSHing in. All comparisons are local git -- no GitHub API, no rate limits,
// no 422 from a fork that lacks a 'main' branch.
export function startUpdateChecker(): NodeJS.Timeout {
  setTimeout(() => { refreshUpdateStatus().catch(() => {}) }, 10_000)
  return setInterval(() => { refreshUpdateStatus().catch(() => {}) }, 15 * 60_000)
}
