import type Database from 'better-sqlite3';

const OLD_SECTION = `Por que: o validador adversarial e ESTATICO (so LE o codigo, nao roda testes) e o gate de entrega so confere no FIM. Quem garante verde durante o desenvolvimento e o PROPRIO coder, rodando os comandos. Um coder que reporta pronto com verificacao vermelha e o defeito numero 1 a evitar. Gere o CODER_CONTRACT com essa disciplina LITERAL ("rode ate verde; so declare pronto com tudo passando") - NUNCA o generico "valide antes de declarar pronto", que deixa passar teste vermelho.

## Regras do workflow.js (subset ESM restrito)`;

const NEW_SECTION = `Por que: o validador adversarial e ESTATICO (so LE o codigo, nao roda testes) e o gate de entrega so confere no FIM. Quem garante verde durante o desenvolvimento e o PROPRIO coder, rodando os comandos. Um coder que reporta pronto com verificacao vermelha e o defeito numero 1 a evitar. Gere o CODER_CONTRACT com essa disciplina LITERAL ("rode ate verde; so declare pronto com tudo passando") - NUNCA o generico "valide antes de declarar pronto", que deixa passar teste vermelho.

## Green-check objetivo por rodada (host; obrigatorio no dev-loop)

Os validadores de codigo sao ESTATICOS (so LEEM): convergir contando SO os findings deles deixa a sprint convergir mesmo com typecheck/test VERMELHO. Por isso o workflow.js que voce gera DEVE, em cada rodada do dev-loop (apos o coder e o fix da rodada), chamar a primitiva HOST greenCheck() e MESCLAR os findings dela no MESMO set de convergencia que o devBlockersOf consome, ANTES dele:
- greenCheck(arg) e NAO-BLOQUEANTE: o HOST roda typecheck + test (e build quando o projeto tem build script E a rodada e candidata a convergencia, via arg.final===true) e devolve { ok, findings, checks } SEM dar throw. Vermelho do host = finding P1 deterministico; nunca aborta o run (ao contrario de gate(mode:'auto')).
- A primitiva esta no ctx ao lado de validateSprintPlan/materializeSprintPlan (mesma familia). NAO use shell do agente para isso: o green-check roda no HOST e e runtime-agnostico (o node nao precisa de Bash).
- greenCheck() devolve findings CRUS no formato { severity, where, problem, fix } (nao um grupo). O dedupeFindings itera GRUPOS com .findings; para nao engolir os findings do host, embrulhe-os como um GRUPO: const findings = dedupeFindings([...validators, { findings: greenCheckFindings }]). Mesclar findings crus direto (...greenCheckFindings) faz o dedupe ignora-los e o vermelho do host some - o oposto do objetivo.
- Posicao EXATA no loop: rode greenCheck e mescle ANTES de calcular const blockers = devBlockersOf(findings). Build caro (monorepo) NAO roda toda rodada: passe arg.final===true SO na rodada candidata a convergencia (quando os validadores read-only ja zeraram bloqueio), senao arg.final fica false (so typecheck+test).
Sem esse merge, a sprint converge so porque os validadores read-only nao acharam P1 - mesmo com o green-check vermelho. O finding do host entra no MESMO set que o devBlockersOf consome.

## Regras do workflow.js (subset ESM restrito)`;

const OLD_PRIMITIVES = `- Use somente as primitivas injetadas no ctx: phase, agent, parallel, gate, artifact, checkpoint, log, alem das primitivas de plano validateSprintPlan e materializeSprintPlan.`;

const NEW_PRIMITIVES = `- Use somente as primitivas injetadas no ctx: phase, agent, parallel, gate, artifact, checkpoint, log, alem das primitivas de plano validateSprintPlan e materializeSprintPlan e a primitiva de verificacao greenCheck (green-check objetivo por rodada, NAO-BLOQUEANTE).`;

const NEW_MARKER = 'Green-check objetivo por rodada (host; obrigatorio no dev-loop)';

export function applyMigrationV111(db: Database.Database): void {
  db.prepare(
    `UPDATE agents SET system_prompt = REPLACE(system_prompt, ?, ?)
       WHERE id = 'dynamic-workflow-builder'
         AND system_prompt LIKE ?
         AND system_prompt NOT LIKE ?`,
  ).run(OLD_SECTION, NEW_SECTION, `%${OLD_SECTION}%`, `%${NEW_MARKER}%`);

  db.prepare(
    `UPDATE agents SET system_prompt = REPLACE(system_prompt, ?, ?)
       WHERE id = 'dynamic-workflow-builder'
         AND system_prompt LIKE ?
         AND system_prompt NOT LIKE ?`,
  ).run(OLD_PRIMITIVES, NEW_PRIMITIVES, `%${OLD_PRIMITIVES}%`, `%${NEW_PRIMITIVES}%`);
}
