#!/usr/bin/env python3
"""OAuth Token Master — pro-active token refresh with fcntl.flock synchronization.

Monitors ~/.claude/.credentials.json for the Claude AI OAuth token expiry time.
When expiresAt is within T-25 minutes, acquires an fcntl.flock lock and refreshes
the token. The lock ensures only ONE refresh agent runs concurrently, avoiding
the "invalid_grant" race condition when multiple processes try to refresh the
same one-time-use refresh token.

Activates only when shared session mode is enabled (dashboard config).
"""
import fcntl, json, os, time, sys, logging, urllib.request, urllib.error

HOME = os.path.expanduser("~")
CRED_PATH = os.path.join(HOME, ".claude/.credentials.json")
LOCK_PATH = os.path.join(HOME, ".claude/.credentials.lock")
LOG_PATH = os.path.join(HOME, "Projects/marveen/store/oauth-token-master.log")
DASHBOARD_TOKEN_PATH = os.path.join(HOME, "Projects/marveen/store/.dashboard-token")
DASHBOARD_URL = "http://localhost:3420"
PRE_EXPIRY_MINUTES = 25  # Refresh if T-25 min or less
OAUTH_ENDPOINT = "https://platform.claude.com/v1/oauth/token"
OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
OAUTH_SCOPES = ["user:inference", "user:file_upload", "user:mcp_servers", "user:profile", "user:sessions:claude_code"]

# Ensure log directory exists before configuring logging
os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH),
        logging.StreamHandler(sys.stderr),
    ],
)
logger = logging.getLogger("oauth-token-master")


def is_shared_session_enabled() -> bool:
    """Check dashboard config if shared session mode is active."""
    try:
        dashboard_config = os.path.join(HOME, ".claude/.dashboard-config.json")
        if os.path.exists(dashboard_config):
            with open(dashboard_config) as f:
                cfg = json.load(f)
                return cfg.get("shared_session_mode", False)
    except Exception as e:
        logger.warning(f"Failed to check shared session config: {e}")
    return False


def load_credentials() -> dict | None:
    """Load credentials.json, return the content or None if not found."""
    try:
        with open(CRED_PATH) as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load credentials: {e}")
        return None


def get_token_expiry() -> int | None:
    """Return expiresAt timestamp in milliseconds, or None if not found."""
    creds = load_credentials()
    if not creds:
        return None
    oauth = creds.get("claudeAiOauth", {})
    return oauth.get("expiresAt")


def time_until_expiry_sec() -> int | None:
    """Return seconds until token expiry, or None if unknown."""
    exp_ms = get_token_expiry()
    if not exp_ms:
        return None
    now_ms = time.time() * 1000
    return int((exp_ms - now_ms) / 1000)


def should_refresh() -> bool:
    """Check if token is within PRE_EXPIRY_MINUTES of expiry."""
    secs = time_until_expiry_sec()
    if secs is None:
        return False
    return secs < (PRE_EXPIRY_MINUTES * 60)


def refresh_token_via_http() -> bool:
    """Refresh token via Anthropic OAuth endpoint (JSON). Return True if successful."""
    try:
        creds = load_credentials()
        if not creds:
            logger.error("Failed to load credentials for refresh")
            return False

        oauth = creds.get("claudeAiOauth", {})
        refresh_token = oauth.get("refreshToken")
        if not refresh_token:
            logger.error("No refreshToken found in credentials")
            return False

        logger.info("Attempting token refresh via platform.claude.com/v1/oauth/token (JSON)...")

        # JSON body with scope (required for Claude.ai OAuth)
        payload = json.dumps({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": OAUTH_CLIENT_ID,
            "scope": " ".join(OAUTH_SCOPES),
        }).encode('utf-8')

        req = urllib.request.Request(
            OAUTH_ENDPOINT,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                resp_data = json.loads(response.read().decode('utf-8'))

                new_access_token = resp_data.get("access_token")
                new_refresh_token = resp_data.get("refresh_token", refresh_token)
                expires_in = resp_data.get("expires_in", 3600)

                if not new_access_token:
                    logger.error(f"OAuth response missing access_token: {resp_data}")
                    return False

                # Update credentials.json atomically
                oauth["accessToken"] = new_access_token
                oauth["refreshToken"] = new_refresh_token
                oauth["expiresAt"] = int((time.time() + expires_in) * 1000)
                creds["claudeAiOauth"] = oauth

                # Write atomically (temp + rename), preserve 0600 permissions
                temp_path = CRED_PATH + ".tmp"
                with open(temp_path, "w") as f:
                    json.dump(creds, f)
                os.chmod(temp_path, 0o600)
                os.replace(temp_path, CRED_PATH)

                logger.info(f"Token refresh succeeded (new expiry in {expires_in}s)")
                return True

        except urllib.error.HTTPError as e:
            resp_body = e.read().decode('utf-8', errors='replace')
            logger.error(f"OAuth HTTP {e.code}: {resp_body[:100]}")
            return False

    except Exception as e:
        logger.error(f"Token refresh exception: {e}")
        return False




# Global lock file handle (keeps lock alive)
_lock_file = None

def acquire_lock(timeout_sec: int = 10) -> bool:
    """Acquire fcntl.flock on the credentials file. Return True if acquired."""
    global _lock_file
    try:
        os.makedirs(os.path.dirname(LOCK_PATH), exist_ok=True)
        _lock_file = open(LOCK_PATH, "a")
        fcntl.flock(_lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        logger.info("fcntl lock acquired")
        return True
    except IOError:
        logger.warning("fcntl lock in use by another process (this is OK, skipping refresh)")
        if _lock_file:
            _lock_file.close()
        return False
    except Exception as e:
        logger.error(f"fcntl lock error: {e}")
        if _lock_file:
            _lock_file.close()
        return False


def notify_atlas(message: str) -> None:
    """Send an inter-agent message to atlas via the dashboard API."""
    try:
        token_file = DASHBOARD_TOKEN_PATH
        if not os.path.exists(token_file):
            logger.warning("Dashboard token not found, cannot notify Atlas")
            return
        with open(token_file) as f:
            token = f.read().strip()
        payload = json.dumps({
            "from": "daidalosz",
            "to": "atlas",
            "content": message,
        }).encode('utf-8')
        req = urllib.request.Request(
            f"{DASHBOARD_URL}/api/messages",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            logger.info(f"Atlas notified: {resp.status}")
    except Exception as e:
        logger.warning(f"Failed to notify Atlas: {e}")


def main():
    if not is_shared_session_enabled():
        logger.debug("Shared session mode is disabled, skipping token refresh check")
        return

    secs = time_until_expiry_sec()
    if secs is None:
        logger.debug("Token expiry time unknown")
        return

    logger.info(f"Token expires in {secs} seconds (~{secs // 60} minutes)")

    if not should_refresh():
        logger.debug(f"Token still valid for >{PRE_EXPIRY_MINUTES} min, skipping refresh")
        return

    logger.warning(f"Token expires in <{PRE_EXPIRY_MINUTES} min, acquiring lock for refresh...")

    if not acquire_lock():
        logger.info("Lock unavailable; another process is refreshing, skipping this cycle")
        return

    if refresh_token_via_http():
        logger.info("Token refresh completed successfully")
    else:
        logger.error("Token refresh failed; credentials may stale until manual re-auth")
        notify_atlas(
            f"OAUTH TOKEN REFRESH FAILED. Token expires in {secs // 60} minutes. "
            "Manual re-auth may be required: `claude auth login`"
        )


if __name__ == "__main__":
    main()
