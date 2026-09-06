# locale-query patch

Faz o i18n do LionDesign priorizar `?locale=<code>` da URL como default
inicial, depois de consultar `localStorage`.

## Motivacao

SPEC `docs/spec-opendesign-vendor.md` secao 5.6 (linhas 632-638): _"a UI do
OD deve iniciar em `pt-BR` quando o app LionClaw estiver em PT-BR; o
`bootstrap.ensureSession` propaga o locale via query/config patchada"_.

O `bootstrap.ensureSession()` ja construia `webUrl =
${base}/projects/${id}?host=lionclaw&locale=pt-BR`, mas o i18n upstream
ignorava o parametro: a funcao `detectInitialLocale()` so consultava
`localStorage['open-design:locale']` e caia em `'en'` quando ausente. Em
qualquer cold start, o OD abria em ingles mesmo com a query setada.

Findings P1/P2 marcou isso como bug — o efeito ao usuario era continuar
vendo a UI do OD em ingles mesmo com o LionClaw configurado para PT-BR.

## Arquivos tocados

- `apps/web/src/i18n/index.tsx` — `detectInitialLocale()` agora aplica
  prioridade condicional ao modo:

  **Modo embedded (`?host=lionclaw` ou `sessionStorage['lionclaw:embedded']='1'`):**
  1. Query `?locale=<code>` ganha (LionClaw eh autoridade da sessao).
  2. `localStorage['open-design:locale']`.
  3. Default `'en'`.

  **Modo standalone (sem flag de embedded):**
  1. `localStorage` (comportamento upstream, pick manual do usuario).
  2. Query `?locale=<code>` (defensivo).
  3. Default `'en'`.

  Em ambos os modos, quando a query eh aceita ela persiste no `localStorage`
  para sobreviver ao router upstream que descarta query params.

## Diff resumido

```diff
+function readLocaleFromQuery(): Locale | null {
+  if (typeof window === 'undefined') return null;
+  try {
+    const raw = new URLSearchParams(window.location.search).get('locale');
+    if (raw && (LOCALES as string[]).includes(raw)) return raw as Locale;
+  } catch {
+    /* ignore */
+  }
+  return null;
+}

 function detectInitialLocale(): Locale {
   if (typeof window === 'undefined') return 'en';
   try {
     const stored = window.localStorage.getItem(LS_KEY);
     if (stored && (LOCALES as string[]).includes(stored)) {
       return stored as Locale;
     }
   } catch {
     /* ignore */
   }
+  const fromQuery = readLocaleFromQuery();
+  if (fromQuery) {
+    try { window.localStorage.setItem(LS_KEY, fromQuery); } catch { /* ignore */ }
+    return fromQuery;
+  }
   return 'en';
 }
```

Patch CONDICIONAL: sem `?locale=` valido e sem `localStorage`, comportamento
upstream (`'en'`) eh preservado integralmente.

## Procedimento de reaplicacao apos update do vendor

1. Atualizar o vendor (ver `vendor/open-design/.lionclaw-patches/README.md`).
2. Aplicar o diff acima em `apps/web/src/i18n/index.tsx`. Se o upstream
   refatorou `detectInitialLocale`, encaixar a checagem da query DEPOIS da
   leitura de `localStorage` e ANTES do fallback `'en'`.
3. Smoke manual:
   - **Embedded + localStorage limpo:** abrir `<webUrl>/projects/<id>?host=lionclaw&locale=pt-BR`.
     UI deve abrir em PT-BR.
   - **Embedded + localStorage com `en` pre-gravado:** mesmo URL acima.
     UI deve **mudar para PT-BR** (query do LionClaw vence — fluxo do Findings P2 sobre prioridade).
   - **Standalone (sem `?host=lionclaw`):** trocar idioma no menu para `'en'`,
     reabrir com `?locale=pt-BR`. UI deve permanecer em `'en'` (pick manual
     via localStorage ganha — comportamento upstream preservado).
