---
name: revisao-de-decisoes
description: transforma uma SPEC ou documento de decisoes (tecnicas ou de negocio) numa pagina de aprovacao regra a regra (ok / ajustar / rejeitar + nota), com questoes e recomendacao, progresso, changelog de validadores e exportacao das decisoes em texto; a pagina abre no painel lateral do LionClaw e o botao "Gerar decisoes" devolve o texto ao composer do chat; depois aplica as decisoes de volta no documento
category: produto
version: 1
---

# revisao-de-decisoes

Pagina de aprovacao de decisoes no formato LionLabs: fundo preto, laranja neon e branco. Cada regra vira um cartao com `ok` / `ajustar` / `rejeitar` e campo de nota; questoes abertas viram cartoes com recomendacao e opcoes; um botao gera o texto das decisoes e o coloca no composer do chat para o dono revisar e enviar. As marcacoes do dono ficam salvas pelo LionClaw e sobrevivem a fechar e reabrir a pagina.

Serve para SPECs de produto e tecnicas, decisoes de negocio, ADRs, roadmaps: qualquer documento em que alguem precisa dizer sim, nao ou "muda isso" item a item.

## Quando usar

- Pedido explicito: "monta a revisao de decisoes", "quero aprovar as decisoes desta SPEC", "gera a pagina de aprovacao".
- Regra do prompt: sempre que uma SPEC ou decisao de negocio pedir aprovacao item a item, a resposta e esta pagina, nao uma lista no chat.
- Aplicar: o dono envia o texto gerado pela pagina (formato em `formato-decisoes.md`); voce aplica no documento e reemite a pagina.

## Arquivos desta skill

- `template.html`: a pagina completa (CSS + JS). So o bloco `var DATA = {...}` muda por documento. NAO alterar o design: e o formato aprovado pelo dono. O bloco `<script>` inicial e o adaptador que fala com o LionClaw (marcacoes e composer); nao remover.
- `formato-decisoes.md`: o formato do texto que o botao "Gerar decisoes" produz e as regras para aplica-lo de volta no documento.

## Passo a passo: gerar a pagina

1. Leia o documento inteiro. Extraia, nesta ordem:
   - **Fatos**: contexto verificado, nao votavel (ex.: "hoje a fila e unica"). Marque `fixed: true` nos fatos corrigidos por validadores.
   - **Regras / decisoes votaveis**: cada uma com id ESTAVEL (o id do documento: `RM1`, `5.5`, `D3`, `AC-7`...), agrupadas nas secoes do documento. Texto de ate 2 frases, na lingua de quem le, sem jargao que o dono nao usa. Uma regra = uma decisao; se um paragrafo tem duas decisoes, vira dois cartoes (`7.3a`, `7.3b`).
   - **Fases / sequencia** (se houver): so quando a ordem carrega informacao real.
   - **Questoes abertas**: cada uma com a recomendacao E o motivo, mais 2 a 4 opcoes que o documento sustenta. Nunca inventar opcao. O leitor sempre tem "Outro".
   - **Changelog**: o que validadores derrubaram (P1/P2/P3) e decisoes ja tomadas (D1, D2...).
2. Tag `validador` (aparece em laranja ao lado do id) SOMENTE em regra que nasceu ou mudou por achado de validador. Outras tags possiveis: `novo`, `dono`.
3. Monte o bloco `DATA` do `template.html` (ver a estrutura comentada no proprio template). Regras:
   - `storageKey`: `<projeto>-<documento>-v<MAJOR>`, so letras minusculas, digitos e hifen. So muda de versao MAJOR; em revisoes menores as marcacoes do dono precisam sobreviver. Regras reescritas voltam a pendente sozinhas porque o dono as reve.
   - `title` da pagina: nome curto e especifico, sem sufixo explicador. Troque tambem o `<title>` no topo do arquivo.
   - `lede`: 2 a 3 frases dizendo o que e e o que o dono deve fazer.
4. Escreva o HTML completo em `~/.lionclaw/artifacts/<slug-do-documento>-<YYYYMMDD-HHmm>.html` (a pasta ja existe). O arquivo e autocontido: nenhum `<script src=`, nenhum recurso externo alem do `<link>` de fontes do Google que ja esta no template.
5. Termine a resposta com a linha `ARQUIVO_HTML: <caminho absoluto do arquivo>`. O LionClaw abre a pagina no painel lateral. Nunca peca ao dono para abrir o arquivo no navegador.
6. Republicacao (regras reescritas, versao nova): gere um arquivo NOVO com timestamp novo e a mesma `storageKey`; o card da mensagem antiga continua abrindo a versao antiga e as marcacoes seguem pela chave.
7. Entregue ao dono, no chat: o que mudou desde a ultima versao (em bullets curtos) e o que esta pendente.

## Passo a passo: aplicar as decisoes

O dono envia o texto gerado pela pagina (o botao "Gerar decisoes" ja o coloca no composer; formato em `formato-decisoes.md`). Para cada linha:

- `ok`: a regra fica como esta.
- `ajustar -> nota`: reescreva a regra incorporando a nota; registre a mudanca como decisao numerada (`Dn`) no changelog e na secao "Decisoes do dono" do documento.
- `rejeitar`: remova a regra do documento (ou marque "(Removida pelo dono, Dn)" quando outras regras a citam) e propague: aliases, ACs, fases e glossario que a citavam.
- `Qn: <opcao> -> nota`: registre a questao como DECIDIDA com a opcao e converta em regra onde couber.
- `Pendentes: ...`: mantenha marcadas como `[PENDENTE de leitura do dono]` no documento; nunca decida por ele.

Depois: suba a versao do documento, atualize o changelog, reemita a pagina com as regras reescritas (arquivo novo, mesma `storageKey`, linha `ARQUIVO_HTML:` no fim) e devolva o documento ao dono. Se o documento tiver validadores adversariais no fluxo, rode-os de novo antes de reemitir e liste os achados na secao de changelog da pagina.

## Regras fixas

- Nunca inventar regra, opcao ou recomendacao que o documento nao sustenta. Recomendacao sem motivo nao vale.
- Nunca decidir pelo dono: item sem marcacao continua pendente.
- Texto para leigo no assunto: a pagina e para quem decide, nao para quem implementa. Nomes de arquivo e funcao so quando o dono precisa ir la.
- O design (cores, fontes, layout, controles) e o do template. Nao "melhorar".
- Uma pagina por documento; versoes sao arquivos novos com a mesma `storageKey`.
