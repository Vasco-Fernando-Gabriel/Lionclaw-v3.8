# LionDesign Vendor

This is a pruned LionDesign vendor embedded in LionClaw.

It is used by the LionClaw `development-v2` pipeline for the LionDesign Studio phase. LionClaw starts the sidecar from this directory through `electron/main/open-design/manager.ts` with:

```bash
pnpm tools-dev run web
```

## Upstream

Source metadata is stored in `.vendor-meta.json`.

Current imported upstream:

```json
{
  "upstream": "https://github.com/nexu-io/open-design.git",
  "commit": "5bd9763181f2c868e1439bfc4842859ec69df102"
}
```

## Pruned Shape

This vendor intentionally does not include upstream docs, CI, release automation, deployment files, Nix files, e2e suites, translations, screenshots, or local caches.

Those surfaces are not used by LionClaw runtime and should not be reintroduced unless a LionClaw feature explicitly depends on them.

## Runtime Surfaces Kept

- `apps/`
- `packages/`
- `tools/`
- `scripts/`
- `skills/`
- `design-systems/`
- `design-templates/`
- `assets/`
- `prompt-templates/`
- `craft/`
- `templates/`
- package and lock files
- `LICENSE`
- `.vendor-meta.json`
- `.lionclaw-patches/`
- `AGENTS.md` and `CLAUDE.md`

## Notes

- `node_modules/`, `.tmp/`, `dist/`, `.next/`, and logs are local generated state and are intentionally ignored.
- If LionDesign is used after a cleanup, the LionClaw boot-installer may reinstall vendor dependencies.
- Agent instructions for this pruned vendor are in `AGENTS.md`.
