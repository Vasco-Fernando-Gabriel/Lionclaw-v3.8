---
name: dreaming
description: Analisa conversas recentes, filtra memoria de trabalho e mantem MEMORY.md enxuto.
category: memory
---

# Skill: Dreaming

## Trigger
Use quando executado pelo cron semanal ou quando o usuario pedir "dreaming", "analisar conversas", "extrair padroes", "atualizar memoria".

## Modo de execucao
**AUTO-APPLY com guardrails.** Dreaming aplica direto as mudancas seguras (definidas abaixo) e gera relatorio APENAS pras mudancas em quarentena. Nao espera aprovacao humana pras operacoes de baixo risco — usuario ja autorizou esse comportamento.

Relatorio sempre vai pra `~/.lionclaw/workspaces/lionclaw/dreaming-reports/YYYY-MM-DD_dreaming-report.md` registrando o que foi aplicado e o que ficou em quarentena.

## Objetivo
Analisar conversas recentes do LionClaw, extrair padroes/decisoes, e manter MEMORY.md enxuto (<=50 linhas) e USER.md sem duplicacao.

Distribuicao:
- **MEMORY.md / USER.md** — atualizacoes pontuais (decisoes, preferencias, estado de projetos)
- **Knowledge Graph** — analise pesada (padroes recorrentes, licoes aprendidas, insights tecnicos)

## Regras de Auto-Apply

### REMOVE AUTOMATICAMENTE (sem perguntar)
Aplica direto, sem entrar em relatorio:

1. Entrada FORA das 4 secoes obrigatorias (Decisoes ativas / Workarounds / Estado de projetos / Referencias externas) no MEMORY.md
2. Entrada SEM data formatada `[YYYY-MM-DD]`
3. Duplicata literal (>85% similaridade textual) entre MEMORY.md e USER.md — remove do MEMORY.md
4. Duplicata literal interna no MEMORY.md ou USER.md — mantem a versao mais recente
5. Tarefa marcada como "RESOLVIDO", "feito", "concluido", "aplicado" nas conversas recentes
6. Estado efemero detectado por palavras-chave: "smoke test concluido", "validado nesta sessao", "rodando agora", "modelo X ativo nesta sessao", "todos MCPs funcionais"
7. Mapa de codigo (entrada que cita arquivo+linha do tipo "src/X linha N faz Z") — pertence ao codigo ou ao Graph, nao a memoria
8. Estado contavel via banco/filesystem ("297 memorias indexadas", "131 videos", "171 ativos", "426 produtos")
9. Estado de projetos sem atualizacao ha >21 dias E sem mencao nas conversas dos ultimos 7 dias
10. Workaround antigo com evidencia textual de resolucao na conversa

### ADICIONA AUTOMATICAMENTE (sem perguntar)
Aplica direto quando detectado nas conversas recentes:

1. Decisao NOVA com motivacao explicita do usuario ("X porque Y", "decidimos X", "vamos sempre X")
2. Workaround NOVO ainda ativo (bug encontrado + jeito de contornar)
3. Estado de projeto que MUDOU (iniciou, bloqueou, encerrou, marco entregue)
4. Referencia externa NOVA (URL, ID de planilha, voice_id, token, GID, path canonico nao-derivavel)

### ATUALIZA AUTOMATICAMENTE (sem perguntar)
1. Substituir entrada antiga por versao mais completa do mesmo topico
2. Trocar numeros obsoletos quando o novo aparece claro nas conversas
3. Mover entrada mal-classificada pra secao correta (ex: workaround listado em decisoes)

### QUARENTENA (vai pro relatorio, espera review humano)
Operacoes de alto risco que entram no relatorio sem aplicar:

1. Remover Referencia externa unica (URL, ID, GID, voice_id) com <90 dias
2. Remover Decisao com motivacao explicita com <90 dias
3. Adicionar nova entrada ao USER.md (preferencia/perfil — estavel, queima facil de errar)
4. Modificar SOUL.md ou RULES.md (NUNCA fazer auto-apply nesses arquivos)
5. Conflito entre fontes (USER.md diz A, conversa diz B — usuario decide)

## Fases de Execucao

### Fase 1: Coleta
Ler conversas dos ultimos 7 dias do banco SQLite:
```sql
SELECT s.id, s.title, s.type, m.role, m.content, m.created_at
FROM messages m
JOIN sessions s ON m.session_id = s.id
WHERE m.created_at >= datetime('now', '-7 days')
  AND s.type = 'chat'
  AND m.role IN ('user', 'assistant')
  AND length(m.content) > 50
ORDER BY m.created_at ASC
```
- Ignorar sessoes de tipo 'scheduled', 'telegram' (automaticas)
- Ignorar mensagens curtas (<50 chars)
- Agrupar por sessao para manter contexto

### Fase 2: Analise
Classificar cada candidato em uma das categorias:
- **decisao** (vai pra Decisoes ativas se tem motivacao)
- **workaround** (vai pra Workarounds se ainda ativo)
- **estado_projeto** (vai pra Estado de projetos se mudou)
- **referencia** (vai pra Referencias externas se nao-derivavel)
- **preferencia** (vai pra USER.md — QUARENTENA)
- **padrao_recorrente** (vai pro Graph via graph_ingest)
- **efemero** (descarta)

### Fase 3: Aplicacao Auto
Para cada candidato classificado:
- Se cai em REMOVE/ADD/UPDATE automatico → Edit no MEMORY.md direto
- Se cai em QUARENTENA → vai pro relatorio com proposta detalhada
- Se cai em padrao_recorrente → graph_ingest (apos graph_search pra evitar duplicata)

### Fase 4: Validacao pos-aplicacao
Executar e CORRIGIR se falhar:
1. MEMORY.md <= 50 linhas (se passou, podar mais — comeca pelo Estado de projetos mais antigo)
2. Toda entrada com data [YYYY-MM-DD]
3. Apenas as 4 secoes obrigatorias
4. Nenhuma duplicata MEMORY ↔ USER

### Fase 5: Relatorio Final
Salvar em `~/.lionclaw/workspaces/lionclaw/dreaming-reports/YYYY-MM-DD_dreaming-report.md`:
```
## Aplicado automaticamente
- Removido: N entradas (lista)
- Adicionado: N entradas (lista)
- Atualizado: N entradas (lista)

## Quarentena (aguarda review)
- Propostas para USER.md (lista com justificativa)
- Remocoes de alto risco (lista com justificativa)

## Ingerido no Graph
- N notas (lista de titulos)

## Estado final
- MEMORY.md: N linhas
- USER.md: N linhas
```

## Regras de Seguranca (sobreescrevem auto-apply)
- NUNCA modificar SOUL.md ou RULES.md (sempre quarentena)
- NUNCA remover Referencia externa <90 dias sem evidencia de obsolescencia
- NUNCA adicionar entrada nova ao USER.md sem quarentena
- Antes de cada remocao, validar que a info nao esta sendo citada nas conversas dos ultimos 7 dias
- Antes de graph_ingest, fazer graph_search para evitar duplicatas

## Modelo
Opus — necessario para analise de grande volume com julgamento critico.
