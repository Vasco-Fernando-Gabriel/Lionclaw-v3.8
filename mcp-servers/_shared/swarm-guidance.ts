export const SWARM_MODE_GUIDANCE = `Escolha o modo antes de montar os argumentos:
- comite: vários especialistas analisam o MESMO alvo. Envie mode:"comite", target e members:[{slug, objective, member}]. Cada member é {kind:"registered", agentId} ou uma configuração ephemeral completa. Não envie promptTemplate, member singular ou items neste modo.
- fanout: UM perfil de agente analisa VÁRIOS alvos. Envie mode:"fanout", promptTemplate contendo {{item}}, member singular e items:[{target}]. Não envie members ou target no topo neste modo.
Para uma auditoria com secrets, auth, OWASP e isolation, use UMA chamada comite com QUATRO members. Uma run ativa por chat pode executar vários membros em paralelo, respeitando o limite de concorrência. Não crie uma run por especialista nem um cron para serializar os membros.
Consulte swarm_catalog e use agentIds disponíveis retornados por ele; não invente IDs. Envie arrays e objetos como JSON, nunca como strings. Campos comuns: requestId, cwd absoluto autorizado, objective; knownContext é opcional.
Reenvie o mesmo requestId apenas com o mesmo plano. Ao corrigir/alterar o plano, use outro requestId. Se já houver uma run ativa, consulte swarm_inspect/swarm_list e informe o estado; não aborte sem pedido do usuário. A conclusão é entregue automaticamente ao chat; não é necessário criar cron para acompanhar.`;

export const SWARM_COMITE_EXAMPLE = {
  requestId: 'auditoria-01',
  cwd: '/workspace/autorizado',
  objective: 'Auditar segurança sem alterar código',
  mode: 'comite',
  target: '.',
  members: ['secrets', 'auth', 'owasp', 'isolation'].map((slug) => ({
    slug,
    objective: `Auditar ${slug}`,
    member: { kind: 'registered', agentId: `ID_DO_CATALOGO_${slug.toUpperCase()}` },
  })),
};
export const SWARM_FANOUT_EXAMPLE = {
  requestId: 'analise-01',
  cwd: '/workspace/autorizado',
  objective: 'Analisar dois alvos sem alterar código',
  mode: 'fanout',
  promptTemplate: 'Analise {{item}} e registre evidências.',
  member: { kind: 'registered', agentId: 'ID_DO_CATALOGO' },
  items: [{ target: 'alvo A' }, { target: 'alvo B' }],
};
export const SWARM_START_DESCRIPTION = `Inicia análise paralela assíncrona, sem confirmação extra. Não use para desenvolver código; use Workflows.
${SWARM_MODE_GUIDANCE}
Exemplo comite (substitua cwd e IDs pelos valores autorizados/do catálogo): ${JSON.stringify(SWARM_COMITE_EXAMPLE)}
Exemplo fanout (substitua cwd, ID e alvos): ${JSON.stringify(SWARM_FANOUT_EXAMPLE)}`;
