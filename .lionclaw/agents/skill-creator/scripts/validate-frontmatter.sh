#!/bin/bash
# Valida o frontmatter de um SKILL.md
# Uso: ./validate-frontmatter.sh /caminho/para/SKILL.md

set -euo pipefail

FILE="${1:?Uso: $0 <caminho-para-SKILL.md>}"

if [ ! -f "$FILE" ]; then
  echo "ERRO: Arquivo nao encontrado: $FILE"
  exit 1
fi

ERRORS=0

# Extrair frontmatter (entre --- e ---)
FRONTMATTER=$(sed -n '/^---$/,/^---$/p' "$FILE" | sed '1d;$d')

if [ -z "$FRONTMATTER" ]; then
  echo "ERRO: Frontmatter YAML nao encontrado"
  exit 1
fi

# Verificar name
NAME=$(echo "$FRONTMATTER" | grep '^name:' | sed 's/name: *//' | tr -d '"' | tr -d "'")
if [ -z "$NAME" ]; then
  echo "ERRO: Campo 'name' ausente"
  ERRORS=$((ERRORS + 1))
elif [ ${#NAME} -gt 64 ]; then
  echo "ERRO: 'name' excede 64 caracteres (${#NAME})"
  ERRORS=$((ERRORS + 1))
elif ! echo "$NAME" | grep -qE '^[a-z0-9][a-z0-9-]*$'; then
  echo "ERRO: 'name' deve ser lowercase com hifens: $NAME"
  ERRORS=$((ERRORS + 1))
else
  echo "OK: name = $NAME"
fi

# Verificar description
DESC=$(echo "$FRONTMATTER" | grep '^description:' | sed 's/description: *//' | tr -d '"' | tr -d "'")
if [ -z "$DESC" ]; then
  echo "ERRO: Campo 'description' ausente"
  ERRORS=$((ERRORS + 1))
elif [ ${#DESC} -gt 1024 ]; then
  echo "ERRO: 'description' excede 1024 caracteres (${#DESC})"
  ERRORS=$((ERRORS + 1))
else
  echo "OK: description (${#DESC} chars)"
fi

# Contar linhas do body
BODY_LINES=$(sed -n '/^---$/,/^---$/!p' "$FILE" | tail -n +2 | wc -l | tr -d ' ')
if [ "$BODY_LINES" -gt 500 ]; then
  echo "AVISO: Body tem $BODY_LINES linhas (recomendado < 500)"
else
  echo "OK: body ($BODY_LINES linhas)"
fi

if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "RESULTADO: $ERRORS erro(s) encontrado(s)"
  exit 1
else
  echo ""
  echo "RESULTADO: Frontmatter valido!"
  exit 0
fi
