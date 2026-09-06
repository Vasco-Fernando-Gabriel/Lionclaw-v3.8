---
name: design-taste-frontend
description: Engenheiro Sênior de UI/UX. Arquiteta interfaces digitais sobrescrevendo os vieses padrão de LLMs. Impõe regras baseadas em métricas, arquitetura estrita de componentes, aceleração de hardware CSS e engenharia de design equilibrada.
category: UI & Design
---

# Skill de Frontend de Alto Nível

## 1. CONFIGURAÇÃO BASELINE ATIVA
* DESIGN_VARIANCE: 8 (1=Simetria Perfeita, 10=Caos Artístico)
* MOTION_INTENSITY: 6 (1=Estático/Sem movimento, 10=Cinematográfico/Física Mágica)
* VISUAL_DENSITY: 4 (1=Galeria de Arte/Arejado, 10=Cockpit de Piloto/Dados Compactados)

**Instrução de IA:** O baseline padrão para todas as gerações é estritamente definido para esses valores (8, 6, 4). Não peça ao usuário para editar este arquivo. Caso contrário, SEMPRE ouça o usuário: adapte esses valores dinamicamente com base no que ele solicita explicitamente nos prompts de chat. Use esses valores de baseline (ou os substituídos pelo usuário) como suas variáveis globais para orientar a lógica específica nas Seções 3 a 7.

## 2. ARQUITETURA & CONVENÇÕES PADRÃO
A menos que o usuário especifique explicitamente um stack diferente, siga estas restrições estruturais para manter a consistência:

* **VERIFICAÇÃO DE DEPENDÊNCIA [OBRIGATÓRIA]:** Antes de importar QUALQUER biblioteca de terceiros (ex: `framer-motion`, `lucide-react`, `zustand`), você DEVE verificar o `package.json`. Se o pacote estiver faltando, você DEVE fornecer o comando de instalação (ex: `npm install nome-do-pacote`) antes de fornecer o código. **Nunca** assuma que uma biblioteca existe.
* **Framework & Interatividade:** React ou Next.js. Padrão para Server Components (`RSC`).
    * **SEGURANÇA RSC:** Estado global funciona APENAS em Client Components. No Next.js, envolva os providers em um componente `"use client"`.
    * **ISOLAMENTO DE INTERATIVIDADE:** Se as Seções 4 ou 7 (Movimento/Vidro Líquido) estiverem ativas, o componente específico de UI interativo DEVE ser extraído como um componente folha isolado com `'use client'` no topo. Server Components devem renderizar exclusivamente layouts estáticos.
* **Gerenciamento de Estado:** Use `useState`/`useReducer` local para UI isolada. Use estado global estritamente para evitar prop-drilling profundo.
* **Política de Estilização:** Use Tailwind CSS (v3/v4) para 90% da estilização.
    * **LOCK DE VERSÃO DO TAILWIND:** Verifique o `package.json` primeiro. Não use sintaxe v4 em projetos v3.
    * **GUARDA DE CONFIG T4:** Para v4, NÃO use o plugin `tailwindcss` no `postcss.config.js`. Use `@tailwindcss/postcss` ou o plugin Vite.
* **POLÍTICA ANTI-EMOJI [CRÍTICO]:** NUNCA use emojis em código, marcação, conteúdo de texto ou alt text. Substitua símbolos por ícones de alta qualidade (Radix, Phosphor) ou primitivos SVG limpos. Emojis são PROIBIDOS.
* **Responsividade & Espaçamento:**
  * Padronize breakpoints (`sm`, `md`, `lg`, `xl`).
  * Contenha layouts de página usando `max-w-[1400px] mx-auto` ou `max-w-7xl`.
  * **Estabilidade de Viewport [CRÍTICO]:** NUNCA use `h-screen` para seções Hero de altura total. SEMPRE use `min-h-[100dvh]` para evitar salto catastrófico de layout em navegadores móveis (iOS Safari).
  * **Grid sobre Matemática Flex:** NUNCA use matemática de porcentagem complexa com flexbox (`w-[calc(33%-1rem)]`). SEMPRE use CSS Grid (`grid grid-cols-1 md:grid-cols-3 gap-6`) para estruturas confiáveis.
* **Ícones:** Você DEVE usar exatamente `@phosphor-icons/react` ou `@radix-ui/react-icons` como os caminhos de importação (verifique a versão instalada). Padronize `strokeWidth` globalmente (ex: use exclusivamente `1.5` ou `2.0`).


## 3. DIRETIVAS DE ENGENHARIA DE DESIGN (Correção de Viés)
LLMs têm vieses estatísticos em relação a padrões específicos de clichê de UI. Construa proativamente interfaces premium usando estas regras elaboradas:

**Regra 1: Tipografia Determinística**
* **Display/Títulos:** Padrão para `text-4xl md:text-6xl tracking-tighter leading-none`.
    * **ANTI-MEDIOCRIDADE:** Desencoraje `Inter` para vibes "Premium" ou "Criativo". Force caráter único usando `Geist`, `Outfit`, `Cabinet Grotesk` ou `Satoshi`.
    * **REGRA DE UI TÉCNICA:** Fontes serif são estritamente PROIBIDAS para UIs de Dashboard/Software. Para esses contextos, use exclusivamente pareamentos Sans-Serif de alto nível (`Geist` + `Geist Mono` ou `Satoshi` + `JetBrains Mono`).
* **Corpo/Parágrafos:** Padrão para `text-base text-gray-600 leading-relaxed max-w-[65ch]`.

**Regra 2: Calibração de Cores**
* **Restrição:** Máximo 1 Cor de Acento. Saturação < 80%.
* **A PROIBIÇÃO DO LILÁS:** A estética "IA Roxo/Azul" é estritamente PROIBIDA. Sem brilhos roxos em botões, sem gradientes neon. Use bases neutras absolutas (Zinc/Slate) com acentos singulares de alto contraste (ex: Esmeralda, Azul Elétrico ou Rosa Profundo).
* **CONSISTÊNCIA DE CORES:** Fique com uma paleta para o output inteiro. Não flutue entre cinzas quentes e frios no mesmo projeto.

**Regra 3: Diversificação de Layout**
* **ANTI-VIÉS CENTRAL:** Seções Hero/H1 centralizadas são estritamente PROIBIDAS quando `LAYOUT_VARIANCE > 4`. Force estruturas de "Tela Dividida" (50/50), "Conteúdo Alinhado à Esquerda/Ativo Alinhado à Direita" ou "Espaço em Branco Assimétrico".

**Regra 4: Materialidade, Sombras e "Anti-Abuso de Cards"**
* **HARDENING DE DASHBOARD:** Para `VISUAL_DENSITY > 7`, contêineres de card genéricos são estritamente PROIBIDOS. Use agrupamento lógico via `border-t`, `divide-y` ou puramente espaço negativo. As métricas de dados devem respirar sem ser encaixotadas, a menos que a elevação (z-index) seja funcionalmente necessária.
* **Execução:** Use cards APENAS quando a elevação comunica hierarquia. Quando uma sombra é usada, matize-a para a matiz do fundo.

**Regra 5: Estados de UI Interativa**
* **Geração Obrigatória:** LLMs naturalmente geram estados de sucesso "estáticos". Você DEVE implementar ciclos de interação completos:
  * **Carregamento:** Skeleton loaders correspondendo aos tamanhos do layout (evite spinners circulares genéricos).
  * **Estados Vazios:** Estados vazios lindamente compostos indicando como popular os dados.
  * **Estados de Erro:** Relatório de erro claro e inline (ex: formulários).
  * **Feedback Tátil:** No `:active`, use `-translate-y-[1px]` ou `scale-[0.98]` para simular um pressionar físico indicando sucesso/ação.

**Regra 6: Padrões de Dados & Formulários**
* **Formulários:** O rótulo DEVE ficar acima do input. O texto auxiliar é opcional, mas deve existir na marcação. Texto de erro abaixo do input. Use `gap-2` padrão para blocos de input.

## 4. PROATIVIDADE CRIATIVA (Implementação Anti-Mediocridade)
Para combater ativamente designs genéricos de IA, implemente sistematicamente esses conceitos de codificação de alto nível como seu baseline:
* **Refração "Vidro Líquido":** Quando o glassmorphism for necessário, vá além do `backdrop-blur`. Adicione uma borda interna de 1px (`border-white/10`) e uma sombra interna sutil (`shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]`) para simular refração física de borda.
* **Microfísica Magnética (Se MOTION_INTENSITY > 5):** Implemente botões que se puxam levemente em direção ao cursor do mouse. **CRÍTICO:** NUNCA use `useState` do React para hover magnético ou animações contínuas. Use EXCLUSIVAMENTE `useMotionValue` e `useTransform` do Framer Motion fora do ciclo de render do React para evitar colapso de performance no mobile.
* **Micro-Interações Perpétuas:** Quando `MOTION_INTENSITY > 5`, incorpore animações contínuas e infinitas (Pulso, Máquina de Escrever, Flutuação, Shimmer, Carrossel) em componentes padrão (avatares, pontos de status, fundos). Aplique Física de Mola premium (`type: "spring", stiffness: 100, damping: 20`) a todos os elementos interativos — sem easing linear.
* **Transições de Layout:** Sempre utilize as props `layout` e `layoutId` do Framer Motion para reordenação suave, redimensionamento e transições de elemento compartilhado através de mudanças de estado.
* **Orquestração Escalonada:** Não monte listas ou grids instantaneamente. Use `staggerChildren` (Framer) ou cascata CSS (`animation-delay: calc(var(--index) * 100ms)`) para criar revelações sequenciais em cascata. **CRÍTICO:** Para `staggerChildren`, o Parent (`variants`) e os Children DEVEM residir na árvore de Client Component idêntica. Se os dados forem buscados de forma assíncrona, passe-os como props para um wrapper Motion de Parent centralizado.

## 5. PROTEÇÕES DE PERFORMANCE
* **Custo do DOM:** Aplique filtros de grão/ruído exclusivamente a pseudo-elementos fixos com pointer-event-none (ex: `fixed inset-0 z-50 pointer-events-none`) e NUNCA a contêineres de scroll para evitar repaints contínuos de GPU e degradação de performance no mobile.
* **Aceleração de Hardware:** Nunca anime `top`, `left`, `width` ou `height`. Anime exclusivamente via `transform` e `opacity`.
* **Contenção de Z-Index:** NUNCA use `z-50` ou `z-10` arbitrários sem motivo. Use z-indexes estritamente para contextos de camada sistêmicos (Navbars Adesivas, Modais, Sobreposições).

## 6. REFERÊNCIA TÉCNICA (Definições dos Controles)

### DESIGN_VARIANCE (Nível 1-10)
* **1-3 (Previsível):** Flexbox `justify-center`, grids simétricos estritos de 12 colunas, paddings iguais.
* **4-7 (Deslocado):** Use `margin-top: -2rem` sobrepondo, proporções de imagem variadas (ex: 4:3 ao lado de 16:9), cabeçalhos alinhados à esquerda sobre dados centralizados.
* **8-10 (Assimétrico):** Layouts masonry, CSS Grid com unidades fracionárias (ex: `grid-template-columns: 2fr 1fr 1fr`), zonas vazias massivas (`padding-left: 20vw`).
* **OVERRIDE MOBILE:** Para níveis 4-10, qualquer layout assimétrico acima de `md:` DEVE cair agressivamente para um layout estrito de coluna única (`w-full`, `px-4`, `py-8`) em viewports `< 768px` para evitar scroll horizontal e quebra de layout.

### MOTION_INTENSITY (Nível 1-10)
* **1-3 (Estático):** Sem animações automáticas. Apenas estados CSS `:hover` e `:active`.
* **4-7 (CSS Fluido):** Use `transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1)`. Use cascatas de `animation-delay` para entradas no carregamento. Foque estritamente em `transform` e `opacity`. Use `will-change: transform` com moderação.
* **8-10 (Coreografia Avançada):** Revelações complexas disparadas por scroll ou paralaxe. Use hooks do Framer Motion. NUNCA use `window.addEventListener('scroll')`.

### VISUAL_DENSITY (Nível 1-10)
* **1-3 (Modo Galeria de Arte):** Muito espaço em branco. Enormes lacunas entre seções. Tudo parece muito caro e limpo.
* **4-7 (Modo App do Dia a Dia):** Espaçamento normal para apps web padrão.
* **8-10 (Modo Cockpit):** Paddings minúsculos. Sem caixas de cards; apenas linhas de 1px para separar dados. Tudo está compacto. **Obrigatório:** Use Monospace (`font-mono`) para todos os números.

## 7. SINAIS DE IA (Padrões Proibidos)
Para garantir um output premium e não genérico, você DEVE estritamente evitar estas assinaturas comuns de design de IA, a menos que explicitamente solicitado:

### Visual & CSS
* **SEM Brilhos Neon/Externos:** Não use `box-shadow` padrão ou brilhos automáticos. Use bordas internas ou sombras suavemente matizadas.
* **SEM Preto Puro:** Nunca use `#000000`. Use Off-Black, Zinc-950 ou Carvão.
* **SEM Acentos Supersaturados:** Dessature os acentos para misturar elegantemente com os neutros.
* **SEM Texto Gradiente Excessivo:** Não use gradientes de preenchimento de texto para cabeçalhos grandes.
* **SEM Cursores de Mouse Personalizados:** Eles são desatualizados e arruínam a performance/acessibilidade.

### Tipografia
* **SEM Fonte Inter:** Proibida. Use `Geist`, `Outfit`, `Cabinet Grotesk` ou `Satoshi`.
* **SEM H1s Gigantes:** O primeiro título não deve gritar. Controle a hierarquia com peso e cor, não apenas escala massiva.
* **Restrições de Serif:** Use fontes Serif APENAS para designs criativos/editoriais. **NUNCA** use Serif em Dashboards limpos.

### Layout & Espaçamento
* **Alinhe & Espaçe Perfeitamente:** Garanta que padding e margens sejam matematicamente perfeitos. Evite elementos flutuantes com lacunas esquisitas.
* **SEM Layouts de 3 Cards em Coluna:** O layout genérico de "3 cards iguais horizontalmente" para features é PROIBIDO. Use Zig-Zag de 2 colunas, grid assimétrico ou abordagem de scroll horizontal.

### Conteúdo & Dados (O Efeito "João da Silva")
* **SEM Nomes Genéricos:** "João da Silva", "Maria Santos" são proibidos. Use nomes realistas e criativos.
* **SEM Avatares Genéricos:** NÃO use ícones de usuário SVG padrão de "ovo" ou Lucide para avatares. Use placeholders de fotos criativos e críveis ou estilização específica.
* **SEM Números Falsos:** Evite outputs previsíveis como `99,99%`, `50%` ou números de telefone básicos (`12345678`). Use dados orgânicos e irregulares (`47,2%`, `(11) 98472-1928`).
* **SEM Nomes de Startup Genéricos:** "Acme", "Nexus", "SmartFlow". Invente nomes de marca premium e contextuais.
* **SEM Palavras de Preenchimento:** Evite clichês de copywriting de IA como "Eleve", "Fluido", "Libere", "Próxima Geração". Use verbos concretos.

### Recursos Externos & Componentes
* **SEM Links Unsplash Quebrados:** Não use Unsplash. Use placeholders absolutos e confiáveis como `https://picsum.photos/seed/{string_aleatoria}/800/600` ou SVG UI Avatars.
* **Personalização do shadcn/ui:** Você pode usar `shadcn/ui`, mas NUNCA em seu estado padrão genérico. Você DEVE personalizar os raios, cores e sombras para corresponder à estética premium do projeto.
* **Limpeza Pronta para Produção:** O código deve ser extremamente limpo, visualmente marcante, memorável e meticulosamente refinado em cada detalhe.

## 8. O ARSENAL CRIATIVO (Inspiração de Alto Nível)
Não recorra à UI genérica. Extraia desta biblioteca de conceitos avançados para garantir que o output seja visualmente marcante e memorável. Quando apropriado, aproveite **GSAP (ScrollTrigger/Paralaxe)** para scrolltelling complexo ou **ThreeJS/WebGL** para animações 3D/Canvas. **CRÍTICO:** Nunca misture GSAP/ThreeJS com Framer Motion na mesma árvore de componentes. Use Framer Motion como padrão para interações UI/Bento. Use GSAP/ThreeJS EXCLUSIVAMENTE para scrolltelling de página completa isolado ou fundos de canvas, envoltos em blocos estritos de limpeza useEffect.

### O Paradigma Hero Padrão
* Pare de fazer texto centralizado sobre uma imagem escura. Tente seções Hero assimétricas: Texto limpo alinhado à esquerda ou à direita. O fundo deve apresentar uma imagem de alta qualidade e relevante com um desvanecer estilístico sutil.

### Navegação & Menus
* **Magnificação de Dock do Mac OS:** Barra de navegação na borda; ícones escalam fluidamente no hover.
* **Botão Magnético:** Botões que se puxam fisicamente em direção ao cursor.
* **Menu Pegajoso:** Sub-itens se desprendem do botão principal como um líquido viscoso.
* **Dynamic Island:** Um componente de UI em formato de pílula que se transforma para mostrar status/alertas.
* **Menu Radial Contextual:** Um menu circular expandindo exatamente nas coordenadas do clique.
* **Speed Dial Flutuante:** Um FAB que se expande em uma linha curva de ações secundárias.
* **Mega Menu Reveal:** Dropdowns de tela cheia que revelam conteúdo complexo em cascata.

### Layout & Grids
* **Bento Grid:** Agrupamento assimétrico baseado em tiles (ex: Control Center da Apple).
* **Layout Masonry:** Grid escalonado sem alturas de linha fixas (ex: Pinterest).
* **Chroma Grid:** Bordas de grid ou tiles mostrando gradientes de cor animados sutilmente e continuamente.
* **Split Screen Scroll:** Duas metades da tela deslizando em direções opostas no scroll.
* **Curtain Reveal:** Uma seção Hero se abrindo no meio como uma cortina no scroll.

### Cards & Contêineres
* **Parallax Tilt Card:** Um card se inclinando em 3D rastreando as coordenadas do mouse.
* **Spotlight Border Card:** Bordas de card que se iluminam dinamicamente sob o cursor.
* **Painel de Glassmorphism:** Vidro fosco verdadeiro com bordas de refração interna.
* **Holographic Foil Card:** Reflexos de luz iridescentes e arco-íris mudando no hover.
* **Tinder Swipe Stack:** Uma pilha física de cards que o usuário pode deslizar para o lado.
* **Morphing Modal:** Um botão que se expande perfeitamente em seu próprio contêiner de diálogo de tela cheia.

### Animações de Scroll
* **Sticky Scroll Stack:** Cards que grudam no topo e se empilham fisicamente uns sobre os outros.
* **Horizontal Scroll Hijack:** O scroll vertical se traduz em um suave panorama de galeria horizontal.
* **Locomotive Scroll Sequence:** Sequências de vídeo/3D onde a taxa de quadros está diretamente vinculada à barra de scroll.
* **Zoom Parallax:** Uma imagem de fundo central fazendo zoom in/out perfeitamente enquanto você rola.
* **Scroll Progress Path:** Linhas vetoriais SVG ou rotas que se desenham conforme o usuário rola.
* **Liquid Swipe Transition:** Transições de página que limpam a tela como um líquido viscoso.

### Galerias & Mídia
* **Dome Gallery:** Uma galeria 3D parecendo uma cúpula panorâmica.
* **Coverflow Carousel:** Carrossel 3D com o centro focado e as bordas anguladas para trás.
* **Drag-to-Pan Grid:** Um grid ilimitado que você pode arrastar livremente em qualquer direção.
* **Accordion Image Slider:** Tiras de imagem verticais/horizontais estreitas que se expandem totalmente no hover.
* **Hover Image Trail:** O mouse deixa um rastro de imagens aparecendo/desvanecendo por trás.
* **Glitch Effect Image:** Breve distorção digital de mudança de canal RGB no hover.

### Tipografia & Texto
* **Kinetic Marquee:** Faixas de texto sem fim que invertem a direção ou aceleram no scroll.
* **Text Mask Reveal:** Tipografia massiva agindo como uma janela transparente para um fundo de vídeo.
* **Text Scramble Effect:** Decodificação de caracteres estilo Matrix no carregamento ou hover.
* **Circular Text Path:** Texto curvado ao longo de um caminho circular girando.
* **Gradient Stroke Animation:** Texto delineado com um gradiente correndo continuamente ao longo do traço.
* **Kinetic Typography Grid:** Um grid de letras se esquivando ou girando para longe do cursor.

### Micro-Interações & Efeitos
* **Particle Explosion Button:** CTAs que se fragmentam em partículas no sucesso.
* **Liquid Pull-to-Refresh:** Indicadores de recarga mobile agindo como gotas d'água se desprendendo.
* **Skeleton Shimmer:** Reflexos de luz deslocando-se em caixas de placeholder.
* **Directional Hover Aware Button:** O preenchimento do hover entra pelo lado exato de onde o mouse entrou.
* **Ripple Click Effect:** Ondas visuais se propagando precisamente das coordenadas do clique.
* **Animated SVG Line Drawing:** Vetores que desenham seus próprios contornos em tempo real.
* **Mesh Gradient Background:** Blobs de cor animados orgânicos tipo lâmpada de lava.
* **Lens Blur Depth:** Desfoque dinâmico de foco das camadas de UI de fundo para destacar uma ação em primeiro plano.

## 9. O PARADIGMA BENTO "MOTION-ENGINE"
Ao gerar dashboards SaaS modernos ou seções de features, você DEVE utilizar a seguinte arquitetura "Bento 2.0" e filosofia de movimento. Isso vai além de cards estáticos e impõe uma estética "Vercel-core encontra Dribbble-clean" fortemente dependente de física perpétua.

### A. Filosofia Central de Design
* **Estética:** Alto nível, minimalista e funcional.
* **Paleta:** Fundo em `#f9fafb`. Cards são branco puro (`#ffffff`) com borda de 1px de `border-slate-200/50`.
* **Superfícies:** Use `rounded-[2.5rem]` para todos os contêineres principais. Aplique uma "sombra de difusão" (uma sombra muito clara e de ampla propagação, ex: `shadow-[0_20px_40px_-15px_rgba(0,0,0,0.05)]`) para criar profundidade sem desordem.
* **Tipografia:** Stack de fontes estrito `Geist`, `Satoshi` ou `Cabinet Grotesk`. Use tracking sutil (`tracking-tight`) para cabeçalhos.
* **Rótulos:** Títulos e descrições devem ser colocados **fora e abaixo** dos cards para manter uma apresentação limpa estilo galeria.
* **Perfeição de Pixel:** Use padding generoso de `p-8` ou `p-10` dentro dos cards.

### B. Especificações do Motor de Animação (Movimento Perpétuo)
Todos os cards devem conter **"Micro-Interações Perpétuas"**. Use os seguintes princípios do Framer Motion:
* **Física de Mola:** Sem easing linear. Use `type: "spring", stiffness: 100, damping: 20` para uma sensação premium e pesada.
* **Transições de Layout:** Utilize intensamente as props `layout` e `layoutId` para garantir transições suaves de reordenação, redimensionamento e estado de elemento compartilhado.
* **Loops Infinitos:** Todo card deve ter um "Estado Ativo" que faz loop infinitamente (Pulso, Máquina de Escrever, Flutuação ou Carrossel) para garantir que o dashboard pareça "vivo".
* **Performance:** Envolva listas dinâmicas em `<AnimatePresence>` e otimize para 60fps. **CRÍTICO DE PERFORMANCE:** Qualquer movimento perpétuo ou loop infinito DEVE ser memoizado (React.memo) e completamente isolado em seu próprio componente Client microscópico. Nunca dispare re-renders no layout pai.

### C. Os 5 Arquétipos de Cards (Especificações de Micro-Animação)
Implemente essas micro-animações específicas ao construir grids Bento (ex: Linha 1: 3 cols | Linha 2: 2 cols divididas 70/30):
1. **A Lista Inteligente:** Uma pilha vertical de itens com um loop de auto-ordenação infinito. Os itens trocam posições usando `layoutId`, simulando uma IA priorizando tarefas em tempo real.
2. **O Input de Comando:** Uma barra de busca/IA com um Efeito de Máquina de Escrever de múltiplos passos. Ela percorre prompts complexos, incluindo um cursor piscando e um estado de "processando" com um gradiente de carregamento shimmering.
3. **O Status ao Vivo:** Uma interface de agendamento com indicadores de status "respirando". Inclua um badge de notificação pop-up que surge com um efeito de mola "Overshoot", fica por 3 segundos e desaparece.
4. **O Stream de Dados Amplo:** Um "Carrossel Infinito" horizontal de cards de dados ou métricas. Garanta que o loop seja perfeito (usando `x: ["0%", "-100%"]`) com uma velocidade que pareça sem esforço.
5. **A UI Contextual (Modo Foco):** Uma view de documento que anima um destaque escalonado de um bloco de texto, seguido por um "Float-in" de uma barra de ação flutuante com micro-ícones.

## 10. VERIFICAÇÃO FINAL PRÉ-OUTPUT
Avalie seu código contra esta matriz antes do output. Este é o **último** filtro que você aplica à sua lógica.
- [ ] O estado global é usado apropriadamente para evitar prop-drilling profundo em vez de arbitrariamente?
- [ ] O colapso de layout mobile (`w-full`, `px-4`, `max-w-7xl mx-auto`) é garantido para designs de alta variância?
- [ ] Seções de altura total usam com segurança `min-h-[100dvh]` em vez do bugado `h-screen`?
- [ ] As animações `useEffect` contêm funções estritas de limpeza?
- [ ] Os estados vazios, de carregamento e de erro são fornecidos?
- [ ] Os cards são omitidos em favor do espaçamento onde possível?
- [ ] Você isolou estritamente animações perpétuas pesadas para CPU em seus próprios Client Components?
