# Sistema de Design: Padrão Taste
**Skill:** stitch-design-taste

---

## Configuração — Defina Seu Estilo
Ajuste esses controles antes de usar este sistema de design. Eles controlam o quão criativo, denso e animado o output deve ser. Escolha o nível que se encaixa no seu projeto.

| Controle | Nível | Descrição |
|------|-------|-------------|
| **Criatividade** | `8` | `1` = Ultra-minimalista, suíço, silencioso, monocromático. `5` = Equilibrado, limpo mas com personalidade. `10` = Expressivo, editorial, experimentos tipográficos ousados, imagens inline em títulos, forte assimetria. Padrão: `8` |
| **Densidade** | `4` | `1` = Arejado como galeria, espaço em branco enorme. `5` = Seções equilibradas. `10` = Denso como cockpit, muito dado. Padrão: `4` |
| **Variância** | `8` | `1` = Previsível, grids simétricos. `5` = Deslocamentos sutis. `10` = Caótico artístico, nenhuma seção igual a outra. Padrão: `8` |
| **Intenção de Movimento** | `6` | `1` = Estático, sem animação. `5` = Dicas sutis de hover/entrada. `10` = Orquestração cinematográfica em cada componente. Padrão: `6` |

> **Como usar:** Mude os números acima para corresponder à vibe do seu projeto. Em **Criatividade 1–3**, o sistema produz interfaces limpas e silenciosas, estilo Notion. Em **Criatividade 7–10**, espere tipografia com imagens inline, contraste de escala dramático e layouts editoriais fortes. O restante das regras abaixo se adapta aos seus níveis escolhidos.

---

## 1. Tema Visual & Atmosfera
Uma interface arejada como galeria com layouts assimétricos confiantes e movimento com física de mola fluida. A atmosfera é clínica mas quente — como um estúdio de arquitetura bem iluminado onde cada elemento ganha seu lugar através da função. A densidade é equilibrada (Nível 4), a variância é alta (Nível 8) para prevenir tédio simétrico, e o movimento é fluido mas nunca teatral (Nível 6). A impressão geral: caro, intencional, vivo.

## 2. Paleta de Cores & Papéis
- **Branco Canvas** (#F9FAFB) — Superfície de fundo primária. Neutro-quente, nunca branco-azulado clínico
- **Superfície Pura** (#FFFFFF) — Preenchimento de card e contêiner. Usado com sombra sussurro para elevação
- **Tinta Carvão** (#18181B) — Texto primário. Profundidade Zinc-950 — nunca preto puro
- **Aço Secundário** (#71717A) — Texto do corpo, descrições, metadados. Calor do Zinc-500
- **Ardósia Suave** (#94A3B8) — Texto terciário, timestamps, estados desabilitados
- **Borda Sussurro** (rgba(226,232,240,0.5)) — Bordas de card, linhas estruturais de 1px. Semi-transparente para profundidade
- **Sombra Difusa** (rgba(0,0,0,0.05)) — Elevação de card. Ampla difusão, blur de 40px, offset de -15px. Nunca dura

### Seleção de Acento (Escolha UM por projeto)
- **Sinal Esmeralda** (#10B981) — Para crescimento, sucesso, dashboards de dados positivos
- **Azul Elétrico** (#3B82F6) — Para produtividade, SaaS, ferramentas de desenvolvedor
- **Rosa Profundo** (#E11D48) — Para projetos criativos, editoriais, voltados à moda
- **Calor Âmbar** (#F59E0B) — Para comunidade, social, produtos com tons quentes

### Cores Proibidas
- Gradientes neon roxo/violeta — a estética "IA Roxa"
- Preto puro (#000000) — sempre Off-Black ou Zinc-950
- Acentos supersaturados acima de 80% de saturação
- Sistemas mistos de cinza quente/frio no mesmo projeto

## 3. Regras de Tipografia
- **Display:** `Geist`, `Satoshi`, `Cabinet Grotesk` ou `Outfit` — Track apertado (`-0.025em`), escala fluida controlada, hierarquia orientada por peso (700–900). Não gritante. Leading comprimido (`1.1`). Alternativas forçadas — `Inter` é PROIBIDO para contextos premium
- **Corpo:** Mesma família no peso 400 — Leading relaxado (`1.65`), largura máxima de 65ch, cor Aço Secundário (#71717A)
- **Mono:** `Geist Mono` ou `JetBrains Mono` — Para blocos de código, metadados, timestamps. Quando a densidade excede Nível 7, todos os números mudam para monospace
- **Escala:** Display em `clamp(2.25rem, 5vw, 3.75rem)`. Corpo em `1rem/1.125rem`. Metadados mono em `0.8125rem`

### Fontes Proibidas
- `Inter` — proibido em todos os contextos premium/criativos
- Fontes serif genéricas (`Times New Roman`, `Georgia`, `Garamond`, `Palatino`) — PROIBIDAS. Se serif for necessário para editorial/criativo, use apenas serifs modernos distintos como `Fraunces`, `Gambarino`, `Editorial New` ou `Instrument Serif`. Serif é sempre PROIBIDO em dashboards ou UIs de software

## 4. Estilizações de Componentes
* **Botões:** Superfície plana, sem brilho externo. Primário: preenchimento de acento com texto branco. Secundário: fantasma/contorno. Estado ativo: `-1px translateY` ou `scale(0.98)` para pressão tátil. Hover: mudança sutil de fundo, nunca brilho
* **Cards/Contêineres:** Cantos generosamente arredondados (`2.5rem`). Preenchimento branco puro. Borda sussurro (`1px`, semi-transparente). Sombra difusa (`0 20px 40px -15px rgba(0,0,0,0.05)`). Padding interno `2rem–2.5rem`. Usado APENAS quando a elevação comunica hierarquia — layouts de alta densidade substituem cards por divisores `border-top` ou espaço negativo
* **Inputs/Formulários:** Rótulo posicionado acima do input. Texto auxiliar opcional. Texto de erro abaixo em Rosa Profundo. Anel de foco na cor de acento, offset de `2px`. Sem rótulos flutuantes. Espaçamento padrão de `0.5rem` entre a pilha rótulo-input-erro
* **Navegação:** Elegante, adesiva. Ícones escalam no hover (Magnificação de Dock opcional). Sem hambúrguer no desktop. Horizontal limpo com espaçamento generoso
* **Loaders:** Shimmer esquelético correspondendo exatamente às dimensões e cantos arredondados do layout. Reflexo de luz deslizante em formas de placeholder. Nunca spinners circulares
* **Estados Vazios:** Composição de ilustração ou ícone com texto de orientação. Nunca apenas "Nenhum dado encontrado"
* **Estados de Erro:** Inline, contextual. Sublinhado ou borda de acento vermelho. Ação clara de recuperação

## 5. Seção Hero
O Hero é a primeira impressão — deve ser marcante, criativo e nunca genérico.
- **Tipografia com Imagem Inline:** Incorpore pequenas fotos ou visuais contextuais diretamente entre palavras ou letras no título. Exemplo: "Construímos [foto de mãos digitando] produtos [foto de tela] digitais" — imagens ficam inline na altura do tipo, arredondadas, agindo como pontuação visual entre palavras. Esta é a técnica criativa característica
- **Sem Elementos Sobrepostos:** O texto nunca deve sobrepor imagens ou outro texto. Cada elemento tem sua própria zona espacial clara. Sem camadas de z-index de conteúdo, sem títulos posicionados absolutamente sobre imagens. Separação limpa sempre
- **Sem Texto de Preenchimento:** "Role para explorar", "Deslize para baixo", ícones de seta de scroll, chevrons saltitantes e qualquer chrome de UI instrucional são PROIBIDOS. O usuário sabe como rolar. Deixe o conteúdo puxá-los naturalmente
- **Estrutura Assimétrica:** Layouts de Hero centralizados são PROIBIDOS neste nível de variância. Use Tela Dividida (50/50), texto Alinhado à Esquerda / visual à direita, ou Espaço em Branco Assimétrico com grandes zonas vazias
- **Contenção de CTA:** Máximo um botão CTA primário. Sem links secundários "Saiba mais". Sem micro-copy redundante abaixo do título

## 6. Princípios de Layout
- **Grid Primeiro:** CSS Grid para todos os layouts estruturais. Nunca matemática de porcentagem flexbox (`calc(33% - 1rem)` é PROIBIDO)
- **Sem Sobreposição:** Os elementos nunca devem se sobrepor. Sem camadas posicionadas absolutamente empilhando conteúdo. Cada elemento ocupa sua própria célula de grid ou posição de fluxo. Zonas espaciais limpas e separadas
- **Seções de Features:** O padrão "3 cards iguais em linha" é PROIBIDO. Use Zig-Zag de 2 colunas, grids Bento assimétricos (2fr 1fr 1fr) ou galerias de scroll horizontal
- **Contenção:** Todo conteúdo dentro de `max-width: 1400px`, centralizado. Padding horizontal generoso (`1rem` mobile, `2rem` tablet, `4rem` desktop)
- **Altura Total:** Use `min-height: 100dvh` — nunca `height: 100vh` (salto da barra de endereço do iOS Safari)
- **Arquitetura Bento:** Para grids de features, use Linha 1: 3 colunas | Linha 2: 2 colunas (divisão 70/30). Cada tile contém uma micro-animação perpétua

## 7. Regras Responsivas
Cada tela deve funcionar perfeitamente em todos os viewports. **Responsivo não é opcional — é um requisito difícil. Cada elemento deve ser testado em 375px, 768px e 1440px.**
- **Colapso Mobile-First (< 768px):** Todos os layouts de múltiplas colunas colapsam para uma única coluna estrita. `width: 100%`, `padding: 1rem`, `gap: 1.5rem`. Sem exceções
- **Sem Scroll Horizontal:** Overflow horizontal no mobile é uma falha crítica. Todos os elementos devem caber dentro da largura do viewport
- **Escala Tipográfica:** Os títulos escalam para baixo graciosamente via `clamp()`. O texto do corpo fica em `1rem` mínimo. Nunca reduza o corpo abaixo de `14px`
- **Alvos de Toque:** Todos os elementos interativos mínimo de `44px` de alvo de toque. Espaçamento generoso entre itens clicáveis. Botões devem ser de largura total no mobile
- **Comportamento de Imagens:** Imagens hero e inline escalam proporcionalmente. Imagens de tipografia inline (fotos entre palavras) empilham abaixo do título no mobile em vez de inline
- **Navegação:** Nav horizontal desktop colapsa para menu mobile limpo (slide-in ou sobreposição de tela cheia)
- **Cards & Grids:** Grids bento e layouts assimétricos revertem para cards de coluna única empilhados em largura total
- **Consistência de Espaçamento:** As lacunas de seção vertical reduzem proporcionalmente no mobile (`clamp(3rem, 8vw, 6rem)`)
- **Viewports de Teste:** Os designs devem ser verificados em: `375px` (iPhone SE), `390px` (iPhone 14), `768px` (iPad), `1024px` (laptop pequeno), `1440px` (desktop)

## 8. Movimento & Interação (Intenção de Fase de Código)
> **Nota:** O Stitch gera telas estáticas — ele não anima. Esta seção documenta o **comportamento de movimento pretendido** para que o agente de codificação (Antigravity, Cursor, etc.) saiba exatamente como implementar as animações ao construir o design exportado em um produto ao vivo.

- **Motor de Física:** Baseado em mola exclusivamente. `stiffness: 100, damping: 20`. Sem easing linear em lugar nenhum. Sensação premium e pesada em todos os elementos interativos
- **Micro-Loops Perpétuos:** Todo componente de dashboard ativo tem um estado de loop infinito — Pulso em pontos de status, Máquina de Escrever em barras de busca, Flutuação em ícones de features, Shimmer em estados de carregamento
- **Orquestração Escalonada:** Listas e grids montam com atrasos em cascata (`animation-delay: calc(var(--index) * 100ms)`). Revelações em cascata, nunca montagem instantânea
- **Transições de Layout:** Reordenação suave via IDs de elemento compartilhados. Os itens trocam posições com física, simulando inteligência em tempo real
- **Regras de Hardware:** Anime APENAS `transform` e `opacity`. Nunca `top`, `left`, `width`, `height`. Filtros de grão/ruído em pseudo-elementos fixos com pointer-events-none apenas
- **Performance:** Animações perpétuas pesadas para CPU isoladas em componentes folha microscópicos. Nunca dispare re-renders do pai. Mínimo de 60fps como alvo

## 9. Anti-Padrões (Proibidos)
- Sem emojis — em qualquer lugar na UI, código ou alt text
- Sem fonte `Inter` — use `Geist`, `Outfit`, `Cabinet Grotesk`, `Satoshi`
- Sem fontes serif genéricas (`Times New Roman`, `Georgia`, `Garamond`) — se serif for necessário, use apenas serifs modernos distintos (`Fraunces`, `Instrument Serif`)
- Sem preto puro (`#000000`) — Off-Black ou Zinc-950 apenas
- Sem brilhos neon externos ou glows de box-shadow padrão
- Sem cores de acento supersaturadas acima de 80%
- Sem texto de gradiente excessivo em cabeçalhos grandes
- Sem cursores de mouse personalizados
- Sem elementos sobrepostos — texto nunca sobrepõe imagens ou outro conteúdo. Separação espacial limpa sempre
- Sem layouts de cards de 3 colunas iguais para features
- Sem seções Hero centralizadas (neste nível de variância)
- Sem texto de UI de preenchimento: "Role para explorar", "Deslize para baixo", "Descubra mais abaixo", setas de scroll, chevrons saltitantes — todos PROIBIDOS
- Sem nomes genéricos: "João Silva", "Maria Souza", "Empresa X", "Nexus", "SmartFlow"
- Sem números redondos falsos: `99,99%`, `50%`, `1234567` — use dados orgânicos: `47,2%`, `(11) 98472-1928`
- Sem clichês de copywriting de IA: "Eleve", "Fluido", "Libere", "Próxima Geração", "Revolucionize"
- Sem links Unsplash quebrados — use `picsum.photos/seed/{id}/800/600` ou SVG UI Avatars
- Sem padrões genéricos de `shadcn/ui` — personalize raios, cores, sombras para corresponder a este sistema
- Sem spam de `z-index` — use apenas para contextos de camada de Navbar, Modal, Sobreposição
- Sem `h-screen` — sempre `min-h-[100dvh]`
- Sem spinners de carregamento circulares — apenas shimmer esquelético
