# tools/replay

Recomputes a take's capture verdict and biomarker readiness from its own saved evidence with the
same `quality-core` build the phone ran (`evaluateRecordedTake`), and compares with the phone's
`quality.json` (DEV_PLAN M8).

```bash
pnpm replay <takeDir|folder> [more…] [--config ../config] [--check] [--write] [--json]
```

A take directory holds plaintext files: `quality.json` (required), `landmarks.bin`, `sensors.bin`,
`capture.json` (optional). Encrypted uploads are decrypted first on the server with dev keys
(`backend/analysis/export_take.py`).

| Parity             | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `match`            | verdict, reasons, readiness, events and movement window equal the phone's  |
| `mismatch`         | same inputs and versions, different result: a bug — investigate            |
| `input_mismatch`   | files differ from the ones the phone evaluated (SHA-256) or are unreadable |
| `version_mismatch` | other test config, quality-core or registry version: parity not defined    |
| `no_inputs`        | `quality.json` written before M8 (no `replayInputs`)                       |

`--check` exits 1 unless every take matches. `test/parity.test.ts` runs 50 mock-recorded takes
(5 tests × 5 performances × full / stopped early) through the app's own evaluation and replay.
