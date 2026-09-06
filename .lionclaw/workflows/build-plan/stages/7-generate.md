# Etapa 7: Geracao da SPEC

O usuario aprovou o discovery. O main process agora deve disparar o pipeline de geracao automatica.

## Instrucoes para o main process

Esta etapa nao envolve o workflow agent conversando com o usuario. O agente de conversa encerrou seu trabalho na Etapa 6.

O main process deve executar `executeSpecGeneration()` com o workflow run atual:

1. **Ler** o `discovery-notes.md` aprovado como fonte de verdade
2. **Disparar** o pipeline `spec-builder -> spec-validator` em loop (max 3 iteracoes)
3. **Fazer streaming** dos resultados de cada agente via IPC `workflow:agent-stream`
4. **Emitir** `workflow:generation-round` a cada iteracao com `{ round, max }`
5. **Emitir** `workflow:generation-done` quando o loop terminar com `{ specPath, notesPath }`

## Pipeline spec-builder -> spec-validator

### Iteracao 1 (geracao inicial)

**spec-builder** recebe:
- Input: conteudo completo do `discovery-notes.md`
- Tarefa: gerar `SPEC.md` unificada com todas as secoes

**spec-validator** recebe:
- Input: discovery-notes.md + SPEC.md gerada
- Tarefa: validar completude e consistencia, gerar `validation-report-1.md`

Se o relatorio contem `## Status: PASS` -> encerrar loop.
Se contem `[MISS]` ou `[CONFLICT]` -> continuar para iteracao 2.

### Iteracoes 2-3 (correcao)

**spec-builder** recebe:
- Input: SPEC.md atual + relatorio de validacao da iteracao anterior
- Tarefa: corrigir os problemas identificados

**spec-validator** recebe:
- Input: discovery-notes.md + SPEC.md corrigida
- Tarefa: re-validar, gerar `validation-report-{n}.md`

Repetir ate `## Status: PASS` ou atingir max 3 iteracoes.

### Apos o loop

Emitir `workflow:generation-done` com paths da SPEC gerada.
Se ainda houver issues apos 3 iteracoes, incluir na emissao para o renderer exibir destaque.

## Estrutura esperada da SPEC.md gerada

O spec-builder deve gerar um documento com as seguintes secoes:

```
# SPEC - [Nome do Produto]

## Resumo Executivo

## Database Schema
- Tabelas com campos, tipos, constraints
- RLS policies
- Triggers
- Indexes
- Seed data
- Diagrama ER

## Backend
- Estrutura de pastas
- Endpoints (metodo, path, auth, request, response)
- Middleware
- Agent Graph (se aplicavel)
- Integracoes externas

## Frontend
- Mapa de paginas
- Arvore de componentes
- Camada de API (hooks, fetch)
- Auth flow
- Design System

## Security
- Auth flow completo
- Checklist de seguranca
- .env.example
```
