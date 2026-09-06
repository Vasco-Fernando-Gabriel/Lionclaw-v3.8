#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { google, calendar_v3 } from 'googleapis';

let calendarApi: calendar_v3.Calendar;

function initCalendar(): void {
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

  calendarApi = google.calendar({ version: 'v3', auth: oauth2Client });
}

function formatEvent(event: calendar_v3.Schema$Event): string {
  const lines: string[] = [];
  lines.push(`ID: ${event.id ?? 'N/A'}`);
  lines.push(`Titulo: ${event.summary ?? '(sem titulo)'}`);

  const startRaw = event.start?.dateTime ?? event.start?.date;
  const endRaw = event.end?.dateTime ?? event.end?.date;
  lines.push(`Inicio: ${startRaw ?? 'N/A'}`);
  lines.push(`Fim: ${endRaw ?? 'N/A'}`);

  if (event.location) lines.push(`Local: ${event.location}`);
  if (event.description) lines.push(`Descricao: ${event.description}`);

  if (event.attendees && event.attendees.length > 0) {
    const attendeeList = event.attendees
      .map((a) => `${a.email ?? ''}${a.responseStatus ? ` (${a.responseStatus})` : ''}`)
      .join(', ');
    lines.push(`Participantes: ${attendeeList}`);
  }

  if (event.htmlLink) lines.push(`Link: ${event.htmlLink}`);
  if (event.status) lines.push(`Status: ${event.status}`);

  return lines.join('\n');
}

function formatEventList(events: calendar_v3.Schema$Event[]): string {
  if (events.length === 0) return 'Nenhum evento encontrado.';
  return events.map((e, i) => `--- Evento ${i + 1} ---\n${formatEvent(e)}`).join('\n\n');
}

const server = new Server(
  { name: 'google-calendar', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_calendars',
      description: 'Listar todos os calendarios do usuario. Retorna id, nome, descricao e cor de cada calendario.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'list_events',
      description: 'Listar eventos de um calendario em um periodo. Pode filtrar por texto.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          calendar_id: {
            type: 'string',
            description: 'ID do calendario (default: primary)',
          },
          time_min: {
            type: 'string',
            description: 'Data/hora de inicio em ISO8601 (ex: 2026-03-15T00:00:00-03:00)',
          },
          time_max: {
            type: 'string',
            description: 'Data/hora de fim em ISO8601 (ex: 2026-03-22T23:59:59-03:00)',
          },
          max_results: {
            type: 'number',
            description: 'Numero maximo de eventos a retornar (default: 20)',
          },
          query: {
            type: 'string',
            description: 'Texto para filtrar eventos por titulo ou descricao',
          },
        },
      },
    },
    {
      name: 'get_event',
      description: 'Obter detalhes completos de um evento especifico pelo ID.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          calendar_id: {
            type: 'string',
            description: 'ID do calendario',
          },
          event_id: {
            type: 'string',
            description: 'ID do evento',
          },
        },
        required: ['calendar_id', 'event_id'],
      },
    },
    {
      name: 'create_event',
      description: 'Criar um novo evento no Google Calendar.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          calendar_id: {
            type: 'string',
            description: 'ID do calendario (default: primary)',
          },
          summary: {
            type: 'string',
            description: 'Titulo do evento',
          },
          description: {
            type: 'string',
            description: 'Descricao detalhada do evento',
          },
          start: {
            type: 'string',
            description: 'Data/hora de inicio em ISO8601 (ex: 2026-03-20T15:00:00)',
          },
          end: {
            type: 'string',
            description: 'Data/hora de fim em ISO8601 (ex: 2026-03-20T16:00:00)',
          },
          attendees: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lista de emails dos participantes',
          },
          location: {
            type: 'string',
            description: 'Local do evento (endereco ou URL de videoconferencia)',
          },
          timezone: {
            type: 'string',
            description: 'Fuso horario (default: America/Sao_Paulo)',
          },
        },
        required: ['summary', 'start', 'end'],
      },
    },
    {
      name: 'update_event',
      description: 'Atualizar um evento existente. Somente os campos informados serao alterados.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          calendar_id: {
            type: 'string',
            description: 'ID do calendario',
          },
          event_id: {
            type: 'string',
            description: 'ID do evento a atualizar',
          },
          summary: {
            type: 'string',
            description: 'Novo titulo do evento',
          },
          description: {
            type: 'string',
            description: 'Nova descricao do evento',
          },
          start: {
            type: 'string',
            description: 'Nova data/hora de inicio em ISO8601',
          },
          end: {
            type: 'string',
            description: 'Nova data/hora de fim em ISO8601',
          },
          attendees: {
            type: 'array',
            items: { type: 'string' },
            description: 'Nova lista de emails dos participantes (substitui a lista atual)',
          },
          location: {
            type: 'string',
            description: 'Novo local do evento',
          },
        },
        required: ['calendar_id', 'event_id'],
      },
    },
    {
      name: 'delete_event',
      description: 'Excluir permanentemente um evento do calendario.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          calendar_id: {
            type: 'string',
            description: 'ID do calendario',
          },
          event_id: {
            type: 'string',
            description: 'ID do evento a excluir',
          },
        },
        required: ['calendar_id', 'event_id'],
      },
    },
    {
      name: 'find_free_time',
      description: 'Encontrar horarios livres em um ou mais calendarios usando a API freebusy.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          calendar_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lista de IDs de calendarios a verificar (ex: ["primary", "work@example.com"])',
          },
          time_min: {
            type: 'string',
            description: 'Data/hora de inicio da busca em ISO8601',
          },
          time_max: {
            type: 'string',
            description: 'Data/hora de fim da busca em ISO8601',
          },
          duration_minutes: {
            type: 'number',
            description: 'Duracao minima desejada dos slots livres em minutos',
          },
        },
        required: ['calendar_ids', 'time_min', 'time_max', 'duration_minutes'],
      },
    },
    {
      name: 'quick_add',
      description: 'Adicionar evento via texto em linguagem natural (ex: "Reuniao amanha as 15h", "Almoço com João sexta 12:30").',
      inputSchema: {
        type: 'object' as const,
        properties: {
          calendar_id: {
            type: 'string',
            description: 'ID do calendario (default: primary)',
          },
          text: {
            type: 'string',
            description: 'Descricao do evento em texto livre (ex: "Reuniao de alinhamento amanha as 14h")',
          },
        },
        required: ['text'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;

  try {
    initCalendar();

    switch (name) {
      case 'list_calendars': {
        const response = await calendarApi.calendarList.list();
        const calendars = (response.data.items ?? []).map((cal) => ({
          id: cal.id,
          summary: cal.summary,
          description: cal.description,
          primary: cal.primary ?? false,
          backgroundColor: cal.backgroundColor,
          accessRole: cal.accessRole,
          timeZone: cal.timeZone,
        }));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(calendars, null, 2),
          }],
        };
      }

      case 'list_events': {
        const calendarId = (a.calendar_id as string) || 'primary';
        const maxResults = (a.max_results as number) || 20;

        const params: calendar_v3.Params$Resource$Events$List = {
          calendarId,
          maxResults,
          singleEvents: true,
          orderBy: 'startTime',
        };

        if (a.time_min) params.timeMin = a.time_min as string;
        if (a.time_max) params.timeMax = a.time_max as string;
        if (a.query) params.q = a.query as string;

        const response = await calendarApi.events.list(params);
        const events = response.data.items ?? [];

        return {
          content: [{
            type: 'text' as const,
            text: formatEventList(events),
          }],
        };
      }

      case 'get_event': {
        const response = await calendarApi.events.get({
          calendarId: a.calendar_id as string,
          eventId: a.event_id as string,
        });
        return {
          content: [{
            type: 'text' as const,
            text: formatEvent(response.data),
          }],
        };
      }

      case 'create_event': {
        const calendarId = (a.calendar_id as string) || 'primary';
        const timezone = (a.timezone as string) || 'America/Sao_Paulo';
        const startDt = a.start as string;
        const endDt = a.end as string;

        const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(startDt);

        const eventBody: calendar_v3.Schema$Event = {
          summary: a.summary as string,
          start: isAllDay
            ? { date: startDt }
            : { dateTime: startDt, timeZone: timezone },
          end: isAllDay
            ? { date: endDt }
            : { dateTime: endDt, timeZone: timezone },
        };

        if (a.description) eventBody.description = a.description as string;
        if (a.location) eventBody.location = a.location as string;

        if (Array.isArray(a.attendees) && a.attendees.length > 0) {
          eventBody.attendees = (a.attendees as string[]).map((email) => ({ email }));
        }

        const response = await calendarApi.events.insert({
          calendarId,
          requestBody: eventBody,
          sendUpdates: 'all',
        });

        return {
          content: [{
            type: 'text' as const,
            text: `Evento criado com sucesso.\n\n${formatEvent(response.data)}`,
          }],
        };
      }

      case 'update_event': {
        const calendarId = a.calendar_id as string;
        const eventId = a.event_id as string;

        const existing = await calendarApi.events.get({ calendarId, eventId });
        const current = existing.data;

        const patch: calendar_v3.Schema$Event = {};

        if (a.summary !== undefined) patch.summary = a.summary as string;
        if (a.description !== undefined) patch.description = a.description as string;
        if (a.location !== undefined) patch.location = a.location as string;

        if (a.start !== undefined) {
          const startDt = a.start as string;
          const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(startDt);
          const tz = current.start?.timeZone || 'America/Sao_Paulo';
          patch.start = isAllDay ? { date: startDt } : { dateTime: startDt, timeZone: tz };
        }

        if (a.end !== undefined) {
          const endDt = a.end as string;
          const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(endDt);
          const tz = current.end?.timeZone || 'America/Sao_Paulo';
          patch.end = isAllDay ? { date: endDt } : { dateTime: endDt, timeZone: tz };
        }

        if (Array.isArray(a.attendees)) {
          patch.attendees = (a.attendees as string[]).map((email) => ({ email }));
        }

        const response = await calendarApi.events.patch({
          calendarId,
          eventId,
          requestBody: patch,
          sendUpdates: 'all',
        });

        return {
          content: [{
            type: 'text' as const,
            text: `Evento atualizado com sucesso.\n\n${formatEvent(response.data)}`,
          }],
        };
      }

      case 'delete_event': {
        await calendarApi.events.delete({
          calendarId: a.calendar_id as string,
          eventId: a.event_id as string,
          sendUpdates: 'all',
        });

        return {
          content: [{
            type: 'text' as const,
            text: `Evento ${a.event_id as string} excluido com sucesso do calendario ${a.calendar_id as string}.`,
          }],
        };
      }

      case 'find_free_time': {
        const calendarIds = a.calendar_ids as string[];
        const timeMin = a.time_min as string;
        const timeMax = a.time_max as string;
        const durationMs = (a.duration_minutes as number) * 60 * 1000;

        const freeBusy = await calendarApi.freebusy.query({
          requestBody: {
            timeMin,
            timeMax,
            items: calendarIds.map((id) => ({ id })),
          },
        });

        const calendars = freeBusy.data.calendars ?? {};

        const allBusy: Array<{ start: number; end: number }> = [];
        for (const calId of calendarIds) {
          const calData = calendars[calId];
          if (!calData || !calData.busy) continue;
          for (const slot of calData.busy) {
            if (slot.start && slot.end) {
              allBusy.push({
                start: new Date(slot.start).getTime(),
                end: new Date(slot.end).getTime(),
              });
            }
          }
        }

        allBusy.sort((a, b) => a.start - b.start);
        const merged: Array<{ start: number; end: number }> = [];
        for (const interval of allBusy) {
          if (merged.length === 0 || interval.start > merged[merged.length - 1].end) {
            merged.push({ start: interval.start, end: interval.end });
          } else {
            merged[merged.length - 1].end = Math.max(
              merged[merged.length - 1].end,
              interval.end,
            );
          }
        }

        const rangeStart = new Date(timeMin).getTime();
        const rangeEnd = new Date(timeMax).getTime();
        const freeSlots: Array<{ start: string; end: string; duration_minutes: number }> = [];

        let cursor = rangeStart;
        for (const busy of merged) {
          if (cursor < busy.start) {
            const gapMs = busy.start - cursor;
            if (gapMs >= durationMs) {
              freeSlots.push({
                start: new Date(cursor).toISOString(),
                end: new Date(busy.start).toISOString(),
                duration_minutes: Math.floor(gapMs / 60000),
              });
            }
          }
          cursor = Math.max(cursor, busy.end);
        }

        if (cursor < rangeEnd) {
          const gapMs = rangeEnd - cursor;
          if (gapMs >= durationMs) {
            freeSlots.push({
              start: new Date(cursor).toISOString(),
              end: new Date(rangeEnd).toISOString(),
              duration_minutes: Math.floor(gapMs / 60000),
            });
          }
        }

        if (freeSlots.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `Nenhum horario livre de pelo menos ${a.duration_minutes as number} minutos encontrado no periodo informado.`,
            }],
          };
        }

        const lines = [
          `Horarios livres encontrados (minimo ${a.duration_minutes as number} min):`,
          '',
          ...freeSlots.map((s, i) =>
            `Slot ${i + 1}: ${s.start} ate ${s.end} (${s.duration_minutes} minutos)`,
          ),
        ];

        return {
          content: [{
            type: 'text' as const,
            text: lines.join('\n'),
          }],
        };
      }

      case 'quick_add': {
        const calendarId = (a.calendar_id as string) || 'primary';

        const response = await calendarApi.events.quickAdd({
          calendarId,
          text: a.text as string,
          sendUpdates: 'all',
        });

        return {
          content: [{
            type: 'text' as const,
            text: `Evento adicionado via texto livre.\n\n${formatEvent(response.data)}`,
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
      content: [{
        type: 'text' as const,
        text: `Erro Google Calendar: ${(err as Error).message}`,
      }],
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
