import { describe, it, expect } from 'vitest';
import {
  classifyByContent,
  stripCommentsAndStrings,
  ROLE_MIN_HITS,
  ROLE_METADATA,
  PATH_HINTS,
} from '../repo-profiler';
import type { Role } from '../repo-profiler';


describe('stripCommentsAndStrings', () => {
  it('removes single-line comments so keywords inside are not counted', () => {
    const result = stripCommentsAndStrings('const x = 1; // session foo');
    expect(result).not.toContain('session');
  });

  it('removes block comments so keywords inside are not counted', () => {
    const result = stripCommentsAndStrings('/* session token */ const x = 1;');
    expect(result).not.toContain('session');
    expect(result).not.toContain('token');
  });

  it('replaces double-quoted string contents with empty quotes', () => {
    const result = stripCommentsAndStrings('const a = "session";');
    expect(result).not.toContain('session');
    expect(result).toContain('""');
  });

  it('preserves identifiers that appear outside strings and comments', () => {
    const result = stripCommentsAndStrings('const session = 1;');
    expect(result).toContain('session');
  });

  it('replaces template literal contents with empty backticks', () => {
    const result = stripCommentsAndStrings('const x = `session ${y}`;');
    expect(result).not.toContain('session');
    expect(result).toContain('``');
  });

  it('removes single-quoted string contents', () => {
    const result = stripCommentsAndStrings("const s = 'token';");
    expect(result).not.toContain('token');
    expect(result).toContain("''");
  });
});


describe('classifyByContent - threshold enforcement', () => {
  it('does NOT assign auth when only 1 content hit (threshold is 2)', () => {
    const content = 'function session() {}';
    const roles = classifyByContent('src/foo.ts', 'foo.ts', content);
    expect(roles).not.toContain('auth');
  });

  it('assigns auth when 3+ distinct pattern hits appear in real code', () => {
    const content = [
      'function session() {}',
      'function token() {}',
      'bcrypt.hash(password, 10);',
    ].join('\n');
    const roles = classifyByContent('src/foo.ts', 'foo.ts', content);
    expect(roles).toContain('auth');
  });

  it('assigns auth when path is under src/auth/ even with zero content hits', () => {
    const roles = classifyByContent('src/auth/handler.ts', 'handler.ts', 'const x = 1;');
    expect(roles).toContain('auth');
  });

  it('assigns migration when path is under a migrations/ subfolder', () => {
    const content = 'CREATE TABLE foo (id INT);';
    const roles = classifyByContent('db/migrations/001.sql', '001.sql', content);
    expect(roles).toContain('migration');
  });

  it('assigns config role when basename matches a config file pattern', () => {
    const roles = classifyByContent('config/app.config.ts', 'app.config.ts', null);
    expect(roles).toContain('config');
  });

  it('assigns route role when route patterns exceed threshold', () => {
    const content = [
      'router.use(handler);',
      'app.get("/users", getUsers);',
      'app.post("/users", createUser);',
    ].join('\n');
    const roles = classifyByContent('src/users.ts', 'users.ts', content);
    expect(roles).toContain('route');
  });

  it('assigns middleware role when path is under src/middleware/ via PATH_HINT boost', () => {
    const roles = classifyByContent('src/middlewares/logger.ts', 'logger.ts', 'const x = 1;');
    expect(roles).toContain('middleware');
  });

  it('returns empty array for a completely neutral file with no matching role', () => {
    const content = 'const answer = 42;';
    const roles = classifyByContent('src/utils/math.ts', 'math.ts', content);
    expect(roles).not.toContain('auth');
    expect(roles).not.toContain('query');
    expect(roles).not.toContain('route');
  });
});


describe('ROLE_MIN_HITS', () => {
  const ALL_ROLES: Role[] = [
    'auth', 'query', 'crypto', 'route', 'middleware',
    'template', 'async', 'error-handling', 'config', 'migration',
  ];

  it('has an entry for each of the 10 roles', () => {
    expect(Object.keys(ROLE_MIN_HITS)).toHaveLength(10);
    for (const role of ALL_ROLES) {
      expect(ROLE_MIN_HITS[role]).toBeTypeOf('number');
      expect(ROLE_MIN_HITS[role]).toBeGreaterThanOrEqual(1);
    }
  });
});


describe('ROLE_METADATA', () => {
  const ALL_ROLES: Role[] = [
    'auth', 'query', 'crypto', 'route', 'middleware',
    'template', 'async', 'error-handling', 'config', 'migration',
  ];

  it('has 10 entries with required fields', () => {
    expect(Object.keys(ROLE_METADATA)).toHaveLength(10);
    for (const role of ALL_ROLES) {
      const meta = ROLE_METADATA[role];
      expect(meta).toBeDefined();
      expect(meta.label).toBeTypeOf('string');
      expect(meta.description).toBeTypeOf('string');
      expect(Array.isArray(meta.samplePatterns)).toBe(true);
      expect(meta.samplePatterns.length).toBeGreaterThan(0);
    }
  });

  it('threshold in ROLE_METADATA matches ROLE_MIN_HITS for every role', () => {
    for (const role of ALL_ROLES) {
      expect(ROLE_METADATA[role].threshold).toBe(ROLE_MIN_HITS[role]);
    }
  });
});


describe('PATH_HINTS', () => {
  it('has at least one hint that matches src/middlewares/foo.ts', () => {
    const matched = PATH_HINTS.filter(
      (h) => h.role === 'middleware' && h.regex.test('src/middlewares/foo.ts'),
    );
    expect(matched.length).toBeGreaterThan(0);
  });

  it('has at least one hint that matches src/crypto/utils.ts for crypto role', () => {
    const matched = PATH_HINTS.filter(
      (h) => h.role === 'crypto' && h.regex.test('src/crypto/utils.ts'),
    );
    expect(matched.length).toBeGreaterThan(0);
  });

  it('has at least one hint that matches src/auth/login.ts for auth role', () => {
    const matched = PATH_HINTS.filter(
      (h) => h.role === 'auth' && h.regex.test('src/auth/login.ts'),
    );
    expect(matched.length).toBeGreaterThan(0);
  });

  it('has at least one hint that matches db/migrations/001.sql for migration role', () => {
    const matched = PATH_HINTS.filter(
      (h) => h.role === 'migration' && h.regex.test('db/migrations/001.sql'),
    );
    expect(matched.length).toBeGreaterThan(0);
  });
});
