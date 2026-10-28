# OmniManager developer commands. Run `make help` for the list.
# Configuration comes from .env / backend/.env (see .env.example).

PYTHON ?= python3
VENV := backend/.venv
PY := $(abspath $(VENV))/bin/python
MANAGE := cd backend && "$(PY)" manage.py

.PHONY: help setup db migrate seed dev api web jobs test test-backend test-frontend e2e build check

help:
	@echo "setup          Create the Python venv and install backend + frontend dependencies"
	@echo "db             Create the PostgreSQL database named in DATABASE_URL (if missing)"
	@echo "migrate        Apply database migrations"
	@echo "seed           (Re)create the demo workspaces and accounts (development only)"
	@echo "dev            Run the API (:8000) and the web app (:5173) together"
	@echo "api / web      Run only the API or only the web app"
	@echo "jobs           Run scheduled jobs every 5 minutes (recurring invoices, reminders, expiry)"
	@echo "test           Backend (pytest) + frontend (typecheck + vitest) tests"
	@echo "test-backend   Backend tests only"
	@echo "test-frontend  Frontend typecheck + unit tests only"
	@echo "e2e            Playwright end-to-end workflows against an isolated database"
	@echo "build          Production build of the web app (frontend/dist)"
	@echo "check          Django system checks + verify there are no missing migrations"

setup:
	test -d $(VENV) || $(PYTHON) -m venv $(VENV)
	"$(PY)" -m pip install --upgrade pip
	"$(PY)" -m pip install -r backend/requirements-dev.txt
	cd frontend && npm ci

db:
	cd backend && "$(PY)" scripts/create_db.py

migrate:
	$(MANAGE) migrate

seed:
	$(MANAGE) seed_demo --reset

dev:
	$(MAKE) -j2 api web

api:
	$(MANAGE) runserver 127.0.0.1:8000

web:
	cd frontend && npm run dev

jobs:
	$(MANAGE) run_jobs --loop 300

test: test-backend test-frontend

test-backend:
	cd backend && "$(PY)" -m pytest

test-frontend:
	cd frontend && npm run typecheck && npm test

e2e:
	cd frontend && BACKEND_PYTHON="$(PY)" npm run e2e

build:
	cd frontend && npm run build

check:
	$(MANAGE) check
	$(MANAGE) makemigrations --check --dry-run
