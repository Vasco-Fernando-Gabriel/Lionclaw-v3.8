# Etapa 2: PRD - Requisitos do Produto

Voce esta na Etapa 2 do workflow BuildPlan. O discovery foi concluido e aprovado pelo usuario.

Antes de comecar, **rele o discovery-notes.md completo** para recuperar todo o contexto coletado na Etapa 1.

## Objetivo

Gerar o PRD (Product Requirements Document) em 3 secoes, apresentando cada uma ao usuario para aprovacao antes de avancar.

## Regra geral

- Gere uma secao por vez, apresente, aguarde feedback/aprovacao, entao gere a proxima.
- Apos aprovacao de cada secao, atualize o `discovery-notes.md` via Write tool com o conteudo aprovado.
- Adapte o conteudo ao contexto especifico do produto - nao use templates genericos.

---

## Secao 2.1: User Stories

Gere user stories baseadas no discovery. Formato obrigatorio:

```
Como [persona do usuario principal], quero [acao especifica], para [beneficio mensuravel].

Criterios de aceite:
- [ ] [criterio 1]
- [ ] [criterio 2]
```

Cubra as 3 core features identificadas no discovery. Adicione stories para auth/onboarding e billing se aplicavel.

Apos apresentar as stories, pergunte:
> "Essas user stories cobrem a solucao? Quer adicionar, remover ou ajustar alguma?"

Aguarde resposta. Aplique ajustes se necessario. Salve o resultado aprovado em `## PRD - User Stories` no discovery-notes.md.

---

## Secao 2.2: Requisitos Funcionais

Gere requisitos funcionais agrupados por dominio. Use os dominios relevantes ao produto (exemplos comuns: Auth, Core Features, Dashboard, Billing, Notificacoes, Admin). Nao use dominios que nao fazem sentido pro produto.

Formato:
```
### [Dominio]
- RF-XX: [requisito especifico e mensuravel]
```

Apos apresentar, pergunte:
> "Faltou alguma funcionalidade? Tem algo pra remover ou reformular?"

Aguarde resposta. Aplique ajustes. Salve o resultado aprovado em `## PRD - Requisitos Funcionais` no discovery-notes.md.

---

## Secao 2.3: Requisitos Nao-Funcionais

Gere RNFs nas categorias abaixo, adaptando ao contexto do produto:

**Seguranca:**
- Autenticacao, autorizacao, RLS, sessions, CORS, rate limiting

**Performance:**
- Tempos de resposta, paginacao, streaming se aplicavel, cache

**UX:**
- Responsividade, dark/light mode, loading states, acessibilidade

Apos apresentar, pergunte:
> "Algum requisito de performance ou seguranca especifico que eu devo incluir?"

Aguarde resposta. Aplique ajustes. Salve o resultado aprovado em `## PRD - Requisitos Nao-Funcionais` no discovery-notes.md.

---

## Finalizando a Etapa 2

Apos as 3 secoes aprovadas:
1. Faca um resumo breve do PRD gerado.
2. Diga: "PRD concluido. Vamos pra Etapa 3 - Modelagem do Banco de Dados?"
3. Aguarde confirmacao do usuario antes de avancar.
