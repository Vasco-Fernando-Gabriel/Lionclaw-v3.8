import type Database from 'better-sqlite3';


const CODE_WRITER_IDS = [
  'dynamic-workflow-coder',
  'dynamic-workflow-coder-codex',
  'dynamic-workflow-coder-glm',
  'dynamic-workflow-fixer',
] as const;
const DOC_WRITER_ID = 'dynamic-workflow-doc-writer';

const OLD_CODE_WRITER_MAX_TURNS = 80;
const NEW_CODE_WRITER_MAX_TURNS = 150;
const OLD_DOC_WRITER_MAX_TURNS = 60;
const NEW_DOC_WRITER_MAX_TURNS = 100;

const OLD_CODE_WRITER_COMMANDS = ['npm run typecheck', 'npm run test', 'npm install', 'npm ci'];
const NEW_CODE_WRITER_COMMANDS = [
  'npm run typecheck',
  'npm run test',
  'npm install',
  'npm ci',
  'npm run build',
  'npm run lint',
  'node --version',
  'npm --version',
  'printenv NODE_ENV',
  'echo',
];

export function applyMigrationV151(db: Database.Database): void {
  const migrate = db.transaction(() => {
    const updateTurns = db.prepare(
      'UPDATE agents SET max_turns = ? WHERE id = ? AND max_turns = ?',
    );
    const updateCommands = db.prepare(
      'UPDATE agents SET allowed_commands = ? WHERE id = ? AND allowed_commands = ?',
    );
    const oldCommandsJson = JSON.stringify(OLD_CODE_WRITER_COMMANDS);
    const newCommandsJson = JSON.stringify(NEW_CODE_WRITER_COMMANDS);
    for (const id of CODE_WRITER_IDS) {
      updateTurns.run(NEW_CODE_WRITER_MAX_TURNS, id, OLD_CODE_WRITER_MAX_TURNS);
      updateCommands.run(newCommandsJson, id, oldCommandsJson);
    }
    updateTurns.run(NEW_DOC_WRITER_MAX_TURNS, DOC_WRITER_ID, OLD_DOC_WRITER_MAX_TURNS);
  });
  migrate.immediate();
}

export const __V151_INTERNAL = {
  CODE_WRITER_IDS: [...CODE_WRITER_IDS],
  DOC_WRITER_ID,
  OLD_CODE_WRITER_MAX_TURNS,
  NEW_CODE_WRITER_MAX_TURNS,
  OLD_DOC_WRITER_MAX_TURNS,
  NEW_DOC_WRITER_MAX_TURNS,
  OLD_CODE_WRITER_COMMANDS,
  NEW_CODE_WRITER_COMMANDS,
};
