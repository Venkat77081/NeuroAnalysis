# CLAUDE.md — NeuroCapture

The full plan is in `DEV_PLAN.md` (v3.1). The agreed UI mockups are linked from `docs/mockups.md`.

## Working rules (DEV_PLAN §3)

- Work **one milestone at a time** (M0 → M10). Do not start the next milestone until every acceptance criterion of the current one passes.
- At the end of each milestone, report:
  1. files created/changed
  2. tests run and results
  3. each acceptance criterion with pass/fail and the measured value
  4. assumptions made
  5. decisions that need human review
- Put all protocol values, thresholds and user-facing text in `config/` and the i18n files. Never hard-code them.
- `packages/quality-core` must stay pure TypeScript: no DOM, no Capacitor, no Node-only APIs. 100% of its public functions need unit tests.
- Native plugin code must never wait on JavaScript to keep recording. JS failures, WebView reloads or a slow bridge must not stop or corrupt a recording.
- Never log patient names, external IDs, raw frames or landmark streams. Use the provided `logger` with PII redaction.
- Write ambiguities to `docs/assumptions.md` and carry on. Record significant technical choices in `docs/decisions/NNN-title.md`.
- Do not add features outside this plan (no diagnosis, no scoring UI, no cloud ML) unless asked.
- Keep commits small, one task per commit, with clear messages.

## Agreed product decisions (mockup review, 13 Nov 2026)

- Takes are **fixed duration**: 15 s (FT, FR, FTF, FA), 45 s (SAW). The native timer stops recording; detectors never do.
- Capture follows the **DNE protocol** (decision 013): FT, FTF, FR with both hands in one take, patient seated facing the camera; SAW back and forth 15 ft. The per-hand variant lives on branch `claude/variant-per-hand-protocol`.
- Every test records at **60 fps** with no 30 fps fallback; below **59 fps** a take fails; a doctor may change the limit in settings (decision 015).
- Biomarker readiness is **never shown to operators**. Retake-fixable readiness failures become plain RETAKE reasons.
- Override = **"Keep this take…"** → reason required → "Keep and flag for review" → shown as "Kept · flagged".

## Agreed platform decisions (mockup review, 15 Nov 2026; `docs/PLATFORM_PLAN.md`, decision 023)

- The app has two modes: **patients** (home recording by invite → PIN) and **operators** (ID + password on hospital-registered phones).
- **Hospital-owned data**: NeuroCapture stores patients only by a random **NCID**. Names, MRNs, records, videos, clinical logs and biomarker results stay in the hospital's systems, reached through the **hospital connector**. Never store patient identity on the platform.
- Biomarkers are computed **at the hospital** (next to the connector) from the 60 fps video; NeuroCapture servers never hold a decryptable recording (decision 027). Phone landmarks are only for guidance and capture quality.
- Every hospital has its own take key; the platform never accepts a patient's contact details or MRN; connectors pin the platform key (decision 027).
- FA biomarker formulas follow the JBHI 2024 appendix.

## Commands

```bash
pnpm install
pnpm contracts:gen        # regenerate TS types from /contracts
pnpm validate             # validate config/ and contracts/tests samples
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @neurocapture/mobile dev      # web app in mock mode
pnpm e2e                  # Playwright smoke test (mock mode)
docker compose up -d      # api + postgres (storage profile: see docs/decisions/004); GET http://localhost:8000/health
cd backend && pytest && ruff check .
cd connector && pytest && ruff check .   # hospital connector, tested against the platform in-process (M11)
cd connector && python -m scripts.gen_contract   # regenerate contracts/connector-api.yaml
python apps/dashboard/e2e/stack/run_stack.py --dir /tmp/nc-stack [--lan <wifi ip>]   # real platform + connector + FHIR stand-in, seeded; prints sign-ins
pnpm dev:dashboard        # dashboards against that stack (http://localhost:5174); see docs/qa/testing-guide.md
pnpm e2e:dashboard        # dashboards against the real platform + connector, then the no-identity scan
cd backend && python -m app.admin create-platform-admin --email you@example.org   # prints a one-time invite link (M10)
```

## Layout

See DEV_PLAN §6. Key packages: `packages/quality-core` (pure TS), `packages/capture-kit` (Capacitor plugin + Mock/Webcam impls), `packages/contracts-ts` (generated types + validator CLI), `apps/mobile` (React + Vite + Capacitor), `backend` (FastAPI), `connector` (hospital connector, FastAPI, docs/connector.md), `apps/dashboard` (web dashboards, docs/dashboard.md).
