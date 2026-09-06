#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { google } from 'googleapis';
import { drive_v3 } from 'googleapis';
import fs from 'fs';
import path from 'path';

const FILE_FIELDS = 'files(id, name, mimeType, size, modifiedTime, webViewLink, parents, owners)';

const GOOGLE_EXPORT_MIMES: Record<string, Record<string, string>> = {
  'application/vnd.google-apps.document': {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
  },
  'application/vnd.google-apps.spreadsheet': {
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
  },
  'application/vnd.google-apps.presentation': {
    pdf: 'application/pdf',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
};

const GOOGLE_APPS_TYPES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
]);

let driveApi: drive_v3.Drive;

function initDrive(): void {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const accessToken = process.env.GOOGLE_ACCESS_TOKEN;

  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET sao obrigatorios');
  if (!refreshToken) throw new Error('GOOGLE_REFRESH_TOKEN nao encontrado. Configure no Settings.');

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken, access_token: accessToken || undefined });
  driveApi = google.drive({ version: 'v3', auth: oauth2Client });
}

const server = new Server(
  { name: 'google-drive', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_files',
      description: 'Listar arquivos e pastas no Google Drive. Retorna id, nome, tipo, tamanho, data de modificacao e link.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          folder_id: { type: 'string', description: 'ID da pasta (default: root)' },
          query: { type: 'string', description: 'Filtro adicional em sintaxe Drive query' },
          max_results: { type: 'number', description: 'Numero maximo de resultados (default: 20)' },
          order_by: { type: 'string', description: 'Ordenacao (default: modifiedTime desc)' },
          file_type: { type: 'string', description: 'Filtrar por mimeType (ex: application/pdf)' },
        },
      },
    },
    {
      name: 'search_files',
      description: 'Buscar arquivos no Drive usando sintaxe de query do Google Drive (ex: "name contains \'relatorio\' and mimeType=\'application/pdf\'").',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Query em sintaxe Drive (obrigatorio)' },
          max_results: { type: 'number', description: 'Numero maximo de resultados (default: 20)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_file_metadata',
      description: 'Obter metadados completos de um arquivo: nome, tipo, tamanho, dono, permissoes, data de criacao e modificacao.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file_id: { type: 'string', description: 'ID do arquivo no Drive' },
        },
        required: ['file_id'],
      },
    },
    {
      name: 'read_file',
      description: 'Ler o conteudo de um arquivo do Drive. Google Docs/Sheets/Slides sao exportados como texto. Outros arquivos retornam base64 (limite 50KB).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file_id: { type: 'string', description: 'ID do arquivo no Drive' },
        },
        required: ['file_id'],
      },
    },
    {
      name: 'download_file',
      description: 'Baixar um arquivo do Drive para o disco local.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file_id: { type: 'string', description: 'ID do arquivo no Drive' },
          destination_path: { type: 'string', description: 'Caminho completo de destino no disco local' },
        },
        required: ['file_id', 'destination_path'],
      },
    },
    {
      name: 'upload_file',
      description: 'Fazer upload de um arquivo local para o Google Drive.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          source_path: { type: 'string', description: 'Caminho completo do arquivo local a ser enviado' },
          folder_id: { type: 'string', description: 'ID da pasta de destino no Drive (default: root)' },
          name: { type: 'string', description: 'Nome do arquivo no Drive (default: nome do arquivo local)' },
          mime_type: { type: 'string', description: 'MIME type do arquivo (detectado automaticamente se omitido)' },
        },
        required: ['source_path'],
      },
    },
    {
      name: 'create_folder',
      description: 'Criar uma nova pasta no Google Drive.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Nome da pasta' },
          parent_folder_id: { type: 'string', description: 'ID da pasta pai (default: root)' },
        },
        required: ['name'],
      },
    },
    {
      name: 'move_file',
      description: 'Mover um arquivo para outra pasta no Drive.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file_id: { type: 'string', description: 'ID do arquivo a ser movido' },
          new_parent_id: { type: 'string', description: 'ID da pasta de destino' },
        },
        required: ['file_id', 'new_parent_id'],
      },
    },
    {
      name: 'rename_file',
      description: 'Renomear um arquivo ou pasta no Drive.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file_id: { type: 'string', description: 'ID do arquivo a ser renomeado' },
          new_name: { type: 'string', description: 'Novo nome do arquivo' },
        },
        required: ['file_id', 'new_name'],
      },
    },
    {
      name: 'delete_file',
      description: 'Mover um arquivo para a lixeira do Drive.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file_id: { type: 'string', description: 'ID do arquivo a ser movido para a lixeira' },
        },
        required: ['file_id'],
      },
    },
    {
      name: 'share_file',
      description: 'Compartilhar um arquivo do Drive com outro usuario por email.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file_id: { type: 'string', description: 'ID do arquivo a ser compartilhado' },
          email: { type: 'string', description: 'Email do usuario com quem compartilhar' },
          role: { type: 'string', description: 'Nivel de acesso: reader, writer ou commenter (default: reader)' },
        },
        required: ['file_id', 'email'],
      },
    },
    {
      name: 'list_shared_with_me',
      description: 'Listar arquivos que foram compartilhados com o usuario autenticado.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          max_results: { type: 'number', description: 'Numero maximo de resultados (default: 20)' },
        },
      },
    },
    {
      name: 'export_google_doc',
      description: 'Exportar um Google Doc, Sheet ou Slide para um formato de arquivo (pdf, docx, xlsx, pptx, csv, txt) e salvar no disco local.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file_id: { type: 'string', description: 'ID do Google Doc/Sheet/Slide' },
          export_format: { type: 'string', description: 'Formato de exportacao: pdf, docx, xlsx, pptx, csv ou txt' },
          destination_path: { type: 'string', description: 'Caminho completo de destino no disco local (opcional, usa /tmp se omitido)' },
        },
        required: ['file_id', 'export_format'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;

  try {
    initDrive();

    switch (name) {
      case 'list_files': {
        const folderId = (a.folder_id as string) || 'root';
        const maxResults = (a.max_results as number) || 20;
        const orderBy = (a.order_by as string) || 'modifiedTime desc';

        let q = `'${folderId}' in parents and trashed = false`;
        if (a.file_type) q += ` and mimeType = '${a.file_type as string}'`;
        if (a.query) q += ` and ${a.query as string}`;

        const res = await driveApi.files.list({
          q,
          pageSize: maxResults,
          orderBy,
          fields: FILE_FIELDS,
        });

        const files = (res.data.files || []).map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size,
          modifiedTime: f.modifiedTime,
          webViewLink: f.webViewLink,
        }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(files, null, 2),
          }],
        };
      }

      case 'search_files': {
        const maxResults = (a.max_results as number) || 20;

        const res = await driveApi.files.list({
          q: a.query as string,
          pageSize: maxResults,
          orderBy: 'modifiedTime desc',
          fields: FILE_FIELDS,
        });

        const files = (res.data.files || []).map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size,
          modifiedTime: f.modifiedTime,
          webViewLink: f.webViewLink,
        }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(files, null, 2),
          }],
        };
      }

      case 'get_file_metadata': {
        const res = await driveApi.files.get({
          fileId: a.file_id as string,
          fields: 'id, name, mimeType, size, modifiedTime, createdTime, webViewLink, webContentLink, parents, owners, permissions, shared, sharingUser, trashed, starred, description',
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(res.data, null, 2),
          }],
        };
      }

      case 'read_file': {
        const fileId = a.file_id as string;

        const metaRes = await driveApi.files.get({
          fileId,
          fields: 'id, name, mimeType, size',
        });
        const meta = metaRes.data;
        const mimeType = meta.mimeType || '';

        let content: string;
        let truncated = false;

        if (GOOGLE_APPS_TYPES.has(mimeType)) {
          const exportRes = await driveApi.files.export(
            { fileId, mimeType: 'text/plain' },
            { responseType: 'arraybuffer' },
          );
          const buffer = Buffer.from(exportRes.data as ArrayBuffer);
          content = buffer.toString('utf-8');
        } else {
          const downloadRes = await driveApi.files.get(
            { fileId, alt: 'media' },
            { responseType: 'arraybuffer' },
          );
          const buffer = Buffer.from(downloadRes.data as ArrayBuffer);
          const maxBytes = 50 * 1024;
          if (buffer.length > maxBytes) {
            truncated = true;
            content = buffer.subarray(0, maxBytes).toString('base64');
          } else {
            content = buffer.toString('base64');
          }
        }

        const result: Record<string, unknown> = {
          metadata: {
            id: meta.id,
            name: meta.name,
            mimeType: meta.mimeType,
            size: meta.size,
          },
          content,
          encoding: GOOGLE_APPS_TYPES.has(mimeType) ? 'utf-8' : 'base64',
        };

        if (truncated) {
          result.truncated = true;
          result.note = 'Conteudo truncado em 50KB. Use download_file para obter o arquivo completo.';
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      case 'download_file': {
        const fileId = a.file_id as string;
        const destPath = a.destination_path as string;

        const metaRes = await driveApi.files.get({
          fileId,
          fields: 'id, name, mimeType',
        });
        const mimeType = metaRes.data.mimeType || '';

        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }

        if (GOOGLE_APPS_TYPES.has(mimeType)) {
          const exportMimes = GOOGLE_EXPORT_MIMES[mimeType] || {};
          const exportMimeType = exportMimes['pdf'] || 'application/pdf';
          const exportRes = await driveApi.files.export(
            { fileId, mimeType: exportMimeType },
            { responseType: 'arraybuffer' },
          );
          fs.writeFileSync(destPath, Buffer.from(exportRes.data as ArrayBuffer));
        } else {
          const downloadRes = await driveApi.files.get(
            { fileId, alt: 'media' },
            { responseType: 'arraybuffer' },
          );
          fs.writeFileSync(destPath, Buffer.from(downloadRes.data as ArrayBuffer));
        }

        const stats = fs.statSync(destPath);

        return {
          content: [{
            type: 'text' as const,
            text: `Arquivo baixado com sucesso.\nDestino: ${destPath}\nTamanho: ${stats.size} bytes`,
          }],
        };
      }

      case 'upload_file': {
        const sourcePath = a.source_path as string;
        const folderId = (a.folder_id as string) || 'root';
        const fileName = (a.name as string) || path.basename(sourcePath);
        const mimeType = (a.mime_type as string) || 'application/octet-stream';

        if (!fs.existsSync(sourcePath)) {
          return {
            content: [{ type: 'text' as const, text: `Erro Google Drive: Arquivo nao encontrado: ${sourcePath}` }],
            isError: true,
          };
        }

        const fileStream = fs.createReadStream(sourcePath);
        const stats = fs.statSync(sourcePath);

        const res = await driveApi.files.create({
          requestBody: {
            name: fileName,
            parents: [folderId],
          },
          media: {
            mimeType,
            body: fileStream,
          },
          fields: 'id, name, mimeType, size, webViewLink',
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: 'Upload realizado com sucesso.',
              localSize: stats.size,
              file: res.data,
            }, null, 2),
          }],
        };
      }

      case 'create_folder': {
        const parentId = (a.parent_folder_id as string) || 'root';

        const res = await driveApi.files.create({
          requestBody: {
            name: a.name as string,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
          },
          fields: 'id, name, webViewLink',
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: 'Pasta criada com sucesso.',
              folder: res.data,
            }, null, 2),
          }],
        };
      }

      case 'move_file': {
        const fileId = a.file_id as string;
        const newParentId = a.new_parent_id as string;

        const metaRes = await driveApi.files.get({
          fileId,
          fields: 'parents',
        });
        const currentParents = (metaRes.data.parents || []).join(',');

        const res = await driveApi.files.update({
          fileId,
          addParents: newParentId,
          removeParents: currentParents,
          fields: 'id, name, parents',
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: 'Arquivo movido com sucesso.',
              file: res.data,
            }, null, 2),
          }],
        };
      }

      case 'rename_file': {
        const res = await driveApi.files.update({
          fileId: a.file_id as string,
          requestBody: { name: a.new_name as string },
          fields: 'id, name',
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: 'Arquivo renomeado com sucesso.',
              file: res.data,
            }, null, 2),
          }],
        };
      }

      case 'delete_file': {
        await driveApi.files.update({
          fileId: a.file_id as string,
          requestBody: { trashed: true },
        });

        return {
          content: [{
            type: 'text' as const,
            text: `Arquivo movido para a lixeira com sucesso. ID: ${a.file_id as string}`,
          }],
        };
      }

      case 'share_file': {
        const role = (a.role as string) || 'reader';
        const validRoles = ['reader', 'writer', 'commenter'];
        if (!validRoles.includes(role)) {
          return {
            content: [{ type: 'text' as const, text: `Erro Google Drive: Role invalido. Use: reader, writer ou commenter` }],
            isError: true,
          };
        }

        const res = await driveApi.permissions.create({
          fileId: a.file_id as string,
          requestBody: {
            type: 'user',
            role,
            emailAddress: a.email as string,
          },
          fields: 'id, type, role, emailAddress',
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: `Arquivo compartilhado com ${a.email as string} como ${role}.`,
              permission: res.data,
            }, null, 2),
          }],
        };
      }

      case 'list_shared_with_me': {
        const maxResults = (a.max_results as number) || 20;

        const res = await driveApi.files.list({
          q: 'sharedWithMe = true and trashed = false',
          pageSize: maxResults,
          orderBy: 'modifiedTime desc',
          fields: FILE_FIELDS,
        });

        const files = (res.data.files || []).map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size,
          modifiedTime: f.modifiedTime,
          webViewLink: f.webViewLink,
        }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(files, null, 2),
          }],
        };
      }

      case 'export_google_doc': {
        const fileId = a.file_id as string;
        const exportFormat = a.export_format as string;

        const metaRes = await driveApi.files.get({
          fileId,
          fields: 'id, name, mimeType',
        });
        const meta = metaRes.data;
        const mimeType = meta.mimeType || '';

        const exportMimes = GOOGLE_EXPORT_MIMES[mimeType];
        if (!exportMimes) {
          return {
            content: [{
              type: 'text' as const,
              text: `Erro Google Drive: Tipo de arquivo '${mimeType}' nao suporta exportacao. Use apenas com Google Docs, Sheets ou Slides.`,
            }],
            isError: true,
          };
        }

        const exportMimeType = exportMimes[exportFormat];
        if (!exportMimeType) {
          const supported = Object.keys(exportMimes).join(', ');
          return {
            content: [{
              type: 'text' as const,
              text: `Erro Google Drive: Formato '${exportFormat}' nao suportado para este tipo de arquivo. Formatos suportados: ${supported}`,
            }],
            isError: true,
          };
        }

        let destPath = a.destination_path as string | undefined;
        if (!destPath) {
          destPath = path.join('/tmp', `${meta.name || fileId}.${exportFormat}`);
        }

        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
          fs.mkdirSync(destDir, { recursive: true });
        }

        const exportRes = await driveApi.files.export(
          { fileId, mimeType: exportMimeType },
          { responseType: 'arraybuffer' },
        );

        fs.writeFileSync(destPath, Buffer.from(exportRes.data as ArrayBuffer));
        const stats = fs.statSync(destPath);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              message: 'Exportacao concluida com sucesso.',
              source: { id: meta.id, name: meta.name, mimeType: meta.mimeType },
              destination: destPath,
              format: exportFormat,
              size: stats.size,
            }, null, 2),
          }],
        };
      }

      default:
        return {
          content: [{ type: 'text' as const, text: `Tool desconhecida: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Erro Google Drive: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
