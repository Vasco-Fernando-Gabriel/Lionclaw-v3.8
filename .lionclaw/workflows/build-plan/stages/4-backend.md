# Etapa 4: Backend - Arquitetura e Endpoints

Voce esta na Etapa 4 do workflow BuildPlan. Discovery, PRD e Database foram concluidos e aprovados.

Antes de comecar, **rele o discovery-notes.md completo** para recuperar todo o contexto.

## Objetivo

Definir a arquitetura completa do backend: estrutura de pastas, endpoints, middleware, integracoes e agent graph (se o produto tiver IA).

## Perguntas de refinamento (uma por vez)

Faca apenas as perguntas relevantes ao produto. Contextualize com o que ja sabe:

**Q1.** "Pro backend, baseado na stack que voce escolheu ([stack do discovery]), quer adicionar algo? Por exemplo: cache (Redis), filas (BullMQ/SQS), vector DB pra RAG (pgvector/Pinecone)?"

> Se o usuario nao souber, sugira baseado no tipo de produto:
> - Produto com IA conversacional: cache de sessoes + vector DB
> - Produto CRUD simples: framework puro, sem complexidade extra
> - Produto com processamento pesado (video, audio, imagens): filas assincronas

**Q2.** (Condicional - so se o produto tem IA) "O agente de IA deve ter quais capacidades/tools? Por exemplo: busca na web, acesso a banco, execucao de codigo, envio de email..."

**Q3.** (Condicional - so se o produto tem IA) "O fluxo do agente: prefere linear (steps fixos) ou com decisoes dinamicas (agente decide o proximo passo)?"

**Q4.** "Streaming das respostas via SSE (Server-Sent Events) - ok, ou prefere polling tradicional?"

**Q5.** "Alguma API externa que preciso integrar alem das ja mencionadas? (pagamento, email, SMS, analytics...)"

## Gerar e apresentar a arquitetura

Apos as perguntas, gere e apresente:

**Estrutura de pastas:**
```
src/
  [organizacao por dominio, adaptada ao framework escolhido]
```

**Endpoints completos** (para cada endpoint):
```
[METODO] [path]
Descricao: [o que faz]
Auth: [requerida/publica/admin]
Request: { [campos] }
Response: { [campos] }
```

**Middleware:**
- Auth middleware (validacao de sessao/token)
- Rate limiting
- Error handling
- Logging

**Agent graph** (se o produto tiver IA):
- Nos e suas responsabilidades
- Transicoes entre nos
- State/contexto mantido
- Tools disponveis por no

**Padroes:**
- Error handling (formato de resposta de erro)
- Logging (estruturado, nivel de log)
- Schemas de validacao (Zod/Joi/etc baseado na stack)

## Aprovacao

Apos apresentar, pergunte:
> "Arquitetura do backend ok? Quer ajustar algum endpoint, middleware ou integracao?"

Aguarde feedback. Aplique ajustes se necessario.

## Salvar no discovery-notes.md

Apos aprovacao, atualize as secoes no discovery-notes.md:
- `## Backend - Endpoints e Integracoes`: estrutura de pastas, lista completa de endpoints, middleware, integracoes
- `## Backend - Agent Graph`: apenas se tiver IA - nos, transicoes, state, tools

## Finalizando a Etapa 4

Diga: "Backend definido. Vamos pra Etapa 5 - Arquitetura do Frontend?"
Aguarde confirmacao antes de avancar.
