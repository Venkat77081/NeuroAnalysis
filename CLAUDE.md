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
- Biomarker readiness is **never shown to operators**. Retake-fixable readiness failures become plain RETAKE reasons.
- Override = **"Keep this take…"** → reason required → "Keep and flag for review" → shown as "Kept · flagged".

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
```

## Layout

See DEV_PLAN §6. Key packages: `packages/quality-core` (pure TS), `packages/capture-kit` (Capacitor plugin + Mock/Webcam impls), `packages/contracts-ts` (generated types + validator CLI), `apps/mobile` (React + Vite + Capacitor), `backend` (FastAPI).
