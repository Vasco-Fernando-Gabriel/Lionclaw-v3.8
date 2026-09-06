---
name: ui-brutalista-industrial
description: Interfaces mecânicas brutas fundindo tipografia suíça impressa com estética militar de terminal. Grids rígidos, contraste extremo de escala tipográfica, cor utilitária, efeitos de degradação analógica. Para dashboards densos em dados, portfólios ou sites editoriais que precisam parecer plantas técnicas desclassificadas.
category: UI & Design
---

# SKILL: Brutalismo Industrial & Interface de Telemetria Tática

## 1. Meta da Skill
**Nome:** Engenharia de Interface de Brutalismo Industrial & Telemetria Tática
**Descrição:** Proficiência avançada em arquitetar interfaces web que sintetizam design tipográfico suíço de meados do século, manuais de manufatura industrial e interfaces de terminal aeroespacial/militar retro-futuristas. Esta disciplina requer domínio absoluto sobre grids modulares rígidos, contraste extremo de escala tipográfica, paletas de cores puramente utilitárias e a simulação programática de degradação analógica (meios-tons, varreduras CRT, dithering bitmap). O objetivo é construir ambientes digitais que transmitam funcionalidade bruta, precisão mecânica e alta densidade de dados, descartando deliberadamente os padrões convencionais de UI para consumidores.

## 2. Arquétipos Visuais
O sistema de design opera mesclando dois paradigmas visuais distintos, mas altamente compatíveis. **Escolha UM por projeto e comprometa-se com ele. Não alterne nem misture ambos os modos na mesma interface.**

### 2.1 Impressão Industrial Suíça
Derivada de sistemas de identidade corporativa dos anos 1960 e plantas de maquinário pesado.
* **Características:** Modos claros de alto contraste (substratos de newsprint/off-white). Dependência de tipografia sans-serif monolítica e pesada. Grids estruturais implacáveis delineados por linhas divisórias visíveis. Uso agressivo e assimétrico de espaço negativo pontuado por numerais ou letras maiúsculas que sangram pelo viewport. Uso intenso do vermelho primário como cor de alerta/acento.

### 2.2 Telemetria Tática & Terminal CRT
Derivada de bancos de dados militares classificados, mainframes legados e Heads-Up Displays (HUDs) aeroespaciais.
* **Características:** Exclusividade em modo escuro. Apresentação de dados tabulares de alta densidade. Domínio absoluto de tipografia monoespaçada. Integração de dispositivos de enquadramento técnico (colchetes ASCII, miras). Aplicação de limitações de hardware simuladas (brilho de fósforo, varreduras, renderização de baixo bit-depth).

## 3. Arquitetura Tipográfica
A tipografia é a infraestrutura estrutural e decorativa primária. A imagem é secundária. O sistema exige variância extrema em escala, peso e espaçamento.

### 3.1 Macro-Tipografia (Cabeçalhos Estruturais)
* **Classificação:** Neo-Grotesque / Sans-Serif Pesado.
* **Fontes Web Ideais:** Neue Haas Grotesk (Black), Inter (Extra Bold/Black), Archivo Black, Roboto Flex (Heavy), Monument Extended.
* **Parâmetros de Implementação:**
    * **Escala:** Implantado em escalas massivas usando tipografia fluida (ex: `clamp(4rem, 10vw, 15rem)`).
    * **Tracking (Letter-spacing):** Extremamente apertado, frequentemente negativo (`-0.03em` a `-0.06em`), forçando os glifos a formarem blocos arquitetônicos sólidos.
    * **Leading (Line-height):** Altamente comprimido (`0.85` a `0.95`).
    * **Caixa:** Exclusivamente maiúsculas para impacto estrutural.

### 3.2 Micro-Tipografia (Dados & Telemetria)
* **Classificação:** Monospace / Sans Técnico.
* **Fontes Web Ideais:** JetBrains Mono, IBM Plex Mono, Space Mono, VT323, Courier Prime.
* **Parâmetros de Implementação:**
    * **Escala:** Fixo e pequeno (`10px` a `14px` / `0.7rem` a `0.875rem`).
    * **Tracking:** Generoso (`0.05em` a `0.1em`) para simular espaçamento de máquina de escrever mecânica ou matrizes de terminal.
    * **Leading:** Padrão a apertado (`1.2` a `1.4`).
    * **Caixa:** Exclusivamente maiúsculas. Usado para todos os metadados, navegação, IDs de unidade e coordenadas.

### 3.3 Contraste Textural (Ruptura Artística)
* **Classificação:** Serif de Alto Contraste.
* **Fontes Web Ideais:** Playfair Display, EB Garamond, Times New Roman.
* **Parâmetros de Implementação:** Usado com extrema moderação. Deve ser submetido a pós-processamento pesado (filtros de meio-tom, dithering de 1 bit) para degradar a perfeição vetorial e criar justaposição textural em relação às sans-serifs limpas.

## 4. Sistema de Cores
A arquitetura de cores não dá margem para negociação. Gradientes, sombras suaves e translucidez moderna são estritamente proibidos. As cores simulam mídia física ou displays emissivos primitivos.

**CRÍTICO: Escolha UMA paleta de substrato por projeto e use-a consistentemente. Nunca misture substratos claros e escuros na mesma interface.**

### Se Impressão Industrial Suíça (Claro):
* **Fundo:** `#F4F4F0` ou `#EAE8E3` (Papel de documentação fosco e não alvejado).
* **Primeiro plano:** `#050505` a `#111111` (Tinta de Carbono).
* **Acento:** `#E61919` ou `#FF2A2A` (Vermelho de Aviação/Perigo). Esta é a ÚNICA cor de acento. Usada para tachados, grossas linhas divisórias estruturais ou destaques de dados vitais.

### Se Telemetria Tática (Escuro):
* **Fundo:** `#0A0A0A` ou `#121212` (CRT desativado. Evite o preto puro `#000000`).
* **Primeiro plano:** `#EAEAEA` (Fósforo branco). Esta é a cor de texto primária.
* **Acento:** `#E61919` ou `#FF2A2A` (Vermelho de Aviação/Perigo). Mesmo vermelho, mesmas regras.
* **Verde Terminal (`#4AF626`):** Opcional. Use APENAS para um único elemento específico de UI (ex: um indicador de status ou uma leitura de dados) — nunca como cor de texto geral. Se não servir a um propósito claro, omita completamente.

## 5. Engenharia de Layout e Espaço
O layout deve parecer matematicamente projetado. Rejeita o padding convencional da web em favor da compartimentalização visível.

* **O Grid Planta Técnica:** Adesão estrita a arquiteturas CSS Grid. Os elementos não flutuam; são ancorados precisamente às trilhas e interseções do grid.
* **Compartimentalização Visível:** Utilização extensiva de bordas sólidas (`1px` ou `2px solid`) para delinear zonas distintas de informação. Réguas horizontais (`<hr>`) frequentemente abrangem toda a largura do contêiner para segregar unidades operacionais.
* **Densidade Bimodal:** Os layouts oscilam entre densidade extrema de dados (metadados monoespaçados compactados) e vastas extensões de espaço negativo calculado emoldurando macro-tipografia.
* **Geometria:** Rejeição absoluta de `border-radius`. Todos os cantos devem ter exatamente 90 graus para impor rigidez mecânica.

## 6. Componentes de UI e Simbologia
As convenções padrão de UI web são substituídas por elementos gráficos utilitários e industriais.

* **Decoração Sintática:** Utilização de caracteres ASCII para enquadrar pontos de dados.
    * *Enquadramento:* `[ SISTEMAS DE ENTREGA ]`, `< RE-IND >`
    * *Direcional:* `>>>`, `///`, `\\\\`
* **Marcadores Industriais:** Integração proeminente dos símbolos de marca registrada (`®`), copyright (`©`) e marca comercial (`™`) funcionando como elementos geométricos estruturais em vez de texto jurídico.
* **Ativos Técnicos:** Integração de miras (`+`) em interseções de grid, linhas verticais repetidas (códigos de barras), listras horizontais de aviso espessas e dados de string aleatórios (ex: `REV 2.6`, `UNID / D-01`) para simular processos mecânicos ativos.

## 7. Efeitos de Textura e Pós-Processamento
Para evitar que o design pareça puramente digital, a degradação analógica simulada é inserida no frontend via CSS e filtros SVG.

* **Meio-tom e Dithering de 1 Bit:** Transformar imagens de tom contínuo ou tipografia serif grande em padrões de matriz de pontos. Alcançado via pré-processamento ou sobreposições CSS `mix-blend-mode: multiply` combinadas com padrões de pontos radiais SVG.
* **Varreduras CRT:** Para interfaces de terminal, aplicar um `repeating-linear-gradient` ao fundo para simular varreduras horizontais de feixe de elétrons (ex: `repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.1) 2px, rgba(0,0,0,0.1) 4px)`).
* **Ruído Mecânico:** Um filtro SVG de estática/ruído global de baixa opacidade aplicado à raiz do DOM para introduzir um grão físico unificado nos modos claro e escuro.

## 8. Diretrizes de Engenharia Web
1. **Determinismo de Grid:** Utilize `display: grid; gap: 1px;` com cores contrastantes de fundo pai/filho para gerar linhas divisórias matematicamente perfeitas e extremamente finas sem declarações de borda complexas.
2. **Rigidez Semântica:** Construa o DOM usando tags semânticas precisas (`<data>`, `<samp>`, `<kbd>`, `<output>`, `<dl>`) para refletir com precisão a natureza técnica da telemetria.
3. **Clamping de Tipografia:** Implemente funções CSS `clamp()` exclusivamente para macro-tipografia para garantir que o texto massivo escale de forma agressiva mantendo a integridade estrutural em diferentes viewports.
