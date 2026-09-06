import {
  ensureRemoteMcpWrapperSync,
  resolveRemoteMcpWrapperPath,
  type RemoteMcpDescriptor,
} from './remote-mcp-wrapper';

export const BLOTATO_MCP_URL = 'https://mcp.blotato.com/mcp';
export const BLOTATO_API_KEY_SECRET = 'BLOTATO_API_KEY';

export function getBlotatoRemoteMcpDescriptor(): RemoteMcpDescriptor {
  return {
    providerId: 'blotato',
    mcpUrl: BLOTATO_MCP_URL,
    runtimeSubdir: 'blotato',
    wrapperFileName: 'blotato-mcp-wrapper.js',
    auth: { mode: 'header', headerName: 'blotato-api-key', secretEnvVar: BLOTATO_API_KEY_SECRET },
  };
}

export function getBlotatoMcpWrapperPath(): string {
  return resolveRemoteMcpWrapperPath(getBlotatoRemoteMcpDescriptor());
}

export function ensureBlotatoMcpWrapperSync(): string {
  return ensureRemoteMcpWrapperSync(getBlotatoRemoteMcpDescriptor());
}
