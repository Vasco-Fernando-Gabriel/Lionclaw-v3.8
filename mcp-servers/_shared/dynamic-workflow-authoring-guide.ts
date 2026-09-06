
export const AUTHORING_GUIDE_EXAMPLE_START = '// --- INICIO workflow.js de referencia ---';
export const AUTHORING_GUIDE_EXAMPLE_END = '// --- FIM workflow.js de referencia ---';

export const AUTHORING_ALLOWED_AGENT_TYPES = [
  'dynamic-workflow-scout',
  'dynamic-workflow-doc-writer',
  'dynamic-workflow-coder',
  'dynamic-workflow-coder-codex',
  'dynamic-workflow-coder-glm',
  'dynamic-workflow-fixer',
  'dynamic-workflow-validator-spec',
  'dynamic-workflow-validator-regression',
  'dynamic-workflow-validator-tests',
  'dynamic-workflow-refuter',
  'dynamic-workflow-sprint-planner',
  'dynamic-workflow-plan-validator-coverage',
  'dynamic-workflow-plan-validator-criteria',
  'dynamic-workflow-plan-validator-topology',
] as const;

export const AUTHORING_GUIDE_TEXT = String.raw`# Guia de autoria de workflow dinamico (modelo canonico)

Chame este guia ANTES de todo dynamic_workflow_author. O .js E o workflow: meta literal + corpo top-level. Nao leia ~/.lionclaw/workflow-templates (copia morta, nao compila, usa gate()). O que esta aqui e a unica referencia.

## FATAL no host (o run morre ou o author e recusado se violar)
- gate() no .js autorado (gate-not-in-manifest). Nao existe plan-review: os unicos gates sao os do host (boundary:<fase>, boundary:coordinator-finished, failure:<nodeId>, cc-delivery).
- Writer (coder/-codex/-glm, fixer, doc-writer) com schema (writer-schema-forbidden). O vm nao tem git nem fs: o writer TERMINA a resposta com os blocos "ARQUIVOS TOCADOS:" e "RESUMO:" e o .js repassa esse texto adiante.
- agentType fora da lista fechada ou nao-literal (variavel/template). Lista: dynamic-workflow-scout, dynamic-workflow-doc-writer, dynamic-workflow-coder, dynamic-workflow-coder-codex, dynamic-workflow-coder-glm, dynamic-workflow-fixer, dynamic-workflow-validator-spec, dynamic-workflow-validator-regression, dynamic-workflow-validator-tests, dynamic-workflow-refuter, dynamic-workflow-sprint-planner, dynamic-workflow-plan-validator-coverage/-criteria/-topology.
- model de outra familia que o runtime do agentType (model-cross-family); model/effort por node em local/external.
- Interpolar resultado de agent()/parallel() sem await (prompt-invalid); import/require/process/fetch/Date.now()/Math.random()/new Date() sem argumento.
- Sempre "await phase(nome)": o host pode PAUSAR ali (gate boundary:<fase> quando a janela nao e verde). phase() sem await deixa o proximo agent() correr antes do gate e gastar dinheiro numa fronteira nao julgada.

## Contrato de retorno de agent() (rodada 2; leia antes de escrever qualquer prompt)
- Node SEM schema (todo writer: coder/-codex/-glm, fixer, doc-writer) devolve STRING: o texto cru da resposta. Node COM schema (scout, validadores, refuter, sprint-planner, plan-validator-*) devolve OBJETO ja parseado.
- NUNCA String(obj), "" + obj ou obj concatenado em prompt/log: vira "[object Object]" e o validador fica sem escopo. Objeto so entra em prompt, log ou digest via JSON.stringify(obj).
- Por 1 versao, TODO retorno de writer passa por textOf(r) (helper do exemplo): hosts anteriores devolviam { output: texto } e o helper cobre os dois formatos. Escopo dos validadores (ARQUIVOS TOCADOS), digest e log usam SO textOf.
- null = decisao "skip" do orquestrador. Falha nao-retryavel do node (ou retries esgotados) NAO devolve mais null direto: o host PARA dentro do agent() e abre o gate failure:<nodeId> (mode orchestrator); o orquestrador decide por dynamic_workflow_approve(runId, "failure:<nodeId>", { decision: "approve", payload: { action } }): retry (default; instruction opcional vira [AJUSTE DO ORQUESTRADOR] no MESMO node, nova attempt agora), switch-agent (+agentType), skip (o agent() devolve null ao .js) ou abort (o run morre). retry e switch-agent re-executam DENTRO do mesmo agent(): o .js nem ve.
- Entao o .js so ve null apos skip EXPLICITO: registre (log + unidade marcada "SKIPPED") e siga sem fabricar saida. Nunca trate null como sucesso, nunca lance, nunca "siga como se nada" (a unidade pulada fica visivel no digest e na fronteira). Em parallel, null naquela posicao = item pulado (filtre).
- maxTurns por agent() (1..400): writers grandes com maxTurns: 150 (o seed ja vem com 150; doc-writer 100). Unidade que passa de ~20 min ou ~100 turnos esta grande demais: quebre em 2 ACs em vez de subir maxTurns.

## Plano do sprint-planner (shape que o .js le)
agent(prompt, { agentType: "dynamic-workflow-sprint-planner", schema: PLAN }) devolve { sprints: [...] } CRU. O host so normaliza esse plano em validateSprintPlan (PROIBIDO no .js autorado), entao o .js aplica os MESMOS defaults e le os MESMOS campos do PlannedSprint normalizado:
- sprint: { id ("s0","s1"...; ausente => "s" + indice), name (ausente => "Sprint " + indice), description, stack: string[], coderAgentId (ignore: o agentType do writer e literal no .js), validatorAgentIds: string[] (ignore: os 3 validadores sao fixos por eixo), features: [...], writeSetHint: string[] (default []), dependencies: string[] (default []), maxRounds }.
- feature: { id (ausente => sprintId + "-f" + indice), name, acceptanceCriteria: string[] NAO-VAZIO }.
- A UNIDADE de trabalho e UM item de features[].acceptanceCriteria; o arquivo-alvo vem de writeSetHint. Sprint sem features ou feature sem acceptanceCriteria e plano INVALIDO: log + return { ok: false, motivo: "plano-invalido" } e re-rode o planner com os erros (nunca invente AC no lugar dele).

## Doutrina (o host NAO aplica; e o que faz o run curto e barato)
- Todo node com timeoutMs (<= 45 min; alvo 30 min para writer, 15 para read-only). Sem timeoutMs o stall cai no piso de 3 min.
- Unidade = 1 AC (ou 1 arquivo), writer com maxTurns: 150 e timeoutMs de 30 min. Se a unidade passa de ~20 min ou ~100 turnos, quebre em 2 ACs. A ULTIMA unidade de cada sprint roda npm run build alem do typecheck (os writers podem rodar npm run build, npm run lint, node --version, npm --version, printenv NODE_ENV e echo); greenCheck({ final: true }) tambem roda build quando o package.json da worktree tem o script build.
- greenCheck({ final: false }) apos CADA unidade; greenCheck({ final: true }) no fim da sprint. Nunca passe sprintIndex. Resultado { ok, inconclusive, findings, checks }: inconclusive = infra (o host bloqueia o run), nunca vermelho.
- Fan-out em parallel: ordene os itens canonicamente (where|problem) ANTES de atribuir id = "f" + indice; ids estaveis mantem o journal no resume.
- Refuter SO para P1: findings.filter(f => f.severity === "P1") DEPOIS da ordenacao canonica e dos ids; P2/P3 vao DIRETO para advisories (sem refuter, sem recheck). Saidas de validador, refuter e re-refuter ECOAM where/problem VERBATIM do finding (e por essa chave que o host fecha um P1). Nunca reescreva o texto do finding.
- Schema inline: o host valida SO objeto de topo + required; enum/properties sao IGNORADOS. Por isso o PROMPT do refuter diz "verdict: 'real' ou 'false'" e o do recheck "verdict: 'fixed' ou 'still-real'" (o modelo nao ve o schema). Leia fail-closed: P1 so conta como corrigido com rechecks[i]?.verdict === "fixed"; null (skip no parallel) = ainda aberto.
- Convergencia P1-only confirmado-real; P1 rebaixado pelo refuter (severityConfirmada P2/P3) e P2/P3 reais sao advisory (anexe ao prompt do proximo writer e do reporter).
- UM fixer de sprint, so se houver P1 real ou greenCheck final vermelho. Sem 2a rodada de validadores e sem 2o fixer: se ainda vermelho, log("SPRINT-VERDICT: RED ..."), reporter, e o .js encerra sem avancar (a fronteira sai ATENCAO e o orquestrador decide).
- Reporter por sprint = dynamic-workflow-scout com schema { unidades[], gates[], p1Restantes[], advisories[], notas } + artifact({ path: "artifacts/digest-s<N>.json", data }) + log(JSON.stringify(digest)). Tudo que entra no prompt do reporter vai por JSON.stringify (nunca concatenacao de objeto).
- adjust-next-node { nodeId, instruction } pode mirar QUALQUER node futuro por id (recusado so se o node ja iniciou/concluiu); "*" = proximo node a iniciar. Use labels previsiveis (u-<sprint>-<ac>, val-*, refute-*, fix-*, reporter-*) para o orquestrador conseguir mirar.
- Entrega e do host: o gate cc-delivery aparece sozinho quando o run escreveu codigo; voce o aprova pelo chat. Nao escreva merge/push no .js.
- Antes de author confirme o projectPath com o humano; edit_coordinator exige o run quiescente (pause antes).

## PROIBIDO no .js autorado
gate() (gate-not-in-manifest, fatal), materializeSprintPlan()/validateSprintPlan(), node sem timeoutMs ou com timeoutMs > 45 min, writer com schema, agentType fora da lista (dynamic-workflow-closer, -narrator, -maestro, -builder e qualquer outra squad), sprintIndex em greenCheck, fan-out por indice sem ordenacao canonica previa, import/require/process/fetch/Date.now()/Math.random()/new Date() sem argumento, agentType via variavel ou template, interpolar resultado de agent()/parallel() sem await, String(obj)/concatenar objeto em prompt ou log, tratar null de agent() como sucesso, escrever fora do workspace.

## Primitivas (assinaturas reais)
- agent(prompt, { agentType, label?, phase?, schema?, model?, effort?, timeoutMs, maxTurns? }) -> string (node sem schema = writer) ou objeto parseado (schema); null SO apos skip do orquestrador no gate failure:<nodeId>. schema: string "schemas/validator.schema.json" | "schemas/refute.schema.json" (incluidos em todo pacote) ou objeto JSON Schema inline (o host valida objeto de topo + required). maxTurns: 1..400.
- parallel([() => agent(...), ...], { id?, maxConcurrency? }) -> array na MESMA ordem; item pulado (skip) vira null naquela posicao (filtre).
- await phase(nome) muda a fase corrente (SEMPRE com await: o host pode pausar ali no gate boundary); { phase } por chamada poe SO aquele node na fase.
- greenCheck({ final }) -> { ok, inconclusive, findings: [{ severity: "P1", where, problem, fix }], checks }. final: true roda build quando o package.json da worktree tem o script.
- artifact({ path, data }) grava relativo ao runDir (JSON por default). log(string). args = input do run.

## Fluxo por sprint
1 documentos (scout com schema inline -> doc-writer -> sprint-planner com schema PLAN) | 2 unidades de 1 AC (coder 30 min, maxTurns 150 + greenCheck({ final: false }); vermelho => UM fixer so com gc.findings; ultima unidade roda npm run build) | 3 fim: greenCheck({ final: true }) + UMA rodada de 3 validadores em parallel, escopo fechado nos ARQUIVOS TOCADOS (via textOf) | 4 refuter SO POR P1 (effort low, le so o where); P2/P3 direto para advisory | 5 real = P1 confirmado | 6 UM fixer + greenCheck({ final: true }) + re-refute por P1 (recheck-) | 7 reporter scout + artifact | 8 auditoria DoD (scout) | 9 cc-delivery (host).

` +
'// --- INICIO workflow.js de referencia ---\n' +
String.raw`export const meta = {
  name: "feature-curta",
  description: "1 feature em sprints curtas: sprint-planner, unidades de 1 AC com maxTurns, greenCheck por unidade, build na ultima unidade, 1 rodada de validacao, refuter P1-only",
  phases: ["Documentos", "Sprint", "Auditoria"]
};

// args (input do run): { objetivo, specPath, planoPath }
const objetivo = args.objetivo;
const T30 = 30 * 60_000;
const T15 = 15 * 60_000;
const WRITER_TURNS = 150;
const VALIDATOR = "schemas/validator.schema.json";
const PLAN = {
  type: "object",
  required: ["sprints"],
  properties: {
    sprints: {
      type: "array",
      items: {
        type: "object",
        required: ["features"],
        properties: {
          id: { type: "string" }, name: { type: "string" }, description: { type: "string" },
          stack: { type: "array", items: { type: "string" } },
          writeSetHint: { type: "array", items: { type: "string" } },
          dependencies: { type: "array", items: { type: "string" } },
          features: {
            type: "array",
            items: {
              type: "object",
              required: ["acceptanceCriteria"],
              properties: { id: { type: "string" }, name: { type: "string" }, acceptanceCriteria: { type: "array", items: { type: "string" } } }
            }
          }
        }
      }
    }
  }
};
const REFUTE = {
  type: "object",
  required: ["where", "problem", "verdict", "severityConfirmada", "evidencia"],
  properties: {
    where: { type: "string" }, problem: { type: "string" },
    verdict: { type: "string", enum: ["real", "false"] },
    severityConfirmada: { type: "string", enum: ["P1", "P2", "P3"] },
    evidencia: { type: "string" }
  }
};
const RECHECK = {
  type: "object",
  required: ["where", "problem", "verdict", "evidencia"],
  properties: {
    where: { type: "string" }, problem: { type: "string" },
    verdict: { type: "string", enum: ["fixed", "still-real"] },
    evidencia: { type: "string" }
  }
};
const DIGEST = {
  type: "object",
  required: ["unidades", "gates", "p1Restantes", "advisories", "notas"],
  properties: {
    unidades: { type: "array", items: { type: "string" } },
    gates: { type: "array", items: { type: "string" } },
    p1Restantes: { type: "array", items: { type: "string" } },
    advisories: { type: "array", items: { type: "string" } },
    notas: { type: "string" }
  }
};
const FECHO = "\nTERMINE a resposta com dois blocos, nesta ordem:\nARQUIVOS TOCADOS:\n- <um caminho por linha>\nRESUMO:\n<2 linhas>";
// Contrato: writer (sem schema) devolve STRING. { output } cobre hosts anteriores por 1 versao. Nunca String(obj).
const textOf = (r) => (typeof r === "string" ? r : (r && typeof r.output === "string" ? r.output : JSON.stringify(r)));
const blocoTocados = (r) => {
  const t = textOf(r);
  const i = t.indexOf("ARQUIVOS TOCADOS:");
  return i >= 0 ? t.slice(i) : t;
};
const chave = (f) => String(f.where) + "|" + String(f.problem);

// 1. Documentos: scout read-only com schema inline, doc-writer (writer sem schema), sprint-planner (schema PLAN)
await phase("Documentos");
const mapa = await agent(
  "Mapeie o codigo relevante para: " + objetivo + ". Liste arquivos e riscos. Nao edite nada.",
  {
    agentType: "dynamic-workflow-scout", label: "mapa", timeoutMs: T15,
    schema: { type: "object", required: ["arquivos", "riscos"], properties: { arquivos: { type: "array", items: { type: "string" } }, riscos: { type: "array", items: { type: "string" } } } }
  }
);
const plano = await agent(
  "Escreva " + args.planoPath + " com o plano de entrega para: " + objetivo + "\nMapa: " + JSON.stringify(mapa) + FECHO,
  { agentType: "dynamic-workflow-doc-writer", label: "plano", timeoutMs: T30, maxTurns: 100 }
);
// null = o orquestrador decidiu skip no gate failure:plano. Registre e siga sem fabricar o documento.
if (plano === null) await log("SKIP plano: doc-writer pulado pelo orquestrador; " + args.planoPath + " nao foi escrito");
const planoCru = await agent(
  "Decomponha em sprints a SPEC " + args.specPath + " para: " + objetivo + ". Retorne SO { sprints } (cada sprint com id, name, description, stack, writeSetHint, dependencies e features com id, name e acceptanceCriteria nao-vazio).\nMapa: " + JSON.stringify(mapa),
  { agentType: "dynamic-workflow-sprint-planner", label: "planner", timeoutMs: T15, schema: PLAN }
);
// Mesmos defaults que o host aplica na validacao do plano (primitiva proibida aqui): id, feature.id, writeSetHint, dependencies.
const sprints = (planoCru && Array.isArray(planoCru.sprints) ? planoCru.sprints : []).map((s, i) => {
  const sid = typeof s.id === "string" && s.id.length > 0 ? s.id : "s" + i;
  return {
    id: sid,
    name: typeof s.name === "string" && s.name.length > 0 ? s.name : "Sprint " + i,
    writeSetHint: Array.isArray(s.writeSetHint) ? s.writeSetHint.filter((w) => typeof w === "string") : [],
    dependencies: Array.isArray(s.dependencies) ? s.dependencies : [],
    features: (Array.isArray(s.features) ? s.features : []).map((f, j) => ({
      id: typeof f.id === "string" && f.id.length > 0 ? f.id : sid + "-f" + j,
      name: typeof f.name === "string" ? f.name : "",
      acceptanceCriteria: (Array.isArray(f.acceptanceCriteria) ? f.acceptanceCriteria : []).filter((c) => typeof c === "string" && c.trim().length > 0)
    }))
  };
});
const planoInvalido = sprints.length === 0 || sprints.some((s) => s.features.length === 0 || s.features.some((f) => f.acceptanceCriteria.length === 0));
if (planoInvalido) {
  await log("PLANO INVALIDO: sprint sem features ou feature sem acceptanceCriteria. Re-rode o planner com os erros; nao invente AC.");
  return { ok: false, motivo: "plano-invalido", plano: planoCru };
}

const advisories = [];
for (const sprint of sprints) {
  await phase("Sprint " + sprint.id);
  const tocados = [];
  const unidades = [];
  const alvo = sprint.writeSetHint.length > 0
    ? "Arquivos permitidos (writeSetHint da sprint): " + sprint.writeSetHint.join(", ")
    : "Toque o minimo de arquivos necessario.";
  // Unidade = 1 AC. Se uma unidade passa de ~20 min ou ~100 turnos, ela esta grande: quebre o AC em 2.
  const acs = sprint.features.flatMap((f) => f.acceptanceCriteria.map((texto, k) => ({ id: f.id + "-a" + k, texto })));

  // 2. Unidades: writer 30 min, maxTurns 150 + greenCheck por unidade; a ULTIMA unidade roda npm run build
  for (let u = 0; u < acs.length; u++) {
    const ac = acs[u];
    const ultima = u === acs.length - 1;
    const saida = await agent(
      [
        "Implemente SOMENTE o criterio " + ac.id + ": " + ac.texto,
        alvo,
        ultima
          ? "Ultima unidade da sprint: rode npm run typecheck E npm run build antes de terminar; se o build falhar, corrija antes de responder."
          : "Rode npm run typecheck antes de terminar.",
        advisories.length > 0 ? "Advisories (P2/P3, nao bloqueiam): " + advisories.join("; ") : "",
        FECHO
      ].join("\n"),
      { agentType: "dynamic-workflow-coder", label: "u-" + sprint.id + "-" + ac.id, timeoutMs: T30, maxTurns: WRITER_TURNS }
    );
    if (saida === null) {
      // skip explicito do orquestrador (gate failure:<nodeId>): registra e segue, sem fabricar saida.
      unidades.push(ac.id + ": SKIPPED (skip do orquestrador)");
      await log("SKIP " + ac.id + " na sprint " + sprint.id + ": unidade pulada pelo orquestrador");
      continue;
    }
    unidades.push(ac.id + ": ok");
    tocados.push(blocoTocados(saida));
    const gc = await greenCheck({ final: false });
    if (!gc.ok && !gc.inconclusive) {
      const fix = await agent(
        "Corrija SOMENTE estes findings do green-check:\n" + JSON.stringify(gc.findings, null, 2) + FECHO,
        { agentType: "dynamic-workflow-fixer", label: "fix-u-" + sprint.id + "-" + ac.id, timeoutMs: T30, maxTurns: WRITER_TURNS }
      );
      if (fix === null) unidades.push(ac.id + ": fixer SKIPPED (green-check da unidade segue vermelho)");
      else tocados.push(blocoTocados(fix));
    }
  }

  // 3. Fim da sprint: greenCheck final (roda build se o package.json tiver o script) + UMA rodada de 3 validadores (escopo fechado)
  const gcFinal = await greenCheck({ final: true });
  const gates = ["sprint-final ok=" + gcFinal.ok + " inconclusive=" + gcFinal.inconclusive];
  const escopo = [
    "Criterios da sprint " + sprint.id + " (" + sprint.name + "):",
    acs.map((ac) => "- " + ac.id + ": " + ac.texto).join("\n"),
    "Leia SO estes arquivos e seus testes (blocos ARQUIVOS TOCADOS das unidades):",
    tocados.join("\n"),
    "Unidades: " + JSON.stringify(unidades),
    "Green-check do host: " + JSON.stringify({ ok: gcFinal.ok, findings: gcFinal.findings }),
    "Ecoe where e problem VERBATIM em cada finding; nunca reescreva o texto do finding."
  ].join("\n");
  const vereditos = await parallel([
    () => agent(escopo, { agentType: "dynamic-workflow-validator-spec", label: "val-spec-" + sprint.id, timeoutMs: T15, effort: "low", schema: VALIDATOR }),
    () => agent(escopo, { agentType: "dynamic-workflow-validator-regression", label: "val-reg-" + sprint.id, timeoutMs: T15, effort: "low", schema: VALIDATOR }),
    () => agent(escopo, { agentType: "dynamic-workflow-validator-tests", label: "val-tests-" + sprint.id, timeoutMs: T15, effort: "low", schema: VALIDATOR })
  ], { id: "validadores-" + sprint.id });

  // 4. Ordena canonicamente ANTES de atribuir ids estaveis; refuter SO para P1 (P2/P3 direto para advisory)
  const findings = vereditos
    .flatMap((v) => (v && Array.isArray(v.findings) ? v.findings : []))
    .sort((a, b) => (chave(a) < chave(b) ? -1 : chave(a) > chave(b) ? 1 : 0))
    .map((f, i) => ({ ...f, id: "f" + i }));
  const p1 = findings.filter((f) => f.severity === "P1");
  for (const f of findings.filter((f) => f.severity !== "P1")) advisories.push(f.where + ": " + f.problem);
  const refutations = p1.length === 0 ? [] : await parallel(
    p1.map((f) => () => agent(
      "Confirme ou refute por EVIDENCIA. Leia SO os arquivos citados em where.\nFinding: " + JSON.stringify(f) + "\nResponda JSON com where e problem VERBATIM, verdict: 'real' ou 'false' (exatamente uma dessas strings), severityConfirmada: 'P1' | 'P2' | 'P3' e evidencia.",
      { agentType: "dynamic-workflow-refuter", label: "refute-" + f.id, timeoutMs: T15, effort: "low", schema: REFUTE }
    )),
    { id: "refute-" + sprint.id, maxConcurrency: 4 }
  );

  // 5. Convergencia: so P1 confirmado-real bloqueia; P1 rebaixado pelo refuter vira advisory
  const decididos = p1.map((f, i) => ({ ...f, refute: refutations[i] }));
  const reais = decididos.filter((f) => f.refute && f.refute.verdict === "real");
  const real = reais.filter((f) => f.refute.severityConfirmada === "P1");
  for (const f of reais.filter((f) => f.refute.severityConfirmada !== "P1")) advisories.push(f.where + ": " + f.problem);
  let p1Restantes = real.map(chave);
  let verdict = "GREEN";

  // 6. UM fixer de sprint + greenCheck final + re-refute por P1 corrigido (sem 2o fixer)
  if (real.length > 0 || (!gcFinal.ok && !gcFinal.inconclusive)) {
    const fixSprint = await agent(
      "Corrija SOMENTE:\n" + JSON.stringify({ p1: real, greenCheck: gcFinal.findings }, null, 2) + FECHO,
      { agentType: "dynamic-workflow-fixer", label: "fix-" + sprint.id, timeoutMs: T30, maxTurns: WRITER_TURNS }
    );
    if (fixSprint !== null) tocados.push(blocoTocados(fixSprint));
    const gcPos = await greenCheck({ final: true });
    gates.push("pos-fixer ok=" + gcPos.ok + " inconclusive=" + gcPos.inconclusive);
    const rechecks = real.length === 0 || fixSprint === null ? [] : await parallel(
      real.map((f) => () => agent(
        "O finding abaixo foi corrigido? Leia SO os arquivos citados em where.\nFinding: " + JSON.stringify({ where: f.where, problem: f.problem }) + "\nResponda JSON com where e problem VERBATIM, verdict: 'fixed' ou 'still-real' (exatamente uma dessas strings) e evidencia.",
        { agentType: "dynamic-workflow-refuter", label: "recheck-" + f.id, timeoutMs: T15, effort: "low", schema: RECHECK }
      )),
      { id: "recheck-" + sprint.id, maxConcurrency: 4 }
    );
    // Fail-closed: so verdict === "fixed" fecha o P1 (null, texto fora do enum, still-real ou fixer pulado = aberto).
    p1Restantes = real.filter((f, i) => rechecks[i]?.verdict !== "fixed").map(chave);
    if (!gcPos.ok || p1Restantes.length > 0) {
      verdict = "RED";
      await log("SPRINT-VERDICT: RED sprint " + sprint.id + " p1Restantes=" + p1Restantes.length + " greenCheck=" + gcPos.ok);
    }
  }

  // 7. Reporter: scout por sprint com schema + artifact + log. Objetos SO via JSON.stringify.
  const dados = { unidades, tocados, gates, p1Restantes, advisories, verdict };
  const digestOut = await agent(
    "Monte o digest da sprint " + sprint.id + " SO com estes dados (nao invente):\n" + JSON.stringify(dados, null, 2),
    { agentType: "dynamic-workflow-scout", label: "reporter-" + sprint.id, timeoutMs: T15, effort: "low", schema: DIGEST }
  );
  // Reporter pulado (skip) => digest mecanico com os mesmos dados; nunca perde a sprint.
  const digest = digestOut !== null ? digestOut : { unidades, gates, p1Restantes, advisories, notas: "reporter SKIPPED; digest mecanico" };
  await artifact({ path: "artifacts/digest-" + sprint.id + ".json", data: digest });
  await log(JSON.stringify(digest));
  if (verdict === "RED") return { ok: false, sprint: sprint.id, digest };
}

// 8. Auditoria final DoD (read-only). 9. A entrega fica com o gate cc-delivery do host.
await phase("Auditoria");
const dod = await agent(
  "Audite a Definition of Done de: " + objetivo + ". Confira cada AC no codigo e nos testes. Nao edite nada.\nSprints: " + JSON.stringify(sprints),
  { agentType: "dynamic-workflow-scout", label: "dod", timeoutMs: T15, schema: { type: "object", required: ["ok", "pendencias"], properties: { ok: { type: "boolean" }, pendencias: { type: "array", items: { type: "string" } } } } }
);
// dod pode ser null (skip do orquestrador): nunca lance; null = nao auditado.
return { ok: dod?.ok === true, pendencias: dod?.pendencias ?? ["auditoria DoD nao concluida"] };
` +
'// --- FIM workflow.js de referencia ---\n' +
String.raw`
## Model e effort por node (DINAMISMO POR NODE)
Cada agent() aceita model e effort proprios. effort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra". Na familia Claude, "xhigh"/"max"/"ultra" viram "max". REGRA INTRA-FAMILIA: o provider vem do agentType e nunca muda; o model tem que ser da mesma familia do runtime (claude-* em cloud, glm-* em zai, minimax-* em minimax-tp, gpt-*/codex-* em codex, grok-* em grok, kimi-code/* em kimi); cruzar familia e fatal model-cross-family. Override de model transportado em cloud/zai/minimax-tp/codex/grok; Kimi aceita apenas effort por node (model override e fatal) e so os tiers anunciados pelo modelo (K3: low/high/max; K2.7 rejeita effort explicito). Grok suporta model/effort (low/medium/high). Em local/external, model/effort por node e erro fatal. "ultra" so executa em node CODEX com modelo gpt-5.6 que o anuncie, custa 2-3x: NUNCA escolha "ultra" por conta propria, so quando o humano pediu. Roster sugerido: validadores e refuters effort "low"; coder/fixer "high"; planner opus.
`;
