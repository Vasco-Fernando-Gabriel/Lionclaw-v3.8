#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { google, gmail_v1 } from 'googleapis';


let gmailApi: gmail_v1.Gmail;

function initGmail(): void {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const accessToken = process.env.GOOGLE_ACCESS_TOKEN;

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET sao obrigatorios');
  }
  if (!refreshToken) {
    throw new Error('GOOGLE_REFRESH_TOKEN nao encontrado. Configure no Settings.');
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({
    refresh_token: refreshToken,
    access_token: accessToken || undefined,
  });

  gmailApi = google.gmail({ version: 'v1', auth: oauth2Client });
}


function extractBody(payload: gmail_v1.Schema$MessagePart): string {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }
  if (payload.parts) {
    const textPart = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      return Buffer.from(textPart.body.data, 'base64url').toString('utf-8');
    }
    const htmlPart = payload.parts.find((p) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) {
      return Buffer.from(htmlPart.body.data, 'base64url').toString('utf-8');
    }
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result) return result;
    }
  }
  return '';
}

function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string {
  return (
    headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || ''
  );
}

function createRawEmail(opts: {
  to: string;
  subject: string;
  body: string;
  from?: string;
  cc?: string;
  bcc?: string;
  bodyType?: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const contentType = opts.bodyType === 'html' ? 'text/html' : 'text/plain';
  const lines = [
    `To: ${opts.to}`,
    ...(opts.from ? [`From: ${opts.from}`] : []),
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    ...(opts.bcc ? [`Bcc: ${opts.bcc}`] : []),
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: ${contentType}; charset=utf-8`,
    ...(opts.inReplyTo
      ? [
          `In-Reply-To: ${opts.inReplyTo}`,
          `References: ${opts.references || opts.inReplyTo}`,
        ]
      : []),
    '',
    opts.body,
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

function formatMessageSummary(msg: gmail_v1.Schema$Message): object {
  const headers = msg.payload?.headers;
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: getHeader(headers, 'from'),
    to: getHeader(headers, 'to'),
    subject: getHeader(headers, 'subject'),
    date: getHeader(headers, 'date'),
    snippet: msg.snippet || '',
    labelIds: msg.labelIds || [],
  };
}


const server = new Server(
  { name: 'google-gmail', version: '1.0.0' },
  { capabilities: { tools: {} } },
);


server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_messages',
      description:
        'Lista emails da caixa de entrada ou de uma pasta/label especifica. Retorna resumo com id, remetente, assunto, data e snippet.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description:
              'Filtro em sintaxe Gmail (ex: "is:unread", "from:exemplo@gmail.com", "after:2024/01/01"). Padrao: vazio (lista tudo).',
          },
          max_results: {
            type: 'number',
            description: 'Numero maximo de mensagens a retornar. Padrao: 10.',
          },
          label_ids: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Lista de IDs de labels para filtrar (ex: ["INBOX", "UNREAD"]). Padrao: apenas INBOX.',
          },
        },
      },
    },
    {
      name: 'get_message',
      description:
        'Le o conteudo completo de um email pelo seu ID, incluindo corpo, cabecalhos e metadata.',
      inputSchema: {
        type: 'object' as const,
        required: ['message_id'],
        properties: {
          message_id: {
            type: 'string',
            description: 'ID da mensagem Gmail (obtido em list_messages ou search_messages).',
          },
          format: {
            type: 'string',
            enum: ['full', 'metadata', 'minimal'],
            description:
              'Nivel de detalhe: "full" (conteudo completo, padrao), "metadata" (apenas cabecalhos), "minimal" (apenas IDs e labels).',
          },
        },
      },
    },
    {
      name: 'search_messages',
      description:
        'Busca avancada de emails usando sintaxe de pesquisa do Gmail. Retorna resumo das mensagens encontradas.',
      inputSchema: {
        type: 'object' as const,
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description:
              'Consulta em sintaxe Gmail (ex: "from:joao@empresa.com subject:reuniao after:2024/01/01 has:attachment").',
          },
          max_results: {
            type: 'number',
            description: 'Numero maximo de resultados. Padrao: 20.',
          },
        },
      },
    },
    {
      name: 'send_email',
      description:
        'Envia um novo email. ATENCAO: acao irreversivel - sera solicitada confirmacao do usuario antes de enviar.',
      inputSchema: {
        type: 'object' as const,
        required: ['to', 'subject', 'body'],
        properties: {
          to: {
            type: 'string',
            description: 'Destinatario(s). Multiplos separados por virgula.',
          },
          cc: {
            type: 'string',
            description: 'Destinatarios em copia. Multiplos separados por virgula.',
          },
          bcc: {
            type: 'string',
            description: 'Destinatarios em copia oculta. Multiplos separados por virgula.',
          },
          subject: {
            type: 'string',
            description: 'Assunto do email.',
          },
          body: {
            type: 'string',
            description: 'Corpo do email (texto puro ou HTML conforme body_type).',
          },
          body_type: {
            type: 'string',
            enum: ['text', 'html'],
            description: 'Formato do corpo: "text" (padrao) ou "html".',
          },
        },
      },
    },
    {
      name: 'reply_to',
      description:
        'Responde a um email existente, mantendo o thread. ATENCAO: acao irreversivel - sera solicitada confirmacao.',
      inputSchema: {
        type: 'object' as const,
        required: ['message_id', 'body'],
        properties: {
          message_id: {
            type: 'string',
            description: 'ID da mensagem a ser respondida.',
          },
          body: {
            type: 'string',
            description: 'Corpo da resposta.',
          },
          body_type: {
            type: 'string',
            enum: ['text', 'html'],
            description: 'Formato do corpo: "text" (padrao) ou "html".',
          },
          reply_all: {
            type: 'boolean',
            description:
              'Se true, responde para todos os destinatarios originais (Reply All). Padrao: false.',
          },
        },
      },
    },
    {
      name: 'forward',
      description:
        'Encaminha um email para um ou mais destinatarios. ATENCAO: acao irreversivel - sera solicitada confirmacao.',
      inputSchema: {
        type: 'object' as const,
        required: ['message_id', 'to'],
        properties: {
          message_id: {
            type: 'string',
            description: 'ID da mensagem a ser encaminhada.',
          },
          to: {
            type: 'string',
            description: 'Destinatario(s) do encaminhamento. Multiplos separados por virgula.',
          },
          additional_body: {
            type: 'string',
            description: 'Texto adicional a ser incluido antes do conteudo original encaminhado.',
          },
        },
      },
    },
    {
      name: 'list_labels',
      description:
        'Lista todas as labels (pastas) da conta Gmail, incluindo labels do sistema (INBOX, SENT, etc.) e labels personalizadas.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'modify_labels',
      description:
        'Adiciona ou remove labels de uma ou mais mensagens. Util para organizar, arquivar ou categorizar emails.',
      inputSchema: {
        type: 'object' as const,
        required: ['message_ids'],
        properties: {
          message_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lista de IDs das mensagens a modificar.',
          },
          add_labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Labels a adicionar (ex: ["STARRED", "Label_123"]).',
          },
          remove_labels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Labels a remover (ex: ["UNREAD", "INBOX"]).',
          },
        },
      },
    },
    {
      name: 'mark_read',
      description: 'Marca uma ou mais mensagens como lidas (remove a label UNREAD).',
      inputSchema: {
        type: 'object' as const,
        required: ['message_ids'],
        properties: {
          message_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lista de IDs das mensagens a marcar como lidas.',
          },
        },
      },
    },
    {
      name: 'mark_unread',
      description: 'Marca uma ou mais mensagens como nao lidas (adiciona a label UNREAD).',
      inputSchema: {
        type: 'object' as const,
        required: ['message_ids'],
        properties: {
          message_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lista de IDs das mensagens a marcar como nao lidas.',
          },
        },
      },
    },
    {
      name: 'trash_message',
      description:
        'Move uma mensagem para a lixeira. A mensagem pode ser recuperada dentro de 30 dias.',
      inputSchema: {
        type: 'object' as const,
        required: ['message_id'],
        properties: {
          message_id: {
            type: 'string',
            description: 'ID da mensagem a mover para a lixeira.',
          },
        },
      },
    },
    {
      name: 'create_draft',
      description: 'Cria um rascunho de email que pode ser editado e enviado posteriormente.',
      inputSchema: {
        type: 'object' as const,
        required: ['to', 'subject', 'body'],
        properties: {
          to: {
            type: 'string',
            description: 'Destinatario(s). Multiplos separados por virgula.',
          },
          subject: {
            type: 'string',
            description: 'Assunto do rascunho.',
          },
          body: {
            type: 'string',
            description: 'Corpo do rascunho.',
          },
          body_type: {
            type: 'string',
            enum: ['text', 'html'],
            description: 'Formato do corpo: "text" (padrao) ou "html".',
          },
        },
      },
    },
    {
      name: 'list_drafts',
      description: 'Lista os rascunhos salvos na conta Gmail.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          max_results: {
            type: 'number',
            description: 'Numero maximo de rascunhos a retornar. Padrao: 10.',
          },
        },
      },
    },
  ],
}));


server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (!gmailApi) {
    try {
      initGmail();
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Erro Gmail: ${(err as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }

  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;

  try {
    switch (name) {
      case 'list_messages': {
        const labelIds = (a.label_ids as string[] | undefined) ?? ['INBOX'];
        const maxResults = (a.max_results as number | undefined) ?? 10;
        const query = (a.query as string | undefined) ?? '';

        const listRes = await gmailApi.users.messages.list({
          userId: 'me',
          q: query || undefined,
          labelIds,
          maxResults,
        });

        const messages = listRes.data.messages ?? [];
        if (messages.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'Nenhuma mensagem encontrada.' }],
          };
        }

        const summaries = await Promise.all(
          messages.map(async (m) => {
            const msgRes = await gmailApi.users.messages.get({
              userId: 'me',
              id: m.id!,
              format: 'metadata',
              metadataHeaders: ['From', 'To', 'Subject', 'Date'],
            });
            return formatMessageSummary(msgRes.data);
          }),
        );

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(summaries, null, 2) }],
        };
      }

      case 'get_message': {
        const messageId = a.message_id as string;
        const format = (a.format as 'full' | 'metadata' | 'minimal' | undefined) ?? 'full';

        const msgRes = await gmailApi.users.messages.get({
          userId: 'me',
          id: messageId,
          format,
        });

        const msg = msgRes.data;
        const headers = msg.payload?.headers;

        if (format === 'minimal') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        if (format === 'metadata') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(formatMessageSummary(msg), null, 2),
              },
            ],
          };
        }

        const body = msg.payload ? extractBody(msg.payload) : '';
        const result = {
          id: msg.id,
          threadId: msg.threadId,
          labelIds: msg.labelIds,
          from: getHeader(headers, 'from'),
          to: getHeader(headers, 'to'),
          cc: getHeader(headers, 'cc'),
          subject: getHeader(headers, 'subject'),
          date: getHeader(headers, 'date'),
          messageId: getHeader(headers, 'message-id'),
          snippet: msg.snippet,
          body,
          sizeEstimate: msg.sizeEstimate,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'search_messages': {
        const query = a.query as string;
        const maxResults = (a.max_results as number | undefined) ?? 20;

        const listRes = await gmailApi.users.messages.list({
          userId: 'me',
          q: query,
          maxResults,
        });

        const messages = listRes.data.messages ?? [];
        if (messages.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Nenhum email encontrado para a busca: "${query}"`,
              },
            ],
          };
        }

        const summaries = await Promise.all(
          messages.map(async (m) => {
            const msgRes = await gmailApi.users.messages.get({
              userId: 'me',
              id: m.id!,
              format: 'metadata',
              metadataHeaders: ['From', 'To', 'Subject', 'Date'],
            });
            return formatMessageSummary(msgRes.data);
          }),
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { query, total: summaries.length, messages: summaries },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'send_email': {
        const to = a.to as string;
        const subject = a.subject as string;
        const body = a.body as string;
        const cc = a.cc as string | undefined;
        const bcc = a.bcc as string | undefined;
        const bodyType = (a.body_type as string | undefined) ?? 'text';

        const profileRes = await gmailApi.users.getProfile({ userId: 'me' });
        const from = profileRes.data.emailAddress ?? '';

        const raw = createRawEmail({ to, from, cc, bcc, subject, body, bodyType });

        const sendRes = await gmailApi.users.messages.send({
          userId: 'me',
          requestBody: { raw },
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  messageId: sendRes.data.id,
                  threadId: sendRes.data.threadId,
                  to,
                  subject,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'reply_to': {
        const messageId = a.message_id as string;
        const body = a.body as string;
        const bodyType = (a.body_type as string | undefined) ?? 'text';
        const replyAll = (a.reply_all as boolean | undefined) ?? false;

        const originalRes = await gmailApi.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References'],
        });

        const original = originalRes.data;
        const originalHeaders = original.payload?.headers;

        const originalFrom = getHeader(originalHeaders, 'from');
        const originalTo = getHeader(originalHeaders, 'to');
        const originalCc = getHeader(originalHeaders, 'cc');
        const originalSubject = getHeader(originalHeaders, 'subject');
        const originalMessageId = getHeader(originalHeaders, 'message-id');
        const originalReferences = getHeader(originalHeaders, 'references');

        const replySubject = originalSubject.startsWith('Re:')
          ? originalSubject
          : `Re: ${originalSubject}`;

        const profileRes = await gmailApi.users.getProfile({ userId: 'me' });
        const ownEmail = profileRes.data.emailAddress ?? '';

        let to = originalFrom;
        let cc: string | undefined;

        if (replyAll) {
          const allRecipients = [originalTo, originalCc]
            .filter(Boolean)
            .join(',')
            .split(',')
            .map((e) => e.trim())
            .filter((e) => e && !e.includes(ownEmail));
          cc = allRecipients.join(', ') || undefined;
        }

        const references = originalReferences
          ? `${originalReferences} ${originalMessageId}`
          : originalMessageId;

        const raw = createRawEmail({
          to,
          from: ownEmail,
          cc,
          subject: replySubject,
          body,
          bodyType,
          inReplyTo: originalMessageId,
          references,
        });

        const sendRes = await gmailApi.users.messages.send({
          userId: 'me',
          requestBody: { raw, threadId: original.threadId ?? undefined },
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  messageId: sendRes.data.id,
                  threadId: sendRes.data.threadId,
                  repliedTo: messageId,
                  replyAll,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'forward': {
        const messageId = a.message_id as string;
        const to = a.to as string;
        const additionalBody = (a.additional_body as string | undefined) ?? '';

        const originalRes = await gmailApi.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'full',
        });

        const original = originalRes.data;
        const originalHeaders = original.payload?.headers;

        const originalFrom = getHeader(originalHeaders, 'from');
        const originalDate = getHeader(originalHeaders, 'date');
        const originalSubject = getHeader(originalHeaders, 'subject');
        const originalTo = getHeader(originalHeaders, 'to');
        const originalBody = original.payload ? extractBody(original.payload) : '';

        const fwdSubject = originalSubject.startsWith('Fwd:')
          ? originalSubject
          : `Fwd: ${originalSubject}`;

        const forwardedBlock = [
          '',
          '---------- Mensagem encaminhada ----------',
          `De: ${originalFrom}`,
          `Data: ${originalDate}`,
          `Assunto: ${originalSubject}`,
          `Para: ${originalTo}`,
          '',
          originalBody,
        ].join('\n');

        const body = additionalBody ? `${additionalBody}\n${forwardedBlock}` : forwardedBlock;

        const profileRes = await gmailApi.users.getProfile({ userId: 'me' });
        const from = profileRes.data.emailAddress ?? '';

        const raw = createRawEmail({ to, from, subject: fwdSubject, body, bodyType: 'text' });

        const sendRes = await gmailApi.users.messages.send({
          userId: 'me',
          requestBody: { raw },
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  messageId: sendRes.data.id,
                  threadId: sendRes.data.threadId,
                  forwardedMessageId: messageId,
                  to,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'list_labels': {
        const labelsRes = await gmailApi.users.labels.list({ userId: 'me' });
        const labels = labelsRes.data.labels ?? [];

        const formatted = labels.map((l) => ({
          id: l.id,
          name: l.name,
          type: l.type,
          messageListVisibility: l.messageListVisibility,
          labelListVisibility: l.labelListVisibility,
          messagesTotal: l.messagesTotal,
          messagesUnread: l.messagesUnread,
          threadsTotal: l.threadsTotal,
          threadsUnread: l.threadsUnread,
        }));

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }],
        };
      }

      case 'modify_labels': {
        const messageIds = a.message_ids as string[];
        const addLabelIds = (a.add_labels as string[] | undefined) ?? [];
        const removeLabelIds = (a.remove_labels as string[] | undefined) ?? [];

        const results = await Promise.all(
          messageIds.map((id) =>
            gmailApi.users.messages.modify({
              userId: 'me',
              id,
              requestBody: { addLabelIds, removeLabelIds },
            }),
          ),
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  modified: results.length,
                  messageIds,
                  addedLabels: addLabelIds,
                  removedLabels: removeLabelIds,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'mark_read': {
        const messageIds = a.message_ids as string[];

        await Promise.all(
          messageIds.map((id) =>
            gmailApi.users.messages.modify({
              userId: 'me',
              id,
              requestBody: { removeLabelIds: ['UNREAD'] },
            }),
          ),
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { success: true, markedRead: messageIds.length, messageIds },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'mark_unread': {
        const messageIds = a.message_ids as string[];

        await Promise.all(
          messageIds.map((id) =>
            gmailApi.users.messages.modify({
              userId: 'me',
              id,
              requestBody: { addLabelIds: ['UNREAD'] },
            }),
          ),
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { success: true, markedUnread: messageIds.length, messageIds },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'trash_message': {
        const messageId = a.message_id as string;

        await gmailApi.users.messages.trash({ userId: 'me', id: messageId });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  messageId,
                  message: 'Mensagem movida para a lixeira. Pode ser recuperada em ate 30 dias.',
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'create_draft': {
        const to = a.to as string;
        const subject = a.subject as string;
        const body = a.body as string;
        const bodyType = (a.body_type as string | undefined) ?? 'text';

        const profileRes = await gmailApi.users.getProfile({ userId: 'me' });
        const from = profileRes.data.emailAddress ?? '';

        const raw = createRawEmail({ to, from, subject, body, bodyType });

        const draftRes = await gmailApi.users.drafts.create({
          userId: 'me',
          requestBody: {
            message: { raw },
          },
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  success: true,
                  draftId: draftRes.data.id,
                  messageId: draftRes.data.message?.id,
                  to,
                  subject,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'list_drafts': {
        const maxResults = (a.max_results as number | undefined) ?? 10;

        const draftsRes = await gmailApi.users.drafts.list({
          userId: 'me',
          maxResults,
        });

        const drafts = draftsRes.data.drafts ?? [];
        if (drafts.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'Nenhum rascunho encontrado.' }],
          };
        }

        const draftDetails = await Promise.all(
          drafts.map(async (d) => {
            const draftRes = await gmailApi.users.drafts.get({
              userId: 'me',
              id: d.id!,
              format: 'metadata',
            });
            const msg = draftRes.data.message;
            const headers = msg?.payload?.headers;
            return {
              draftId: d.id,
              messageId: msg?.id,
              to: getHeader(headers, 'to'),
              subject: getHeader(headers, 'subject'),
              snippet: msg?.snippet ?? '',
            };
          }),
        );

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(draftDetails, null, 2) }],
        };
      }

      default:
        return {
          content: [
            { type: 'text' as const, text: `Erro Gmail: tool desconhecida "${name}"` },
          ],
          isError: true,
        };
    }
  } catch (err) {
    const msg = (err as Error).message;
    return {
      content: [{ type: 'text' as const, text: `Erro Gmail: ${msg}` }],
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
