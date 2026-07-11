# Dockerfile — Atlas fleet test harness (secondary restore path).
#
# PURPOSE: Verify that a backup archive is complete and the full fleet
# can boot in a clean environment. NOT for production use.
#
# Build:
#   echo "your-passphrase" > passphrase.txt
#   docker build --secret id=age_passphrase,src=./passphrase.txt -t marveen-fleet .
#   rm passphrase.txt
#
# Run:
#   docker run -d -p 3420:3420 --name marveen-fleet marveen-fleet
#
# Verify (wait ~3 min for agent stagger):
#   docker exec marveen-fleet sqlite3 /home/northber/Projects/marveen/store/claudeclaw.db \
#       "PRAGMA integrity_check;"
#   curl -s -o /dev/null -w "%{http_code}" http://localhost:3420         # expect 200
#   TOKEN=$(docker exec marveen-fleet cat /home/northber/Projects/marveen/store/.dashboard-token)
#   curl -H "Authorization: Bearer $TOKEN" "http://localhost:3420/api/memories?agent=atlas&q=test"
#
# Clean up:
#   docker rm -f marveen-fleet && docker rmi marveen-fleet
#
# SECURITY WARNING: the built image contains decrypted secrets (vault keys, tokens)
# in its layers. NEVER push to Docker Hub, GHCR, or any other registry.

# syntax=docker/dockerfile:1.4
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git sqlite3 age tmux curl procps \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN useradd -m -s /bin/bash northber

# Copy backup archive (must be named marveen-backup.tar.gz.age, placed next to Dockerfile)
COPY marveen-backup.tar.gz.age /home/northber/

# Decrypt + extract as root (secret mount is root-only by default; chown after).
# age reads passphrase from /dev/tty; `script -q -c` provides the PTY while
# printf pipes the passphrase through it. Flags:
#   -e / --return  propagate the child's exit code (otherwise script returns its own)
#   bash -c 'set -o pipefail; ...' ensures age failure is not masked by tar's exit code
# Result: wrong passphrase or corrupt archive fails the build with non-zero exit.
RUN --mount=type=secret,id=age_passphrase \
    PASS="$(cat /run/secrets/age_passphrase)" \
 && printf '%s\n' "${PASS}" \
    | script -q -e -c "bash -c 'set -o pipefail; age -d /home/northber/marveen-backup.tar.gz.age | tar -xzpC /home/northber'" /dev/null \
 && chown -R northber:northber /home/northber \
 && unset PASS

USER northber
WORKDIR /home/northber

# Clone repo from embedded bundle; pinned_sha parsed with node (not python3)
RUN git clone /home/northber/Projects/marveen/fleet.bundle /tmp/marveen-src \
 && PINNED=$(node -e \
      "process.stdout.write(require('/home/northber/Projects/marveen/manifest.json').pinned_sha)") \
 && cd /tmp/marveen-src && git checkout "$PINNED"

# Build
RUN cd /tmp/marveen-src && npm ci --silent && npm run build --silent

# Overlay source onto project dir (preserves extracted store/, vault, .env-for-backup, etc.)
RUN cp -a /tmp/marveen-src/. /home/northber/Projects/marveen/ \
 && rm -rf /tmp/marveen-src

# .env + vault-resolved OAuth token
RUN mv /home/northber/Projects/marveen/.env-for-backup \
       /home/northber/Projects/marveen/.env \
 && echo "CLAUDE_CODE_OAUTH_TOKEN=CLAUDE_CODE_OAUTH_TOKEN" \
    | node /home/northber/Projects/marveen/scripts/vault-resolve.mjs \
    >> /home/northber/Projects/marveen/.env

# Rename snapshot DB to live DB
RUN mv /home/northber/Projects/marveen/store/claudeclaw-snapshot.db \
       /home/northber/Projects/marveen/store/claudeclaw.db \
 && rm -f /home/northber/Projects/marveen/fleet.bundle

EXPOSE 3420

# In direct-launch mode, start.sh backgrounds both dashboard and channels via
# nohup and then exits -- so the container would die immediately without a
# keepalive. This wrapper starts the fleet and then waits on the dashboard pid.
RUN printf '#!/bin/bash\nset -e\n/home/northber/Projects/marveen/scripts/start.sh\nsleep 2\nexec tail -f /home/northber/Projects/marveen/store/dashboard.log 2>/dev/null || exec tail -f /dev/null\n' \
    > /home/northber/docker-entrypoint.sh \
 && chmod +x /home/northber/docker-entrypoint.sh

ENTRYPOINT ["/home/northber/docker-entrypoint.sh"]
