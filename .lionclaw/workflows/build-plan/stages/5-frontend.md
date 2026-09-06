# Etapa 5: Frontend - Arquitetura e Design

Voce esta na Etapa 5 do workflow BuildPlan. Discovery, PRD, Database e Backend foram concluidos.

Antes de comecar, **rele o discovery-notes.md completo** para recuperar todo o contexto.

## Objetivo

Definir a arquitetura completa do frontend: paginas, componentes, design system, camada de API e auth flow.

## Perguntas de refinamento (uma por vez)

**Q1.** "Tem referencia visual? Pode ser site, print de tela, Figma, template que gosta, ou descrever o estilo que quer."

> Se tiver referencia, analise e extraia: layout, paleta de cores, tipografia, estilo de componentes.
> Se nao tiver, continue com as proximas perguntas.

**Q2.** "Preferencia de layout do dashboard/app?
  a) Sidebar fixa + conteudo principal
  b) Top navigation + conteudo
  c) Sidebar colapsavel (expande/recolhe)
  d) Me surpreenda - voce decide baseado no produto"

**Q3.** "Paleta de cores?
  a) Dark mode como padrao
  b) Light mode como padrao
  c) Auto (segue configuracao do sistema do usuario)
  d) Tenho cores especificas - [quais?]"

**Q4.** "Precisa de algum componente especial?
  Por exemplo: chat interface, drag & drop, kanban board, editor rich text, calendario, graficos/dashboard analytics..."

**Q5.** "Landing page eh necessaria pro MVP ou so o app logado (dashboard)?"

## Gerar e apresentar a arquitetura

Apos as perguntas, gere e apresente:

**Mapa de paginas (routing):**
```
/ -> [pagina]
/[rota] -> [pagina]
[descricao breve de cada pagina e seu proposito]
```

**Arvore de componentes** (principais, nao exaustiva):
```
[Pagina]
  [ComponenteA]
    [SubComponente]
  [ComponenteB]
```

**Camada de API (fetch layer):**
- Fetch wrapper/client base
- Hooks por dominio (ex: useAuth, useProducts)
- SSE client (se aplicavel)
- Tratamento de erros

**Auth flow no frontend:**
- Rotas protegidas vs publicas
- Redirect para login se nao autenticado
- Persistencia de sessao
- Logout e limpeza de estado

**Design system:**
- Cores (primaria, secundaria, neutros, feedback)
- Tipografia (fonte, escalas de tamanho)
- Espacamento (escala de spacing)
- Componentes base (Button, Input, Card, Modal, etc)
- Dark/Light mode (se aplicavel)

## Aprovacao

Apos apresentar, pergunte:
> "Arquitetura do frontend ok? Quer ajustar alguma pagina, componente ou decisao de design?"

Aguarde feedback. Aplique ajustes se necessario.

## Salvar no discovery-notes.md

Apos aprovacao, atualize as secoes no discovery-notes.md:
- `## Frontend - Paginas e Componentes`: mapa de paginas, arvore de componentes, camada de API, auth flow
- `## Frontend - Design System`: cores, tipografia, spacing, componentes base, referencias visuais

## Finalizando a Etapa 5

Diga: "Frontend definido. Ultima etapa tecnica - vamos pra Seguranca?"
Aguarde confirmacao antes de avancar.
