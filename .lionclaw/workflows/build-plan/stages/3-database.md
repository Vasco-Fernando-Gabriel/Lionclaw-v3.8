# Etapa 3: Database - Modelagem do Banco de Dados

Voce esta na Etapa 3 do workflow BuildPlan. Discovery e PRD foram concluidos e aprovados.

Antes de comecar, **rele o discovery-notes.md completo** para recuperar todo o contexto das etapas anteriores.

## Objetivo

Definir o schema completo do banco de dados: tabelas, campos, relacoes, RLS, triggers e indexes.

## Fluxo

### Passo 1: Identificar entidades

Analise o discovery + PRD e identifique as entidades do sistema. Apresente a lista e pergunte:

> "Baseado no PRD, identifiquei estas entidades: [lista]. Faltou alguma? Tem alguma que nao faz sentido?"

Aguarde resposta. Ajuste a lista se necessario.

### Passo 2: Perguntas de refinamento

Para campos ou decisoes ambiguos, faca as perguntas necessarias (uma por vez):

- Para campos que podem ser texto livre ou enum: "O campo **[nome]** deve ser texto livre, select com opcoes fixas (enum), ou JSONB flexivel?"
- Sobre exclusao: "Precisa de soft delete (marcar como deletado, manter no banco) ou hard delete (apagar de verdade)?"
- Sobre historico: "Alguma entidade precisa de historico/versionamento? (ex: versoes de documento, historico de status)"

So faca as perguntas relevantes ao produto - nao pergunte sobre coisas que ja ficaram claras no discovery.

### Passo 3: Gerar e apresentar o schema

Apos as perguntas de refinamento, gere e apresente:

**Tabelas com campos e tipos:**
```sql
-- Exemplo de formato
CREATE TABLE [tabela] (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  [campo] [tipo] [constraints],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**RLS Policies** (para cada tabela com dados de usuario):
```sql
-- SELECT, INSERT, UPDATE, DELETE por user_id
```

**Triggers:**
```sql
-- auto-update updated_at
-- auto-create profile on user signup (se aplicavel)
```

**Indexes** (foreign keys e campos de busca frequente):
```sql
CREATE INDEX idx_[tabela]_[campo] ON [tabela]([campo]);
```

**Seed data** (planos, categorias fixas, etc - se aplicavel)

**Diagrama ER em texto:**
```
[tabela_a] --< [tabela_b] (relacao e cardinalidade)
```

### Passo 4: Aprovacao

Apos apresentar o schema completo, pergunte:
> "Schema esta bom? Quer ajustar alguma tabela, campo ou relacao?"

Aguarde feedback. Aplique ajustes se necessario.

## Salvar no discovery-notes.md

Apos aprovacao, atualize a secao `## Database - Entidades e Relacoes` no discovery-notes.md com o schema completo aprovado (tabelas, campos, tipos, relacoes, RLS, triggers, indexes, seed data, diagrama ER).

## Finalizando a Etapa 3

Diga: "Schema do banco definido. Vamos pra Etapa 4 - Arquitetura do Backend?"
Aguarde confirmacao antes de avancar.
