import type Database from 'better-sqlite3';

export function applyMigrationV58(db: Database.Database): void {
  const insertAgent = db.prepare(`
    INSERT OR IGNORE INTO agents (
      id, name, description, system_prompt, model, effort, thinking, thinking_budget,
      max_turns, max_tool_rounds, allowed_tools, mcp_servers,
      is_active, skills, runtime, squad, sort_order,
      local_config, external_config, codex_config, local_mode
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `);

  const agents = [
    {
      id: 'pipe2-prd-completo',
      name: 'Pipe2 PRD Completo',
      description:
        'Gera o PRD Completo do pipeline development-v2 incorporando o design lock aprovado. Prompt placeholder — conteudo completo na Sprint 6.',
      systemPrompt: 'Voce e o pipe2-prd-completo. Prompt placeholder — sera atualizado na Sprint 6.',
      model: 'claude-opus-4-7',
      effort: 'high',
      thinking: 'enabled',
      thinkingBudget: 10000,
      maxTurns: 30,
      maxToolRounds: 20,
      allowedTools: JSON.stringify(['Read', 'Write', 'Edit', 'Glob', 'Grep']),
      mcpServers: JSON.stringify([]),
      isActive: 1,
      skills: JSON.stringify([]),
      runtime: 'cloud',
      squad: 'pipeline',
      sortOrder: 900,
    },
    {
      id: 'pipe2-tech-frontend',
      name: 'Pipe2 Frontend Tecnico',
      description:
        'Decisoes tecnicas de Frontend no pipeline development-v2, considerando o design lock e artifact HTML. Prompt placeholder — conteudo completo na Sprint 6.',
      systemPrompt: 'Voce e o pipe2-tech-frontend. Prompt placeholder — sera atualizado na Sprint 6.',
      model: 'claude-sonnet-4-6',
      effort: 'high',
      thinking: 'enabled',
      thinkingBudget: 8000,
      maxTurns: 30,
      maxToolRounds: 20,
      allowedTools: JSON.stringify(['Read', 'Write', 'Edit', 'Glob', 'Grep']),
      mcpServers: JSON.stringify([]),
      isActive: 1,
      skills: JSON.stringify([]),
      runtime: 'cloud',
      squad: 'pipeline',
      sortOrder: 901,
    },
    {
      id: 'pipe2-spec-builder',
      name: 'Pipe2 Spec Builder',
      description:
        'Gera a SPEC do pipeline development-v2 incorporando rotas, telas, componentes, tokens e path do artifact HTML. Prompt placeholder — conteudo completo na Sprint 6.',
      systemPrompt: 'Voce e o pipe2-spec-builder. Prompt placeholder — sera atualizado na Sprint 6.',
      model: 'claude-opus-4-7',
      effort: 'high',
      thinking: 'enabled',
      thinkingBudget: 15000,
      maxTurns: 40,
      maxToolRounds: 30,
      allowedTools: JSON.stringify(['Read', 'Write', 'Edit', 'Glob', 'Grep']),
      mcpServers: JSON.stringify([]),
      isActive: 1,
      skills: JSON.stringify([]),
      runtime: 'cloud',
      squad: 'pipeline',
      sortOrder: 902,
    },
    {
      id: 'pipe2-spec-validator',
      name: 'Pipe2 Spec Validator',
      description:
        'Valida a SPEC do pipeline development-v2 contra PRD, user stories e design lock. Prompt placeholder — conteudo completo na Sprint 6.',
      systemPrompt: 'Voce e o pipe2-spec-validator. Prompt placeholder — sera atualizado na Sprint 6.',
      model: 'claude-sonnet-4-6',
      effort: 'high',
      thinking: 'enabled',
      thinkingBudget: 8000,
      maxTurns: 30,
      maxToolRounds: 20,
      allowedTools: JSON.stringify(['Read', 'Write', 'Edit', 'Glob', 'Grep']),
      mcpServers: JSON.stringify([]),
      isActive: 1,
      skills: JSON.stringify([]),
      runtime: 'cloud',
      squad: 'pipeline',
      sortOrder: 903,
    },
    {
      id: 'pipe2-spec-enricher',
      name: 'Pipe2 Spec Enricher',
      description:
        'Enriquece a SPEC do pipeline development-v2 com edge cases, UI states e paths alternativos considerando o design lock. Prompt placeholder — conteudo completo na Sprint 6.',
      systemPrompt: 'Voce e o pipe2-spec-enricher. Prompt placeholder — sera atualizado na Sprint 6.',
      model: 'claude-sonnet-4-6',
      effort: 'high',
      thinking: 'enabled',
      thinkingBudget: 8000,
      maxTurns: 30,
      maxToolRounds: 20,
      allowedTools: JSON.stringify(['Read', 'Write', 'Edit', 'Glob', 'Grep']),
      mcpServers: JSON.stringify([]),
      isActive: 1,
      skills: JSON.stringify([]),
      runtime: 'cloud',
      squad: 'pipeline',
      sortOrder: 904,
    },
  ];

  const insertAll = db.transaction(() => {
    for (const agent of agents) {
      insertAgent.run(
        agent.id,
        agent.name,
        agent.description,
        agent.systemPrompt,
        agent.model,
        agent.effort,
        agent.thinking,
        agent.thinkingBudget,
        agent.maxTurns,
        agent.maxToolRounds,
        agent.allowedTools,
        agent.mcpServers,
        agent.isActive,
        agent.skills,
        agent.runtime,
        agent.squad,
        agent.sortOrder,
        null,
        null,
        null,
        'simple',
      );
    }
  });

  insertAll();
}
