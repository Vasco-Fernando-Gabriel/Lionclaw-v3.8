---
name: context-cleanup
description: Limpa USER.md e MEMORY.md removendo entradas duplicadas, redundantes ou desatualizadas. Executada semanalmente para manter os arquivos de contexto enxutos.
category: Ferramentas
---

# Skill: context-cleanup

## Quando usar
Executada semanalmente para limpar USER.md e MEMORY.md, removendo entradas duplicadas, redundantes ou desatualizadas.

## Arquivos alvo
- `~/.lionclaw/USER.md`
- `~/.lionclaw/MEMORY.md`

## Fluxo

### 1. Ler os dois arquivos na íntegra

### 2. Aplicar limpeza no USER.md
Identificar e remover:
- Linhas com o mesmo conteúdo ou conteúdo que é subconjunto de outra linha já presente
- Entradas que repetem o mesmo fato com palavras ligeiramente diferentes (ex: "Utiliza Shopify para e-commerce" vs "Usa Shopify para gestão de pedidos de e-commerce" — manter só a mais completa)
- Seções com título mas sem conteúdo útil

Regras:
- NUNCA remover informação única e não coberta por outra entrada
- Manter SEMPRE a versão mais completa quando há duplicatas parciais
- Não reescrever nem parafrasear — apenas remover o redundante
- Preservar estrutura de seções (## headers)

### 3. Aplicar limpeza no MEMORY.md
Identificar e remover:
- Linhas do tipo "Última execução não encontrou pedidos" repetidas — manter no máximo 1, ou nenhuma se for puramente ephemeral
- Registros de status de execução antigos que já não têm valor (ex: "MCP X aguardando restart" de semanas atrás)
- Duplicatas de configurações já estáveis (ex: voice_id do Alfred aparecendo 2x)

Regras:
- Manter entradas de configuração estável (IDs, URLs, credenciais referenciadas)
- Manter contexto de projetos em andamento
- Remover logs de execução repetitivos e estados transitórios antigos

### 4. Salvar os arquivos limpos
Usar Write para sobrescrever cada arquivo com o conteúdo limpo.

### 5. Reportar no chat
```
Cleanup semanal concluído:

  USER.md:   X linhas → Y linhas (Z removidas)
  MEMORY.md: X linhas → Y linhas (Z removidas)

Principais remoções:
  - "[exemplo do que foi removido]" (aparecia N vezes)
  - "[outro exemplo]"
```

Se nenhuma limpeza foi necessária:
```
Cleanup semanal: nada a remover. Arquivos já estão limpos.
```

## Regras críticas
- NUNCA deletar seções inteiras sem checar se há conteúdo único nelas
- Em caso de dúvida se algo é redundante, MANTER
- Não alterar o conteúdo semântico — só remover linhas duplicadas/redundantes
- Não tocar em nenhum outro arquivo além de USER.md e MEMORY.md
