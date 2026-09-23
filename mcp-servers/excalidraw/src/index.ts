#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import crypto from 'crypto';

interface ViewData {
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
  title: string;
  createdAt: number;
}

const views = new Map<string, ViewData>();

function pruneViews(): void {
  if (views.size <= 50) return;
  const sorted = [...views.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  const toRemove = sorted.slice(0, sorted.length - 50);
  for (const [id] of toRemove) {
    views.delete(id);
  }
}

function buildViewHtml(view: ViewData): string {
  const sceneJson = JSON.stringify({
    elements: view.elements,
    appState: {
      viewBackgroundColor: '#191919',
      theme: 'dark',
      ...view.appState,
    },
    files: view.files,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body,#root{width:100%;height:100%;overflow:hidden;background:#191919}
.loading{display:flex;align-items:center;justify-content:center;height:100%;color:#888;font-family:system-ui;font-size:14px}
.error{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#ef4444;font-family:system-ui;font-size:13px;padding:20px;text-align:center;gap:8px}
.error button{background:#27272a;color:#d4d4d8;border:1px solid #3f3f46;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:13px}
.excalidraw .App-menu,
.excalidraw .layer-ui__wrapper__top-right,
.excalidraw .layer-ui__wrapper__footer,
.excalidraw .Island,
.excalidraw .HintViewer,
.excalidraw .ToolIcon,
.excalidraw .App-toolbar,
.excalidraw .App-bottom-bar,
.excalidraw .MainMenu,
.excalidraw .main-menu-trigger,
.excalidraw .undo-redo-buttons,
.excalidraw .help-icon,
.excalidraw .zoom-actions,
.excalidraw .footer-center,
.excalidraw button:not(.excalidraw-button){display:none!important}
.excalidraw .layer-ui__wrapper{pointer-events:none}
</style>
</head>
<body>
<div id="root"><div class="loading">Carregando Excalidraw...</div></div>
<script>
window.__EXCALIDRAW_SCENE__=${sceneJson};
</script>
<script src="lionclaw-asset://bundle/excalidraw-bundle.js"></script>
<script>
try{
  var B=ExcalidrawBundle;
  var root=B.createRoot(document.getElementById('root'));
  root.render(
    B.React.createElement(B.Excalidraw,{
      initialData:window.__EXCALIDRAW_SCENE__,
      viewModeEnabled:true,
      zenModeEnabled:true,
      theme:'dark',
      UIOptions:{
        canvasActions:{export:false,saveAsImage:false,loadScene:false,clearCanvas:false,toggleTheme:false}
      }
    })
  );
}catch(err){
  document.getElementById('root').innerHTML=
    '<div class="error"><span>Erro ao carregar Excalidraw: '+err.message+'</span></div>';
}
</script>
</body>
</html>`;
}

function buildExcalidrawFile(view: ViewData): string {
  return JSON.stringify(
    {
      type: 'excalidraw',
      version: 2,
      source: 'lionclaw',
      elements: view.elements,
      appState: {
        gridSize: null,
        viewBackgroundColor: '#ffffff',
        ...view.appState,
      },
      files: view.files,
    },
    null,
    2,
  );
}

const server = new Server(
  {
    name: 'excalidraw',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'create_view',
      description:
        'Cria um diagrama Excalidraw e retorna um preview renderizado. Use para criar diagramas de arquitetura, fluxogramas, wireframes, mapas mentais e qualquer visualizacao. Os elementos seguem o formato nativo Excalidraw.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          elements: {
            type: 'array',
            description:
              'Array de elementos Excalidraw. Cada elemento precisa de: type (rectangle, ellipse, diamond, text, arrow, line, freedraw), x, y, width, height. Opcionais: strokeColor, backgroundColor, fillStyle, strokeWidth, text, fontSize, points (para arrows/lines), roundness, label ({text, fontSize} para texto dentro de shapes).',
            items: { type: 'object' },
          },
          title: {
            type: 'string',
            description: 'Titulo do diagrama',
          },
          appState: {
            type: 'object',
            description: 'Estado do app Excalidraw (opcional). Ex: { viewBackgroundColor: "#ffffff" }',
          },
        },
        required: ['elements'],
      },
    },
    {
      name: 'export_to_excalidraw',
      description:
        'Exporta um diagrama criado anteriormente como arquivo .excalidraw JSON. Use o viewId retornado por create_view.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          viewId: {
            type: 'string',
            description: 'ID do view retornado por create_view',
          },
        },
        required: ['viewId'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'create_view') {
    const input = args as {
      elements?: unknown[];
      title?: string;
      appState?: Record<string, unknown>;
    };

    const elements = input.elements || [];
    const title = input.title || 'Excalidraw';
    const appState = input.appState || {};
    const viewId = crypto.randomUUID();

    const view: ViewData = {
      elements,
      appState,
      files: {},
      title,
      createdAt: Date.now(),
    };

    views.set(viewId, view);
    pruneViews();

    const html = buildViewHtml(view);
    const excalidrawFile = buildExcalidrawFile(view);

    const resultPayload = {
      viewId,
      title,
      elementCount: elements.length,
      html,
      excalidrawFile,
      resourceUri: `ui://excalidraw/${viewId}`,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(resultPayload),
        },
      ],
      _meta: {
        ui: {
          resourceUri: `ui://excalidraw/${viewId}`,
        },
      },
    };
  }

  if (name === 'export_to_excalidraw') {
    const input = args as { viewId?: string };
    const viewId = input.viewId || '';
    const view = views.get(viewId);

    if (!view) {
      return {
        content: [{ type: 'text' as const, text: `View nao encontrado: ${viewId}` }],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: buildExcalidrawFile(view),
        },
      ],
    };
  }

  return {
    content: [{ type: 'text' as const, text: `Ferramenta desconhecida: ${name}` }],
    isError: true,
  };
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [
    {
      uriTemplate: 'ui://excalidraw/{viewId}',
      name: 'Excalidraw View',
      description: 'HTML renderizado de um diagrama Excalidraw',
      mimeType: 'text/html;profile=mcp-app',
    },
  ],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [...views.entries()].map(([id, view]) => ({
    uri: `ui://excalidraw/${id}`,
    name: view.title,
    description: `Diagrama com ${view.elements.length} elementos`,
    mimeType: 'text/html;profile=mcp-app',
  })),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  const match = uri.match(/^ui:\/\/excalidraw\/(.+)$/);

  if (!match) {
    throw new Error(`URI invalido: ${uri}`);
  }

  const viewId = match[1];
  const view = views.get(viewId);

  if (!view) {
    throw new Error(`View nao encontrado: ${viewId}`);
  }

  return {
    contents: [
      {
        uri,
        mimeType: 'text/html;profile=mcp-app',
        text: buildViewHtml(view),
      },
    ],
  };
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
