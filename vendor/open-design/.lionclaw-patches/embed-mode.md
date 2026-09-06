# embed-mode patch

Esconde botoes upstream do LionDesign quando rodando dentro do LionClaw e bloqueia
endpoints de finalize server-side.

## Motivacao

SPEC `docs/spec-opendesign-vendor.md` secao 5.11 (linhas 905-973). O Design Lock
oficial eh produzido pelo `PipelineEngine` do LionClaw (fase 5 do pipeline
`development-v2`); qualquer botao/endpoint de finalize concorrente quebra essa
garantia (gera `DESIGN.md` upstream que NAO eh contrato, exige BYOK Anthropic,
ignora `sessionConfig`).

Decisao explicita: o snapshot oficial do Design Lock **nao** consome `DESIGN.md`
upstream (SPEC L957-959). Se o OD gerar internamente, fica orfao no projeto OD
local — sem efeito nas fases 6+.

## Sinal de ativacao (tres camadas — duas client, uma server)

- **Server-side (daemon):** variavel de ambiente `OD_EMBED_HOST=lionclaw`,
  injetada pelo `electron/main/open-design/manager.ts:buildSidecarRuntimeEnv()`
  no `spawn` do sidecar (apos o filtro de prefixos `OD_*` proibidos, igual a
  reinjecao controlada de `OD_DATA_DIR`).
- **Client-side primaria:** query `?host=lionclaw` na URL inicial, emitida pelo
  `electron/main/open-design/bootstrap.ts:ensureSession()` no `webUrl` retornado.
  Necessaria porque Next.js client bundle nao acessa `process.env.OD_EMBED_HOST`
  em runtime sem prefixo `NEXT_PUBLIC_`.
- **Client-side secundaria (cache, Findings P1.2):** `sessionStorage['lionclaw:embedded']='1'`,
  gravada na primeira deteccao da query acima. Necessaria porque o router upstream
  faz `pushState`/`replaceState` SEM preservar query params
  (`vendor/open-design/apps/web/src/router.ts:46-52`), entao a query some apos
  o usuario abrir um arquivo. Sem esse cache, os botoes upstream voltariam a
  aparecer dentro de uma mesma sessao do Studio.

Ambas sao injetadas/originadas pelo LionClaw e jamais documentadas para o
usuario setar. Sem flag, o vendor mantem 100% do comportamento upstream — patch
CONDICIONAL, nao destrutivo.

## Arquivos tocados

- `apps/web/src/lib/embed-mode.ts` (NOVO) — helper `isLionClawEmbedded()`
  baseado em `window.location.search`.
- `apps/web/src/components/ProjectActionsToolbar.tsx` — esconde botoes
  `Finalize design package` e `Continue in CLI` quando `isLionClawEmbedded()`.
  Adiciona `data-testid="finalize-package"` e `data-testid="continue-in-cli"`
  como wrappers dos botoes (SPEC L1093 — snapshot da toolbar nao pode conter
  esses testids em modo embedded).
- `apps/daemon/src/import-export-routes.ts` — middleware no `registerFinalizeRoutes`
  que retorna `403 { error: 'embedded mode: finalize disabled' }` em qualquer
  `*/finalize/*` quando `OD_EMBED_HOST=lionclaw`. Guard adicional in-handler
  para `POST /api/projects/:id/finalize/anthropic` (defense-in-depth).

## Diffs

### apps/web/src/lib/embed-mode.ts (NOVO)

```ts
// LionClaw embed-mode detector — patch interno (SPEC docs/spec-opendesign-vendor.md
// secao 5.11, linhas 905-973). Quando o LionDesign roda dentro do LionClaw, a UI
// upstream de finalize/CLI nao participa do fluxo oficial (Design Lock eh produzido
// pelo PipelineEngine). Esse modulo expoe a deteccao client-side.
//
// Sinal: query `?host=lionclaw` na URL inicial, injetada pelo LionClaw via
// `bootstrap.ensureSession` (cinta secundaria). A cinta primaria seria a env var
// `OD_EMBED_HOST=lionclaw` injetada pelo `manager.start` (server-side / spawn env),
// mas Next.js client bundle nao tem acesso a `process.env.OD_EMBED_HOST` em runtime
// sem prefixo `NEXT_PUBLIC_` — entao o cliente le a query, e o server le a env.
//
// Patch CONDICIONAL: sem `?host=lionclaw`, todos os componentes voltam ao
// comportamento upstream. Nao destrutivo.

export function isLionClawEmbedded(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('host') === 'lionclaw';
  } catch {
    return false;
  }
}
```

### apps/web/src/components/ProjectActionsToolbar.tsx (diff resumido)

```diff
+import { isLionClawEmbedded } from '../lib/embed-mode';

 export function ProjectActionsToolbar({
   designMdState,
   finalizeStatus,
   onFinalize,
   onCancelFinalize,
   onContinueInCli,
   hidden,
 }: ProjectActionsToolbarProps) {
   if (hidden) return null;
+  const embedded = isLionClawEmbedded();
   return (
     <div className="project-actions-toolbar" role="toolbar" aria-label="Project actions">
-      <FinalizeDesignButton ... />
-      <ContinueInCliButton ... />
+      {embedded ? null : (
+        <span data-testid="finalize-package">
+          <FinalizeDesignButton ... />
+        </span>
+      )}
+      {embedded ? null : (
+        <span data-testid="continue-in-cli">
+          <ContinueInCliButton ... />
+        </span>
+      )}
     </div>
   );
 }
```

### apps/daemon/src/import-export-routes.ts (diff resumido)

```diff
 export function registerFinalizeRoutes(app: Express, ctx: RegisterFinalizeRoutesDeps) {
   const { db } = ctx;
   // ...
+  // LionClaw embed-mode middleware: bloqueia *qualquer* `*/finalize/*`
+  // com 403 quando `OD_EMBED_HOST=lionclaw`.
+  app.use((req, res, next) => {
+    if (process.env.OD_EMBED_HOST === 'lionclaw' && /\/finalize\//.test(req.path)) {
+      return res.status(403).json({ error: 'embedded mode: finalize disabled' });
+    }
+    return next();
+  });

   app.post('/api/projects/:id/finalize/anthropic', async (req, res) => {
+    // Defense-in-depth: guard duplicado in-handler.
+    if (process.env.OD_EMBED_HOST === 'lionclaw') {
+      return res.status(403).json({ error: 'embedded mode: finalize disabled' });
+    }
     const { apiKey, baseUrl, model, maxTokens } = req.body || {};
     // ... (resto do handler upstream inalterado) ...
   });
 }
```

Nota sobre o middleware: o regex `/\/finalize\//` eh estreito; rotas registradas
no mesmo `app` antes desse `app.use` ja foram resolvidas, mas o middleware esta
contido dentro do `registerFinalizeRoutes` e nao afeta rotas com path fora de
`*/finalize/*`. Para qualquer rota nova de finalize que o upstream adicionar (ex:
`POST /api/projects/:id/finalize/openai`), o middleware vai bloquear
automaticamente — consistente com a allow-list interna do adapter HTTP do
LionClaw (`electron/main/open-design/adapter-http.ts`).

## Procedimento de reaplicacao apos update do vendor

1. Atualizar o vendor seguindo `vendor/open-design/.lionclaw-patches/README.md`
   (rm -rf + clone + flatten do .git + update do `.vendor-meta.json`).
2. Re-aplicar manualmente os tres trechos acima:
   - Criar `apps/web/src/lib/embed-mode.ts` com o conteudo completo do diff.
   - Aplicar o diff no `ProjectActionsToolbar.tsx` (import + condicional dos botoes
     + `data-testid` wrappers).
   - Aplicar o diff no `import-export-routes.ts` (middleware + guard no handler).
3. Verificar manualmente que outras rotas que renderizam os botoes (qualquer
   componente novo no upstream que importe `FinalizeDesignButton` ou
   `ContinueInCliButton` direto) tambem sao patchados. Hoje (vendor flatten de
   referencia em `.vendor-meta.json`) a unica renderizacao eh em
   `apps/web/src/components/ProjectView.tsx` via `ProjectActionsToolbar`.
4. Rodar:
   - `npx vitest run electron/main/__tests__/open-design-manager-start.test.ts` —
     valida que `OD_EMBED_HOST=lionclaw` esta injetado no spawn env (SPEC L1090).
   - `npx vitest run electron/main/__tests__/open-design-adapter-http.test.ts` —
     valida allow-list do adapter (SPEC L1092).
   - `npx vitest run electron/main/__tests__/open-design-bootstrap.test.ts` —
     valida `?host=lionclaw` no `webUrl` retornado (SPEC L1091).
5. Smoke manual do daemon (SPEC L1094) — opcional, quando alterar codigo do vendor:
   - `cd vendor/open-design && OD_EMBED_HOST=lionclaw pnpm tools-dev run web ...`
   - `curl -X POST http://127.0.0.1:<daemon-port>/api/projects/x/finalize/anthropic`
     deve retornar HTTP 403 com body `{"error":"embedded mode: finalize disabled"}`.
   - Sem `OD_EMBED_HOST`, deve retornar 400 (BAD_REQUEST por payload faltando) —
     comportamento upstream preservado.
6. Smoke manual da toolbar (SPEC L1093) — opcional:
   - Abrir `http://127.0.0.1:<web-port>/projects/<id>?host=lionclaw` no browser e
     verificar que os botoes `Finalize design package` e `Continue in CLI` NAO
     estao renderizados na toolbar.
   - Abrir a mesma URL SEM `?host=lionclaw` e verificar que ambos os botoes
     aparecem (comportamento upstream).
