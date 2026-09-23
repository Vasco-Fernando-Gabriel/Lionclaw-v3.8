#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { google } from 'googleapis';
import { youtube_v3 } from 'googleapis';

let youtubeApi: youtube_v3.Youtube;

function initYoutube(): void {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const accessToken = process.env.GOOGLE_ACCESS_TOKEN;

  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET sao obrigatorios');
  if (!refreshToken) throw new Error('GOOGLE_REFRESH_TOKEN nao encontrado. Configure no Settings.');

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken, access_token: accessToken || undefined });
  youtubeApi = google.youtube({ version: 'v3', auth: oauth2Client });
}

const server = new Server({ name: 'youtube', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_videos',
      description:
        'Listar os videos mais recentes do canal do usuario autenticado. Retorna titulo, URL, data de publicacao, views, likes e descricao.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: {
            type: 'number',
            description: 'Quantidade de videos a retornar (padrao 20, max 50).',
          },
          page_token: {
            type: 'string',
            description: 'Token para proxima pagina (paginacao).',
          },
        },
      },
    },
    {
      name: 'get_video',
      description:
        'Obter detalhes completos de um video pelo ID ou URL. Inclui titulo, descricao, tags, views, likes, comentarios, duracao.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          video_id: {
            type: 'string',
            description: 'ID do video (ex: dQw4w9WgXcQ) ou URL completa do YouTube.',
          },
        },
        required: ['video_id'],
      },
    },
    {
      name: 'get_channel_stats',
      description: 'Retornar estatisticas do canal: total de inscritos, total de views, total de videos.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'list_comments',
      description: 'Listar comentarios de um video.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          video_id: {
            type: 'string',
            description: 'ID do video ou URL completa.',
          },
          limit: {
            type: 'number',
            description: 'Quantidade de comentarios (padrao 20, max 100).',
          },
        },
        required: ['video_id'],
      },
    },
    {
      name: 'search_videos',
      description: 'Buscar videos no canal por palavra-chave no titulo ou descricao.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Termo de busca.',
          },
          limit: {
            type: 'number',
            description: 'Quantidade de resultados (padrao 10, max 50).',
          },
        },
        required: ['query'],
      },
    },
  ],
}));

function extractVideoId(input: string): string {
  const urlMatch = input.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  if (urlMatch) return urlMatch[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  return input;
}

function formatDuration(iso: string): string {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return iso;
  const h = match[1] ? `${match[1]}h` : '';
  const m = match[2] ? `${match[2]}min` : '';
  const s = match[3] ? `${match[3]}s` : '';
  return [h, m, s].filter(Boolean).join(' ') || '0s';
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    initYoutube();
  } catch (err) {
    return { content: [{ type: 'text' as const, text: `Erro de autenticacao: ${(err as Error).message}` }] };
  }

  try {
    if (name === 'get_channel_stats') {
      const res = await youtubeApi.channels.list({
        part: ['snippet', 'statistics'],
        mine: true,
      });
      const channel = res.data.items?.[0];
      if (!channel) return { content: [{ type: 'text' as const, text: 'Canal nao encontrado.' }] };

      const stats = channel.statistics;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                nome: channel.snippet?.title,
                descricao: channel.snippet?.description?.substring(0, 200),
                inscritos: Number(stats?.subscriberCount || 0).toLocaleString('pt-BR'),
                total_views: Number(stats?.viewCount || 0).toLocaleString('pt-BR'),
                total_videos: stats?.videoCount,
                url: `https://youtube.com/channel/${channel.id}`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === 'list_videos') {
      const limit = Math.min(Number(args?.limit) || 20, 50);
      const pageToken = args?.page_token as string | undefined;

      const channelRes = await youtubeApi.channels.list({ part: ['id'], mine: true });
      const channelId = channelRes.data.items?.[0]?.id;
      if (!channelId) return { content: [{ type: 'text' as const, text: 'Canal nao encontrado.' }] };

      const searchRes = await youtubeApi.search.list({
        part: ['snippet'],
        channelId,
        order: 'date',
        type: ['video'],
        maxResults: limit,
        ...(pageToken ? { pageToken } : {}),
      });

      const videoIds = searchRes.data.items?.map((i) => i.id?.videoId).filter(Boolean) as string[];
      if (!videoIds?.length) return { content: [{ type: 'text' as const, text: 'Nenhum video encontrado.' }] };

      const statsRes = await youtubeApi.videos.list({
        part: ['statistics', 'contentDetails'],
        id: videoIds,
      });

      const statsMap = new Map(statsRes.data.items?.map((v) => [v.id, v]));

      const videos = searchRes.data.items?.map((item) => {
        const id = item.id?.videoId || '';
        const stats = statsMap.get(id);
        return {
          id,
          titulo: item.snippet?.title,
          url: `https://youtu.be/${id}`,
          publicado_em: item.snippet?.publishedAt?.split('T')[0],
          thumbnail: item.snippet?.thumbnails?.medium?.url,
          views: Number(stats?.statistics?.viewCount || 0).toLocaleString('pt-BR'),
          likes: Number(stats?.statistics?.likeCount || 0).toLocaleString('pt-BR'),
          comentarios: Number(stats?.statistics?.commentCount || 0).toLocaleString('pt-BR'),
          duracao: formatDuration(stats?.contentDetails?.duration || 'PT0S'),
        };
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                total_retornado: videos?.length,
                next_page_token: searchRes.data.nextPageToken || null,
                videos,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === 'get_video') {
      const videoId = extractVideoId(args?.video_id as string);
      const res = await youtubeApi.videos.list({
        part: ['snippet', 'statistics', 'contentDetails'],
        id: [videoId],
      });

      const video = res.data.items?.[0];
      if (!video) return { content: [{ type: 'text' as const, text: `Video ${videoId} nao encontrado.` }] };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                id: video.id,
                titulo: video.snippet?.title,
                url: `https://youtu.be/${video.id}`,
                publicado_em: video.snippet?.publishedAt?.split('T')[0],
                descricao: video.snippet?.description?.substring(0, 1000),
                tags: video.snippet?.tags || [],
                duracao: formatDuration(video.contentDetails?.duration || 'PT0S'),
                views: Number(video.statistics?.viewCount || 0).toLocaleString('pt-BR'),
                likes: Number(video.statistics?.likeCount || 0).toLocaleString('pt-BR'),
                comentarios: Number(video.statistics?.commentCount || 0).toLocaleString('pt-BR'),
                thumbnail: video.snippet?.thumbnails?.maxres?.url || video.snippet?.thumbnails?.high?.url,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === 'list_comments') {
      const videoId = extractVideoId(args?.video_id as string);
      const limit = Math.min(Number(args?.limit) || 20, 100);

      const res = await youtubeApi.commentThreads.list({
        part: ['snippet'],
        videoId,
        maxResults: limit,
        order: 'relevance',
      });

      const comments = res.data.items?.map((item) => {
        const top = item.snippet?.topLevelComment?.snippet;
        return {
          autor: top?.authorDisplayName,
          texto: top?.textDisplay?.substring(0, 500),
          likes: top?.likeCount,
          data: top?.publishedAt?.split('T')[0],
          respostas: item.snippet?.totalReplyCount,
        };
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ total: comments?.length, comentarios: comments }, null, 2),
          },
        ],
      };
    }

    if (name === 'search_videos') {
      const channelRes = await youtubeApi.channels.list({ part: ['id'], mine: true });
      const channelId = channelRes.data.items?.[0]?.id;
      if (!channelId) return { content: [{ type: 'text' as const, text: 'Canal nao encontrado.' }] };

      const limit = Math.min(Number(args?.limit) || 10, 50);
      const res = await youtubeApi.search.list({
        part: ['snippet'],
        channelId,
        q: args?.query as string,
        type: ['video'],
        maxResults: limit,
        order: 'relevance',
      });

      const videos = res.data.items?.map((item) => ({
        id: item.id?.videoId,
        titulo: item.snippet?.title,
        url: `https://youtu.be/${item.id?.videoId}`,
        publicado_em: item.snippet?.publishedAt?.split('T')[0],
        descricao_curta: item.snippet?.description?.substring(0, 200),
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ total: videos?.length, videos }, null, 2),
          },
        ],
      };
    }

    return { content: [{ type: 'text' as const, text: `Tool desconhecida: ${name}` }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text' as const, text: `Erro: ${msg}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
