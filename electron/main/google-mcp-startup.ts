
import { createLogger } from './logger';
import { updateMCPServer, startServer } from './mcp-manager';

const logger = createLogger('google-mcp-startup');

export const GOOGLE_MCP_IDS = ['google-gmail', 'google-drive', 'google-sheets'] as const;

export interface GoogleMcpStartFailure {
  id: string;
  error: string;
}

export async function startGoogleMcps(): Promise<GoogleMcpStartFailure[]> {
  const failures: GoogleMcpStartFailure[] = [];
  for (const id of GOOGLE_MCP_IDS) {
    try {
      updateMCPServer(id, { isActive: true });
      await startServer(id);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({ id, error });
      logger.warn({ id, err, code: 'MCP-START-FAIL' }, 'Failed to start Google MCP after OAuth');
    }
  }
  return failures;
}
