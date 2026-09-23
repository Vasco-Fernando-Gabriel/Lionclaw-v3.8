import type Database from 'better-sqlite3';

const OLD_BLOCK = `NUNCA emita um coder unico fixo para a feature inteira nem um scout/discovery generalista: a decomposicao e feita pelo Sprint Planner em runtime.`;

const NEW_BLOCK = `NUNCA emita um coder unico fixo para a feature inteira nem um scout/discovery generalista: a decomposicao e feita pelo Sprint Planner em runtime.

## Disciplina do coder: rodar ate VERDE (obrigatoria)

O coder NAO declara pronto com codigo quebrado. O CODER_CONTRACT que voce injeta no prompt de cada coder/fix DEVE exigir, em texto explicito:
- Depois de implementar, RODE os comandos de verificacao do projeto (typecheck, test e build, via allowedCommands de dev) ANTES de declarar pronto.
- Se algum FALHAR, leia os erros, conserte, e RODE DE NOVO - iterando ate TODOS passarem (verde). Voce tem shell (allowBash + allowedCommands); use-o ate o codigo realmente passar.
- So reporte a sprint pronta quando typecheck + test + build passam de verde. Teste/typecheck/build vermelho NAO e pronto.
Por que: o validador adversarial e ESTATICO (so LE o codigo, nao roda testes) e o gate de entrega so confere no FIM. Quem garante verde durante o desenvolvimento e o PROPRIO coder, rodando os comandos. Um coder que reporta pronto com verificacao vermelha e o defeito numero 1 a evitar. Gere o CODER_CONTRACT com essa disciplina LITERAL ("rode ate verde; so declare pronto com tudo passando") - NUNCA o generico "valide antes de declarar pronto", que deixa passar teste vermelho.`;

const NEW_MARKER = 'rodar ate VERDE (obrigatoria)';

export function applyMigrationV110(db: Database.Database): void {
  db.prepare(
    `UPDATE agents SET system_prompt = REPLACE(system_prompt, ?, ?)
       WHERE id = 'dynamic-workflow-builder'
         AND system_prompt LIKE ?
         AND system_prompt NOT LIKE ?`,
  ).run(OLD_BLOCK, NEW_BLOCK, `%${OLD_BLOCK}%`, `%${NEW_MARKER}%`);
}
