import { useState, useEffect } from 'react';
import {
  Server, Plus, RotateCw, Trash2, TestTube, Circle,
  Cloud, HardDrive, RefreshCw, ToggleLeft, ToggleRight,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import type { MCPServerConfig, SDKMcpServer } from '@/types';

export function MCPServersPage() {
  const [localServers, setLocalServers] = useState<MCPServerConfig[]>([]);
  const [sdkServers, setSdkServers] = useState<SDKMcpServer[]>([]);
  const [isLoadingLocal, setIsLoadingLocal] = useState(true);
  const [isLoadingSDK, setIsLoadingSDK] = useState(true);
  const [expandedSDK, setExpandedSDK] = useState<Set<string>>(new Set());

  const loadLocal = async () => {
    setIsLoadingLocal(true);
    const result = await window.lionclaw.mcp.list();
    setLocalServers(result);
    setIsLoadingLocal(false);
  };

  const loadSDK = async () => {
    setIsLoadingSDK(true);
    try {
      const result = await window.lionclaw.mcp.listSDK();
      setSdkServers(result);
    } catch {
    }
    setIsLoadingSDK(false);
  };

  useEffect(() => {
    loadLocal();
    loadSDK();
  }, []);

  const handleRefreshSDK = async () => {
    setIsLoadingSDK(true);
    try {
      await window.lionclaw.mcp.refreshSDK();
      await loadSDK();
    } catch {
      setIsLoadingSDK(false);
    }
  };

  const handleToggleSDK = async (name: string, currentlyEnabled: boolean) => {
    await window.lionclaw.mcp.toggleSDK(name, !currentlyEnabled);
    setSdkServers((prev) =>
      prev.map((s) =>
        s.name === name ? { ...s, isDisabledLocally: currentlyEnabled } : s,
      ),
    );
  };

  const toggleExpanded = (name: string) => {
    setExpandedSDK((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const handleTest = async (id: string) => {
    const result = await window.lionclaw.mcp.test(id);
    if (result.success) {
      alert('Servidor OK!');
    } else {
      alert(`Erro: ${result.error}`);
    }
  };

  const handleRestart = async (id: string) => {
    await window.lionclaw.mcp.restart(id);
    loadLocal();
  };

  const handleToggle = async (id: string, currentlyActive: boolean) => {
    await window.lionclaw.mcp.toggle(id, !currentlyActive);
    loadLocal();
  };

  const handleDelete = async (id: string) => {
    await window.lionclaw.mcp.delete(id);
    loadLocal();
  };

  const handleIndexModeChange = async (id: string, indexMode: 'tools' | 'server') => {
    await window.lionclaw.mcp.update(id, { indexMode });
    loadLocal();
  };

  const statusColor = (status?: string) => {
    switch (status) {
      case 'running':
      case 'connected':
        return 'text-green-400';
      case 'error':
      case 'failed':
        return 'text-red-400';
      case 'needs-auth':
        return 'text-yellow-400';
      case 'pending':
        return 'text-blue-400';
      case 'disabled':
        return 'text-zinc-600';
      default:
        return 'text-zinc-600';
    }
  };

  const statusLabel = (status: string) => {
    const labels: Record<string, string> = {
      connected: 'Conectado',
      failed: 'Erro',
      'needs-auth': 'Precisa autenticar',
      pending: 'Conectando...',
      disabled: 'Desabilitado',
      running: 'Rodando',
      stopped: 'Parado',
    };
    return labels[status] || status;
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">MCP Servers</h1>
            <p className="text-sm text-zinc-500 mt-1">
              Servidores MCP para ferramentas externas
            </p>
          </div>
          <button className="flex items-center gap-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors">
            <Plus size={16} />
            Novo Server
          </button>
        </div>

        {/* Secao SDK (Herdados) */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Cloud size={16} className="text-blue-400" />
              <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
                Claude Code
              </h2>
              <span className="text-[10px] bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded-full">
                herdados
              </span>
            </div>
            <button
              onClick={handleRefreshSDK}
              className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
              title="Atualizar"
            >
              <RefreshCw size={14} className={isLoadingSDK ? 'animate-spin' : ''} />
            </button>
          </div>

          {isLoadingSDK ? (
            <div className="flex justify-center py-6">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : sdkServers.length === 0 ? (
            <div className="text-center py-6 text-zinc-600 bg-zinc-900/50 rounded-xl border border-zinc-800/50">
              <p className="text-sm">Nenhum MCP herdado encontrado</p>
              <p className="text-xs mt-1">
                Configure MCPs no Claude Code para ve-los aqui
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {sdkServers.map((server) => (
                <div
                  key={server.name}
                  className="bg-zinc-900 border border-zinc-800 rounded-xl p-4"
                >
                  <div className="flex items-center gap-3">
                    {/* Toggle */}
                    <button
                      onClick={() =>
                        handleToggleSDK(server.name, !server.isDisabledLocally)
                      }
                      className="flex-shrink-0"
                    >
                      {server.isDisabledLocally ? (
                        <ToggleLeft size={20} className="text-zinc-600" />
                      ) : (
                        <ToggleRight size={20} className="text-green-400" />
                      )}
                    </button>

                    {/* Status dot */}
                    <Circle
                      size={8}
                      fill="currentColor"
                      className={
                        server.isDisabledLocally
                          ? 'text-zinc-600'
                          : statusColor(server.status)
                      }
                    />

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3
                          className={`text-sm font-semibold ${
                            server.isDisabledLocally
                              ? 'text-zinc-500'
                              : 'text-zinc-200'
                          }`}
                        >
                          {server.name}
                        </h3>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            server.isDisabledLocally
                              ? 'bg-zinc-800 text-zinc-600'
                              : 'bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          {statusLabel(
                            server.isDisabledLocally ? 'disabled' : server.status,
                          )}
                        </span>
                        {server.scope && (
                          <span className="text-[10px] text-zinc-600">
                            {server.scope}
                          </span>
                        )}
                        {server.serverInfo && (
                          <span className="text-[10px] text-zinc-600">
                            v{server.serverInfo.version}
                          </span>
                        )}
                      </div>
                      {server.error && (
                        <p className="text-xs text-red-400 mt-0.5">{server.error}</p>
                      )}
                    </div>

                    {/* Expand tools */}
                    {server.tools && server.tools.length > 0 && (
                      <button
                        onClick={() => toggleExpanded(server.name)}
                        className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
                      >
                        {expandedSDK.has(server.name) ? (
                          <ChevronDown size={14} />
                        ) : (
                          <ChevronRight size={14} />
                        )}
                      </button>
                    )}
                  </div>

                  {/* Tools count summary */}
                  {server.tools &&
                    server.tools.length > 0 &&
                    !expandedSDK.has(server.name) && (
                      <p className="text-[11px] text-zinc-600 mt-2 ml-11">
                        {server.tools.length} tool
                        {server.tools.length > 1 ? 's' : ''}:{' '}
                        {server.tools
                          .slice(0, 3)
                          .map((t) => t.name)
                          .join(', ')}
                        {server.tools.length > 3 &&
                          ` (+${server.tools.length - 3} mais)`}
                      </p>
                    )}

                  {/* Expanded tools list */}
                  {expandedSDK.has(server.name) && server.tools && (
                    <div className="mt-3 ml-11 space-y-1">
                      {server.tools.map((tool) => (
                        <div
                          key={tool.name}
                          className="flex items-start gap-2 text-xs"
                        >
                          <span className="text-zinc-400 font-mono shrink-0">
                            {tool.name}
                          </span>
                          {tool.description && (
                            <span className="text-zinc-600 truncate">
                              {tool.description}
                            </span>
                          )}
                          {tool.annotations?.destructive && (
                            <span className="text-[9px] bg-red-500/10 text-red-400 px-1 rounded shrink-0">
                              destrutivo
                            </span>
                          )}
                          {tool.annotations?.readOnly && (
                            <span className="text-[9px] bg-green-500/10 text-green-400 px-1 rounded shrink-0">
                              read-only
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Secao Local (LionClaw) */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <HardDrive size={16} className="text-amber-400" />
            <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">
              LionClaw
            </h2>
            <span className="text-[10px] bg-amber-500/10 text-amber-400 px-2 py-0.5 rounded-full">
              locais
            </span>
          </div>

          {isLoadingLocal ? (
            <div className="flex justify-center py-6">
              <div className="w-5 h-5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : localServers.length === 0 ? (
            <div className="text-center py-6 text-zinc-600 bg-zinc-900/50 rounded-xl border border-zinc-800/50">
              <Server size={32} className="mx-auto mb-3 opacity-50" />
              <p className="text-sm">Nenhum MCP server local configurado</p>
              <p className="text-xs mt-1">
                Adicione servidores para Gmail, Calendar, etc.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {localServers.map((server) => (
                <div
                  key={server.id}
                  className="bg-zinc-900 border border-zinc-800 rounded-xl p-4"
                >
                  <div className="flex items-center gap-3">
                    {/* Toggle */}
                    <button
                      onClick={() => handleToggle(server.id, server.isActive)}
                      className="flex-shrink-0"
                    >
                      {server.isActive ? (
                        <ToggleRight size={20} className="text-green-400" />
                      ) : (
                        <ToggleLeft size={20} className="text-zinc-600" />
                      )}
                    </button>

                    <Circle
                      size={8}
                      fill="currentColor"
                      className={server.isActive ? statusColor(server.status) : 'text-zinc-600'}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className={`text-sm font-semibold ${server.isActive ? 'text-zinc-200' : 'text-zinc-500'}`}>
                          {server.name}
                        </h3>
                        <span className="text-[10px] text-zinc-600 font-mono">
                          {server.id}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-500 font-mono mt-0.5">
                        {server.command} {server.args.join(' ')}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {/* SPEC mcp-index-invoke 5: dial do indice por server */}
                      <select
                        value={server.indexMode ?? 'tools'}
                        onChange={(e) =>
                          handleIndexModeChange(
                            server.id,
                            e.target.value === 'server' ? 'server' : 'tools',
                          )
                        }
                        title="Como o server aparece no indice compacto de MCPs"
                        className="bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1 text-[11px] text-zinc-300 outline-none focus:border-amber-500/50"
                      >
                        <option value="tools">Indice detalhado (1 linha/tool)</option>
                        <option value="server">Indice resumido (1 linha)</option>
                      </select>
                      <button
                        onClick={() => handleTest(server.id)}
                        className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
                        title="Testar"
                      >
                        <TestTube size={14} />
                      </button>
                      <button
                        onClick={() => handleRestart(server.id)}
                        className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
                        title="Reiniciar"
                      >
                        <RotateCw size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(server.id)}
                        className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-red-400"
                        title="Remover"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  {server.envKeys.length > 0 && (
                    <div className="mt-2 flex gap-1">
                      {server.envKeys.map((key) => (
                        <span
                          key={key}
                          className="px-2 py-0.5 bg-zinc-800 rounded text-[10px] text-zinc-400 font-mono"
                        >
                          {key}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
