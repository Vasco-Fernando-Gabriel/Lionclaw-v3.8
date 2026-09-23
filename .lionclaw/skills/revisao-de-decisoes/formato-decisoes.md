# Formato das decisoes (saida do botao "Gerar decisoes")

O botao gera este texto e copia para a area de transferencia. O dono cola no chat.

```
<exportTitle>

[<titulo da secao>]
<id>: ok
<id>: ajustar -> <nota do dono>
<id>: rejeitar
<id>: rejeitar -> <nota>

[Questoes]
Q1: <opcao escolhida>
Q2: <opcao escolhida> -> <nota>
Q3: (sem opcao) -> <nota>

Pendentes: <id>, <id>
```

Regras do formato:
- Uma linha por regra marcada; regras sem marcacao nao aparecem nas secoes e vao para `Pendentes`.
- `->` separa o estado da nota. Nota e obrigatoria em `ajustar` (a pagina pede, mas nao bloqueia; se vier vazia, pergunte ao dono o que muda antes de aplicar).
- Questoes so aparecem se tiverem opcao ou nota.
- Os ids sao os do documento. Nunca renumere ao aplicar.

# Aplicar de volta no documento

| Linha | Efeito no documento |
|---|---|
| `ok` | nada muda |
| `ajustar -> nota` | reescrever a regra com a nota; changelog + "Decisoes do dono" ganham `Dn` |
| `rejeitar` | remover a regra e propagar (aliases, ACs, fases, glossario); registrar `Dn` |
| `Qn: opcao` | marcar a questao como DECIDIDA; virar regra onde couber |
| `Pendentes` | manter `[PENDENTE de leitura do dono]`; nunca decidir por ele |

Depois de aplicar: versao do documento sobe, changelog lista as `Dn` novas, a pagina e republicada no mesmo link com as regras reescritas (elas voltam a pendente para o dono rever) e o documento e devolvido ao dono.
