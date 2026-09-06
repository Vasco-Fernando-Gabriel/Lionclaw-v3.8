# E2E (Playwright + Electron)

Testes end-to-end que dirigem o app Electron **buildado** via `_electron.launch`.

## Seguranca / isolamento

- Rodam contra um **profile isolado** (`HOME` de teste, default `/tmp/lionclaw-e2e-home`),
  nunca o `~/.lionclaw` real. O DB do LionClaw fica em `$HOME/.lionclaw` (ver `paths.ts`),
  entao trocar `HOME` isola tudo: DB, scheduler, Telegram, MCP.
- O boot do profile de teste sobe vazio: scheduler sem tasks, Telegram sem token, MCP sem config.
  Nenhum turno de LLM/MCP e disparado.
- A senha vem de `E2E_PASSWORD` (env), **nunca** commitada.

## Rodar

```bash
npm run build                                   # gera dist/ (uma vez)
E2E_PASSWORD='<senha>' bash e2e/seed-profile.sh # cria o profile isolado semeado
E2E_PASSWORD='<senha>' npm run test:e2e         # roda os testes
```

Screenshots ficam em `e2e/.artifacts/` (gitignored).

## Cobertura atual (`context-bar.spec.ts`)

Login (senha, sem 2FA) -> abre uma sessao com contexto persistido -> valida que a
**barrinha de contexto hidrata** (`ctx: 550.0K / 1.0M`, ~55%), que o **slider de
compactacao** em Settings mostra 55%, e que o texto legado "LM Studio" foi removido.
