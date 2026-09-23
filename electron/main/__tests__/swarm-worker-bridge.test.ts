import { describe, expect, it, vi } from 'vitest';
vi.mock('../mcp-path-resolver', () => ({
  resolveMcpServerRuntime: () => ({ command: '/node', entryPath: '/swarm.js', env: {} }),
}));
import { resolveHelperTokenOwner } from '../helper-identity';
import { createSwarmWorkerBridge, dispatchSwarmFindings } from '../swarm/worker-bridge';
describe('Swarm worker capability', () => {
  it('vincula upload exclusivamente à tentativa e revoga imediatamente', async () => {
    const upload = vi.fn(() => ({ uploadId: 'u', nextSeq: 0, sha256: '' }));
    const first = createSwarmWorkerBridge(upload);
    const secondUpload = vi.fn(() => ({ uploadId: 'u', nextSeq: 0, sha256: '' }));
    const second = createSwarmWorkerBridge(secondUpload);
    const token = resolveHelperTokenOwner(first.spawnEnv.LIONCLAW_HELPER_TOKEN)!;
    expect(first.extraArgs.join(' ')).not.toContain(first.spawnEnv.LIONCLAW_HELPER_TOKEN);
    const operation = { operation: 'begin', uploadId: 'u' };
    await dispatchSwarmFindings(token, operation);
    expect(upload).toHaveBeenCalledWith(operation);
    expect(secondUpload).not.toHaveBeenCalled();
    first.dispose();
    await expect(dispatchSwarmFindings(token, operation)).rejects.toThrow('revogada');
    await expect(dispatchSwarmFindings('inventado', operation)).rejects.toThrow('revogada');
    second.dispose();
  });
});
