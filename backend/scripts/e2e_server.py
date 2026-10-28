"""
Starts an isolated API server for the Playwright end-to-end suite.

It never touches your development database: the suite runs against E2E_DATABASE_URL, which
defaults to your DATABASE_URL with an "_e2e" suffix on the database name. The database is
created if missing, migrated and reseeded with the demo fixtures on every start.

Usage (normally invoked by `npm run e2e` via playwright.config.ts):
    python scripts/e2e_server.py
Environment:
    E2E_DATABASE_URL  database for the run (default: DATABASE_URL + "_e2e")
    E2E_API_PORT      port for the API server (default 8001)
    E2E_FRONTEND_URL  origin the Vite server for the run listens on (default http://127.0.0.1:5174)
"""

import os
import secrets
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse, urlunparse

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent))
from create_db import ensure_database  # noqa: E402

BACKEND = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND / ".env")
load_dotenv(BACKEND.parent / ".env")


def e2e_database_url() -> str:
    explicit = os.environ.get("E2E_DATABASE_URL")
    if explicit:
        return explicit
    base = os.environ.get("DATABASE_URL")
    if not base:
        sys.exit("Set DATABASE_URL (or E2E_DATABASE_URL) before running the end-to-end suite.")
    parsed = urlparse(base)
    return urlunparse(parsed._replace(path=parsed.path.rstrip("/") + "_e2e"))


def main() -> None:
    url = e2e_database_url()
    if url == os.environ.get("DATABASE_URL"):
        sys.exit("E2E_DATABASE_URL must differ from DATABASE_URL - the suite resets its database.")
    port = os.environ.get("E2E_API_PORT", "8001")
    frontend = os.environ.get("E2E_FRONTEND_URL", "http://127.0.0.1:5174")
    if ensure_database(url):
        print(f"[e2e] created database {urlparse(url).path.lstrip('/')}", flush=True)
    env = {
        **os.environ,
        "DATABASE_URL": url,
        "DJANGO_DEBUG": "true",
        "FRONTEND_URL": frontend,
        "DJANGO_CSRF_TRUSTED_ORIGINS": frontend,
        "PAYMENT_PROVIDER": "sandbox",
        # A fresh random signing secret per run: the sandbox signs and verifies with the same server.
        "SANDBOX_WEBHOOK_SECRET": secrets.token_urlsafe(32),
        "THROTTLE_AUTH": "1000/min",
        "THROTTLE_PAYMENTS": "1000/min",
        "EMAIL_FILE_PATH": str(BACKEND / "var" / "mail-e2e"),
    }
    manage = [sys.executable, str(BACKEND / "manage.py")]
    subprocess.run([*manage, "migrate", "--noinput", "-v", "0"], env=env, check=True)
    subprocess.run([*manage, "seed_demo", "--reset"], env=env, check=True, stdout=subprocess.DEVNULL)
    print(f"[e2e] API on http://127.0.0.1:{port} using {urlparse(url).path.lstrip('/')}", flush=True)
    os.execve(sys.executable, [*manage, "runserver", f"127.0.0.1:{port}", "--noreload"], env)


if __name__ == "__main__":
    main()
