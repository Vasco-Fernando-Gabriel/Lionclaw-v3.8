# LionClaw patches for LionDesign vendor

Patches que o LionClaw aplica sobre o vendor `open-design`. Cada patch tem:
- arquivo `.md` proprio descrevendo o diff e a razao;
- referencia a secao da SPEC que motiva o patch.

Procedimento de update do vendor:
1. `rm -rf vendor/open-design && git clone <upstream> @<ref> --depth 1 vendor/open-design`.
2. `rm -rf vendor/open-design/.git`.
3. Atualizar `vendor/open-design/.vendor-meta.json` com novo commit.
4. Reaplicar manualmente cada patch desta pasta.
5. Rodar testes (snapshot da toolbar, daemon embedded, etc).

Patches atuais:

- [`embed-mode.md`](./embed-mode.md) — Sprint 3 + Findings P1.2. Esconde botoes
  `Finalize design package` e `Continue in CLI` na UI web e retorna HTTP 403
  em `*/finalize/*` no daemon quando o OD esta em modo embedded
  (`OD_EMBED_HOST=lionclaw` no env do sidecar + `?host=lionclaw` na URL
  inicial + `sessionStorage['lionclaw:embedded']` como cache para sobreviver
  ao router upstream que descarta query params). SPEC `docs/spec-opendesign-vendor.md`
  secao 5.11 (linhas 905-973).
- [`locale-query.md`](./locale-query.md) — Findings P1/P2. Faz o i18n
  upstream (`apps/web/src/i18n/index.tsx`) priorizar `?locale=<code>` da URL
  como default inicial, apos consultar `localStorage`. Necessario para que o
  `?locale=pt-BR` injetado pelo `bootstrap.ensureSession()` do LionClaw
  efetivamente abra o OD em portugues brasileiro. SPEC secao 5.6 (linhas
  632-638).
