import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SWARM_START_DESCRIPTION } from '../../_shared/swarm-guidance.js';
import { LocalIpcClient, assertEndpointPresentOrExit, withTurnBinding } from '../../_shared/local-ipc-client.js';
assertEndpointPresentOrExit();
const client = new LocalIpcClient();
const server = new McpServer({ name: 'lionclaw-swarm', version: '1.0.0' });
async function proxy(method: string, params: Record<string, unknown>, extra?: unknown) {
  try {
    const result = await client.callMethod(method, withTurnBinding(params, extra));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      ...(result && typeof result === 'object' && 'error' in result ? { isError: true } : {}),
    };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: String(error) }], isError: true };
  }
}
const member = z.union([
  z.object({ kind: z.literal('registered'), agentId: z.string() }).strict(),
  z
    .object({
      kind: z.literal('ephemeral'),
      runtime: z.enum(['cloud', 'codex', 'zai', 'minimax-tp', 'kimi', 'local', 'external']),
      model: z.string(),
      rolePrompt: z.string(),
      allowedTools: z.array(z.string()),
      providerProfileId: z.string().optional(),
    })
    .strict(),
]);
const isWorker = process.env['LIONCLAW_SWARM_WORKER'] === '1';
if (isWorker) {
  server.tool(
    'swarm_write_findings',
    'Envia relatório em partes: begin, chunk sequencial, finalize com SHA-256 UTF-8. Reenvios idênticos são seguros.',
    {
      operation: z.enum(['begin', 'chunk', 'finalize']),
      uploadId: z.string(),
      seq: z.number().int().nonnegative().optional(),
      content: z.string().optional(),
      chunkCount: z.number().int().nonnegative().optional(),
      sha256: z.string().optional(),
    },
    (upload) => proxy('swarm_write_findings', { upload }),
  );
} else {
  server.tool(
    'swarm_start',
    SWARM_START_DESCRIPTION,
    {
      requestId: z.string(),
      cwd: z.string(),
      objective: z.string(),
      knownContext: z.string().optional(),
      mode: z
        .enum(['fanout', 'comite'])
        .describe('comite: vários agentes no mesmo alvo; fanout: um perfil em vários alvos.'),
      promptTemplate: z.string().optional().describe('Obrigatório apenas em fanout; deve conter {{item}}.'),
      member: member.optional().describe('Obrigatório apenas em fanout: perfil único aplicado aos items.'),
      items: z
        .array(z.object({ target: z.string() }).strict())
        .min(1)
        .max(100)
        .optional()
        .describe('Obrigatório apenas em fanout: alvos do perfil único.'),
      target: z.string().optional().describe('Obrigatório apenas em comite: alvo comum a todos os members.'),
      members: z
        .array(z.object({ slug: z.string(), objective: z.string(), member }).strict())
        .min(1)
        .max(100)
        .optional()
        .describe(
          'Obrigatório apenas em comite. Inclua todos os especialistas nesta lista para executarem na mesma run.',
        ),
    },
    (params, extra) => proxy('swarm_start', params, extra),
  );
  server.tool(
    'swarm_inspect',
    'Consulta estado e resultados da run nesta sessão.',
    { runId: z.string() },
    (params, extra) => proxy('swarm_inspect', params, extra),
  );
  server.tool(
    'swarm_abort',
    'Cancela a run preservando resultados concluídos.',
    { runId: z.string() },
    (params, extra) => proxy('swarm_abort', params, extra),
  );
  server.tool(
    'swarm_list',
    'Lista runs da sessão atual.',
    { cursor: z.string().optional(), limit: z.number().int().positive().max(50).optional() },
    (params, extra) => proxy('swarm_list', params, extra),
  );
  server.tool('swarm_catalog', 'Lista membros e perfis compatíveis disponíveis.', {}, (params, extra) =>
    proxy('swarm_catalog', params, extra),
  );
}
await server.connect(new StdioServerTransport());
