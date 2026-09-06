#!/bin/bash

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PASS_PREFIX="PASS"
FAIL_PREFIX="FAIL"
fail_count=0

echo "=== Sprint 5 — Quality Gates (SPEC L1242-1249) ==="
echo "Repo root: $REPO_ROOT"
echo ""

echo "--- Gate 1: OPEN_DESIGN_ROOT funcional ---"
gate1_hits=$(grep -RIn "OPEN_DESIGN_ROOT" \
    electron/ src/ vendor/open-design/.lionclaw-patches/ 2>/dev/null \
  | grep -v "__tests__" \
  | grep -v "__snapshots__" \
  | grep -v "// " \
  | grep -v "^\* " \
  | grep -v " \* " \
  | grep -v "R-NO-ENV" \
  | grep -v "SPEC L" \
  | grep -v "sem env" \
  | grep -v "comentario" \
  || true)
if [ -n "$gate1_hits" ]; then
  echo "$FAIL_PREFIX Gate 1: OPEN_DESIGN_ROOT referenciado funcionalmente:"
  echo "$gate1_hits"
  fail_count=$((fail_count + 1))
else
  echo "$PASS_PREFIX Gate 1: zero OPEN_DESIGN_ROOT funcional"
fi
echo ""

echo "--- Gate 2: install-deps IPC/CTA ---"
gate2_hits=$(grep -RIn "install-deps\|Instalar dependencias\|Install deps" \
    electron/main/ipc-handlers.ts electron/preload/index.ts src/components/ 2>/dev/null \
  | grep -v "boot-install" \
  | grep -v "__tests__" \
  | grep -v "__snapshots__" \
  | grep -v "REMOVIDO" \
  | grep -v "removido" \
  | grep -v "// " \
  | grep -v "^\* " \
  | grep -v " \* " \
  | grep -v "SEM " \
  || true)
if [ -n "$gate2_hits" ]; then
  echo "$FAIL_PREFIX Gate 2: install-deps IPC/CTA ainda presente:"
  echo "$gate2_hits"
  fail_count=$((fail_count + 1))
else
  echo "$PASS_PREFIX Gate 2: zero install-deps IPC/CTA"
fi
echo ""

echo "--- Gate 3a: finalize/anthropic ---"
gate3a_hits=$(grep -RIn "finalize/anthropic\|finalize\\.anthropic" \
    electron/main/open-design 2>/dev/null \
  | grep -v "__tests__" \
  | grep -v "__snapshots__" \
  | grep -v "denylist" \
  | grep -v "proibido" \
  | grep -v "forbidden" \
  | grep -v "NAO" \
  | grep -v "// " \
  | grep -v "^\* " \
  | grep -v " \* " \
  | grep -v "bloqueado" \
  | grep -v "bloquead" \
  | grep -v "No call to" \
  | grep -v "isForbiddenPath" \
  || true)
if [ -n "$gate3a_hits" ]; then
  echo "$FAIL_PREFIX Gate 3a: finalize/anthropic referenciado funcionalmente:"
  echo "$gate3a_hits"
  fail_count=$((fail_count + 1))
else
  echo "$PASS_PREFIX Gate 3a: zero finalize/anthropic funcional"
fi
echo ""

echo "--- Gate 3b: DESIGN.md ---"
gate3b_hits=$(grep -RIn "DESIGN\\.md" \
    electron/main/open-design 2>/dev/null \
  | grep -v "__tests__" \
  | grep -v "__snapshots__" \
  | grep -v "// " \
  | grep -v "^\* " \
  | grep -v " \* " \
  | grep -v "nao usa" \
  | grep -v "NAO " \
  | grep -v "proibid" \
  | grep -v "bloque" \
  | grep -v "No consumption" \
  | grep -v "SPEC L" \
  || true)
if [ -n "$gate3b_hits" ]; then
  echo "$FAIL_PREFIX Gate 3b: DESIGN.md ainda consumido:"
  echo "$gate3b_hits"
  fail_count=$((fail_count + 1))
else
  echo "$PASS_PREFIX Gate 3b: zero DESIGN.md funcional"
fi
echo ""

echo "--- Gate 4: endpoints fora do allow-list ---"
gate4_hits=$(grep -nE "fetch.+/api/" electron/main/open-design/adapter-http.ts 2>/dev/null \
  | grep -v "/api/health" \
  | grep -v "/api/projects" \
  | grep -v "/api/runs" \
  | grep -v "/api/lionclaw/" \
  | grep -v "// " \
  | grep -v "^\* " \
  | grep -v " \* " \
  || true)
if [ -n "$gate4_hits" ]; then
  echo "$FAIL_PREFIX Gate 4: endpoint fora do allow-list:"
  echo "$gate4_hits"
  fail_count=$((fail_count + 1))
else
  echo "$PASS_PREFIX Gate 4: endpoints respeitam allow-list"
fi
echo ""

echo "--- Gate 5: openDesign.lock removido ---"
gate5_hits=$(grep -n "openDesign\\.lock\\b\\|openDesign\\.lock:" \
    electron/preload/index.ts src/types/index.ts 2>/dev/null \
  | grep -v "REMOVIDO" \
  | grep -v "removido" \
  | grep -v "// " \
  | grep -v "^\* " \
  | grep -v " \* " \
  | grep -v "comentario" \
  || true)
if [ -n "$gate5_hits" ]; then
  echo "$FAIL_PREFIX Gate 5: openDesign.lock ainda exposto:"
  echo "$gate5_hits"
  fail_count=$((fail_count + 1))
else
  echo "$PASS_PREFIX Gate 5: openDesign.lock removido"
fi
echo ""

gate5b_hits=$(grep -n "ipcRenderer\\.invoke(['\"]open-design:lock['\"]" \
    electron/preload/index.ts 2>/dev/null || true)
if [ -n "$gate5b_hits" ]; then
  echo "$FAIL_PREFIX Gate 5b: open-design:lock invocado pelo preload:"
  echo "$gate5b_hits"
  fail_count=$((fail_count + 1))
else
  echo "$PASS_PREFIX Gate 5b: preload nao chama open-design:lock"
fi
echo ""

echo "--- Gate 6: vitest run (suite open-design + dev-v2 paths + IPC snapshot) ---"
if npx vitest run \
    electron/main/__tests__/open-design-adapter-http.test.ts \
    electron/main/__tests__/open-design-boot-installer.test.ts \
    electron/main/__tests__/open-design-bootstrap.test.ts \
    electron/main/__tests__/open-design-brief-builder.test.ts \
    electron/main/__tests__/open-design-contract.test.ts \
    electron/main/__tests__/open-design-embed-mode-vendor.test.ts \
    electron/main/__tests__/open-design-lock-pipeline.test.ts \
    electron/main/__tests__/open-design-manager-start.test.ts \
    electron/main/__tests__/open-design-manager.test.ts \
    electron/main/__tests__/open-design-pnpm-runner.test.ts \
    electron/main/__tests__/open-design-session-config.test.ts \
    electron/main/__tests__/open-design-sprint5-lock.test.ts \
    electron/main/__tests__/open-design-sprint5.test.ts \
    electron/main/__tests__/open-design-vendor-integration.test.ts \
    electron/main/__tests__/lock.test.ts \
    electron/main/__tests__/pipeline-engine-development-v2-paths.test.ts \
    electron/main/__tests__/ipc-channels-snapshot.test.ts \
    2>&1 | tail -10; then
  echo "$PASS_PREFIX Gate 6: vitest da suite open-design ok"
else
  echo "$FAIL_PREFIX Gate 6: vitest da suite open-design falhou"
  fail_count=$((fail_count + 1))
fi
echo ""

echo "=== Resumo ==="
if [ "$fail_count" -gt 0 ]; then
  echo "$FAIL_PREFIX $fail_count gate(s) falhou(aram)."
  exit 1
fi
echo "$PASS_PREFIX TODOS os 6 gates passaram (SPEC L1242-1249)."
exit 0
