import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import {
  materializeBuilderPackage,
  SCHEMAS_SUBDIR,
  VALIDATOR_SCHEMA_FILE,
} from '../dynamic-workflows/workflow-package';
import { REFUTE_SCHEMA_FILE } from '../dynamic-workflows/dev-loop-ids';
import { VALIDATOR_SCHEMA, REFUTE_SCHEMA } from '../dynamic-workflows/dev-loop-schemas';

const WORKFLOW_JS = "export const meta = { name: 'pkg', description: 'd' };\nreturn {};\n";
const MANIFEST = { version: 1, name: 'pkg', phases: [], nodes: [], gates: [] };

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'dwf-pkg-'));
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe('materializeBuilderPackage: schemas do dev-loop em TODO pacote', () => {
  it('pacote SEM schemas ganha validator.schema.json + refute.schema.json (conteudo canonico)', () => {
    const out = materializeBuilderPackage(runDir, { workflowJs: WORKFLOW_JS, manifest: MANIFEST }, 'claude-code', 0);

    const validatorPath = join(runDir, SCHEMAS_SUBDIR, VALIDATOR_SCHEMA_FILE);
    const refutePath = join(runDir, SCHEMAS_SUBDIR, REFUTE_SCHEMA_FILE);
    expect(existsSync(validatorPath)).toBe(true);
    expect(existsSync(refutePath)).toBe(true);
    expect(JSON.parse(readFileSync(validatorPath, 'utf8'))).toEqual(VALIDATOR_SCHEMA);
    expect(JSON.parse(readFileSync(refutePath, 'utf8'))).toEqual(REFUTE_SCHEMA);

    const names = out.schemaPaths.map((p) => basename(p));
    expect(names).toContain(VALIDATOR_SCHEMA_FILE);
    expect(names).toContain(REFUTE_SCHEMA_FILE);
  });

  it('MERGE ADITIVO: schema de mesmo nome no PACOTE nunca e sobrescrito', () => {
    const custom = { $schema: 'custom', type: 'object', properties: {} };
    const out = materializeBuilderPackage(
      runDir,
      {
        workflowJs: WORKFLOW_JS,
        manifest: MANIFEST,
        schemas: { [VALIDATOR_SCHEMA_FILE]: custom, 'outro.schema.json': { type: 'object' } },
      },
      'claude-code',
      0,
    );

    const validatorPath = join(runDir, SCHEMAS_SUBDIR, VALIDATOR_SCHEMA_FILE);
    expect(JSON.parse(readFileSync(validatorPath, 'utf8'))).toEqual(custom);
    expect(existsSync(join(runDir, SCHEMAS_SUBDIR, REFUTE_SCHEMA_FILE))).toBe(true);
    expect(existsSync(join(runDir, SCHEMAS_SUBDIR, 'outro.schema.json'))).toBe(true);
    const names = out.schemaPaths.map((p) => basename(p));
    expect(names.filter((n) => n === VALIDATOR_SCHEMA_FILE)).toHaveLength(1);
  });

  it('MERGE ADITIVO: schema de mesmo nome ja NO DISCO nunca e sobrescrito (edicao do usuario preservada)', () => {
    const schemasDir = join(runDir, SCHEMAS_SUBDIR);
    mkdirSync(schemasDir, { recursive: true });
    const edited = { $schema: 'editado-pelo-usuario', type: 'object' };
    writeFileSync(join(schemasDir, REFUTE_SCHEMA_FILE), JSON.stringify(edited), 'utf8');

    const out = materializeBuilderPackage(runDir, { workflowJs: WORKFLOW_JS, manifest: MANIFEST }, 'claude-code', 0);

    expect(JSON.parse(readFileSync(join(schemasDir, REFUTE_SCHEMA_FILE), 'utf8'))).toEqual(edited);
    const names = out.schemaPaths.map((p) => basename(p));
    expect(names).toContain(REFUTE_SCHEMA_FILE);
    expect(existsSync(join(schemasDir, VALIDATOR_SCHEMA_FILE))).toBe(true);
  });
});
