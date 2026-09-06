---
name: stitch-design-taste
description: Skill de Sistema de Design Semântico para o Google Stitch. Gera arquivos DESIGN.md compatíveis com agentes que impõem padrões de UI premium e anti-genéricos — tipografia estrita, cor calibrada, layouts assimétricos, micro-movimento perpétuo e performance acelerada por hardware.
category: UI & Design
---

# Stitch Design Taste — Skill de Sistema de Design Semântico

## Visão Geral
Esta skill gera arquivos `DESIGN.md` otimizados para geração de telas do Google Stitch. Traduz as diretivas de engenharia frontend anti-mediocridade já testadas na linguagem de design semântica nativa do Stitch — regras descritivas em linguagem natural pareadas com valores precisos que o agente de IA do Stitch pode interpretar para produzir interfaces premium e não genéricas.

O `DESIGN.md` gerado serve como a **única fonte de verdade** para fazer o prompt do Stitch gerar novas telas que se alinhem com uma linguagem de design curada e de alta agência. O Stitch interpreta o design por meio de **"Descrições Visuais"** suportadas por valores específicos de cor, especificações de tipografia e comportamentos de componentes.

## Pré-requisitos
- Acesso ao Google Stitch via [labs.google.com/stitch](https://labs.google.com/stitch)
- Opcionalmente: Servidor MCP do Stitch para integração programática com Cursor, Antigravity ou Gemini CLI

## O Objetivo
Gerar um arquivo `DESIGN.md` que codifique:
1. **Atmosfera visual** — o humor, densidade e filosofia de design
2. **Calibração de cores** — neutros, acentos e padrões proibidos com códigos hex
3. **Arquitetura tipográfica** — stacks de fontes, hierarquia de escala e anti-padrões
4. **Comportamentos de componentes** — botões, cards, inputs com estados de interação
5. **Princípios de layout** — sistemas de grid, filosofia de espaçamento, estratégia responsiva
6. **Filosofia de movimento** — especificações do motor de animação, física de mola, micro-interações perpétuas
7. **Anti-padrões** — lista explícita de clichês de design de IA proibidos

## Instruções de Análise & Síntese

### 1. Definir a Atmosfera
Avalie a intenção do projeto alvo. Use adjetivos evocativos do espectro de gosto:
- **Densidade:** "Arejado como Galeria" (1–3) → "Diário App Equilibrado" (4–7) → "Denso como Cockpit" (8–10)
- **Variância:** "Simétrico Previsível" (1–3) → "Assimétrico Deslocado" (4–7) → "Caótico Artístico" (8–10)
- **Movimento:** "Contido Estático" (1–3) → "CSS Fluido" (4–7) → "Coreografia Cinematográfica" (8–10)

Base padrão: Variância 8, Movimento 6, Densidade 4. Adapte dinamicamente com base na descrição de vibe do usuário.

### 2. Mapear a Paleta de Cores
Para cada cor forneça: **Nome Descritivo** + **Código Hex** + **Papel Funcional**.

**Restrições obrigatórias:**
- Máximo 1 cor de acento. Saturação abaixo de 80%
- A estética "Neon Roxo/Azul de IA" é estritamente PROIBIDA — sem brilhos roxos em botões, sem gradientes neon
- Use bases neutras absolutas (Zinc/Slate) com acentos singulares de alto contraste
- Fique com uma paleta para todo o output — sem flutuação de cinza quente/frio
- Nunca use preto puro (`#000000`) — use Off-Black, Zinc-950 ou Carvão

### 3. Estabelecer Regras de Tipografia
- **Display/Títulos:** Track apertado, escala controlada. Não gritante. Hierarquia por peso e cor, não apenas tamanho massivo
- **Corpo:** Leading relaxado, máximo 65 caracteres por linha
- **Seleção de Fonte:** `Inter` é PROIBIDO para contextos premium/criativos. Force personalidade única: `Geist`, `Outfit`, `Cabinet Grotesk` ou `Satoshi`
- **Proibição de Serif:** Fontes serif genéricas (`Times New Roman`, `Georgia`, `Garamond`, `Palatino`) são PROIBIDAS. Se serif for necessário para contextos editoriais/criativos, use apenas serifs modernos distintos: `Fraunces`, `Gambarino`, `Editorial New` ou `Instrument Serif`. Serif é sempre PROIBIDO em dashboards ou UIs de software
- **Restrição de Dashboard:** Use pareamentos Sans-Serif exclusivamente (`Geist` + `Geist Mono` ou `Satoshi` + `JetBrains Mono`)
- **Override de Alta Densidade:** Quando a densidade exceder 7, todos os números devem usar Monospace

### 4. Definir a Seção Hero
O Hero é a primeira impressão e deve ser criativo, marcante e nunca genérico:
- **Tipografia com Imagem Inline:** Incorpore pequenas fotos ou visuais contextuais diretamente entre palavras ou letras no título. As imagens ficam inline na altura do tipo, arredondadas, agindo como pontuação visual. Esta é a técnica criativa característica
- **Sem Sobreposição:** O texto nunca deve sobrepor imagens ou outro texto. Cada elemento ocupa sua própria zona espacial limpa
- **Sem Texto de Preenchimento:** "Role para explorar", "Deslize para baixo", ícones de seta de scroll, chevrons saltitantes são PROIBIDOS. O conteúdo deve puxar os usuários naturalmente
- **Estrutura Assimétrica:** Layouts de Hero centralizados PROIBIDOS quando a variância exceder 4
- **Contenção de CTA:** Máximo um CTA primário. Sem links secundários "Saiba mais"

### 5. Descrever Estilizações de Componentes
Para cada tipo de componente, descreva forma, cor, profundidade de sombra e comportamento de interação:
- **Botões:** Feedback de pressão tátil no estado ativo. Sem brilhos neon externos. Sem cursores de mouse personalizados
- **Cards:** Use APENAS quando a elevação comunica hierarquia. Matize sombras para a matiz do fundo. Para layouts de alta densidade, substitua cards por divisores border-top ou espaço negativo
- **Inputs/Formulários:** Rótulo acima do input, texto auxiliar opcional, texto de erro abaixo. Espaçamento de gap padrão
- **Estados de Carregamento:** Loaders esqueletais correspondendo às dimensões do layout — sem spinners circulares genéricos
- **Estados Vazios:** Composições ilustradas indicando como popular os dados
- **Estados de Erro:** Relatório de erro claro e inline

### 6. Definir Princípios de Layout
- Sem elementos sobrepostos — cada elemento ocupa sua própria zona espacial clara. Sem empilhamento de conteúdo por posicionamento absoluto
- Seções Hero centralizadas são PROIBIDAS quando a variância exceder 4 — force Tela Dividida, Alinhado à Esquerda ou Espaço em Branco Assimétrico
- O grid genérico de "3 cards iguais horizontalmente" é PROIBIDO — use Zig-Zag de 2 colunas, grid assimétrico ou scroll horizontal
- CSS Grid sobre matemática Flexbox — nunca use hacks de porcentagem com `calc()`
- Contenha layouts usando restrições de largura máxima (ex: 1400px centralizado)
- Seções de altura total devem usar `min-h-[100dvh]` — nunca `h-screen` (salto catastrófico do iOS Safari)

### 7. Definir Regras Responsivas
Todo design deve funcionar em todos os viewports:
- **Colapso Mobile-First (< 768px):** Todos os layouts de múltiplas colunas colapsam para coluna única. Sem exceções
- **Sem Scroll Horizontal:** Overflow horizontal no mobile é falha crítica
- **Escala Tipográfica:** Títulos escalam via `clamp()`. Texto do corpo mínimo `1rem`/`14px`
- **Alvos de Toque:** Todos os elementos interativos mínimo de `44px` de alvo de toque
- **Comportamento de Imagens:** Imagens de tipografia inline (fotos entre palavras) empilham abaixo do título no mobile
- **Navegação:** Nav horizontal desktop colapsa para menu mobile limpo
- **Espaçamento:** Lacunas de seção vertical reduzem proporcionalmente (`clamp(3rem, 8vw, 6rem)`)

### 8. Codificar Filosofia de Movimento
- **Padrão de Física de Mola:** `stiffness: 100, damping: 20` — sensação premium e pesada. Sem easing linear
- **Micro-Interações Perpétuas:** Todo componente ativo deve ter um estado de loop infinito (Pulso, Máquina de Escrever, Flutuação, Shimmer)
- **Orquestração Escalonada:** Nunca monte listas instantaneamente — use atrasos em cascata para revelações em cascata
- **Performance:** Anime exclusivamente via `transform` e `opacity`. Nunca anime `top`, `left`, `width`, `height`. Filtros de grão/ruído em pseudo-elementos fixos apenas

### 9. Listar Anti-Padrões (Sinais de IA)
Codifique-os como regras explícitas "NUNCA FAÇA" no DESIGN.md:
- Sem emojis em qualquer lugar
- Sem fonte `Inter`
- Sem fontes serif genéricas (`Times New Roman`, `Georgia`, `Garamond`) — apenas serifs modernos distintos se necessário
- Sem preto puro (`#000000`)
- Sem brilhos neon/externos
- Sem acentos supersaturados
- Sem texto de gradiente excessivo em cabeçalhos grandes
- Sem cursores de mouse personalizados
- Sem elementos sobrepostos — separação espacial limpa sempre
- Sem layouts de cards de 3 colunas iguais
- Sem nomes genéricos ("João Silva", "Empresa X", "Nexus")
- Sem números redondos falsos (`99,99%`, `50%`)
- Sem clichês de copywriting de IA ("Eleve", "Fluido", "Libere", "Próxima Geração")
- Sem texto de UI de preenchimento: "Role para explorar", "Deslize para baixo", setas de scroll, chevrons saltitantes
- Sem links Unsplash quebrados — use `picsum.photos` ou SVG avatars
- Sem seções Hero centralizadas (para projetos de alta variância)

## Formato de Output (Estrutura do DESIGN.md)

```markdown
# Sistema de Design: [Título do Projeto]

## 1. Tema Visual & Atmosfera
(Descrição evocativa do humor, densidade, variância e intensidade de movimento.)

## 2. Paleta de Cores & Papéis
- **Nome Descritivo** (#HEXHEX) — Papel funcional
(Máx. 1 acento. Saturação < 80%. Sem roxo/neon.)

## 3. Regras de Tipografia
- **Display:** [Nome da Fonte] — Track apertado, escala controlada, hierarquia por peso
- **Corpo:** [Nome da Fonte] — Leading relaxado, largura máx. 65ch, cor secundária neutra
- **Mono:** [Nome da Fonte] — Para código, metadados, timestamps, números de alta densidade
- **Proibido:** Inter, fontes de sistema genéricas para contextos premium. Fontes serif proibidas em dashboards.

## 4. Estilizações de Componentes
* **Botões:** Plano, sem brilho externo. Pressão tátil de -1px no ativo. Preenchimento de acento para primário, fantasma/contorno para secundário.
* **Cards:** Cantos generosamente arredondados (2.5rem). Sombra sussurro difusa. Usados apenas quando elevação serve à hierarquia.
* **Inputs:** Rótulo acima, erro abaixo. Anel de foco na cor de acento. Sem rótulos flutuantes.
* **Loaders:** Shimmer esquelético correspondendo às dimensões exatas do layout. Sem spinners circulares.
* **Estados Vazios:** Composições ilustradas — não apenas texto "Sem dados".

## 5. Princípios de Layout
(Arquitetura responsiva com grid primeiro. Splits assimétricos para seções Hero.
Colapso estrito para coluna única abaixo de 768px. Contenção de largura máxima.)

## 6. Movimento & Interação
(Física de mola para todos os elementos interativos. Revelações em cascata escalonadas.
Micro-loops perpétuos em componentes de dashboard ativos. Apenas transforms acelerados por hardware.)

## 7. Anti-Padrões (Proibidos)
(Lista explícita de padrões proibidos: sem emojis, sem Inter, sem preto puro,
sem brilhos neon, sem grids de 3 colunas iguais, sem clichês de copywriting de IA,
sem nomes de placeholder genéricos, sem links de imagem quebrados.)
```

## Melhores Práticas
- **Seja Descritivo:** "Tinta Carvão Profundo (#18181B)" — não apenas "texto escuro"
- **Seja Funcional:** Explique para que cada elemento é usado
- **Seja Consistente:** Mesma terminologia em todo o documento
- **Seja Preciso:** Inclua códigos hex exatos, valores rem, valores em pixels entre parênteses
- **Seja Opinativo:** Este não é um template neutro — impõe uma estética premium específica

## Dicas para o Sucesso
1. Comece com a atmosfera — entenda a vibe antes de detalhar os tokens
2. Procure padrões — identifique espaçamento, dimensionamento e estilização consistentes
3. Pense semanticamente — nomeie as cores por propósito, não apenas aparência
4. Considere a hierarquia — documente como o peso visual comunica importância
5. Codifique as proibições — os anti-padrões são tão importantes quanto as regras em si

## Armadilhas Comuns a Evitar
- Usar jargão técnico sem tradução ("rounded-xl" em vez de "cantos generosamente arredondados")
- Omitir códigos hex ou usar apenas nomes descritivos
- Esquecer os papéis funcionais dos elementos de design
- Ser muito vago nas descrições de atmosfera
- Ignorar a lista de anti-padrões — estes são o que tornam o output premium
- Recorrer a designs genéricos "seguros" em vez de impor a estética curada
