# LionDesign Vendor Agent Guide

This directory is a pruned LionDesign vendor embedded in LionClaw. It is used by the LionClaw `development-v2` pipeline for the LionDesign Studio phase.

## What Must Stay

The following paths are active runtime, build, or catalog surfaces:

- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.node-version`
- `.vendor-meta.json`, `LICENSE`, `.lionclaw-patches/`
- `apps/daemon`, `apps/web`, `apps/desktop`, `apps/packaged`
- `packages/contracts`, `packages/sidecar-proto`, `packages/sidecar`, `packages/platform`
- `tools/dev`, `tools/pack`, `tools/pr`
- `scripts/`
- `skills/`
- `design-systems/`
- `design-templates/`
- `assets/`
- `prompt-templates/`
- `craft/`
- `templates/`

Do not remove these unless the LionClaw LionDesign integration is being intentionally redesigned.

## What Was Pruned

The upstream repository included docs, CI, release, deployment, Nix, translation, and e2e material that is not part of LionClaw runtime. These surfaces were intentionally removed from the embedded vendor:

- `.github/`
- `docs/`
- `e2e/`
- `deploy/`
- `nix/`
- `specs/`
- `story/`
- localized `README.*.md`, `QUICKSTART*.md`, `CONTRIBUTING*.md`, `MAINTAINERS*.md`
- `TRANSLATIONS.md`, `CHANGELOG.md`
- generated or local runtime folders such as `node_modules/`, `.tmp/`, `dist/`, `.next/`

Do not reintroduce those paths just because upstream has them. Reintroduce only if a LionClaw feature explicitly depends on them.

## Runtime Shape

LionClaw starts LionDesign through `electron/main/open-design/manager.ts` by running:

```bash
pnpm tools-dev run web
```

The command runs with `vendor/open-design` as cwd. The LionDesign daemon/web runtime then creates and edits project artifacts in the LionDesign project cwd under `OD_DATA_DIR`, not in this vendor source tree.

## Agent Context

`CLAUDE.md` points at this file so agent CLIs that auto-read repository instructions get the LionClaw-specific vendor rules.

If you edit under a module with its own `AGENTS.md`, read that file too. Directory-level files describe local package boundaries; this root file describes the pruned vendor contract inside LionClaw.

## Edit Rules

- Keep runtime code and catalogs intact.
- Keep package manifests and workspace links coherent.
- Do not add GitHub Actions, external deployment config, release automation, or upstream e2e suites back into this vendor.
- Do not change LionClaw's Claude SDK, Codex SDK, LionSDK, orchestrator, pipeline, harness, or IPC while cleaning this vendor.
- If package manifests, workspace layout, or generated command entrypoints change, run `pnpm install` in this vendor before validating.

## Useful Validation

For vendor code changes, prefer targeted commands from inside `vendor/open-design`:

```bash
pnpm --filter @open-design/tools-dev build
pnpm --filter @open-design/daemon build
pnpm --filter @open-design/web typecheck
pnpm --filter @open-design/contracts build
```

For pure cleanup of pruned docs, CI, caches, or local build output, these commands are not required.
