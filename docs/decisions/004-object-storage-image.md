# 004 — Dev object storage image (NEEDS REVIEW)

- **Status:** proposed — needs human decision
- **Date:** 2026-11-13
- **Milestone:** M0

## Context

DEV_PLAN §4 uses MinIO for S3-compatible storage in dev. The official `minio/minio` image is no longer
published on Docker Hub (pull fails: "repository does not exist"), and `quay.io` is not reachable from
the build environment. Third-party rebuilds exist (e.g. `pgsty/minio`), and other S3-compatible servers
(e.g. SeaweedFS, Garage) are alternatives. Choosing a third-party image is a supply-chain decision.

## Decision (interim)

`docker-compose.yml` runs **api + postgres** by default. The storage service is behind the `storage`
profile and requires `NC_MINIO_IMAGE` to be set explicitly. Without it, `/health` reports
`storage: not_configured` (still 200). Upload work (M7) is blocked on this decision.

## Options for review

1. Build MinIO from source (AGPLv3) into our own image in our registry.
2. Use a vetted third-party image, pinned by digest.
3. Use a different S3-compatible server (SeaweedFS, Garage) in dev; production uses the cloud provider's S3.
4. Use the chosen production cloud's S3 (India region, §19) for dev too.
