import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import Fuse from 'fuse.js';
import chokidar from 'chokidar';


const LIONCLAW_HOME = process.env.LIONCLAW_HOME || path.join(os.homedir(), '.lionclaw');
const VAULT_DIR = path.join(LIONCLAW_HOME, 'mgraph');
const INGEST_QUEUE_DIR = path.join(VAULT_DIR, '.ingest-queue');
const VAULT_SUBDIRS = ['entities', 'meetings', 'decisions', 'projects', 'references'] as const;
const INDEX_DEBOUNCE_MS = 2000;
const SNIPPET_LENGTH = 200;


interface NoteFrontmatter {
  title: string;
  type: string;
  tags: string[];
  source: string;
  session_id: string;
  created: string;
  updated: string;
}

interface NoteIndexEntry {
  path: string;       // relative to VAULT_DIR, e.g. "entities/person-foo.md"
  title: string;
  type: string;
  tags: string[];
  body: string;
  updatedAt: string;
}

interface SearchResultItem {
  path: string;
  title: string;
  type: string;
  tags: string[];
  score: number;
  snippet: string;
  updatedAt: string;
}


function parseFrontmatter(content: string): { frontmatter: Partial<NoteFrontmatter>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const fmBlock = match[1];
  const body = match[2];
  const fm: Partial<NoteFrontmatter> = {};

  for (const line of fmBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    let value = line.substring(colonIdx + 1).trim();

    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    switch (key) {
      case 'title':      fm.title = value; break;
      case 'type':       fm.type = value; break;
      case 'source':     fm.source = value; break;
      case 'session_id': fm.session_id = value; break;
      case 'created':    fm.created = value; break;
      case 'updated':    fm.updated = value; break;
      case 'tags': {
        const tagMatch = value.match(/\[(.*)\]/);
        if (tagMatch) {
          fm.tags = tagMatch[1]
            .split(',')
            .map((t) => t.trim().replace(/^"|"$/g, ''))
            .filter(Boolean);
        }
        break;
      }
    }
  }

  return { frontmatter: fm, body };
}


function readAllNotes(): NoteIndexEntry[] {
  const entries: NoteIndexEntry[] = [];

  for (const subdir of VAULT_SUBDIRS) {
    const dirPath = path.join(VAULT_DIR, subdir);
    if (!fs.existsSync(dirPath)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of files) {
      const fullPath = path.join(dirPath, file);
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const { frontmatter, body } = parseFrontmatter(content);
      const relativePath = `${subdir}/${file}`;

      entries.push({
        path: relativePath,
        title: frontmatter.title || file.replace('.md', ''),
        type: frontmatter.type || subdir,
        tags: frontmatter.tags || [],
        body: body.trim(),
        updatedAt: frontmatter.updated || frontmatter.created || '',
      });
    }
  }

  return entries;
}


let fuseIndex: Fuse<NoteIndexEntry> | null = null;
let notesList: NoteIndexEntry[] = [];
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

function buildIndex(): void {
  notesList = readAllNotes();
  fuseIndex = new Fuse(notesList, {
    keys: [
      { name: 'title', weight: 3.0 },
      { name: 'tags',  weight: 2.0 },
      { name: 'body',  weight: 1.0 },
    ],
    threshold: 0.4,
    includeScore: true,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });
}

function scheduleRebuild(): void {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    buildIndex();
    rebuildTimer = null;
  }, INDEX_DEBOUNCE_MS);
}

buildIndex();

if (fs.existsSync(VAULT_DIR)) {
  const watcher = chokidar.watch(VAULT_DIR, {
    ignored: /(^|[/\\])\../, // ignore dotfiles/dirs
    persistent: true,
    ignoreInitial: true,
  });
  watcher.on('add', scheduleRebuild);
  watcher.on('change', scheduleRebuild);
  watcher.on('unlink', scheduleRebuild);
}


function extractWikiLinks(content: string): string[] {
  const matches = content.matchAll(/\[\[([^\]]+)\]\]/g);
  const links: string[] = [];
  for (const m of matches) {
    links.push(m[1].trim());
  }
  return links;
}

function wikiLinkKey(rawTarget: string): string {
  let target = rawTarget.split('|')[0].trim();
  if (target.includes('/')) {
    target = target.substring(target.lastIndexOf('/') + 1);
  }
  if (target.endsWith('.md')) {
    target = target.slice(0, -3);
  }
  return target
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
}


function makeSnippet(body: string, query: string): string {
  const lower = body.toLowerCase();
  const queryLower = query.toLowerCase();
  const idx = lower.indexOf(queryLower);

  if (idx === -1) {
    return body.substring(0, SNIPPET_LENGTH).replace(/\n+/g, ' ').trim();
  }

  const start = Math.max(0, idx - 60);
  const end = Math.min(body.length, start + SNIPPET_LENGTH);
  const snippet = body.substring(start, end).replace(/\n+/g, ' ').trim();
  return (start > 0 ? '...' : '') + snippet + (end < body.length ? '...' : '');
}


const server = new McpServer({
  name: 'graph-search',
  version: '1.0.0',
});

const DOMAIN_PREFIX = '[Vault de conhecimento]';


server.tool(
  'graph_search',
  `${DOMAIN_PREFIX} Busca fuzzy nas notas do Knowledge Graph (vault) usando Fuse.js com indice em memoria.
Use esta tool quando precisar encontrar notas, entidades, decisoes, projetos, reunioes ou referencias
importadas de documentos externos. O Knowledge Graph pode ter informacoes exclusivas de docs importados
que nao existem na memoria de conversas (memory_search).
Exemplos de quando usar:
- "encontra notas sobre o projeto X"
- "quais entidades estao registradas?"
- "tem alguma decisao sobre arquitetura?"
- busca em documentos importados (PDFs, URLs, arquivos)`,
  {
    query: z.string().describe('Texto para buscar nas notas. Suporta busca fuzzy.'),
    type: z.enum(['entities', 'meetings', 'decisions', 'projects', 'references']).optional()
      .describe('Filtrar por tipo de nota (opcional).'),
    limit: z.number().optional().default(10).describe('Numero maximo de resultados (padrao: 10).'),
  },
  async ({ query, type, limit }) => {
    try {
      if (!fuseIndex) {
        return {
          content: [{ type: 'text' as const, text: 'Indice ainda nao construido. Tente novamente em instantes.' }],
        };
      }

      let results = fuseIndex.search(query, { limit: (limit || 10) * 3 });

      if (type) {
        results = results.filter((r) => r.item.type === type || r.item.path.startsWith(`${type}/`));
      }

      results.sort((a, b) => {
        const scoreDiff = (a.score ?? 1) - (b.score ?? 1); // lower score = better in Fuse
        if (Math.abs(scoreDiff) > 0.05) return scoreDiff;
        return (b.item.updatedAt || '').localeCompare(a.item.updatedAt || '');
      });

      const topResults = results.slice(0, limit || 10);

      if (topResults.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Nenhuma nota encontrada para: "${query}" no Knowledge Graph.`,
          }],
        };
      }

      const formatted = topResults.map((r, i) => {
        const item = r.item;
        const score = ((1 - (r.score ?? 1)) * 100).toFixed(0);
        const tags = item.tags.length > 0 ? ` [${item.tags.join(', ')}]` : '';
        const snippet = makeSnippet(item.body, query);
        return `### [${i + 1}] ${item.title} (${item.type})${tags} score=${score}%\nPath: ${item.path}\nAtualizado: ${item.updatedAt || 'desconhecido'}\n${snippet}`;
      }).join('\n\n---\n\n');

      return {
        content: [{
          type: 'text' as const,
          text: `Encontrei ${topResults.length} nota(s) no Knowledge Graph:\n\n${formatted}`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Erro na busca: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);


server.tool(
  'graph_read',
  `${DOMAIN_PREFIX} Le o conteudo completo de uma nota do Knowledge Graph pelo seu path relativo.
Use apos graph_search para obter o conteudo completo de uma nota especifica.
O path deve ser no formato "tipo/nome-do-arquivo.md" (ex: "entities/pessoa-joao.md").`,
  {
    path: z.string().describe('Path relativo da nota no vault (ex: "entities/pessoa-joao.md").'),
  },
  async ({ path: notePath }) => {
    try {
      const fullPath = path.resolve(VAULT_DIR, notePath);
      if (!fullPath.startsWith(VAULT_DIR)) {
        return {
          content: [{ type: 'text' as const, text: 'Erro: path invalido (path traversal detectado).' }],
          isError: true,
        };
      }

      if (!fs.existsSync(fullPath)) {
        return {
          content: [{ type: 'text' as const, text: `Nota nao encontrada: ${notePath}` }],
          isError: true,
        };
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      return {
        content: [{ type: 'text' as const, text: content }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Erro ao ler nota: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);


server.tool(
  'graph_stats',
  `${DOMAIN_PREFIX} Retorna estatisticas do Knowledge Graph: total de notas por tipo, total de conexoes wiki-link, e data da ultima atualizacao.`,
  {},
  async () => {
    try {
      const notes = notesList.length > 0 ? notesList : readAllNotes();

      const byType: Record<string, number> = {};
      let totalLinks = 0;
      let lastUpdated = '';

      for (const note of notes) {
        const t = note.type || 'unknown';
        byType[t] = (byType[t] || 0) + 1;

        const links = extractWikiLinks(note.body);
        totalLinks += links.length;

        if (note.updatedAt && note.updatedAt > lastUpdated) {
          lastUpdated = note.updatedAt;
        }
      }

      const byTypeLines = Object.entries(byType)
        .sort(([, a], [, b]) => b - a)
        .map(([type, count]) => `  - ${type}: ${count}`)
        .join('\n');

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Estatisticas do Knowledge Graph:`,
            `- Total de notas: ${notes.length}`,
            `- Por tipo:\n${byTypeLines || '  (nenhuma nota)'}`,
            `- Total de conexoes wiki-link: ${totalLinks}`,
            `- Ultima atualizacao: ${lastUpdated || 'desconhecida'}`,
          ].join('\n'),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Erro ao obter stats: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);


server.tool(
  'graph_connections',
  `${DOMAIN_PREFIX} Retorna notas conectadas a uma nota especifica via wiki-links [[...]], tanto incoming (apontam para ela) quanto outgoing (ela aponta para outras).
Suporta depth 1 (vizinhos diretos) ou depth 2 (vizinhos de vizinhos).
Use o noteId como o titulo da nota ou o path relativo.`,
  {
    noteId: z.string().describe('Titulo ou path relativo da nota (ex: "Joao Silva" ou "entities/joao-silva.md").'),
    depth: z.number().min(1).max(2).optional().default(1)
      .describe('Profundidade de conexoes: 1 = vizinhos diretos, 2 = vizinhos de vizinhos (padrao: 1).'),
  },
  async ({ noteId, depth }) => {
    try {
      const notes = notesList.length > 0 ? notesList : readAllNotes();

      const targetKey = wikiLinkKey(noteId);
      const target = notes.find(
        (n) => n.path === noteId || n.title.toLowerCase() === noteId.toLowerCase() || n.path.includes(noteId),
      ) ?? notes.find(
        (n) => wikiLinkKey(n.path) === targetKey || wikiLinkKey(n.title) === targetKey,
      );

      if (!target) {
        return {
          content: [{ type: 'text' as const, text: `Nota nao encontrada: "${noteId}". Use graph_search para encontrar o path correto.` }],
          isError: true,
        };
      }

      const titleToPath = new Map<string, string>();
      for (const note of notes) {
        for (const key of [wikiLinkKey(note.path), wikiLinkKey(note.title)]) {
          if (key && !titleToPath.has(key)) titleToPath.set(key, note.path);
        }
      }

      const pathToNote = new Map<string, NoteIndexEntry>();
      for (const note of notes) {
        pathToNote.set(note.path, note);
      }

      function getConnections(notePath: string): { outgoing: string[]; incoming: string[] } {
        const note = pathToNote.get(notePath);
        const outgoing: string[] = [];
        const incoming: string[] = [];

        if (note) {
          const links = extractWikiLinks(note.body);
          for (const link of links) {
            const resolvedPath = titleToPath.get(wikiLinkKey(link));
            if (resolvedPath && resolvedPath !== notePath) {
              outgoing.push(resolvedPath);
            }
          }
        }

        for (const n of notes) {
          if (n.path === notePath) continue;
          const links = extractWikiLinks(n.body);
          for (const link of links) {
            const resolvedPath = titleToPath.get(wikiLinkKey(link));
            if (resolvedPath === notePath) {
              incoming.push(n.path);
              break;
            }
          }
        }

        return { outgoing, incoming };
      }

      const d1 = getConnections(target.path);
      const allConnectedPaths = new Set<string>([...d1.outgoing, ...d1.incoming]);

      let d2Paths = new Set<string>();
      if ((depth || 1) >= 2) {
        for (const connPath of allConnectedPaths) {
          const d2 = getConnections(connPath);
          for (const p of [...d2.outgoing, ...d2.incoming]) {
            if (p !== target.path && !allConnectedPaths.has(p)) {
              d2Paths.add(p);
            }
          }
        }
      }

      function formatNoteRef(p: string): string {
        const n = pathToNote.get(p);
        return n ? `- ${n.title} (${n.type}) → ${p}` : `- ${p}`;
      }

      const lines: string[] = [
        `Conexoes de: **${target.title}** (${target.path})`,
        '',
        `## Outgoing (${d1.outgoing.length} links que esta nota aponta)`,
        ...d1.outgoing.map(formatNoteRef),
        '',
        `## Incoming (${d1.incoming.length} notas que apontam para esta)`,
        ...d1.incoming.map(formatNoteRef),
      ];

      if ((depth || 1) >= 2 && d2Paths.size > 0) {
        lines.push('');
        lines.push(`## Vizinhos de vizinhos - depth 2 (${d2Paths.size} notas)`);
        for (const p of d2Paths) {
          lines.push(formatNoteRef(p));
        }
      }

      if (d1.outgoing.length === 0 && d1.incoming.length === 0) {
        lines.push('');
        lines.push('Esta nota nao tem conexoes wiki-link com outras notas.');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Erro ao obter conexoes: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);


server.tool(
  'graph_ingest',
  `${DOMAIN_PREFIX} Enfileira conteudo para ingestao no Knowledge Graph.
Use para adicionar texto, arquivos ou URLs ao vault para processamento pela IA.
O conteudo e colocado em fila e processado pelo main process do LionClaw.
Retorna um jobId para rastrear o status.`,
  {
    content: z.string().describe('Conteudo a ser ingerido (texto, URL ou path de arquivo).'),
    title: z.string().optional().describe('Titulo opcional para o conteudo.'),
    type: z.enum(['text', 'file', 'url']).describe('Tipo do conteudo: "text" para texto livre, "file" para arquivo, "url" para URL.'),
  },
  async ({ content, title, type }) => {
    try {
      fs.mkdirSync(INGEST_QUEUE_DIR, { recursive: true });

      const jobId = randomUUID();
      const jobFile = path.join(INGEST_QUEUE_DIR, `${jobId}.json`);

      const job = {
        type,
        content,
        title: title || null,
        timestamp: new Date().toISOString(),
      };

      fs.writeFileSync(jobFile, JSON.stringify(job, null, 2), 'utf-8');

      return {
        content: [{
          type: 'text' as const,
          text: `Conteudo enfileirado para ingestao no Knowledge Graph.\n- jobId: ${jobId}\n- tipo: ${type}\n- titulo: ${title || '(sem titulo)'}\n\nO LionClaw processara o conteudo em background e adicionara as notas ao vault.`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Erro ao enfileirar ingestao: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);


async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`graph-search MCP failed: ${err}\n`);
  process.exit(1);
});
