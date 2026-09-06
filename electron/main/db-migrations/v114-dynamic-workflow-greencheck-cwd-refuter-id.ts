import type Database from 'better-sqlite3';


const BUILDER_CWD_OLD = `- Posicao EXATA no loop: rode greenCheck DEPOIS dos validadores e ANTES de decidir a convergencia. Build caro (monorepo) NAO roda toda rodada: passe arg.final===true SO na rodada candidata a convergencia (quando os validadores read-only ja zeraram bloqueio), senao arg.final fica false (so typecheck+test).`;
const BUILDER_CWD_NEW = `- Posicao EXATA no loop: rode greenCheck DEPOIS dos validadores e ANTES de decidir a convergencia. Build caro (monorepo) NAO roda toda rodada: passe arg.final===true SO na rodada candidata a convergencia (quando os validadores read-only ja zeraram bloqueio), senao arg.final fica false (so typecheck+test). SEMPRE passe o sprintIndex da sprint atual no arg (greenCheck({ final, sprintIndex })): em batch PARALELO o coder escreve numa worktree DEDICADA da sprint e o green-check TEM que rodar NESSE cwd (resolveSprintCwd) - sem o sprintIndex ele roda no repoRoot e valida o codigo ERRADO.`;
const BUILDER_CWD_MARKER = 'sem o sprintIndex ele roda no repoRoot e valida o codigo ERRADO';

const BUILDER_ID_OLD = `O codigo que monta os refutados-reais e FAIL-CLOSED: ITERA os findings CRUS dos validadores (a fonte da severidade/problem/fix) e descarta um finding SO quando ha uma refutacao correlata (por where/ref, 1:1) com verdict==='ruido'. Um finding cru SEM refutacao correlata (o refuter nao o julgou, errou o 'ref', ou ha colisao de varios no mesmo where) e MANTIDO com a severidade CRUA, NUNCA rebaixado para o numero do LLM. Assim um refuter que erra o ref ou rebaixa um P1 real NAO some o blocker (fail-OPEN); no maximo deixa de descartar um ruido (seguro). A severidade e SEMPRE a reportada pelo validador; o 'ref' do refuter so escolhe O QUE descartar, nunca a nota.`;
const BUILDER_ID_NEW = `O codigo que monta os refutados-reais e FAIL-CLOSED e correlaciona por ID ESTAVEL: atribua um 'id' unico a CADA finding cru ANTES de chamar o refuter (ex: 'f'+indice) e mande o refuter ecoar esse id no campo 'ref'. ITERA os findings CRUS dos validadores (a fonte da severidade/problem/fix) e descarta um finding SO quando ha uma refutacao com o ID EXATO dele dizendo verdict==='ruido'. Correlacionar por where era AMBIGUO: dois findings DISTINTOS no mesmo local colidiam e um 'ruido' podia descartar o finding ERRADO (inclusive um P1 real). Um finding cru SEM refutacao de id exato (o refuter nao o julgou, ou errou o id) e MANTIDO com a severidade CRUA, NUNCA rebaixado para o numero do LLM. Assim um refuter que erra o id ou rebaixa um P1 real NAO some o blocker (fail-OPEN); no maximo deixa de descartar um ruido (seguro). A severidade e SEMPRE a reportada pelo validador; o 'ref' so escolhe O QUE descartar, nunca a nota nem QUAL outro finding.`;
const BUILDER_ID_MARKER = 'FAIL-CLOSED e correlaciona por ID ESTAVEL';

const REFUTER_REF_OLD = `- ref: o where (ou id) do finding original, ancorando a refutacao ao finding cru.`;
const REFUTER_REF_NEW = `- ref: o id EXATO do finding original (o campo "id" que vem em CADA finding cru do lote). A correlacao e por id, NUNCA por where: dois findings podem cair no mesmo where (arquivo/linha) e a refutacao tem que apontar o finding EXATO. Se voce nao colocar o id certo, a refutacao nao casa e o finding cru e MANTIDO (fail-closed).`;
const REFUTER_REF_MARKER = 'o id EXATO do finding original';

export function applyMigrationV114(db: Database.Database): void {
  db.prepare(
    `UPDATE agents SET system_prompt = REPLACE(system_prompt, ?, ?)
       WHERE id = 'dynamic-workflow-builder'
         AND system_prompt LIKE ?
         AND system_prompt NOT LIKE ?`,
  ).run(BUILDER_CWD_OLD, BUILDER_CWD_NEW, `%${BUILDER_CWD_OLD}%`, `%${BUILDER_CWD_MARKER}%`);

  db.prepare(
    `UPDATE agents SET system_prompt = REPLACE(system_prompt, ?, ?)
       WHERE id = 'dynamic-workflow-builder'
         AND system_prompt LIKE ?
         AND system_prompt NOT LIKE ?`,
  ).run(BUILDER_ID_OLD, BUILDER_ID_NEW, `%${BUILDER_ID_OLD}%`, `%${BUILDER_ID_MARKER}%`);

  db.prepare(
    `UPDATE agents SET system_prompt = REPLACE(system_prompt, ?, ?)
       WHERE id = 'dynamic-workflow-refuter'
         AND system_prompt LIKE ?
         AND system_prompt NOT LIKE ?`,
  ).run(REFUTER_REF_OLD, REFUTER_REF_NEW, `%${REFUTER_REF_OLD}%`, `%${REFUTER_REF_MARKER}%`);
}
