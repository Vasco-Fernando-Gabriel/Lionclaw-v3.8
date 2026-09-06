import type { DesignContract, DesignDelta } from '../../../src/types/open-design';

export function buildBrief(contract: DesignContract): string {
  const lines: string[] = [];

  lines.push('# Design Brief');
  lines.push('');

  lines.push('## Direcao Visual');
  lines.push('');
  lines.push(`**Direcao:** ${contract.visual.direction || '(nao especificada)'}`);
  if (contract.visual.designSystem) {
    lines.push(`**Design System:** ${contract.visual.designSystem}`);
  }
  lines.push(`**Densidade:** ${contract.visual.density}`);
  lines.push('');

  lines.push('## Tokens');
  lines.push('');

  const { tokens } = contract.visual;

  if (Object.keys(tokens.colors).length > 0) {
    lines.push('### Cores');
    lines.push('');
    lines.push('| Token | Valor |');
    lines.push('|-------|-------|');
    for (const [k, v] of Object.entries(tokens.colors)) {
      lines.push(`| ${k} | ${v} |`);
    }
    lines.push('');
  }

  if (Object.keys(tokens.typography).length > 0) {
    lines.push('### Tipografia');
    lines.push('');
    lines.push('| Token | Valor |');
    lines.push('|-------|-------|');
    for (const [k, v] of Object.entries(tokens.typography)) {
      lines.push(`| ${k} | ${v} |`);
    }
    lines.push('');
  }

  if (Object.keys(tokens.spacing).length > 0) {
    lines.push('### Espacamento');
    lines.push('');
    lines.push('| Token | Valor |');
    lines.push('|-------|-------|');
    for (const [k, v] of Object.entries(tokens.spacing)) {
      lines.push(`| ${k} | ${v} |`);
    }
    lines.push('');
  }

  if (Object.keys(tokens.radii).length > 0) {
    lines.push('### Radii');
    lines.push('');
    lines.push('| Token | Valor |');
    lines.push('|-------|-------|');
    for (const [k, v] of Object.entries(tokens.radii)) {
      lines.push(`| ${k} | ${v} |`);
    }
    lines.push('');
  }

  lines.push('## Mapa de Telas');
  lines.push('');
  if (contract.screens.length === 0) {
    lines.push('(nenhuma tela declarada)');
  } else {
    for (const screen of contract.screens) {
      lines.push(
        `- **${screen.title}** (\`${screen.id}\`) — rota: \`${screen.route}\`` +
          (screen.userStoryIds.length > 0
            ? ` — stories: ${screen.userStoryIds.join(', ')}`
            : ''),
      );
    }
  }
  lines.push('');

  lines.push('## Navegacao Principal');
  lines.push('');
  if (contract.navigation.primary.length === 0) {
    lines.push('(nenhum item de navegacao declarado)');
  } else {
    for (const item of contract.navigation.primary) {
      lines.push(
        `- **${item.label}** (\`${item.id}\`) -> tela \`${item.targetScreenId}\`` +
          (item.userStoryIds.length > 0
            ? ` — stories: ${item.userStoryIds.join(', ')}`
            : ''),
      );
    }
  }
  lines.push('');

  lines.push('## Componentes Principais');
  lines.push('');
  if (contract.components.length === 0) {
    lines.push('(nenhum componente declarado)');
  } else {
    for (const comp of contract.components) {
      lines.push(`- **${comp.name}** (\`${comp.id}\`) — tipo: \`${comp.type}\``);
    }
  }
  lines.push('');

  const deltas: DesignDelta[] = contract.deltas ?? [];
  if (deltas.length > 0) {
    lines.push('## Deltas');
    lines.push('');
    for (const delta of deltas) {
      const badge = delta.requiresRequirementsChange ? ' [REQUER MUDANCA DE REQUISITOS]' : '';
      lines.push(
        `- **${delta.type}** (\`${delta.id}\`) — impacto: ${delta.impact}${badge}`,
      );
      lines.push(`  ${delta.description}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
