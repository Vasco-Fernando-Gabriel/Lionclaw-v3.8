import type Database from 'better-sqlite3';

export function applyMigrationV118(db: Database.Database): void {
  const retrySection = `## Retry efetivo: nao-progresso + reframe (obrigatorio nos 2 loops)

Um retry so vale se MUDAR alguma variavel. Re-rodar o MESMO agente com os MESMOS findings produz ~a mesma saida (mesmo cerebro + mesmo input): so queima token. O workflow.js que voce gera DEVE detectar NAO-PROGRESSO (os mesmos blockers voltando rodada apos rodada) e, ao detectar, injetar um REFRAME no prompt do PROXIMO writer - muda o ENQUADRAMENTO (o agente ja recebe os findings; falta o sinal "voce ja tentou isso e falhou, MUDE de abordagem"). Vale nos DOIS loops: dev por sprint E plano.

Padrao (adapte aos nomes dos seus helpers):
- Assinatura ESTAVEL do conjunto de blockers da rodada, chaveada por where|problem (a severidade pode oscilar entre rodadas): blockerSignature(findings) = findings.map((f) => (f.where||'') + '|' + (f.problem||'')).sort().join('~~').
- Reframe: stuckNote(stuck) = (!stuck || stuck < 1) ? '' : ' SEM PROGRESSO (' + (stuck+1) + 'a rodada com os MESMOS findings): a abordagem anterior NAO os moveu. NAO repita o mesmo patch - reataque a CAUSA RAIZ: rode o comando de build/test e use a saida REAL, questione a premissa do fix anterior, e tente um caminho fundamentalmente diferente.'.
- No loop carregue lastSig + stuck (por sprint no dev; por plano no plan-loop). Apos computar os blockers da rodada: const sig = blockerSignature(blockers); if (lastSig !== null && sig !== '' && sig === lastSig) stuck++; else stuck = 0; lastSig = sig;.
- Concatene stuckNote(stuck) no prompt do PROXIMO writer: no dev, no coder-continue (devRound>0) E no fix; no plano, no plannerPrompt de re-plan.

Regras DURAS:
- NAO mexe na condicao de convergencia (advisory P3 segue sem travar; isto so torna as rodadas NAO-convergentes efetivas, nunca muda QUANDO converge).
- A assinatura e por where|problem, NUNCA por id (o id de finding e local da rodada, 'f'+indice, nao e estavel entre rodadas).
- stuck=0 quando NAO ha repeticao: o retry normal segue barato; o reframe so entra quando o agente esta de fato preso nos mesmos blockers.`;

  const anchor = '## Regras do workflow.js (subset ESM restrito)';
  db.prepare(
    `UPDATE agents
        SET system_prompt = REPLACE(system_prompt, ?, ? || char(10) || char(10) || ?),
            updated_at = datetime('now')
      WHERE id = 'dynamic-workflow-builder'
        AND system_prompt LIKE '%' || ? || '%'
        AND system_prompt NOT LIKE '%## Retry efetivo: nao-progresso%'`,
  ).run(anchor, retrySection, anchor, anchor);
}
