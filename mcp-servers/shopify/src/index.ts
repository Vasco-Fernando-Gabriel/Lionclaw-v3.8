#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';


interface TokenCache {
  accessToken: string;
  expiresAt: number; // timestamp ms
}

let tokenCache: TokenCache | null = null;

function getEnvConfig(): { storeUrl: string; clientId: string; clientSecret: string } {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!storeUrl || !clientId || !clientSecret) {
    throw new Error(
      'SHOPIFY_STORE_URL, SHOPIFY_CLIENT_ID e SHOPIFY_CLIENT_SECRET precisam estar configurados no Vault do LionClaw.',
    );
  }
  return { storeUrl, clientId, clientSecret };
}

async function getAccessToken(storeUrl: string, clientId: string, clientSecret: string): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 5 * 60 * 1000) {
    return tokenCache.accessToken;
  }

  const url = `https://${storeUrl}/admin/oauth/access_token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Credenciais invalidas (${res.status}). Verifique SHOPIFY_CLIENT_ID e SHOPIFY_CLIENT_SECRET no Vault.`,
      );
    }
    throw new Error(`Erro ao obter access token (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number; scope: string };
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return data.access_token;
}


const API_VERSION = '2024-01';
const ANALYTICS_API_VERSION = '2025-10';
const WRITE_API_VERSION = '2025-01';

function baseUrl(storeUrl: string): string {
  return `https://${storeUrl}/admin/api/${API_VERSION}`;
}

async function shopifyFetch(
  endpoint: string,
  storeUrl: string,
  accessToken: string,
): Promise<{ data: unknown; linkHeader: string | null }> {
  const url = `${baseUrl(storeUrl)}${endpoint}`;
  const res = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
  });

  if (res.status === 401) {
    tokenCache = null;
    throw new Error(
      'Token expirado ou invalido (401). Tente novamente (o token sera renovado automaticamente).',
    );
  }
  if (res.status === 404) {
    throw new Error(`Recurso nao encontrado (404): ${endpoint}`);
  }
  if (res.status === 429) {
    throw new Error(
      'Limite de requisicoes atingido (429). Aguarde alguns segundos e tente novamente.',
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Erro Shopify (${res.status}): ${body}`);
  }

  const data = await res.json();
  const linkHeader = res.headers.get('link');
  return { data, linkHeader };
}


async function shopifyGraphQL(
  query: string,
  variables: Record<string, unknown>,
  storeUrl: string,
  accessToken: string,
  apiVersion: string = API_VERSION,
): Promise<unknown> {
  const url = `https://${storeUrl}/admin/api/${apiVersion}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401) {
    tokenCache = null;
    throw new Error('Token expirado ou invalido (401). Tente novamente.');
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Erro GraphQL Shopify (${res.status}): ${body}`);
  }

  const json = (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${json.errors.map(e => e.message).join(', ')}`);
  }
  return json.data;
}

function extractPageInfo(linkHeader: string | null, rel: string): string | null {
  if (!linkHeader) return null;
  const regex = new RegExp(`<[^>]*[?&]page_info=([^&>]+)[^>]*>;\\s*rel="${rel}"`);
  const match = linkHeader.match(regex);
  return match ? match[1] : null;
}


interface RawProduct {
  id: number;
  title: string;
  status: string;
  vendor: string;
  product_type: string;
  tags: string;
  variants: Array<{
    id: number;
    title: string;
    price: string;
    sku: string | null;
    inventory_quantity: number;
    inventory_item_id: number;
  }>;
  images: Array<{ src: string }>;
}

interface CompactProduct {
  id: number;
  title: string;
  status: string;
  vendor: string;
  product_type: string;
  tags: string;
  price_range: string;
  total_inventory: number;
  variants_count: number;
  image_src: string | null;
}

function compactProduct(p: RawProduct): CompactProduct {
  const prices = (p.variants || []).map(v => parseFloat(v.price)).filter(n => !isNaN(n));
  const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
  const priceRange = minPrice === maxPrice
    ? minPrice.toFixed(2)
    : `${minPrice.toFixed(2)} - ${maxPrice.toFixed(2)}`;
  const totalInventory = (p.variants || []).reduce((sum, v) => sum + (v.inventory_quantity || 0), 0);

  return {
    id: p.id,
    title: p.title,
    status: p.status,
    vendor: p.vendor,
    product_type: p.product_type,
    tags: p.tags,
    price_range: priceRange,
    total_inventory: totalInventory,
    variants_count: p.variants?.length ?? 0,
    image_src: p.images?.[0]?.src ?? null,
  };
}

interface RawOrder {
  id: number;
  name: string;
  created_at: string;
  total_price: string;
  financial_status: string;
  fulfillment_status: string | null;
  customer: { first_name: string; last_name: string; email: string } | null;
  line_items: Array<{
    title: string;
    quantity: number;
    price: string;
    sku: string | null;
    variant_title: string | null;
  }>;
}

interface CompactOrder {
  id: number;
  name: string;
  created_at: string;
  total_price: string;
  financial_status: string;
  fulfillment_status: string | null;
  customer_name: string | null;
  customer_email: string | null;
  line_items_summary: string;
  items_count: number;
}

function compactOrder(o: RawOrder): CompactOrder {
  const customerName = o.customer
    ? `${o.customer.first_name} ${o.customer.last_name}`.trim()
    : null;
  const summary = (o.line_items || [])
    .map(li => `${li.quantity}x ${li.title}${li.variant_title ? ` (${li.variant_title})` : ''}`)
    .join(', ');

  return {
    id: o.id,
    name: o.name,
    created_at: o.created_at,
    total_price: o.total_price,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status,
    customer_name: customerName,
    customer_email: o.customer?.email ?? null,
    line_items_summary: summary,
    items_count: o.line_items?.length ?? 0,
  };
}

const COMPACT_PRODUCT_FIELDS = 'id,title,status,vendor,product_type,tags,variants,images';
const COMPACT_ORDER_FIELDS = 'id,name,created_at,total_price,financial_status,fulfillment_status,customer,line_items';


const server = new Server(
  { name: 'shopify', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const fieldsSchema = {
  type: 'string' as const,
  description: 'Campos especificos a retornar (separados por virgula). Se nao informado, retorna campos resumidos.',
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_products',
      description:
        'Listar produtos da loja Shopify (resumo compacto). Use get_product para detalhes completos.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: {
            type: 'number',
            description: 'Quantidade de produtos (max 250, padrao 25).',
          },
          page_info: {
            type: 'string',
            description: 'Cursor de paginacao (retornado na chamada anterior).',
          },
          status: {
            type: 'string',
            enum: ['active', 'draft', 'archived'],
            description: 'Filtrar por status do produto.',
          },
          fields: fieldsSchema,
        },
      },
    },
    {
      name: 'get_product',
      description: 'Obter detalhes completos de um produto pelo ID.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          product_id: {
            type: 'string',
            description: 'ID do produto.',
          },
        },
        required: ['product_id'],
      },
    },
    {
      name: 'search_products',
      description:
        'Buscar produtos por texto livre (titulo, vendor, tag, tipo, SKU). Usa GraphQL para busca parcial.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Termo de busca (titulo, vendor, tag, tipo, SKU).',
          },
          limit: {
            type: 'number',
            description: 'Quantidade maxima de resultados (padrao 10, max 25).',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_inventory',
      description:
        'Obter niveis de estoque para um ou mais inventory item IDs.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          inventory_item_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lista de inventory_item_id para consultar.',
          },
        },
        required: ['inventory_item_ids'],
      },
    },
    {
      name: 'list_collections',
      description:
        'Listar colecoes (custom + smart) da loja Shopify.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: {
            type: 'number',
            description: 'Quantidade por tipo de colecao (padrao 50).',
          },
        },
      },
    },
    {
      name: 'get_collection_products',
      description: 'Listar produtos de uma colecao especifica (resumo compacto).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          collection_id: {
            type: 'string',
            description: 'ID da colecao.',
          },
          limit: {
            type: 'number',
            description: 'Quantidade de produtos (padrao 25).',
          },
          fields: fieldsSchema,
        },
        required: ['collection_id'],
      },
    },
    {
      name: 'list_orders',
      description: 'Listar pedidos da loja Shopify (resumo compacto). Use get_order para detalhes completos.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: {
            type: 'number',
            description: 'Quantidade de pedidos (padrao 25).',
          },
          status: {
            type: 'string',
            enum: ['open', 'closed', 'cancelled', 'any'],
            description: 'Filtrar por status (padrao: any).',
          },
          financial_status: {
            type: 'string',
            enum: [
              'authorized',
              'pending',
              'paid',
              'partially_paid',
              'refunded',
              'voided',
              'partially_refunded',
              'any',
              'unpaid',
            ],
            description: 'Filtrar por status financeiro.',
          },
          created_at_min: {
            type: 'string',
            description:
              'Data minima de criacao (ISO 8601, ex: 2024-01-01T00:00:00Z).',
          },
          fields: fieldsSchema,
        },
      },
    },
    {
      name: 'get_order',
      description: 'Obter detalhes completos de um pedido pelo ID.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          order_id: {
            type: 'string',
            description: 'ID do pedido.',
          },
        },
        required: ['order_id'],
      },
    },
    {
      name: 'create_product',
      description:
        'Criar um novo produto na loja Shopify. Por seguranca, o padrao e status="DRAFT" (rascunho, invisivel ao cliente). Use status="ACTIVE" apenas com confirmacao explicita.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          title: {
            type: 'string',
            description: 'Titulo do produto (obrigatorio).',
          },
          descriptionHtml: {
            type: 'string',
            description: 'Descricao do produto em HTML.',
          },
          vendor: {
            type: 'string',
            description: 'Vendor/marca do produto.',
          },
          productType: {
            type: 'string',
            description: 'Tipo do produto (ex: "Vestido", "Calca").',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lista de tags.',
          },
          status: {
            type: 'string',
            enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'],
            description: 'Status do produto. Padrao: DRAFT (recomendado para loja em producao).',
          },
          price: {
            type: 'string',
            description: 'Preco da variante unica (modo simples). Use ponto como separador decimal. Ex: "99.90". Nao use junto com "variants".',
          },
          compareAtPrice: {
            type: 'string',
            description: 'Preco "de" (riscado) da variante unica. Use ponto como separador decimal.',
          },
          sku: {
            type: 'string',
            description: 'SKU da variante unica (modo simples).',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Nomes das opcoes do produto (modo multi-variante). Ex: ["Tamanho"] ou ["Tamanho","Cor"]. Use junto com "variants".',
          },
          variants: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                values: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Valores das opcoes, na mesma ordem de "options". Ex: ["P","Vermelho"].',
                },
                price: { type: 'string', description: 'Preco da variante. Ex: "99.90".' },
                compareAtPrice: { type: 'string', description: 'Preco "de" da variante.' },
                sku: { type: 'string', description: 'SKU da variante.' },
                weight_grams: { type: 'number', description: 'Peso da variante em gramas. Se omitido, usa default_weight_grams do produto.' },
              },
              required: ['values', 'price'],
            },
            description: 'Lista de variantes (modo multi-variante). Cada variante precisa de "values" (na ordem de "options") e "price".',
          },
          default_weight_grams: {
            type: 'number',
            description: 'Peso padrao em gramas aplicado a TODAS as variantes que nao definirem weight_grams proprio. Use 150 pra produtos The Notte por padrao.',
          },
          images: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'URL publica da imagem (Shopify baixa e hospeda). Aceita PNG, JPG, WEBP, GIF.' },
                alt: { type: 'string', description: 'Texto alternativo da imagem.' },
              },
              required: ['url'],
            },
            description: 'Imagens do produto. A Shopify serve automaticamente em WebP/AVIF pros browsers compativeis, independente do formato fonte.',
          },
          category: {
            type: 'string',
            description: 'ID da Shopify Taxonomy Category (formato "gid://shopify/TaxonomyCategory/aa-1-2-3") ou apenas o handle final (ex: "aa-1-2-3"). Opcional.',
          },
          metafields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                namespace: { type: 'string', description: 'Namespace do metafield (ex: "custom").' },
                key: { type: 'string', description: 'Chave do metafield.' },
                value: { type: 'string', description: 'Valor (sempre string; objetos/arrays devem vir como JSON serializado).' },
                type: { type: 'string', description: 'Tipo do metafield. Ex: "single_line_text_field", "multi_line_text_field", "number_integer", "boolean", "json", "color", "list.single_line_text_field".' },
              },
              required: ['namespace', 'key', 'value', 'type'],
            },
            description: 'Metafields para gravar no produto. Cada item precisa de namespace, key, value e type.',
          },
        },
        required: ['title'],
      },
    },
    {
      name: 'update_product',
      description:
        'Atualizar um produto existente na Shopify via productSet (mutation atomica). Passe o ID e apenas os campos que quer alterar. Cuidado: passar "variants" SOBRESCREVE a lista atual de variantes do produto (productSet e declarativo).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: {
            type: 'string',
            description: 'ID do produto. Aceita ID numerico ("10104822202654") ou GID ("gid://shopify/Product/10104822202654").',
          },
          title: { type: 'string', description: 'Novo titulo.' },
          descriptionHtml: { type: 'string', description: 'Nova descricao HTML.' },
          vendor: { type: 'string', description: 'Novo vendor.' },
          productType: { type: 'string', description: 'Novo product type.' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lista de tags. SUBSTITUI as tags atuais (nao append).',
          },
          status: {
            type: 'string',
            enum: ['DRAFT', 'ACTIVE', 'ARCHIVED'],
            description: 'Novo status.',
          },
          price: { type: 'string', description: 'Preco unico (modo variante simples).' },
          compareAtPrice: { type: 'string', description: 'Preco "de" da variante unica.' },
          sku: { type: 'string', description: 'SKU da variante unica.' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Nomes das opcoes (modo multi-variante). Use junto com "variants".',
          },
          variants: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                values: { type: 'array', items: { type: 'string' } },
                price: { type: 'string' },
                compareAtPrice: { type: 'string' },
                sku: { type: 'string' },
                weight_grams: { type: 'number', description: 'Peso da variante em gramas. Se omitido, usa default_weight_grams.' },
              },
              required: ['values', 'price'],
            },
            description: 'Lista completa de variantes (SUBSTITUI as atuais). Cada uma precisa de "values" e "price".',
          },
          default_weight_grams: {
            type: 'number',
            description: 'Peso padrao em gramas aplicado a TODAS as variantes que nao definirem weight_grams proprio.',
          },
          images: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                alt: { type: 'string' },
              },
              required: ['url'],
            },
            description: 'Imagens (SUBSTITUI a galeria atual). Para apenas adicionar imagens, use as imagens existentes + as novas.',
          },
          category: {
            type: 'string',
            description: 'ID da Shopify Taxonomy Category (GID ou handle).',
          },
          metafields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                namespace: { type: 'string' },
                key: { type: 'string' },
                value: { type: 'string' },
                type: { type: 'string' },
              },
              required: ['namespace', 'key', 'value', 'type'],
            },
            description: 'Metafields a gravar (upsert por namespace+key).',
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'list_metafield_definitions',
      description: 'Lista todas as definicoes de metafields da loja (com namespace, key, type, descricao). Use para descobrir os metafields fixos antes de gravar produtos.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          owner_type: {
            type: 'string',
            enum: ['PRODUCT', 'PRODUCTVARIANT', 'CUSTOMER', 'ORDER', 'COLLECTION'],
            description: 'Tipo do owner. Padrao: PRODUCT.',
          },
        },
      },
    },
    {
      name: 'list_publications',
      description: 'Lista todos os canais de venda (publications) da loja. Use para descobrir IDs antes de publicar produtos.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'list_locations',
      description: 'Lista todas as locations (estoques/lojas fisicas) da loja Shopify. Use para descobrir IDs antes de ativar inventory.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'publish_product',
      description: 'Vincula um produto a todos os canais de venda da loja, ativa inventory em todas as locations e opcionalmente define uma quantidade padrao de estoque em cada variante. NAO altera o status do produto (DRAFT continua DRAFT). Idempotente.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: {
            type: 'string',
            description: 'ID do produto (numerico ou GID).',
          },
          publication_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs (GID) das publications onde publicar. Opcional - se omitir, publica em TODAS.',
          },
          location_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs (GID) das locations onde ativar inventory. Opcional - se omitir, ativa em TODAS.',
          },
          default_quantity: {
            type: 'number',
            description: 'Quantidade padrao de estoque a setar em cada variante em cada location apos ativar inventory. Use 1 para produtos novos. Omitir = nao mexer no estoque.',
          },
        },
        required: ['id'],
      },
    },
    {
      name: 'analytics_query',
      description: 'Executar consulta ShopifyQL para relatorios e analytics da loja. O unico dataset disponivel e "sales". Exemplos validos: "FROM sales SHOW total_sales GROUP BY month SINCE -1y", "FROM sales SHOW net_sales, orders GROUP BY day SINCE -30d", "FROM sales SHOW average_order_value GROUP BY month SINCE -6m", "FROM sales SHOW total_sales GROUP BY product_title SINCE -3m ORDER BY total_sales DESC LIMIT 10".',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Query em ShopifyQL. Sintaxe: FROM sales SHOW {metricas} [GROUP BY {dimensao}] [SINCE {periodo}] [ORDER BY {campo} ASC|DESC] [LIMIT {n}]. IMPORTANTE: o unico dataset valido e "sales". Metricas validas: total_sales, net_sales, orders, average_order_value, gross_sales, discounts, returns, shipping, tax. Dimensoes para GROUP BY: day, week, month, quarter, year, product_title, product_type, product_vendor, billing_country, billing_city, billing_region, channel. Periodos: -7d, -30d, -90d, -3m, -6m, -1y, -2y.',
          },
        },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, unknown>;

  try {
    const { storeUrl, clientId, clientSecret } = getEnvConfig();
    const accessToken = await getAccessToken(storeUrl, clientId, clientSecret);

    switch (name) {
      case 'list_products': {
        const limit = Math.min((a.limit as number) || 25, 250);
        const pageInfo = a.page_info as string | undefined;
        const status = a.status as string | undefined;
        const customFields = a.fields as string | undefined;
        const useCompact = !customFields;

        let endpoint: string;
        if (pageInfo) {
          const params = new URLSearchParams({
            page_info: pageInfo,
            limit: String(limit),
          });
          if (useCompact) params.set('fields', COMPACT_PRODUCT_FIELDS);
          else params.set('fields', customFields);
          endpoint = `/products.json?${params}`;
        } else {
          const params = new URLSearchParams({ limit: String(limit) });
          if (status) params.set('status', status);
          if (useCompact) params.set('fields', COMPACT_PRODUCT_FIELDS);
          else params.set('fields', customFields);
          endpoint = `/products.json?${params}`;
        }

        const { data, linkHeader } = await shopifyFetch(endpoint, storeUrl, accessToken);
        const products = (data as { products: RawProduct[] }).products;
        const nextPage = extractPageInfo(linkHeader, 'next');

        const result: Record<string, unknown> = {
          total_retornado: products.length,
          produtos: useCompact ? products.map(compactProduct) : products,
        };
        if (nextPage) {
          result.proxima_pagina = nextPage;
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'get_product': {
        const productId = a.product_id as string;
        const { data } = await shopifyFetch(
          `/products/${encodeURIComponent(productId)}.json`,
          storeUrl,
          accessToken,
        );
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify((data as { product: unknown }).product, null, 2) },
          ],
        };
      }

      case 'search_products': {
        const query = a.query as string;
        const limit = Math.min((a.limit as number) || 10, 25);

        const gql = `
          query searchProducts($query: String!, $first: Int!) {
            products(first: $first, query: $query) {
              edges {
                node {
                  id
                  title
                  status
                  vendor
                  productType
                  tags
                  totalInventory
                  priceRangeV2 {
                    minVariantPrice { amount currencyCode }
                    maxVariantPrice { amount currencyCode }
                  }
                  totalVariants
                  featuredImage { url }
                }
              }
            }
          }
        `;

        const data = await shopifyGraphQL(gql, { query, first: limit }, storeUrl, accessToken) as {
          products: {
            edges: Array<{
              node: {
                id: string;
                title: string;
                status: string;
                vendor: string;
                productType: string;
                tags: string[];
                totalInventory: number;
                priceRangeV2: {
                  minVariantPrice: { amount: string; currencyCode: string };
                  maxVariantPrice: { amount: string; currencyCode: string };
                };
                totalVariants: number;
                featuredImage: { url: string } | null;
              };
            }>;
          };
        };

        const produtos = data.products.edges.map(({ node }) => {
          const numericId = node.id.split('/').pop();
          const min = parseFloat(node.priceRangeV2.minVariantPrice.amount);
          const max = parseFloat(node.priceRangeV2.maxVariantPrice.amount);

          return {
            id: numericId,
            title: node.title,
            status: node.status.toLowerCase(),
            vendor: node.vendor,
            product_type: node.productType,
            tags: node.tags.join(', '),
            price_range: min === max ? min.toFixed(2) : `${min.toFixed(2)} - ${max.toFixed(2)}`,
            currency: node.priceRangeV2.minVariantPrice.currencyCode,
            total_inventory: node.totalInventory,
            variants_count: node.totalVariants,
            image_src: node.featuredImage?.url ?? null,
          };
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ total_retornado: produtos.length, produtos }, null, 2),
          }],
        };
      }

      case 'get_inventory': {
        const ids = a.inventory_item_ids as string[];
        const { data } = await shopifyFetch(
          `/inventory_levels.json?inventory_item_ids=${ids.join(',')}`,
          storeUrl,
          accessToken,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                (data as { inventory_levels: unknown[] }).inventory_levels,
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'list_collections': {
        const limit = Math.min((a.limit as number) || 50, 250);

        const [customRes, smartRes] = await Promise.all([
          shopifyFetch(
            `/custom_collections.json?limit=${limit}`,
            storeUrl,
            accessToken,
          ),
          shopifyFetch(
            `/smart_collections.json?limit=${limit}`,
            storeUrl,
            accessToken,
          ),
        ]);

        const custom = (customRes.data as { custom_collections: unknown[] })
          .custom_collections;
        const smart = (smartRes.data as { smart_collections: unknown[] })
          .smart_collections;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  custom_collections: custom,
                  smart_collections: smart,
                  total: custom.length + smart.length,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'get_collection_products': {
        const collectionId = a.collection_id as string;
        const limit = Math.min((a.limit as number) || 25, 250);
        const customFields = a.fields as string | undefined;
        const useCompact = !customFields;

        const params = new URLSearchParams({ limit: String(limit) });
        if (useCompact) params.set('fields', COMPACT_PRODUCT_FIELDS);
        else params.set('fields', customFields);

        const { data } = await shopifyFetch(
          `/collections/${encodeURIComponent(collectionId)}/products.json?${params}`,
          storeUrl,
          accessToken,
        );
        const products = (data as { products: RawProduct[] }).products;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  total_retornado: products.length,
                  produtos: useCompact ? products.map(compactProduct) : products,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'list_orders': {
        const limit = Math.min((a.limit as number) || 25, 250);
        const status = (a.status as string) || 'any';
        const financialStatus = a.financial_status as string | undefined;
        const createdAtMin = a.created_at_min as string | undefined;
        const customFields = a.fields as string | undefined;
        const useCompact = !customFields;

        const params = new URLSearchParams({
          limit: String(limit),
          status,
        });
        if (financialStatus) params.set('financial_status', financialStatus);
        if (createdAtMin) params.set('created_at_min', createdAtMin);
        if (useCompact) params.set('fields', COMPACT_ORDER_FIELDS);
        else params.set('fields', customFields);

        const { data } = await shopifyFetch(
          `/orders.json?${params}`,
          storeUrl,
          accessToken,
        );
        const orders = (data as { orders: RawOrder[] }).orders;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  total_retornado: orders.length,
                  pedidos: useCompact ? orders.map(compactOrder) : orders,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'get_order': {
        const orderId = a.order_id as string;
        const { data } = await shopifyFetch(
          `/orders/${encodeURIComponent(orderId)}.json`,
          storeUrl,
          accessToken,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                (data as { order: unknown }).order,
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'create_product':
      case 'update_product': {
        const isUpdate = name === 'update_product';

        let productGid: string | undefined;
        if (isUpdate) {
          const rawId = a.id as string | undefined;
          if (!rawId) throw new Error('O campo "id" e obrigatorio em update_product.');
          productGid = rawId.startsWith('gid://')
            ? rawId
            : `gid://shopify/Product/${rawId.split('/').pop()}`;
        }

        const title = a.title as string | undefined;
        if (!isUpdate && (!title || title.trim() === '')) {
          throw new Error('O campo "title" e obrigatorio em create_product.');
        }

        let status: string | undefined;
        if (a.status !== undefined) {
          status = (a.status as string).toUpperCase();
          if (!['DRAFT', 'ACTIVE', 'ARCHIVED'].includes(status)) {
            throw new Error(`Status invalido: ${status}. Use DRAFT, ACTIVE ou ARCHIVED.`);
          }
        } else if (!isUpdate) {
          status = 'DRAFT';
        }

        const hasSingle = a.price !== undefined || a.sku !== undefined || a.compareAtPrice !== undefined;
        const hasMulti = Array.isArray(a.variants) && (a.variants as unknown[]).length > 0;

        if (hasSingle && hasMulti) {
          throw new Error(
            'Use APENAS "price/sku/compareAtPrice" (variante unica) OU "variants" (multi). Nao misture os dois.',
          );
        }

        const setInput: Record<string, unknown> = {};
        if (productGid) setInput.id = productGid;
        if (title !== undefined) setInput.title = title;
        if (status !== undefined) setInput.status = status;
        if (a.descriptionHtml !== undefined) setInput.descriptionHtml = a.descriptionHtml as string;
        if (a.vendor !== undefined) setInput.vendor = a.vendor as string;
        if (a.productType !== undefined) setInput.productType = a.productType as string;
        if (a.tags !== undefined) setInput.tags = a.tags as string[];

        if (a.category !== undefined) {
          const rawCat = (a.category as string).trim();
          setInput.category = rawCat.startsWith('gid://')
            ? rawCat
            : `gid://shopify/TaxonomyCategory/${rawCat}`;
        }

        if (Array.isArray(a.metafields) && (a.metafields as unknown[]).length > 0) {
          const rawMetafields = a.metafields as Array<{
            namespace: string;
            key: string;
            value: string;
            type: string;
          }>;
          for (const mf of rawMetafields) {
            if (!mf.namespace || !mf.key || mf.value === undefined || !mf.type) {
              throw new Error('Cada metafield precisa de namespace, key, value e type.');
            }
          }
          setInput.metafields = rawMetafields.map(mf => ({
            namespace: mf.namespace,
            key: mf.key,
            value: mf.value,
            type: mf.type,
          }));
        }

        if (hasMulti) {
          const optionNames = (a.options as string[] | undefined) || ['Title'];
          const rawVariants = a.variants as Array<{
            values: string[];
            price: string;
            compareAtPrice?: string;
            sku?: string;
            weight_grams?: number;
          }>;
          const defaultWeightGrams = typeof a.default_weight_grams === 'number' ? (a.default_weight_grams as number) : undefined;
          for (const v of rawVariants) {
            if (!Array.isArray(v.values) || v.values.length !== optionNames.length) {
              throw new Error(
                `Cada variante precisa de "values" com ${optionNames.length} valor(es), na ordem de "options" (${optionNames.join(', ')}).`,
              );
            }
            if (!v.price) {
              throw new Error('Cada variante precisa de "price".');
            }
          }

          setInput.productOptions = optionNames.map((nm, idx) => {
            const uniqueValues = Array.from(new Set(rawVariants.map(v => v.values[idx])));
            return {
              name: nm,
              values: uniqueValues.map(v => ({ name: v })),
            };
          });

          setInput.variants = rawVariants.map(v => {
            const variantInput: Record<string, unknown> = {
              optionValues: v.values.map((val, idx) => ({
                optionName: optionNames[idx],
                name: val,
              })),
              price: v.price,
            };
            if (v.compareAtPrice) variantInput.compareAtPrice = v.compareAtPrice;
            const invItem: Record<string, unknown> = { tracked: true };
            if (v.sku) invItem.sku = v.sku;
            const weightGrams = typeof v.weight_grams === 'number' ? v.weight_grams : defaultWeightGrams;
            if (typeof weightGrams === 'number') {
              invItem.measurement = {
                weight: { value: weightGrams, unit: 'GRAMS' },
              };
            }
            variantInput.inventoryItem = invItem;
            return variantInput;
          });
        } else if (hasSingle) {
          setInput.productOptions = [{ name: 'Title', values: [{ name: 'Default Title' }] }];
          const variantInput: Record<string, unknown> = {
            optionValues: [{ optionName: 'Title', name: 'Default Title' }],
          };
          if (a.price !== undefined) variantInput.price = a.price as string;
          if (a.compareAtPrice !== undefined) variantInput.compareAtPrice = a.compareAtPrice as string;
          const invItem: Record<string, unknown> = { tracked: true };
          if (a.sku !== undefined) invItem.sku = a.sku as string;
          const dw = typeof a.default_weight_grams === 'number' ? (a.default_weight_grams as number) : undefined;
          if (typeof dw === 'number') {
            invItem.measurement = { weight: { value: dw, unit: 'GRAMS' } };
          }
          variantInput.inventoryItem = invItem;
          setInput.variants = [variantInput];
        }

        const rawImages = Array.isArray(a.images) ? a.images as Array<{ url: string; alt?: string }> : [];
        if (rawImages.length > 0) {
          setInput.files = rawImages.map(img => {
            if (!img.url || typeof img.url !== 'string') {
              throw new Error('Cada imagem precisa de "url" valida.');
            }
            const fileInput: Record<string, unknown> = {
              contentType: 'IMAGE',
              originalSource: img.url,
            };
            if (img.alt) fileInput.alt = img.alt;
            return fileInput;
          });
        }

        const gql = `
          mutation productSet($input: ProductSetInput!) {
            productSet(synchronous: true, input: $input) {
              product {
                id
                title
                status
                handle
                vendor
                productType
                tags
                onlineStoreUrl
                category {
                  id
                  name
                  fullName
                }
                options {
                  name
                  values
                }
                variants(first: 100) {
                  edges {
                    node {
                      id
                      title
                      price
                      compareAtPrice
                      sku
                      selectedOptions { name value }
                    }
                  }
                }
                media(first: 20) {
                  edges {
                    node {
                      id
                      mediaContentType
                      status
                      alt
                      ... on MediaImage {
                        image { url width height }
                      }
                    }
                  }
                }
                metafields(first: 50) {
                  edges {
                    node {
                      id
                      namespace
                      key
                      value
                      type
                    }
                  }
                }
              }
              userErrors {
                field
                message
              }
            }
          }
        `;

        const data = await shopifyGraphQL(gql, { input: setInput }, storeUrl, accessToken, WRITE_API_VERSION) as {
          productSet: {
            product: {
              id: string;
              title: string;
              status: string;
              handle: string;
              vendor: string;
              productType: string;
              tags: string[];
              onlineStoreUrl: string | null;
              category: { id: string; name: string; fullName: string } | null;
              options: Array<{ name: string; values: string[] }>;
              variants: {
                edges: Array<{
                  node: {
                    id: string;
                    title: string;
                    price: string;
                    compareAtPrice: string | null;
                    sku: string | null;
                    selectedOptions: Array<{ name: string; value: string }>;
                  };
                }>;
              };
              media: {
                edges: Array<{
                  node: {
                    id: string;
                    mediaContentType: string;
                    status: string;
                    alt: string | null;
                    image: { url: string; width: number; height: number } | null;
                  };
                }>;
              };
              metafields: {
                edges: Array<{
                  node: {
                    id: string;
                    namespace: string;
                    key: string;
                    value: string;
                    type: string;
                  };
                }>;
              };
            } | null;
            userErrors: Array<{ field: string[]; message: string }>;
          };
        };

        const { product, userErrors } = data.productSet;

        if (userErrors && userErrors.length > 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `Erro ao ${isUpdate ? 'atualizar' : 'criar'} produto: ${JSON.stringify(userErrors, null, 2)}`,
            }],
            isError: true,
          };
        }

        if (!product) {
          return {
            content: [{
              type: 'text' as const,
              text: `Produto nao foi ${isUpdate ? 'atualizado' : 'criado'} (resposta vazia da Shopify).`,
            }],
            isError: true,
          };
        }

        const numericId = product.id.split('/').pop();
        const adminUrl = `https://${storeUrl}/admin/products/${numericId}`;
        const variants = product.variants.edges.map(({ node }) => ({
          id: node.id.split('/').pop(),
          gid: node.id,
          title: node.title,
          price: node.price,
          compare_at_price: node.compareAtPrice,
          sku: node.sku,
          options: node.selectedOptions.reduce<Record<string, string>>((acc, o) => {
            acc[o.name] = o.value;
            return acc;
          }, {}),
        }));

        const media = (product.media?.edges || []).map(({ node }) => ({
          id: node.id,
          tipo: node.mediaContentType,
          status: node.status,
          alt: node.alt,
          url: node.image?.url ?? null,
          width: node.image?.width ?? null,
          height: node.image?.height ?? null,
        }));

        const metafields = (product.metafields?.edges || []).map(({ node }) => ({
          id: node.id,
          namespace: node.namespace,
          key: node.key,
          value: node.value,
          type: node.type,
        }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              [isUpdate ? 'atualizado' : 'criado']: true,
              id: numericId,
              gid: product.id,
              title: product.title,
              status: product.status,
              handle: product.handle,
              vendor: product.vendor,
              product_type: product.productType,
              tags: product.tags,
              category: product.category
                ? { id: product.category.id, name: product.category.name, full_name: product.category.fullName }
                : null,
              options: product.options,
              variants,
              variants_count: variants.length,
              media,
              media_count: media.length,
              metafields,
              metafields_count: metafields.length,
              admin_url: adminUrl,
            }, null, 2),
          }],
        };
      }

      case 'list_metafield_definitions': {
        const ownerType = (a.owner_type as string) || 'PRODUCT';
        const gql = `
          query listDefs($ownerType: MetafieldOwnerType!) {
            metafieldDefinitions(first: 100, ownerType: $ownerType) {
              edges {
                node {
                  id
                  name
                  namespace
                  key
                  description
                  type { name category }
                  ownerType
                  pinnedPosition
                }
              }
            }
          }
        `;
        const data = await shopifyGraphQL(gql, { ownerType }, storeUrl, accessToken, WRITE_API_VERSION) as {
          metafieldDefinitions: {
            edges: Array<{ node: {
              id: string;
              name: string;
              namespace: string;
              key: string;
              description: string | null;
              type: { name: string; category: string };
              ownerType: string;
              pinnedPosition: number | null;
            } }>;
          };
        };
        const items = data.metafieldDefinitions.edges.map(({ node }) => ({
          id: node.id,
          name: node.name,
          namespace: node.namespace,
          key: node.key,
          full_key: `${node.namespace}.${node.key}`,
          description: node.description,
          type: node.type.name,
          category: node.type.category,
          owner_type: node.ownerType,
          pinned: node.pinnedPosition !== null,
          pinned_position: node.pinnedPosition,
        }));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ total: items.length, definitions: items }, null, 2) }],
        };
      }

      case 'list_publications': {
        const gql = `
          query listPublications {
            publications(first: 25) {
              edges {
                node {
                  id
                  name
                  supportsFuturePublishing
                }
              }
            }
          }
        `;
        const data = await shopifyGraphQL(gql, {}, storeUrl, accessToken, WRITE_API_VERSION) as {
          publications: { edges: Array<{ node: { id: string; name: string; supportsFuturePublishing: boolean } }> };
        };
        const items = data.publications.edges.map(({ node }) => ({
          id: node.id,
          name: node.name,
          supports_future_publishing: node.supportsFuturePublishing,
        }));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ total: items.length, publications: items }, null, 2) }],
        };
      }

      case 'list_locations': {
        const gql = `
          query listLocations {
            locations(first: 25) {
              edges {
                node {
                  id
                  name
                  isActive
                  fulfillsOnlineOrders
                  shipsInventory
                }
              }
            }
          }
        `;
        const data = await shopifyGraphQL(gql, {}, storeUrl, accessToken, WRITE_API_VERSION) as {
          locations: { edges: Array<{ node: { id: string; name: string; isActive: boolean; fulfillsOnlineOrders: boolean; shipsInventory: boolean } }> };
        };
        const items = data.locations.edges.map(({ node }) => ({
          id: node.id,
          name: node.name,
          is_active: node.isActive,
          fulfills_online_orders: node.fulfillsOnlineOrders,
          ships_inventory: node.shipsInventory,
        }));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ total: items.length, locations: items }, null, 2) }],
        };
      }

      case 'publish_product': {
        const rawId = a.id as string;
        const productGid = rawId.startsWith('gid://')
          ? rawId
          : `gid://shopify/Product/${rawId}`;

        let pubIds = a.publication_ids as string[] | undefined;
        let locIds = a.location_ids as string[] | undefined;

        if (!pubIds || pubIds.length === 0) {
          const pubData = await shopifyGraphQL(
            `query { publications(first: 25) { edges { node { id } } } }`,
            {},
            storeUrl,
            accessToken,
            WRITE_API_VERSION,
          ) as { publications: { edges: Array<{ node: { id: string } }> } };
          pubIds = pubData.publications.edges.map(e => e.node.id);
        }

        if (!locIds || locIds.length === 0) {
          const locData = await shopifyGraphQL(
            `query { locations(first: 25, includeInactive: false) { edges { node { id isActive } } } }`,
            {},
            storeUrl,
            accessToken,
            WRITE_API_VERSION,
          ) as { locations: { edges: Array<{ node: { id: string; isActive: boolean } }> } };
          locIds = locData.locations.edges.filter(e => e.node.isActive).map(e => e.node.id);
        }

        const prodData = await shopifyGraphQL(
          `query getProductVariants($id: ID!) {
            product(id: $id) {
              id
              title
              variants(first: 100) {
                edges {
                  node {
                    id
                    inventoryItem { id }
                  }
                }
              }
            }
          }`,
          { id: productGid },
          storeUrl,
          accessToken,
          WRITE_API_VERSION,
        ) as {
          product: {
            id: string;
            title: string;
            variants: { edges: Array<{ node: { id: string; inventoryItem: { id: string } } }> };
          } | null;
        };

        if (!prodData.product) {
          return {
            content: [{ type: 'text' as const, text: `Produto nao encontrado: ${productGid}` }],
            isError: true,
          };
        }

        const inventoryItemIds = prodData.product.variants.edges.map(e => e.node.inventoryItem.id);

        const publishGql = `
          mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
            publishablePublish(id: $id, input: $input) {
              publishable { ... on Product { id } }
              userErrors { field message }
            }
          }
        `;
        const publishRes = await shopifyGraphQL(
          publishGql,
          { id: productGid, input: pubIds.map(pid => ({ publicationId: pid })) },
          storeUrl,
          accessToken,
          WRITE_API_VERSION,
        ) as { publishablePublish: { userErrors: Array<{ field: string[]; message: string }> } };

        const publishErrors = publishRes.publishablePublish.userErrors;

        const activateGql = `
          mutation inventoryActivate($inventoryItemId: ID!, $locationId: ID!) {
            inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
              inventoryLevel { id }
              userErrors { field message }
            }
          }
        `;
        const activateErrors: Array<{ inventoryItemId: string; locationId: string; message: string }> = [];
        let activatedCount = 0;
        for (const invId of inventoryItemIds) {
          for (const locId of locIds) {
            try {
              const res = await shopifyGraphQL(
                activateGql,
                { inventoryItemId: invId, locationId: locId },
                storeUrl,
                accessToken,
                WRITE_API_VERSION,
              ) as { inventoryActivate: { userErrors: Array<{ field: string[]; message: string }> } };
              const errs = res.inventoryActivate.userErrors;
              if (errs.length > 0) {
                for (const err of errs) {
                  if (!err.message.toLowerCase().includes('already')) {
                    activateErrors.push({ inventoryItemId: invId, locationId: locId, message: err.message });
                  }
                }
              } else {
                activatedCount++;
              }
            } catch (e) {
              activateErrors.push({
                inventoryItemId: invId,
                locationId: locId,
                message: e instanceof Error ? e.message : String(e),
              });
            }
          }
        }

        const defaultQty = typeof a.default_quantity === 'number' ? (a.default_quantity as number) : undefined;
        let quantitiesSet = 0;
        const quantityErrors: Array<{ inventoryItemId: string; locationId: string; message: string }> = [];

        if (defaultQty !== undefined) {
          const setQtyGql = `
            mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
              inventorySetQuantities(input: $input) {
                userErrors { field message }
              }
            }
          `;
          const quantities = inventoryItemIds.flatMap(invId =>
            locIds!.map(locId => ({ inventoryItemId: invId, locationId: locId, quantity: defaultQty }))
          );
          try {
            const res = await shopifyGraphQL(
              setQtyGql,
              {
                input: {
                  name: 'available',
                  reason: 'correction',
                  ignoreCompareQuantity: true,
                  quantities,
                },
              },
              storeUrl,
              accessToken,
              WRITE_API_VERSION,
            ) as { inventorySetQuantities: { userErrors: Array<{ field: string[]; message: string }> } };
            const errs = res.inventorySetQuantities.userErrors;
            if (errs.length > 0) {
              for (const err of errs) {
                quantityErrors.push({ inventoryItemId: '', locationId: '', message: err.message });
              }
            } else {
              quantitiesSet = quantities.length;
            }
          } catch (e) {
            quantityErrors.push({
              inventoryItemId: '',
              locationId: '',
              message: e instanceof Error ? e.message : String(e),
            });
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              product_id: productGid,
              product_title: prodData.product.title,
              publications: { total: pubIds.length, errors: publishErrors },
              inventory: {
                variants: inventoryItemIds.length,
                locations: locIds.length,
                activated: activatedCount,
                errors: activateErrors,
              },
              quantities: defaultQty !== undefined ? {
                default_quantity: defaultQty,
                set_count: quantitiesSet,
                errors: quantityErrors,
              } : null,
            }, null, 2),
          }],
        };
      }

      case 'analytics_query': {
        const shopifyqlQuery = a.query as string;

        const gql = `
          query analyticsQuery($query: String!) {
            shopifyqlQuery(query: $query) {
              __typename
              tableData {
                columns {
                  name
                  dataType
                  displayName
                }
                rows
              }
              parseErrors
            }
          }
        `;

        const data = await shopifyGraphQL(gql, { query: shopifyqlQuery }, storeUrl, accessToken, ANALYTICS_API_VERSION) as {
          shopifyqlQuery: {
            __typename: string;
            tableData?: {
              columns: Array<{ name: string; dataType: string; displayName: string }>;
              rows: Record<string, string>[];
            };
            parseErrors?: string;
          };
        };

        const result = data.shopifyqlQuery;

        const parsedErrors = result.parseErrors && result.parseErrors !== 'null' && result.parseErrors !== '[]'
          ? (() => { try { return JSON.parse(result.parseErrors!); } catch { return result.parseErrors; } })()
          : null;
        if (parsedErrors && (Array.isArray(parsedErrors) ? parsedErrors.length > 0 : true)) {
          return {
            content: [{
              type: 'text' as const,
              text: `Erro na query ShopifyQL: ${JSON.stringify(parsedErrors)}\n\nDica: Use "FROM sales SHOW total_sales GROUP BY month SINCE -1y" como referencia.`,
            }],
            isError: true,
          };
        }

        if (result.tableData) {
          const { columns, rows: rawRows } = result.tableData;
          const headers = columns.map(c => c.displayName || c.name);

          let rows: Record<string, string>[] = [];
          if (Array.isArray(rawRows) && rawRows.length > 0) {
            rows = rawRows.map(row => {
              const obj: Record<string, string> = {};
              columns.forEach(col => { obj[col.displayName || col.name] = row[col.name]; });
              return obj;
            });
          }

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                tipo: 'tabela',
                colunas: headers,
                total_linhas: rows.length,
                dados: rows,
              }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
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
      content: [
        { type: 'text' as const, text: `Erro Shopify: ${(err as Error).message}` },
      ],
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
