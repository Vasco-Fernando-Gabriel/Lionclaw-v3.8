import type Database from 'better-sqlite3';


const AXIS_OLD = `Cobertura de testes + containment. Correcao vs SPEC e regressao de contrato NAO sao seus eixos: nao duplique findings fora do seu eixo.`;
const AXIS_NEW = `Cobertura e qualidade de testes. Correcao vs SPEC e regressao de contrato NAO sao seus eixos: nao duplique findings fora do seu eixo.`;

const STEP3_OLD = `3. Cheque containment por leitura/diff: arquivo tocado fora do escopo declarado (writeSet e protected paths informados no prompt) e finding P1.`;
const STEP3_NEW = `3. NAO reporte containment de writeSet: o enforcement do writeSet foi desligado (runs sequenciais nao tem sprint concorrente para proteger; o coder edita livre, como o agente Claude). "Arquivo fora do writeSet" NAO e finding. Escrita fora da raiz do workspace ou em path protegido ja e bloqueada no host (hard deny), entao tambem nao e seu eixo.`;

const OUTPUT_OLD = `problem (o gap de cobertura ou a violacao de containment, com evidencia) e fix (correcao objetiva sugerida)`;
const OUTPUT_NEW = `problem (o gap de cobertura ou o defeito de qualidade do teste, com evidencia) e fix (correcao objetiva sugerida)`;

export function applyMigrationV109(db: Database.Database): void {
  const replaceBlock = (oldBlock: string, newBlock: string): void => {
    db.prepare(
      `UPDATE agents SET system_prompt = REPLACE(system_prompt, ?, ?)
         WHERE id = 'dynamic-workflow-validator-tests'
           AND system_prompt LIKE ?`,
    ).run(oldBlock, newBlock, `%${oldBlock}%`);
  };
  replaceBlock(AXIS_OLD, AXIS_NEW);
  replaceBlock(STEP3_OLD, STEP3_NEW);
  replaceBlock(OUTPUT_OLD, OUTPUT_NEW);
}
