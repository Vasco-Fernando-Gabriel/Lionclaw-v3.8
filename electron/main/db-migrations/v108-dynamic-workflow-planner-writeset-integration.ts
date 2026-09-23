import type Database from 'better-sqlite3';

const OLD_BLOCK = `   - writeSetHint: quando declarar, inclua TODOS os arquivos que a sprint vai tocar de fato (codigo-fonte + configs que a sprint precisa: package.json, tsconfig*, etc). Um hint que esquece arquivo legitimo faz o coder "falhar por fora do writeSet"; na duvida, prefira um hint MAIS LARGO (ou nenhum) a um estreito demais`;

const NEW_BLOCK = `   - writeSetHint: inclua TODOS os arquivos que a sprint vai tocar de fato, INCLUINDO os pontos de integracao/wiring (nao so os arquivos novos). Dois erros que reprovam o coder por "fora do writeSet": (a) escopar \`pkg/src/routes/**\`, \`pkg/src/middleware/**\` ou \`pkg/src/handlers/**\` mas ESQUECER o ENTRY do pacote (\`pkg/src/index.ts\` / \`pkg/src/main.ts\`) onde isso e REGISTRADO - se a sprint adiciona rota/middleware/handler/comando, o ENTRY do pacote SEMPRE entra no writeSet; (b) a sprint liga pacotes diferentes (ex: shell -> server -> uma tela no renderer) mas escopa so um - inclua os arquivos cross-pacote que o wiring exige (ex: \`packages/renderer/src/.../App.tsx\` ou o router quando a sprint conecta/adiciona uma tela). Regra pratica: para CADA arquivo novo, pergunte "onde ele e importado/registrado?" e inclua esse arquivo no writeSet tambem. Mantenha o hint MINIMO porem COMPLETO: nao escope pacotes inteiros que voce so toca em 1 arquivo (mata a isolacao/paralelismo das sprints), mas nunca deixe de fora um arquivo que a sprint precisa editar. Na duvida sobre um arquivo, ADICIONE o caminho LITERAL exato dele (ex: \`packages/server/src/index.ts\`), NUNCA alargue para \`**\`/pacote inteiro nem deixe o hint vazio: writeSet vazio ou com \`**\` forca as sprints a rodar SEQUENCIAL (sem paralelismo). Hint vazio/\`**\` so quando a sprint legitimamente toca o pacote inteiro`;

const NEW_MARKER = 'pontos de integracao/wiring';

export function applyMigrationV108(db: Database.Database): void {
  db.prepare(
    `UPDATE agents SET system_prompt = REPLACE(system_prompt, ?, ?)
       WHERE id = 'dynamic-workflow-sprint-planner'
         AND system_prompt LIKE ?
         AND system_prompt NOT LIKE ?`,
  ).run(OLD_BLOCK, NEW_BLOCK, `%${OLD_BLOCK}%`, `%${NEW_MARKER}%`);
}
