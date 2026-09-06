---
name: redesign-projetos-existentes
description: Eleva websites e apps existentes para qualidade premium. Audita o design atual, identifica padrões genéricos de IA e aplica padrões de design de alto nível sem quebrar a funcionalidade. Funciona com qualquer framework CSS ou CSS puro.
category: UI & Design
---

# Skill de Redesign

## Como Funciona

Quando aplicado a um projeto existente, siga esta sequência:

1. **Escanear** — Leia o codebase. Identifique o framework, método de estilização (Tailwind, CSS puro, styled-components, etc.) e padrões de design atuais.
2. **Diagnosticar** — Percorra a auditoria abaixo. Liste cada padrão genérico, ponto fraco e estado ausente que encontrar.
3. **Corrigir** — Aplique atualizações direcionadas trabalhando com o stack existente. Não reescreva do zero. Melhore o que está lá.

## Auditoria de Design

### Tipografia

Verifique esses problemas e corrija-os:

- **Fontes padrão do navegador ou Inter em todo lugar.** Substitua por uma fonte com personalidade. Boas opções: `Geist`, `Outfit`, `Cabinet Grotesk`, `Satoshi`. Para projetos editoriais/criativos, combine um cabeçalho serif com um corpo sans-serif.
- **Títulos sem presença.** Aumente o tamanho para texto de exibição, aperte o letter-spacing, reduza o line-height. Os títulos devem parecer pesados e intencionais.
- **Texto do corpo muito largo.** Limite a largura do parágrafo a aproximadamente 65 caracteres. Aumente o line-height para legibilidade.
- **Apenas pesos Regular (400) e Bold (700) usados.** Introduza Medium (500) e SemiBold (600) para hierarquia mais sutil.
- **Números em fonte proporcional.** Use uma fonte monospace ou habilite figuras tabulares (`font-variant-numeric: tabular-nums`) para interfaces com muitos dados.
- **Ajustes de letter-spacing ausentes.** Use tracking negativo para cabeçalhos grandes, tracking positivo para small caps ou rótulos.
- **Subcabeçalhos em maiúsculas em todo lugar.** Tente itálico em minúsculas, capitalização de sentença ou small-caps.
- **Palavras órfãs.** Palavras únicas sozinhas na última linha. Corrija com `text-wrap: balance` ou `text-wrap: pretty`.

### Cor e Superfícies

- **Fundo preto puro `#000000`.** Substitua por off-black, carvão escuro ou escuro com matiz (`#0a0a0a`, `#121212`, ou um azul escuro).
- **Cores de acento supersaturadas.** Mantenha a saturação abaixo de 80%. Dessature os acentos para que se misturem com os neutros em vez de gritar.
- **Mais de uma cor de acento.** Escolha uma. Remova o resto. Consistência supera variedade.
- **Mistura de cinzas quentes e frios.** Fique com uma família de cinza. Matize todos os cinzas com uma matiz consistente (quente ou frio, não ambos).
- **Estética de "gradiente de IA" roxo/azul.** Esta é a impressão digital de design de IA mais comum. Substitua por bases neutras e um único acento considerado.
- **`box-shadow` genérico.** Matize as sombras para corresponder à matiz do fundo. Use sombras coloridas (ex: sombra azul escura em fundo azul) em vez de preto puro com baixa opacidade.
- **Design plano com zero textura.** Adicione ruído sutil, grão ou micro-padrões aos fundos. Vetores planos puros parecem estéreis.
- **Gradientes perfeitamente uniformes.** Quebre a uniformidade com gradientes radiais, sobreposições de ruído ou gradientes mesh em vez de desvanecer linear padrão de 45 graus.
- **Direção de iluminação inconsistente.** Audite todas as sombras para garantir que sugiram uma única fonte de luz consistente.
- **Seções escuras aleatórias em uma página de modo claro (ou vice-versa).** Uma única seção de fundo escuro quebrando uma página de outro modo clara parece um acidente de copiar-colar. Comprometa-se com modo escuro total ou mantenha um tom de fundo consistente. Se for necessário contraste, use um tom ligeiramente mais escuro da mesma paleta — não um salto repentino para `#111` no meio de uma página creme.
- **Seções vazias e planas sem profundidade visual.** Seções que são apenas texto em fundo simples parecem inacabadas. Adicione imagens de fundo de alta qualidade (desfocadas, sobrepostas ou mascaradas), padrões sutis ou gradientes ambientes.

### Layout

- **Tudo centralizado e simétrico.** Quebre a simetria com margens deslocadas, proporções de imagem mistas ou cabeçalhos alinhados à esquerda sobre conteúdo centralizado.
- **Três colunas de cards iguais como linha de features.** Este é o layout de IA mais genérico. Substitua por um zig-zag de 2 colunas, grid assimétrico, scroll horizontal ou layout masonry.
- **Usando `height: 100vh` para seções de tela cheia.** Substitua por `min-height: 100dvh` para evitar saltos de layout em navegadores móveis (bug de viewport do iOS Safari).
- **Matemática de porcentagem complexa com flexbox.** Substitua por CSS Grid para estruturas de múltiplas colunas confiáveis.
- **Sem contêiner de largura máxima.** Adicione uma restrição de contêiner (cerca de 1200-1440px) com margens automáticas para que o conteúdo não se estenda de ponta a ponta em telas largas.
- **Cards de altura igual forçados pelo flexbox.** Permita alturas variáveis ou use masonry quando o conteúdo varia em comprimento.
- **Border-radius uniforme em tudo.** Varie o raio: mais apertado em elementos internos, mais suave em contêineres.
- **Sem sobreposição ou profundidade.** Os elementos ficam planos um ao lado do outro. Use margens negativas para criar camadas e profundidade visual.
- **Padding vertical simétrico.** O padding superior e inferior são sempre idênticos. Ajuste opticamente — o padding inferior frequentemente precisa ser ligeiramente maior.
- **Dashboard sempre tem uma barra lateral esquerda.** Tente navegação superior, um menu de comando flutuante ou um painel recolhível.
- **Espaçamento em branco ausente.** Dobre o espaçamento. Deixe o design respirar. Layouts densos funcionam para dashboards de dados, não para páginas de marketing.
- **Botões não alinhados na parte inferior em grupos de cards.** Quando os cards têm comprimentos de conteúdo diferentes, os CTAs ficam em alturas aleatórias. Fixe os botões na parte inferior de cada card para que formem uma linha horizontal limpa independentemente do conteúdo acima.
- **Listas de features começando em posições verticais diferentes.** Em tabelas de preços ou cards de comparação, a lista de features deve começar na mesma posição Y em todas as colunas.
- **Ritmo vertical inconsistente em elementos lado a lado.** Ao colocar cards, colunas ou painéis lado a lado, alinhe os elementos compartilhados (títulos, descrições, preços, botões) em todos os itens.

### Interatividade e Estados

- **Sem estados de hover em botões.** Adicione mudança de fundo, leve escala ou translate no hover.
- **Sem feedback ativo/pressionado.** Adicione um sutil `scale(0.98)` ou `translateY(1px)` ao pressionar para simular um clique físico.
- **Transições instantâneas com duração zero.** Adicione transições suaves (200-300ms) a todos os elementos interativos.
- **Anel de foco ausente.** Garanta indicadores de foco visíveis para navegação por teclado. Este é um requisito de acessibilidade, não opcional.
- **Sem estados de carregamento.** Substitua spinners circulares genéricos por skeleton loaders que correspondam à forma do layout.
- **Sem estados vazios.** Um dashboard vazio mostrando nada é uma oportunidade perdida. Projete uma view de "como começar" bem composta.
- **Sem estados de erro.** Adicione mensagens de erro claras e inline para formulários. Não use `window.alert()`.
- **Links mortos.** Botões que linkam para `#`. Ou linke para destinos reais ou desabilite-os visualmente.
- **Sem indicação de página atual na navegação.** Estilize o link de navegação ativo de forma diferente para que os usuários saibam onde estão.
- **Salto de scroll.** Cliques em âncoras saltam instantaneamente. Adicione `scroll-behavior: smooth`.
- **Animações usando `top`, `left`, `width`, `height`.** Mude para `transform` e `opacity` para animação suave acelerada por GPU.

### Conteúdo

- **Nomes genéricos como "João Silva" ou "Maria Souza".** Use nomes diversificados e realistas.
- **Números redondos falsos como `99,99%`, `50%`, `R$100,00`.** Use dados orgânicos e irregulares: `47,2%`, `R$99,00`, `(11) 98472-1928`.
- **Nomes de empresas de placeholder como "Empresa X", "Nexus", "SmartFlow".** Invente nomes de marca contextuais e críveis.
- **Clichês de copywriting de IA.** Nunca use "Eleve", "Fluido", "Libere", "Próxima Geração", "Revolucionário", "Mergulhe", "No mundo de...". Escreva linguagem simples e específica.
- **Pontos de exclamação em mensagens de sucesso.** Remova-os. Seja confiante, não barulhento.
- **Mensagens de erro do tipo "Oops!".** Seja direto: "Conexão falhou. Por favor, tente novamente."
- **Voz passiva.** Use voz ativa: "Não conseguimos salvar suas alterações" em vez de "Erros foram cometidos."
- **Todas as datas de posts de blog idênticas.** Randomize as datas para parecer real.
- **Mesma imagem de avatar para múltiplos usuários.** Use ativos únicos para cada pessoa distinta.
- **Lorem Ipsum.** Nunca use texto latino de placeholder. Escreva copy de rascunho real.
- **Title Case Em Cada Cabeçalho.** Use capitalização de sentença.

### Padrões de Componentes

- **Aparência genérica de card (borda + sombra + fundo branco).** Remova a borda, ou use apenas cor de fundo, ou use apenas espaçamento. Os cards devem existir apenas quando a elevação comunica hierarquia.
- **Sempre um botão preenchido + um botão fantasma.** Adicione links de texto ou estilos terciários para reduzir o ruído visual.
- **Badges em pílula "Novo" e "Beta".** Tente badges quadradas, bandeiras ou rótulos de texto simples.
- **Seções de FAQ em acordeão.** Use uma lista lado a lado, ajuda pesquisável ou divulgação progressiva inline.
- **Carrossel de depoimentos com 3 cards e pontos.** Substitua por um mural masonry, posts sociais incorporados ou uma única citação rotativa.
- **Tabela de preços com 3 torres.** Destaque o tier recomendado com cor e ênfase, não apenas altura extra.
- **Modais para tudo.** Use edição inline, painéis deslizantes ou seções expansíveis em vez de popups para ações simples.
- **Círculos de avatar exclusivamente.** Tente squircles ou quadrados arredondados para uma aparência menos genérica.
- **Toggle de claro/escuro sempre um interruptor sol/lua.** Use um dropdown, detecção de preferência do sistema ou integre nas configurações.
- **Footer com fazenda de links em 4 colunas.** Simplifique. Foque nos principais caminhos de navegação e links legalmente obrigatórios.

### Iconografia

- **Ícones Lucide ou Feather exclusivamente.** Estes são a escolha de ícone "padrão" de IA. Use Phosphor, Heroicons ou um conjunto personalizado para diferenciação.
- **Foguete para "Lançar", escudo para "Segurança".** Substitua metáforas clichês por ícones menos óbvios (raio, impressão digital, faísca, cofre).
- **Larguras de traço inconsistentes entre ícones.** Audite todos os ícones e padronize para um peso de traço.
- **Favicon ausente.** Sempre inclua um favicon com a marca.
- **Fotos de stock de "equipe diversificada".** Use fotos reais da equipe, fotos espontâneas ou um estilo de ilustração consistente.

### Qualidade do Código

- **Div soup.** Use HTML semântico: `<nav>`, `<main>`, `<article>`, `<aside>`, `<section>`.
- **Estilos inline misturados com classes CSS.** Mova toda a estilização para o sistema de estilização do projeto.
- **Larguras em pixels hardcoded.** Use unidades relativas (`%`, `rem`, `em`, `max-width`) para layouts flexíveis.
- **Alt text ausente nas imagens.** Descreva o conteúdo da imagem para leitores de tela. Nunca deixe `alt=""` ou `alt="imagem"` em imagens com significado.
- **Valores de z-index arbitrários como `9999`.** Estabeleça uma escala de z-index limpa no tema/variáveis.
- **Código morto comentado.** Remova todos os artefatos de debug antes de fazer deploy.
- **Importações alucinadas.** Verifique se cada importação realmente existe no `package.json` ou nas dependências do projeto.
- **Meta tags ausentes.** Adicione `<title>`, `description`, `og:image` e meta tags de compartilhamento social adequadas.

### Omissões Estratégicas (O Que a IA Tipicamente Esquece)

- **Sem links legais.** Adicione links de política de privacidade e termos de serviço no footer.
- **Sem navegação "voltar".** Becos sem saída nos fluxos de usuário. Cada página precisa de uma forma de voltar.
- **Sem página 404 personalizada.** Projete uma experiência de "página não encontrada" útil e com a marca.
- **Sem validação de formulário.** Adicione validação client-side para emails, campos obrigatórios e verificações de formato.
- **Sem link "pular para o conteúdo".** Essencial para usuários de teclado. Adicione um skip-link oculto.
- **Sem consentimento de cookies.** Se exigido pela jurisdição, adicione um banner de consentimento adequado.

## Técnicas de Atualização

Ao atualizar um projeto, use estas técnicas de alto impacto para substituir padrões genéricos:

### Atualizações de Tipografia
- **Animação de fonte variável.** Interpole peso ou largura no scroll ou hover para texto que parece vivo.
- **Transições de contorno para preenchimento.** O texto começa como um contorno de traço e preenche com cor na entrada por scroll ou interação.
- **Revelações de máscara de texto.** Tipografia grande funcionando como uma janela para vídeo ou imagens animadas por trás.

### Atualizações de Layout
- **Grid quebrado / assimetria.** Elementos que deliberadamente ignoram a estrutura de colunas — sobrepostos, sangrando fora da tela ou deslocados com randomização calculada.
- **Maximização do espaço em branco.** Uso agressivo de espaço negativo para forçar o foco em um único elemento.
- **Pilhas de cards em paralaxe.** Seções que grudam e fisicamente se empilham umas sobre as outras durante o scroll.
- **Scroll em tela dividida.** Duas metades da tela deslizando em direções opostas.

### Atualizações de Movimento
- **Scroll suave com inércia.** Desacoplar o scroll dos padrões do navegador para uma sensação mais pesada e cinematográfica.
- **Entrada escalonada.** Os elementos entram em cascata com pequenos atrasos, combinando translação no eixo Y com desvanecer de opacidade. Nunca monte tudo de uma vez.
- **Física de mola.** Substitua o easing linear por movimento baseado em mola para uma sensação natural e pesada em todos os elementos interativos.
- **Revelações disparadas por scroll.** Conteúdo entrando por meio de máscaras expansivas, limpezas ou caminhos SVG desenhados vinculados ao progresso do scroll.

### Atualizações de Superfície
- **Glassmorphism verdadeiro.** Vá além de `backdrop-filter: blur`. Adicione uma borda interna de 1px e uma sombra interna sutil para simular refração de borda.
- **Bordas spotlight.** Bordas de cards que se iluminam dinamicamente sob o cursor.
- **Sobreposições de grão e ruído.** Uma sobreposição fixa com pointer-events-none com ruído sutil para quebrar a planicidade digital.
- **Sombras coloridas e com matiz.** Sombras que carregam a matiz do fundo em vez de usar preto genérico.

## Prioridade de Correção

Aplique as mudanças nesta ordem para máximo impacto visual com mínimo risco:

1. **Troca de fonte** — maior melhoria instantânea, menor risco
2. **Limpeza da paleta de cores** — remova cores conflitantes ou supersaturadas
3. **Estados de hover e active** — faz a interface parecer viva
4. **Layout e espaçamento** — grid adequado, largura máxima, padding consistente
5. **Substitua componentes genéricos** — troque padrões clichês por alternativas modernas
6. **Adicione estados de carregamento, vazio e erro** — faz parecer finalizado
7. **Polimento de escala tipográfica e espaçamento** — o toque final premium

## Regras

- Trabalhe com o stack de tecnologia existente. Não migre frameworks ou bibliotecas de estilização.
- Não quebre a funcionalidade existente. Teste após cada mudança.
- Antes de importar qualquer nova biblioteca, verifique primeiro o arquivo de dependências do projeto.
- Se o projeto usar Tailwind, verifique a versão (v3 vs v4) antes de modificar a configuração.
- Se o projeto não tiver framework, use CSS puro.
- Mantenha as mudanças revisáveis e focadas. Pequenas melhorias direcionadas em vez de grandes reescritas.
