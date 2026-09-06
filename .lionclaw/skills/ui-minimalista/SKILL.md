---
name: ui-minimalista
description: Interfaces editoriais limpas. Paleta monocromática quente, contraste tipográfico, grids bento planos, pastéis suaves. Sem gradientes, sem sombras pesadas.
category: UI & Design
---

# Protocolo: Arquiteto de UI Minimalista Premium Utilitário

## 1. Visão Geral do Protocolo
Nome: UI Minimalista Premium Utilitário & Editorial
Descrição: Uma diretiva avançada de engenharia frontend para gerar interfaces web altamente refinadas, ultra-minimalistas, no estilo "documento", análogas às melhores plataformas de workspace. Este protocolo impõe estritamente uma paleta monocromática quente de alto contraste, hierarquias tipográficas personalizadas, macro-espaçamento estrutural meticuloso, layouts de bento-grid e uma arquitetura de componentes ultra-plana com acentos pastel suaves e deliberados. Rejeita ativamente as tendências genéricas de design SaaS.

## 2. Restrições Negativas Absolutas (Elementos Proibidos)
A IA deve evitar estritamente os seguintes padrões genéricos de desenvolvimento web:
- NÃO use as fontes "Inter", "Roboto" ou "Open Sans".
- NÃO use bibliotecas de ícones genéricas de linha fina como "Lucide", "Feather" ou "Heroicons" padrão.
- NÃO use sombras pesadas padrão do Tailwind (ex: `shadow-md`, `shadow-lg`, `shadow-xl`). As sombras devem ser praticamente inexistentes ou altamente personalizadas para serem ultra-difusas e de baixa opacidade (< 0,05).
- NÃO use fundos de cor primária para elementos ou seções grandes (ex: sem hero sections em azul brilhante, verde ou vermelho).
- NÃO use gradientes, cores neon ou glassmorphism 3D (além de borrões sutis em navbars).
- NÃO use `rounded-full` (formatos pílula) para contêineres grandes, cards ou botões primários.
- NÃO use emojis em nenhum lugar do código, marcação, conteúdo de texto, títulos ou texto alternativo. Substitua por ícones adequados ou primitivos SVG limpos.
- NÃO use nomes de placeholder genéricos como "João Silva", "Empresa X" ou "Lorem Ipsum". Use conteúdo realista e contextual.
- NÃO use clichês de copywriting de IA: "Eleve", "Fluido", "Libere", "Próxima Geração", "Revolucionário", "Mergulhe". Escreva linguagem simples e específica.

## 3. Arquitetura Tipográfica
A interface deve depender de contraste tipográfico extremo e seleção de fontes premium para estabelecer uma sensação editorial.
- Sans-Serif Principal (Corpo, UI, Botões): Use fontes geométricas limpas ou nativas do sistema com personalidade. Alvo: `font-family: 'SF Pro Display', 'Geist Sans', 'Helvetica Neue', 'Switzer', sans-serif`.
- Serif Editorial (Títulos Hero & Citações): Alvo: `font-family: 'Lyon Text', 'Newsreader', 'Playfair Display', 'Instrument Serif', serif`. Aplique tracking apertado (`letter-spacing: -0.02em` a `-0.04em`) e line-height apertado (`1.1`).
- Monospace (Código, Teclas, Metadados): Alvo: `font-family: 'Geist Mono', 'SF Mono', 'JetBrains Mono', monospace`.
- Cores de Texto: O texto do corpo nunca deve ser preto absoluto (`#000000`). Use off-black/carvão (`#111111` ou `#2F3437`) com `line-height` generoso de `1.6` para legibilidade. O texto secundário deve ser cinza suave (`#787774`).

## 4. Paleta de Cores (Monocromático Quente + Pastéis Pontuais)
A cor é um recurso escasso, utilizado apenas para significado semântico ou acentos sutis.
- Tela / Fundo: Branco puro `#FFFFFF` ou Creme/Off-White Quente `#F7F6F3` / `#FBFBFA`.
- Superfície Primária (Cards): `#FFFFFF` ou `#F9F9F8`.
- Bordas Estruturais / Divisores: Cinza ultra-claro `#EAEAEA` ou `rgba(0,0,0,0.06)`.
- Cores de Acento: Use exclusivamente pastéis altamente dessaturados e desbotados para tags, fundos de código inline ou fundos sutis de ícones.
  - Vermelho Pálido: `#FDEBEC` (Texto: `#9F2F2D`)
  - Azul Pálido: `#E1F3FE` (Texto: `#1F6C9F`)
  - Verde Pálido: `#EDF3EC` (Texto: `#346538`)
  - Amarelo Pálido: `#FBF3DB` (Texto: `#956400`)

## 5. Especificações de Componentes
- Grids de Features em Bento Box:
  - Utilize layouts CSS Grid assimétricos.
  - Os cards devem ter exatamente `border: 1px solid #EAEAEA`.
  - O border-radius deve ser nítido: máximo `8px` ou `12px`.
  - O padding interno deve ser generoso (ex: `24px` a `40px`).
- Call-To-Action Principal (Botões):
  - Fundo sólido `#111111`, texto `#FFFFFF`.
  - Border-radius leve (`4px` a `6px`). Sem box-shadow.
  - O estado hover deve ser uma mudança sutil de cor para `#333333` ou um micro-scale `transform: scale(0.98)`.
- Tags & Badges de Status:
  - Formato pílula (`border-radius: 9999px`), tipografia muito pequena (`text-xs`), maiúsculas com tracking amplo (`letter-spacing: 0.05em`).
  - O fundo deve usar os Pastéis Suaves definidos.
- Acordeões (FAQ):
  - Remova todas as caixas de contêiner. Separe os itens apenas com `border-bottom: 1px solid #EAEAEA`.
  - Use um ícone limpo e nítido de `+` e `-` para o estado de alternância.
- Micro-UIs de Atalho de Teclado:
  - Renderize atalhos como teclas físicas usando tags `<kbd>`: `border: 1px solid #EAEAEA`, `border-radius: 4px`, `background: #F7F6F3`, usando a fonte Monospace.
- Chrome de Janela de OS Falso:
  - Ao simular software, envolva-o em um contêiner minimalista com uma barra superior branca contendo três pequenos círculos cinza claro (replicando os controles de janela do macOS).

## 6. Diretrizes de Iconografia & Imagens
- Ícones de Sistema: Use "Phosphor Icons (pesos Bold ou Fill)" ou "Radix UI Icons" para uma estética técnica e levemente mais espessa. Padronize a largura do traço em todos os ícones.
- Ilustrações: Esboços de tinta de linha contínua monocromáticos em fundo branco, com uma única forma geométrica deslocada preenchida com uma cor pastel suave.
- Fotografia: Use imagens de alta qualidade e dessaturadas com tom quente. Aplique sobreposições sutis (`opacity: 0.04` de grão quente) para integrar as fotos à paleta monocromática. Nunca use fotos de stock supersaturadas. Use placeholders confiáveis como `https://picsum.photos/seed/{contexto}/1200/800` quando ativos reais não estiverem disponíveis.
- Fundos de Hero & Seções: As seções não devem parecer vazias e planas. Use imagens de fundo sutis em largura total com opacidade muito baixa, pontos de luz radiais suaves (`radial-gradient` com tons quentes em `opacity: 0.03`), ou padrões de linhas geométricas mínimas para adicionar profundidade sem quebrar a estética limpa.

## 7. Movimento Sutil & Micro-Animações
O movimento deve parecer invisível — presente, mas nunca perturbador. O objetivo é sofisticação silenciosa, não espetáculo.
- Entrada por Scroll: Os elementos aparecem suavemente conforme entram no viewport. Use `translateY(12px)` + `opacity: 0` resolvendo em `600ms` com `cubic-bezier(0.16, 1, 0.3, 1)`. Use `IntersectionObserver`, nunca `window.addEventListener('scroll')`.
- Estados de Hover: Os cards sobem com uma mudança de sombra ultra-sutil (`box-shadow` transitando de `0 0 0` para `0 2px 8px rgba(0,0,0,0.04)` em `200ms`). Os botões respondem com `scale(0.98)` no `:active`.
- Revelações Escalonadas: Listas e itens de grid entram com um atraso em cascata (`animation-delay: calc(var(--index) * 80ms)`). Nunca monte tudo de uma vez.
- Movimento Ambiente de Fundo: Opcional. Um único blob de gradiente radial movendo-se muito lentamente (`animation-duration: 20s+`, `opacity: 0.02-0.04`) deslizando atrás de seções hero. Deve ser aplicado a uma camada `position: fixed; pointer-events: none`. Nunca em contêineres de scroll.
- Performance: Anime exclusivamente via `transform` e `opacity`. Sem propriedades que disparem layout (`top`, `left`, `width`, `height`). Use `will-change: transform` com moderação e apenas em elementos que estão animando ativamente.

## 8. Protocolo de Execução
Ao escrever código frontend (HTML, React, Tailwind, Vue) ou projetar um layout:
1. Estabeleça o macro-espaçamento primeiro. Use padding vertical enorme entre seções (ex: `py-24` ou `py-32` no Tailwind).
2. Restrinja a largura do conteúdo tipográfico principal a `max-w-4xl` ou `max-w-5xl`.
3. Aplique imediatamente a hierarquia tipográfica personalizada e as variáveis de cor monocromáticas.
4. Garanta que cada card, divisor e borda siga estritamente a regra `1px solid #EAEAEA`.
5. Adicione animações de entrada por scroll a todos os blocos de conteúdo principais.
6. Garanta que as seções tenham profundidade visual por meio de imagens, gradientes ambientes ou texturas sutis — sem fundos planos e vazios.
7. Forneça código que reflita essa estética editorial de alto nível e sem desordem nativamente, sem necessidade de ajustes manuais.
