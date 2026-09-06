---
name: ui-premium-veo3
description: Constrói websites e interfaces premium do zero com código React/Next.js/Tailwind. Use quando o usuário quiser criar um site, landing page, componente ou interface visual de alto nível. Inclui todos os padrões de design premium, regras anti-genérico, física de animação e suporte a vídeos em loop (Veo3). Escolhe automaticamente a estética correta baseado no briefing.
category: UI & Design
---

# Skill: UI Premium — Construtor de Sites com Vídeo

## Quando usar esta skill
- Usuário quer criar um site, landing page ou componente visual
- Usuário menciona Veo3, vídeos animados, background em vídeo
- Usuário pede um design premium, moderno ou "top"
- Usuário quer fazer o design junto, iterando em conversa

---

## PASSO 0 — IDENTIFICAR ESTÉTICA

Antes de escrever código, identifique qual estética o usuário quer:

| Usuário descreve | Estética a usar |
|---|---|
| Moderno, clean, premium, SaaS, tech | **Taste** — assimétrico, física de mola, tipografia forte |
| Suave, luxo, agência, caro | **Soft** — duplo bezel, vidro, cinematográfico |
| Minimalista, editorial, Notion-like | **Minimalist** — monocromático, sem gradiente, Serif editorial |
| Brutal, raw, dashboard denso, terminal | **Brutalist** — grid rígido, sem border-radius, monoespaçado |
| Redesign de projeto existente | **Redesign** — auditoria + upgrade sem reescrever stack |

**Se não ficou claro:** pergunte em uma linha antes de começar.

---

## CONFIGURAÇÃO ATIVA (padrão Taste)

```
DESIGN_VARIANCE: 8    // 1=simétrico | 10=caótico assimétrico
MOTION_INTENSITY: 6   // 1=estático | 10=cinematográfico
VISUAL_DENSITY: 4     // 1=galeria arejada | 10=cockpit denso
```

Adapte esses valores dinamicamente com base no que o usuário pede.

---

## REGRAS DE ARQUITETURA

**Stack padrão:** Next.js + Tailwind CSS v3 + Framer Motion
**Verificação obrigatória:** antes de importar qualquer lib, checar `package.json`. Fornecer `npm install` se faltar.
**Server Components:** padrão RSC. Componentes interativos isolados com `'use client'`.
**Altura total:** sempre `min-h-[100dvh]` — nunca `h-screen` (bug iOS Safari).
**Grid sobre Flex math:** nunca `calc(33% - 1rem)`. Sempre CSS Grid.
**Ícones:** `@phosphor-icons/react` ou `@radix-ui/react-icons`. Stroke padronizado (`1.5` ou `2.0`).

---

## INTEGRAÇÃO COM VÍDEOs VEO3

Quando o usuário tiver vídeos do Veo3:

```tsx
// Vídeo como background de seção
<section className="relative min-h-[100dvh] overflow-hidden">
  <video
    autoPlay
    loop
    muted
    playsInline
    className="absolute inset-0 w-full h-full object-cover"
  >
    <source src="/videos/hero.mp4" type="video/mp4" />
  </video>
  {/* Overlay para legibilidade do texto */}
  <div className="absolute inset-0 bg-black/40" />
  {/* Conteúdo */}
  <div className="relative z-10 ...">...</div>
</section>

// Vídeo como elemento de feature (card com vídeo)
<div className="rounded-[2.5rem] overflow-hidden aspect-video">
  <video autoPlay loop muted playsInline className="w-full h-full object-cover">
    <source src="/videos/feature-demo.mp4" type="video/mp4" />
  </video>
</div>
```

**Boas práticas com Veo3:**
- Sempre `muted` + `playsInline` para autoplay funcionar no mobile
- Overlay sutil (`bg-black/30` a `bg-black/60`) quando o vídeo for background de texto
- Para múltiplos vídeos: lazy load com `IntersectionObserver` para não travar a página
- Formatos: `.mp4` (H.264) para compatibilidade máxima

---

## PADRÕES PROIBIDOS (Anti-Mediocridade)

### Visual
- ❌ Fonte `Inter` — use `Geist`, `Outfit`, `Cabinet Grotesk` ou `Satoshi`
- ❌ Preto puro `#000000` — use `#0a0a0a`, `zinc-950` ou carvão
- ❌ Gradiente neon roxo/azul — a estética "IA genérica"
- ❌ `box-shadow` padrão escuro — matize a sombra com a cor do fundo
- ❌ Emojis em qualquer lugar do código ou UI

### Layout
- ❌ 3 cards iguais em linha horizontal como feature row
- ❌ Hero centralizado (quando DESIGN_VARIANCE > 4)
- ❌ `h-screen` — sempre `min-h-[100dvh]`
- ❌ Flexbox math complexo — use CSS Grid

### Conteúdo
- ❌ "João da Silva", "Empresa X", "Acme Corp"
- ❌ `99,99%`, `50%`, números redondos demais
- ❌ "Eleve", "Fluido", "Libere", "Próxima Geração", "Revolucione"
- ❌ Links Unsplash — use `picsum.photos/seed/{id}/800/600`

---

## ESTADOS OBRIGATÓRIOS

Todo componente interativo DEVE ter:
- **Loading:** skeleton que espelha o shape do layout (não spinner genérico)
- **Empty:** composição orientando o usuário
- **Error:** mensagem inline direta ("Conexão falhou. Tente novamente.")
- **Active/Hover:** feedback tátil — `scale(0.98)` ou `-translateY(1px)` no `:active`

---

## FÍSICA DE ANIMAÇÃO

Sempre que usar animação:
```js
// Mola padrão — sensação pesada e premium
type: "spring", stiffness: 100, damping: 20

// Cubic-bezier para CSS puro
transition: all 700ms cubic-bezier(0.32, 0.72, 0, 1)
```

- `transform` e `opacity` apenas — nunca `top`, `left`, `width`, `height`
- `backdrop-blur` apenas em elementos `fixed` ou `sticky`
- Micro-loops infinitos isolados em Client Components com `React.memo`

---

## MODO ITERATIVO (construção em conversa)

Quando o usuário estiver construindo o site junto, seção por seção:

1. **Perguntar antes de gerar:** "Qual seção fazemos primeiro? Hero, Features, CTA?"
2. **Uma seção por vez:** gerar completa, pedir feedback, iterar
3. **Manter consistência:** lembrar paleta, fontes e variância definidas na sessão
4. **Slots para vídeo:** quando o usuário ainda não tiver o vídeo, usar placeholder com aspect-ratio correto e indicar onde plugar o arquivo
5. **Output sempre completo:** sem `// ... resto do código`, sem truncamento

---

## CHECKLIST PRÉ-OUTPUT

Antes de entregar qualquer código:
- [ ] Nenhum padrão proibido presente
- [ ] `min-h-[100dvh]` em todas as seções de altura total
- [ ] Dependências verificadas (sem imports fantasma)
- [ ] Colapso mobile garantido (`w-full`, `px-4`, `grid-cols-1` abaixo de 768px)
- [ ] Vídeos com `autoPlay loop muted playsInline`
- [ ] Animações apenas com `transform` e `opacity`
- [ ] Código 100% completo — sem placeholder, sem truncamento
