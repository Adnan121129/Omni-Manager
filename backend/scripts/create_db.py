"""
Creates the PostgreSQL database named in DATABASE_URL if it does not exist yet.

The role in DATABASE_URL needs the CREATEDB privilege (or create the database yourself).
Usage: python scripts/create_db.py [database-url]
"""

import os
import sys
from pathlib import Path
from urllib.parse import urlparse, urlunparse

from dotenv import load_dotenv

BACKEND = Path(__file__).resolve().parent.parent


def ensure_database(url: str) -> bool:
    """Returns True when the database was created, False when it already existed."""
    import psycopg
    from psycopg import sql

    parsed = urlparse(url)
    name = parsed.path.lstrip("/")
    if not name:
        raise SystemExit("DATABASE_URL must include a database name.")
    admin_url = urlunparse(parsed._replace(path="/postgres"))
    with psycopg.connect(admin_url, autocommit=True) as conn:
        if conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone():
            return False
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        return True


if __name__ == "__main__":
    load_dotenv(BACKEND / ".env")
    load_dotenv(BACKEND.parent / ".env")
    target = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DATABASE_URL")
    if not target:
        raise SystemExit("Set DATABASE_URL (see .env.example).")
    db = urlparse(target).path.lstrip("/")
    print(f"Created database {db}" if ensure_database(target) else f"Database {db} already exists")
