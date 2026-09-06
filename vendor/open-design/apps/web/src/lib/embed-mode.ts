// LionClaw embed-mode detector — patch interno (SPEC docs/spec-opendesign-vendor.md
// secao 5.11, linhas 905-973). Quando o LionDesign roda dentro do LionClaw, a UI
// upstream de finalize/CLI nao participa do fluxo oficial (Design Lock eh produzido
// pelo PipelineEngine). Esse modulo expoe a deteccao client-side.
//
// Sinais aceitos (qualquer um basta, em ordem de checagem):
//
//   1. Query `?host=lionclaw` na URL atual. Injetada pelo `bootstrap.ensureSession`
//      do LionClaw na URL inicial do BrowserView/iframe.
//   2. `sessionStorage['lionclaw:embedded'] === '1'`. Cache primeiro-cabe-ganha:
//      assim que (1) eh detectado a primeira vez, gravamos o flag aqui. Necessario
//      porque o router interno do LionDesign faz `pushState`/`replaceState` SEM
//      preservar query params (`vendor/open-design/apps/web/src/router.ts:46-52`),
//      entao a query (1) some apos a primeira navegacao (abrir arquivo, etc) e
//      os botoes upstream "Finalize"/"Continue in CLI" reapareceriam sem essa
//      cinta. SessionStorage eh scoped a este partition, vive enquanto a janela
//      estiver aberta e eh limpo quando o usuario fecha o Studio.
//   3. (Server-side, fora deste arquivo) `process.env.OD_EMBED_HOST === 'lionclaw'`
//      injetado pelo `manager.start` no spawn do daemon. Esse sinal eh lido no
//      daemon (Express middleware) — nao chega no client bundle do Next sem
//      prefixo `NEXT_PUBLIC_`, entao deixamos de fora do client.
//
// Patch CONDICIONAL: sem nenhum dos 3 sinais, todos os componentes voltam ao
// comportamento upstream. Nao destrutivo.
//
// Documentacao do patch: vendor/open-design/.lionclaw-patches/embed-mode.md.

const SESSION_KEY = 'lionclaw:embedded';

function readQueryFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('host') === 'lionclaw';
  } catch {
    return false;
  }
}

function readSessionFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage?.getItem(SESSION_KEY) === '1';
  } catch {
    // sessionStorage pode falhar em iframe restrito, sandbox, ou Safari ITP.
    return false;
  }
}

function persistSessionFlag(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage?.setItem(SESSION_KEY, '1');
  } catch {
    // Falha silenciosa — proxima checagem usa a query enquanto ela existir.
  }
}

export function isLionClawEmbedded(): boolean {
  if (readQueryFlag()) {
    // Primeiro contato com a flag — persiste para sobreviver a `pushState`
    // do router upstream que descarta query params (SPEC L1170 / Findings P1.2).
    persistSessionFlag();
    return true;
  }
  return readSessionFlag();
}
