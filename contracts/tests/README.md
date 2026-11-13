# Contract compatibility samples

- `valid/<schema>/*.json` — must validate. **Never delete a sample** when a schema changes: samples from every earlier version must still validate, or be migrated in CI (DEV_PLAN §12.2). Name samples `<what>-<schemaVersion>.json`.
- `invalid/<schema>/*.json` — must fail, and the error must name the field listed in `invalid/expected.json`.

Run: `pnpm validate`.
