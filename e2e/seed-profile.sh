#!/usr/bin/env bash
set -euo pipefail

E2E_HOME="${E2E_HOME:-/tmp/lionclaw-e2e-home}"
: "${E2E_PASSWORD:?defina E2E_PASSWORD no ambiente}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DB="$E2E_HOME/.lionclaw/data/lionclaw.db"

rm -rf "$E2E_HOME"; mkdir -p "$E2E_HOME"

echo "[seed] boot isolado por 15s para criar schema + migrations..."
HOME="$E2E_HOME" "$REPO/node_modules/.bin/electron" "$REPO/dist/main/index.js" >/tmp/lce2e-boot.log 2>&1 &
BOOTPID=$!; sleep 15; kill "$BOOTPID" 2>/dev/null || true; wait "$BOOTPID" 2>/dev/null || true

[ -f "$DB" ] || { echo "[seed] ERRO: schema nao criado ($DB)"; exit 1; }

HASH="$(node -e "console.log(require('bcryptjs').hashSync(process.env.E2E_PASSWORD, 12))")"

sqlite3 "$DB" <<SQL
DELETE FROM auth;
INSERT INTO auth (id, password_hash) VALUES (1, '$HASH');
INSERT OR REPLACE INTO settings (key, value) VALUES
  ('onboarding_completed','true'),
  ('orchestrator_model','claude-opus-4-8'),
  ('orchestrator_provider',''),
  ('orchestrator_compaction_threshold_percent','55'),
  ('chat_compaction_target_tokens','50000');
DELETE FROM sessions WHERE id='e2e-sess-1';
INSERT INTO sessions (id, title, type, status, input_tokens, output_tokens, cost_usd, active_context_tokens_est, created_at, updated_at)
  VALUES ('e2e-sess-1','Sessao E2E contexto','chat','active', 550000, 1200, 0.5, 550000, datetime('now'), datetime('now'));
INSERT INTO messages (session_id, role, content, created_at) VALUES
  ('e2e-sess-1','user','oi, analise esse repositorio', datetime('now','-2 minutes')),
  ('e2e-sess-1','assistant','Claro. Li os arquivos principais do LionClaw e o contexto foi preenchido.', datetime('now','-1 minutes'));
SQL

echo "[seed] pronto. Profile isolado em $E2E_HOME"
