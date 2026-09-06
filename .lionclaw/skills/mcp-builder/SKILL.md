---
name: mcp-builder
description: "Use this skill when the user wants to create, develop, or improve a Model Context Protocol (MCP) server. This includes: designing new MCP servers from scratch; implementing tools and resources in MCP servers; reviewing and improving existing MCP server code; debugging MCP server issues. Trigger whenever the user mentions \"MCP\", \"MCP server\", \"Model Context Protocol\", or wants to build a tool that connects Claude or LionClaw to external services or APIs."
category: Ferramentas
---

# MCP Server Development Guide

## Stack Recomendado
- **Linguagem**: TypeScript (melhor suporte de SDK, tipagem estática, modelos de IA são melhores nela)
- **Transport**: stdio para servidores locais (padrão LionClaw), streamable HTTP para servidores remotos
- **Validação**: Zod (TypeScript) ou Pydantic (Python)

---

## Processo de Criação

### Fase 1 — Pesquisa e Planejamento

1. Entender a API do serviço (endpoints, autenticação, modelos de dados)
2. Listar ferramentas a implementar, priorizando cobertura de API abrangente
3. Ler documentação do SDK:
   - TypeScript: `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/README.md`
   - Python: `https://raw.githubusercontent.com/modelcontextprotocol/python-sdk/main/README.md`

### Fase 2 — Implementação TypeScript

```bash
mkdir mcp-meu-servidor && cd mcp-meu-servidor
npm init -y
npm install @modelcontextprotocol/sdk zod
npm install -D typescript @types/node ts-node
```

```typescript
// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "meu-servidor",
  version: "1.0.0",
});

// Registrar ferramenta
server.registerTool(
  "nome_da_ferramenta",
  {
    description: "Descrição clara do que a ferramenta faz",
    inputSchema: {
      parametro: z.string().describe("Descrição do parâmetro"),
      opcional: z.number().optional().describe("Parâmetro opcional"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
  },
  async ({ parametro, opcional }) => {
    try {
      // lógica da ferramenta
      const resultado = await chamarAPI(parametro);
      return {
        content: [{ type: "text", text: JSON.stringify(resultado, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Erro: ${error.message}. Verifique ${parametro} e tente novamente.` }],
        isError: true,
      };
    }
  }
);

// Iniciar servidor
const transport = new StdioServerTransport();
await server.connect(transport);
```

### Fase 2 — Implementação Python (alternativa)

```python
from mcp.server.fastmcp import FastMCP
from pydantic import BaseModel

mcp = FastMCP("meu-servidor")

class MinhaInput(BaseModel):
    parametro: str
    opcional: int = 0

@mcp.tool()
async def nome_da_ferramenta(input: MinhaInput) -> str:
    """Descrição clara do que a ferramenta faz."""
    try:
        resultado = await chamar_api(input.parametro)
        return str(resultado)
    except Exception as e:
        return f"Erro: {e}. Verifique {input.parametro} e tente novamente."

if __name__ == "__main__":
    mcp.run()
```

---

## Boas Práticas de Design de Ferramentas

### Nomeação
- Usar prefixo do serviço: `github_create_issue`, `shopify_list_orders`
- Verbos de ação: `get_`, `list_`, `create_`, `update_`, `delete_`
- Nomes descritivos que ajudem o agente a encontrar a ferramenta certa

### Mensagens de Erro
- Específicas: dizer exatamente o que falhou
- Acionáveis: sugerir o próximo passo
- Exemplo: `"Produto não encontrado com ID 123. Use list_products para ver produtos disponíveis."`

### Anotações (Annotations)
```typescript
annotations: {
  readOnlyHint: true,      // não modifica dados
  destructiveHint: false,  // não destrói dados
  idempotentHint: true,    // mesma chamada = mesmo resultado
  openWorldHint: false,    // acessa apenas dados do serviço
}
```

### Paginação
- Sempre implementar para listagens grandes
- Parâmetros: `limit`, `cursor` ou `page`
- Retornar `next_cursor` quando houver mais resultados

---

## Configurar no LionClaw (mcp-manager.ts)

Após criar o servidor, adicionar no `mcp-manager.ts`:

```typescript
{
  name: "meu-servidor",
  command: "node",
  args: ["/caminho/para/meu-servidor/dist/index.js"],
  env: {
    API_KEY: process.env.MEU_SERVICO_API_KEY,
  },
}
```

---

## Testar com MCP Inspector

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

---

## Checklist de Qualidade

- [ ] Todas as ferramentas têm descrições claras
- [ ] Schemas de input com Zod/Pydantic
- [ ] Error handling com mensagens acionáveis
- [ ] Anotações (readOnly, destructive, idempotent)
- [ ] Paginação em listagens
- [ ] Build sem erros TypeScript (`npm run build`)
- [ ] Testado com MCP Inspector

---

## Documentação de Referência

- Spec MCP: `https://modelcontextprotocol.io/sitemap.xml`
- TypeScript SDK: `https://github.com/modelcontextprotocol/typescript-sdk`
- Python SDK: `https://github.com/modelcontextprotocol/python-sdk`
