# 001 — Toolchain versions for M0

- **Status:** accepted
- **Date:** 2026-11-13
- **Milestone:** M0

## Context
DEV_PLAN §4 names libraries but not versions. All versions are pinned exactly in `package.json` / `pyproject.toml`.

## Decision
- Node 22, pnpm 10.28.
- TypeScript **6.0.3**, not 7.x: typescript-eslint 8.72 supports TypeScript `<6.1.0` only.
- React 19.3, Vite 8, Vitest 5, Tailwind CSS 4 (Vite plugin), Capacitor 8.6.
- Playwright 1.63 (matches the Chromium available in the dev container).
- JSON Schema draft 2020-12, validated with Ajv 8; types generated with json-schema-to-typescript 16.
- Backend: Python 3.12, FastAPI, SQLAlchemy 2, Alembic, pytest, ruff; Postgres 16, MinIO.

## Consequences
Revisit TypeScript 7 when typescript-eslint supports it.
