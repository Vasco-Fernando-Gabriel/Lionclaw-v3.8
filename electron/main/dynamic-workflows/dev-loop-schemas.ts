
export const VALIDATOR_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['verdict', 'findings'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'needs-work'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'where', 'problem'],
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['P1', 'P2', 'P3'] },
          where: { type: 'string' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
};

export const REFUTE_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['refutations'],
  additionalProperties: false,
  properties: {
    refutations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ref', 'verdict', 'evidencia', 'severityConfirmada'],
        additionalProperties: false,
        properties: {
          ref: { type: 'string', description: 'o id EXATO do finding cru sendo refutado (campo id do finding; nao o where)' },
          verdict: { type: 'string', enum: ['real', 'ruido'] },
          evidencia: { type: 'string' },
          severityConfirmada: { type: 'string', enum: ['P1', 'P2', 'P3'] },
        },
      },
    },
  },
};
