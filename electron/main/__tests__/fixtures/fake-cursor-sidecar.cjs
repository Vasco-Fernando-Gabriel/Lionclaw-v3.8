'use strict';

const PREFIX = '@@LIONRPC@@';
const mode = process.env.FAKE_SIDECAR_MODE || 'echo';

function send(msg) {
  process.stdout.write(PREFIX + JSON.stringify(msg) + '\n');
}

let buffer = '';
let executionId = null;
let probeResult = null;

function handle(msg) {
  if (mode === 'crash') return;
  switch (msg.type) {
    case 'execute': {
      executionId = msg.config.executionId;
      if (mode === 'ignore-abort') {
        send({ type: 'execute-started', executionId, runId: 'run-ia', agentId: 'agent-ia' });
        return;
      }
      send({ type: 'execute-started', executionId, runId: 'run-1', agentId: 'agent-1' });
      send({ type: 'stream-event', executionId, event: { type: 'status', status: 'RUNNING' } });
      if (mode === 'long-tool') {
        send({ type: 'tool-invoke', executionId, id: 't-long', toolName: 'long_op', args: {} });
      } else {
        send({
          type: 'tool-invoke',
          executionId,
          id: 't-1',
          toolName: 'lion_echo',
          args: { value: 'PING-42' },
        });
      }
      break;
    }
    case 'tool-result': {
      if (msg.id === 't-1') {
        send({
          type: 'execute-result',
          executionId,
          status: 'finished',
          finalText: msg.ok || `erro:${msg.error}`,
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 15,
          },
          agentId: 'agent-1',
          runId: 'run-1',
        });
        setTimeout(() => process.exit(0), 200);
      } else if (msg.id === 't-long') {
        send({ type: 'tool-invoke', executionId, id: 't-probe', toolName: 'probe', args: {} });
      } else if (msg.id === 't-probe') {
        probeResult = msg.error || msg.ok || 'sem-resposta';
      }
      break;
    }
    case 'abort': {
      if (mode === 'ignore-abort') return;
      setTimeout(() => {
        send({
          type: 'execute-result',
          executionId,
          status: 'cancelled',
          finalText: `probe=${probeResult}`,
        });
        setTimeout(() => process.exit(0), 100);
      }, 150);
      break;
    }
    case 'ping': {
      if (mode === 'no-pong') return;
      send({ type: 'pong', id: msg.id });
      break;
    }
    case 'list-models': {
      if (mode === 'models-error') {
        send({ type: 'models-result', id: msg.id, error: 'catalogo indisponivel (fake)' });
      } else {
        send({
          type: 'models-result',
          id: msg.id,
          models: [
            { id: 'composer-2.5', displayName: 'Composer 2.5' },
            { id: 'test-model-x', displayName: 'Test Model X' },
          ],
        });
      }
      break;
    }
    case 'shutdown':
      process.exit(0);
      break;
    default:
      break;
  }
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).replace(/\r$/, '');
    buffer = buffer.slice(idx + 1);
    if (!line.startsWith(PREFIX)) continue;
    try {
      handle(JSON.parse(line.slice(PREFIX.length)));
    } catch {
      // ignora
    }
  }
});
process.stdin.on('end', () => process.exit(0));

if (mode === 'crash') {
  send({ type: 'ready', pid: process.pid, nodeVersion: process.version });
  setTimeout(() => process.exit(7), 50);
} else {
  process.stdout.write('linha de poluicao do sdk\n');
  send({ type: 'ready', pid: process.pid, nodeVersion: process.version });
}
