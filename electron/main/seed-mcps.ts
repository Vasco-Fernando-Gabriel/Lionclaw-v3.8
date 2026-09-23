import { getHiggsfieldRemoteMcpDescriptor } from './higgsfield-auth';
import { getBlotatoRemoteMcpDescriptor, BLOTATO_API_KEY_SECRET } from './blotato-auth';
import { ensureRemoteMcpWrapperSync } from './remote-mcp-wrapper';
import { isPackagedDistributionRuntime, resolveInternalNodeBinary } from './distribution-runtime';

export interface RemoteSeedMcp {
  id: string;
  name: string;
  command: string;
  args: string[];
  envKeys: string[];
  isActive: boolean;
}

export function getRemoteSeedMcps(): RemoteSeedMcp[] {
  const nodeCommand = isPackagedDistributionRuntime() ? resolveInternalNodeBinary() : 'node';
  return [
    {
      id: 'higgsfield',
      name: 'Higgsfield (Imagens & Videos)',
      command: nodeCommand,
      args: [ensureRemoteMcpWrapperSync(getHiggsfieldRemoteMcpDescriptor())],
      envKeys: [],
      isActive: false,
    },
    {
      id: 'blotato',
      name: 'Blotato (Social Posting)',
      command: nodeCommand,
      args: [ensureRemoteMcpWrapperSync(getBlotatoRemoteMcpDescriptor())],
      envKeys: [BLOTATO_API_KEY_SECRET],
      isActive: false,
    },
  ];
}
