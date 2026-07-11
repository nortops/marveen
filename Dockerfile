# Dockerfile — Marveen fleet test harness (secondary restore path).
#
# PURPOSE: Verify that a backup archive is complete and the full fleet
# can boot in a clean environment. NOT for production use.
#
# Build:
#   echo "your-passphrase" > passphrase.txt
#   docker build --secret id=passphrase,src=./passphrase.txt -t marveen-fleet .
#   rm passphrase.txt
#
# Run:
#   docker run -d -p 3420:3420 --name marveen-fleet marveen-fleet
#
# Verify (wait ~3 min for agent stagger):
#   docker exec marveen-fleet node -e \
#     "const d=require('/home/northber/Projects/marveen/node_modules/better-sqlite3'); \
#      const db=d('/home/northber/Projects/marveen/store/claudeclaw.db',{readonly:true}); \
#      console.log(db.pragma('integrity_check',{simple:true})); db.close()"
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
      git tmux curl procps openssl \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN useradd -m -s /bin/bash northber

# Copy backup archive (must be named marveen-backup.tar.gz.enc, placed next to Dockerfile)
COPY marveen-backup.tar.gz.enc /home/northber/

# Decrypt + extract as root (secret mount is root-only by default; chown after).
# openssl reads passphrase from the BuildKit secret file directly -- no TTY needed.
# pipefail ensures a wrong passphrase (openssl non-zero exit) fails the build.
RUN --mount=type=secret,id=passphrase \
    bash -c 'set -o pipefail; \
      openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
        -in /home/northber/marveen-backup.tar.gz.enc \
        -pass file:/run/secrets/passphrase \
      | tar -xzpC /home/northber' \
 && chown -R northber:northber /home/northber \
 && rm /home/northber/marveen-backup.tar.gz.enc

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

# Disable all restored scheduled tasks so they don't fire in the test container.
RUN for cfg in /home/northber/.claude/scheduled-tasks/*/task-config.json; do \
      [ -f "$cfg" ] || continue; \
      node -e " \
        const fs=require('fs'),p=process.argv[1]; \
        try{const d=JSON.parse(fs.readFileSync(p,'utf8'));d.enabled=false;fs.writeFileSync(p,JSON.stringify(d,null,2)+'\n');}catch(e){} \
      " "$cfg"; \
    done

EXPOSE 3420

# In direct-launch mode, start.sh backgrounds both dashboard and channels via
# nohup and then exits -- so the container would die immediately without a
# keepalive. This wrapper starts the fleet and then waits on the dashboard pid.
RUN printf '#!/bin/bash\nset -e\n/home/northber/Projects/marveen/scripts/start.sh\nsleep 2\nexec tail -f /home/northber/Projects/marveen/store/dashboard.log 2>/dev/null || exec tail -f /dev/null\n' \
    > /home/northber/docker-entrypoint.sh \
 && chmod +x /home/northber/docker-entrypoint.sh

ENTRYPOINT ["/home/northber/docker-entrypoint.sh"]
