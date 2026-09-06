#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { google } from 'googleapis';
import { sheets_v4 } from 'googleapis';

const MAX_ROWS_PER_READ = 500;

let sheetsApi: sheets_v4.Sheets;

function initSheets(): void {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const accessToken = process.env.GOOGLE_ACCESS_TOKEN;

  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET sao obrigatorios');
  if (!refreshToken) throw new Error('GOOGLE_REFRESH_TOKEN nao encontrado. Configure no Settings.');

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken, access_token: accessToken || undefined });
  sheetsApi = google.sheets({ version: 'v4', auth: oauth2Client });
}

const server = new Server(
  { name: 'google-sheets', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_sheets',
      description: 'Listar as abas (sheets/tabs) de um spreadsheet.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          spreadsheet_id: { type: 'string', description: 'ID do spreadsheet' },
        },
        required: ['spreadsheet_id'],
      },
    },
    {
      name: 'read_range',
      description: 'Ler um range de celulas de uma aba. Limite de 500 linhas por chamada.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          spreadsheet_id: { type: 'string', description: 'ID do spreadsheet' },
          range: { type: 'string', description: 'Range no formato A1 (ex: "Aba1!A1:D50" ou "A1:D50")' },
          value_render: {
            type: 'string',
            enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE'],
            description: 'Como renderizar valores (default: FORMATTED_VALUE)',
          },
        },
        required: ['spreadsheet_id', 'range'],
      },
    },
    {
      name: 'read_sheet_summary',
      description: 'Ler headers + primeiras N linhas de uma aba para dar contexto.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          spreadsheet_id: { type: 'string', description: 'ID do spreadsheet' },
          sheet_name: { type: 'string', description: 'Nome da aba (default: primeira aba)' },
          preview_rows: { type: 'number', description: 'Numero de linhas de preview (default: 5)' },
        },
        required: ['spreadsheet_id'],
      },
    },
    {
      name: 'write_range',
      description: 'Escrever valores em um range.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          spreadsheet_id: { type: 'string', description: 'ID do spreadsheet' },
          range: { type: 'string', description: 'Range de destino (ex: "Aba1!A1")' },
          values: {
            type: 'array',
            items: { type: 'array', items: {} },
            description: 'Array de arrays com os valores (ex: [["Nome", "Preco"], ["Produto A", "29.90"]])',
          },
          value_input: {
            type: 'string',
            enum: ['RAW', 'USER_ENTERED'],
            description: 'Como interpretar valores (default: USER_ENTERED)',
          },
        },
        required: ['spreadsheet_id', 'range', 'values'],
      },
    },
    {
      name: 'append_rows',
      description: 'Adicionar linhas ao final de uma aba.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          spreadsheet_id: { type: 'string', description: 'ID do spreadsheet' },
          sheet_name: { type: 'string', description: 'Nome da aba (default: primeira aba)' },
          rows: {
            type: 'array',
            items: { type: 'array', items: {} },
            description: 'Array de arrays com as linhas a adicionar',
          },
        },
        required: ['spreadsheet_id', 'rows'],
      },
    },
    {
      name: 'update_cells',
      description: 'Atualizar celulas especificas sem sobrescrever um range inteiro.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          spreadsheet_id: { type: 'string', description: 'ID do spreadsheet' },
          updates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                cell: { type: 'string', description: 'Referencia da celula (ex: "A5")' },
                value: { description: 'Novo valor da celula' },
              },
              required: ['cell', 'value'],
            },
            description: 'Array de atualizacoes pontuais',
          },
          sheet_name: { type: 'string', description: 'Nome da aba (default: primeira aba)' },
        },
        required: ['spreadsheet_id', 'updates'],
      },
    },
    {
      name: 'clear_range',
      description: 'Limpar valores de um range (mantem formatacao).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          spreadsheet_id: { type: 'string', description: 'ID do spreadsheet' },
          range: { type: 'string', description: 'Range a limpar (ex: "Aba1!A1:D50")' },
        },
        required: ['spreadsheet_id', 'range'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!sheetsApi) initSheets();

  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'list_sheets': {
        const { spreadsheet_id } = args as { spreadsheet_id: string };
        const res = await sheetsApi.spreadsheets.get({
          spreadsheetId: spreadsheet_id,
          fields: 'sheets.properties',
        });
        const sheets = (res.data.sheets || []).map((s) => ({
          sheetId: s.properties?.sheetId,
          title: s.properties?.title,
          index: s.properties?.index,
          rowCount: s.properties?.gridProperties?.rowCount,
          columnCount: s.properties?.gridProperties?.columnCount,
        }));
        return { content: [{ type: 'text', text: JSON.stringify(sheets, null, 2) }] };
      }

      case 'read_range': {
        const { spreadsheet_id, range, value_render } = args as {
          spreadsheet_id: string;
          range: string;
          value_render?: string;
        };
        const res = await sheetsApi.spreadsheets.values.get({
          spreadsheetId: spreadsheet_id,
          range,
          valueRenderOption: (value_render || 'FORMATTED_VALUE') as sheets_v4.Params$Resource$Spreadsheets$Values$Get['valueRenderOption'],
        });
        const rows = res.data.values || [];
        const truncated = rows.length > MAX_ROWS_PER_READ;
        const limitedRows = truncated ? rows.slice(0, MAX_ROWS_PER_READ) : rows;
        const result: Record<string, unknown> = {
          range: res.data.range,
          rows: limitedRows,
          total_rows: limitedRows.length,
          total_cols: limitedRows.length > 0 ? Math.max(...limitedRows.map((r) => r.length)) : 0,
        };
        if (truncated) {
          result.truncated = true;
          result.note = 'Use um range menor ou paginado.';
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'read_sheet_summary': {
        const { spreadsheet_id, sheet_name, preview_rows } = args as {
          spreadsheet_id: string;
          sheet_name?: string;
          preview_rows?: number;
        };
        const numPreview = preview_rows || 5;

        const meta = await sheetsApi.spreadsheets.get({
          spreadsheetId: spreadsheet_id,
          fields: 'sheets.properties',
        });
        const sheets = meta.data.sheets || [];
        const targetSheet = sheet_name
          ? sheets.find((s) => s.properties?.title === sheet_name)
          : sheets[0];

        if (!targetSheet) {
          return { content: [{ type: 'text', text: `Aba "${sheet_name}" nao encontrada.` }], isError: true };
        }

        const sheetTitle = targetSheet.properties?.title || 'Sheet1';
        const totalRows = targetSheet.properties?.gridProperties?.rowCount || 0;

        const range = `'${sheetTitle}'!1:${numPreview + 1}`;
        const res = await sheetsApi.spreadsheets.values.get({
          spreadsheetId: spreadsheet_id,
          range,
          valueRenderOption: 'FORMATTED_VALUE',
        });
        const allRows = res.data.values || [];
        const headers = allRows[0] || [];
        const dataRows = allRows.slice(1);
        const preview = dataRows.map((row) => {
          const obj: Record<string, unknown> = {};
          headers.forEach((h, i) => {
            obj[String(h)] = row[i] ?? null;
          });
          return obj;
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ sheet_name: sheetTitle, headers, preview, total_rows: totalRows }, null, 2),
          }],
        };
      }

      case 'write_range': {
        const { spreadsheet_id, range, values, value_input } = args as {
          spreadsheet_id: string;
          range: string;
          values: unknown[][];
          value_input?: string;
        };
        const res = await sheetsApi.spreadsheets.values.update({
          spreadsheetId: spreadsheet_id,
          range,
          valueInputOption: value_input || 'USER_ENTERED',
          requestBody: { values },
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              updated_range: res.data.updatedRange,
              updated_rows: res.data.updatedRows,
              updated_cols: res.data.updatedColumns,
            }, null, 2),
          }],
        };
      }

      case 'append_rows': {
        const { spreadsheet_id, sheet_name, rows } = args as {
          spreadsheet_id: string;
          sheet_name?: string;
          rows: unknown[][];
        };
        const targetRange = sheet_name ? `'${sheet_name}'` : 'Sheet1';
        const res = await sheetsApi.spreadsheets.values.append({
          spreadsheetId: spreadsheet_id,
          range: targetRange,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: rows },
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              updated_range: res.data.updates?.updatedRange,
              appended_rows: res.data.updates?.updatedRows,
            }, null, 2),
          }],
        };
      }

      case 'update_cells': {
        const { spreadsheet_id, updates, sheet_name } = args as {
          spreadsheet_id: string;
          updates: Array<{ cell: string; value: unknown }>;
          sheet_name?: string;
        };
        const sheetPrefix = sheet_name ? `'${sheet_name}'!` : '';
        const data = updates.map((u) => ({
          range: `${sheetPrefix}${u.cell}`,
          values: [[u.value]],
        }));
        const res = await sheetsApi.spreadsheets.values.batchUpdate({
          spreadsheetId: spreadsheet_id,
          requestBody: {
            valueInputOption: 'USER_ENTERED',
            data,
          },
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              total_updated_cells: res.data.totalUpdatedCells,
            }, null, 2),
          }],
        };
      }

      case 'clear_range': {
        const { spreadsheet_id, range } = args as {
          spreadsheet_id: string;
          range: string;
        };
        const res = await sheetsApi.spreadsheets.values.clear({
          spreadsheetId: spreadsheet_id,
          range,
          requestBody: {},
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ cleared_range: res.data.clearedRange }, null, 2),
          }],
        };
      }

      default:
        return { content: [{ type: 'text', text: `Tool desconhecida: ${name}` }], isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Erro: ${msg}` }], isError: true };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
