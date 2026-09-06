#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const VERSION = 'usage-backfill-v1';
const CLAUDE_RUNTIMES = new Set(['cloud', 'zai', 'minimax-tp']);

function emptyUsage() {
  return { inputBase: 0, cacheRead: 0, cacheCreation: 0, output: 0, requests: 0 };
}

export function mergeUsage(target, source) {
  target.inputBase += source.inputBase;
  target.cacheRead += source.cacheRead;
  target.cacheCreation += source.cacheCreation;
  target.output += source.output;
  target.requests += source.requests;
  return target;
}

export function inclusiveInput(usage) {
  return usage.inputBase + usage.cacheRead + usage.cacheCreation;
}

export function calculateBackfillCost(usage, pricing) {
  return Number((
    usage.inputBase * pricing.input / 1e6
    + usage.cacheRead * pricing.cacheRead / 1e6
    + usage.cacheCreation * pricing.cacheCreation / 1e6
    + usage.output * pricing.output / 1e6
  ).toFixed(6));
}

function parseDbTimestamp(value) {
  if (!value) return NaN;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return Date.parse(normalized);
}

function slugifyClaudeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function collectClaudeSessionFile(file, byId) {
  if (!fs.existsSync(file)) return;
  let syntheticSeq = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const message = rec?.message;
    const usage = message?.usage;
    if (!usage) continue;
    const id = message.id || `synthetic:${file}:${++syntheticSeq}`;
    const prev = byId.get(id) ?? {
      inputBase: 0,
      cacheRead: 0,
      cacheCreation: 0,
      output: 0,
      timestamp: Number.POSITIVE_INFINITY,
    };
    const timestamp = Date.parse(rec.timestamp ?? '');
    byId.set(id, {
      inputBase: Math.max(prev.inputBase, usage.input_tokens || 0),
      cacheRead: Math.max(prev.cacheRead, usage.cache_read_input_tokens || 0),
      cacheCreation: Math.max(prev.cacheCreation, usage.cache_creation_input_tokens || 0),
      output: Math.max(prev.output, usage.output_tokens || 0),
      timestamp: Number.isFinite(timestamp) ? Math.min(prev.timestamp, timestamp) : prev.timestamp,
    });
  }
}

export function collectClaudeSessions(projectPath, claudeRoot = path.join(os.homedir(), '.claude', 'projects')) {
  const projectDir = path.join(claudeRoot, slugifyClaudeCwd(projectPath));
  if (!fs.existsSync(projectDir)) return [];
  const sessions = [];
  for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const sessionId = entry.name.slice(0, -'.jsonl'.length);
    const byId = new Map();
    collectClaudeSessionFile(path.join(projectDir, entry.name), byId);
    const subagentsDir = path.join(projectDir, sessionId, 'subagents');
    if (fs.existsSync(subagentsDir)) {
      for (const child of fs.readdirSync(subagentsDir)) {
        if (child.endsWith('.jsonl')) collectClaudeSessionFile(path.join(subagentsDir, child), byId);
      }
    }
    if (byId.size === 0) continue;
    const usage = emptyUsage();
    let minTime = Number.POSITIVE_INFINITY;
    let maxTime = 0;
    for (const item of byId.values()) {
      mergeUsage(usage, { ...item, requests: 1 });
      if (Number.isFinite(item.timestamp)) {
        minTime = Math.min(minTime, item.timestamp);
        maxTime = Math.max(maxTime, item.timestamp);
      }
    }
    sessions.push({ id: sessionId, usage, minTime, maxTime });
  }
  return sessions.sort((a, b) => a.minTime - b.minTime);
}

function deriveKimiWorkdir(projectPath, kimiHome) {
  const abs = path.resolve(projectPath).replace(/\/+$/, '') || '/';
  const slug = path.basename(abs).toLowerCase();
  const hash = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 12);
  return path.join(kimiHome, 'sessions', `wd_${slug}_${hash}`);
}

export function collectKimiSessions(projectPath, kimiHome = path.join(os.homedir(), '.kimi-code')) {
  const workdir = deriveKimiWorkdir(projectPath, kimiHome);
  if (!fs.existsSync(workdir)) return [];
  const sessions = [];
  for (const entry of fs.readdirSync(workdir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('session_')) continue;
    const agentsDir = path.join(workdir, entry.name, 'agents');
    if (!fs.existsSync(agentsDir)) continue;
    const usage = emptyUsage();
    let minTime = Number.POSITIVE_INFINITY;
    let maxTime = 0;
    for (const agent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!agent.isDirectory()) continue;
      const wire = path.join(agentsDir, agent.name, 'wire.jsonl');
      if (!fs.existsSync(wire)) continue;
      for (const line of fs.readFileSync(wire, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec?.type !== 'usage.record' || (rec.usageScope && rec.usageScope !== 'turn')) continue;
        const item = rec.usage;
        if (!item) continue;
        mergeUsage(usage, {
          inputBase: item.inputOther || 0,
          cacheRead: item.inputCacheRead || 0,
          cacheCreation: item.inputCacheCreation || 0,
          output: item.output || 0,
          requests: 1,
        });
        if (Number.isFinite(rec.time)) {
          minTime = Math.min(minTime, rec.time);
          maxTime = Math.max(maxTime, rec.time);
        }
      }
    }
    if (usage.requests > 0) {
      sessions.push({ id: entry.name.slice('session_'.length), usage, minTime, maxTime });
    }
  }
  return sessions.sort((a, b) => a.minTime - b.minTime);
}

function parseMetadata(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function phaseRowsForSprint(rows, sprintIndex) {
  const sprintRows = rows.filter((row) => row.sprint_index === sprintIndex);
  const evaluator = sprintRows.find((row) => /evaluator/i.test(row.agent_id || ''));
  const coder = sprintRows.find((row) => row !== evaluator);
  return { coder, evaluator };
}

function assignSessions(project, rows, rounds, sessions) {
  const assigned = new Map(rows.map((row) => [row.id, { usage: emptyUsage(), sessions: [], modes: new Set() }]));
  const used = new Set();
  const rowBySession = new Map();
  for (const row of rows) {
    const metadata = parseMetadata(row.metadata);
    metadata.tokenStatus = 'reported';
    metadata.costStatus = 'known';
    delete metadata.costUnknownReason;
    if (row.runtime === 'kimi') metadata.costEstimationKind = 'subscription-equivalent-payg';
    for (const sessionId of Array.isArray(metadata.sessionIds) ? metadata.sessionIds : []) {
      rowBySession.set(sessionId, row);
    }
  }
  for (const round of rounds) {
    const pair = phaseRowsForSprint(rows, round.sprint_index);
    if (round.coder_session_id && pair.coder) rowBySession.set(round.coder_session_id, pair.coder);
    if (round.evaluator_session_id && pair.evaluator) rowBySession.set(round.evaluator_session_id, pair.evaluator);
  }
  const put = (session, row, mode) => {
    if (!row || used.has(session.id)) return;
    const target = assigned.get(row.id);
    mergeUsage(target.usage, session.usage);
    target.sessions.push(session.id);
    target.modes.add(mode);
    used.add(session.id);
  };

  for (const session of sessions) put(session, rowBySession.get(session.id), 'session-id');

  for (const round of rounds) {
    const start = parseDbTimestamp(round.started_at) - 30_000;
    const end = parseDbTimestamp(round.completed_at) + 30_000;
    const candidates = sessions.filter((session) => !used.has(session.id) && session.minTime >= start && session.minTime <= end);
    if (candidates.length === 0) continue;
    const { coder, evaluator } = phaseRowsForSprint(rows, round.sprint_index);
    if (!coder || !evaluator) continue;
    if (candidates.length === 1) {
      put(candidates[0], coder, 'round-single');
      continue;
    }
    let split = 1;
    let largestGap = Number.NEGATIVE_INFINITY;
    for (let i = 1; i < candidates.length; i++) {
      const gap = candidates[i].minTime - candidates[i - 1].maxTime;
      if (gap > largestGap) {
        largestGap = gap;
        split = i;
      }
    }
    candidates.forEach((session, index) => put(session, index < split ? coder : evaluator, 'round-window'));
  }

  const preLoopRows = rows
    .filter((row) => row.sprint_index === -1 && Number.isFinite(parseDbTimestamp(row.completed_at)))
    .sort((a, b) => parseDbTimestamp(a.completed_at) - parseDbTimestamp(b.completed_at));
  const projectStart = parseDbTimestamp(project.created_at) - 60_000;
  const projectEnd = parseDbTimestamp(project.updated_at) + 60_000;
  for (const session of sessions) {
    if (used.has(session.id) || session.minTime < projectStart || session.minTime > projectEnd) continue;
    const row = preLoopRows.find((candidate) => session.minTime <= parseDbTimestamp(candidate.completed_at));
    if (row) put(session, row, 'phase-window');
  }

  for (const session of sessions) {
    if (used.has(session.id) || session.minTime < projectStart || session.minTime > projectEnd) continue;
    const nextRound = rounds
      .filter((round) => parseDbTimestamp(round.started_at) >= session.minTime)
      .sort((a, b) => parseDbTimestamp(a.started_at) - parseDbTimestamp(b.started_at))[0];
    if (nextRound && parseDbTimestamp(nextRound.started_at) - session.minTime <= 10 * 60_000) {
      put(session, phaseRowsForSprint(rows, nextRound.sprint_index).coder, 'pre-round');
    }
  }

  const loopRows = rows.filter((row) => row.sprint_index >= 0);
  for (const session of sessions) {
    if (used.has(session.id) || session.minTime < projectStart || session.minTime > projectEnd) continue;
    const nearest = loopRows
      .map((row) => ({ row, distance: Math.abs(session.minTime - parseDbTimestamp(row.completed_at)) }))
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearest && nearest.distance <= 2 * 60 * 60_000) {
      put(session, phaseRowsForSprint(rows, nearest.row.sprint_index).coder, 'nearest-loop');
    }
  }

  return {
    assigned,
    unassigned: sessions.filter((session) => !used.has(session.id) && session.minTime >= projectStart && session.minTime <= projectEnd),
  };
}

function parsePrice(value) {
  if (!value) return null;
  const parts = value.split(',').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error('--price deve ser input,output,cacheRead,cacheCreation');
  }
  return { input: parts[0], output: parts[1], cacheRead: parts[2], cacheCreation: parts[3] };
}

function parseArgs(argv) {
  const options = {
    apply: false,
    repriceCloud: false,
    projects: [],
    db: path.join(os.homedir(), '.lionclaw', 'data', 'lionclaw.db'),
    price: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') options.apply = true;
    else if (argv[i] === '--reprice-cloud') options.repriceCloud = true;
    else if (argv[i] === '--project') options.projects.push(argv[++i]);
    else if (argv[i] === '--db') options.db = argv[++i];
    else if (argv[i] === '--price') options.price = parsePrice(argv[++i]);
    else throw new Error(`argumento desconhecido: ${argv[i]}`);
  }
  if (options.projects.length === 0) throw new Error('informe ao menos um --project <id|nome>');
  return options;
}

function selectProject(db, selector) {
  const rows = db.prepare('SELECT * FROM harness_projects WHERE id = ? OR lower(name) = lower(?)').all(selector, selector);
  if (rows.length !== 1) throw new Error(`projeto nao encontrado ou ambiguo: ${selector}`);
  return rows[0];
}

function runProject(db, project, options) {
  if (project.status !== 'done') throw new Error(`${project.name}: backfill exige projeto concluido`);
  const rows = db.prepare('SELECT * FROM pipeline_phase_metrics WHERE project_id = ? ORDER BY completed_at, phase_number, sprint_index').all(project.id);
  const runtimes = new Set(rows.map((row) => row.runtime).filter(Boolean));
  const source = runtimes.size === 1 && runtimes.has('kimi') ? 'kimi-wire' : 'claude-transcript';
  const supportedRows = rows.filter((row) => source === 'kimi-wire' ? row.runtime === 'kimi' || !row.runtime : CLAUDE_RUNTIMES.has(row.runtime));
  if (supportedRows.length === 0) return { project: project.name, skipped: 'runtime sem fonte de transcript suportada' };
  const sessions = source === 'kimi-wire' ? collectKimiSessions(project.project_path) : collectClaudeSessions(project.project_path);
  if (sessions.length === 0) throw new Error(`${project.name}: nenhum transcript encontrado`);
  const rounds = db.prepare(`
    SELECT s.sprint_index, r.round_number, r.coder_session_id, r.evaluator_session_id, r.started_at, r.completed_at
    FROM harness_rounds r JOIN harness_sprints s ON s.id = r.sprint_id
    WHERE s.project_id = ? ORDER BY s.sprint_index, r.round_number
  `).all(project.id);
  const { assigned, unassigned } = assignSessions(project, supportedRows, rounds, sessions);
  const before = emptyUsage();
  const after = emptyUsage();
  let beforeCost = 0;
  let afterCost = 0;
  const updates = [];
  for (const row of supportedRows) {
    mergeUsage(before, {
      inputBase: Math.max(0, row.input_tokens - row.cache_read_tokens - row.cache_creation_tokens),
      cacheRead: row.cache_read_tokens,
      cacheCreation: row.cache_creation_tokens,
      output: row.output_tokens,
      requests: row.api_requests,
    });
    beforeCost += row.cost_usd || 0;
    const allocation = assigned.get(row.id) ?? { usage: emptyUsage(), sessions: [], modes: new Set() };
    mergeUsage(after, allocation.usage);
    const preserveSdkCost = row.runtime === 'cloud' && !options.repriceCloud;
    if (!preserveSdkCost && !options.price) throw new Error(`${project.name}: --price obrigatorio para runtime ${row.runtime}`);
    const cost = preserveSdkCost ? row.cost_usd : calculateBackfillCost(allocation.usage, options.price);
    afterCost += cost;
    const metadata = parseMetadata(row.metadata);
    metadata.costStatus = 'known';
    metadata.tokenStatus = 'reported';
    delete metadata.costUnknownReason;
    if (!preserveSdkCost) metadata.costSource = 'calculated';
    metadata.historicalUsageBackfill = {
      version: VERSION,
      source,
      appliedAt: new Date().toISOString(),
      attribution: Array.from(allocation.modes),
      sessionIds: allocation.sessions,
      cost: preserveSdkCost ? 'preserved-sdk' : { kind: 'recalculated', pricing: options.price },
    };
    updates.push({
      id: row.id,
      input: inclusiveInput(allocation.usage),
      output: allocation.usage.output,
      cacheRead: allocation.usage.cacheRead,
      cacheCreation: allocation.usage.cacheCreation,
      requests: allocation.usage.requests,
      cost,
      metadata: JSON.stringify(metadata),
    });
  }
  if (options.apply) {
    const update = db.prepare(`
      UPDATE pipeline_phase_metrics SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
        cache_creation_tokens = ?, api_requests = ?, cost_usd = ?, metadata = ?, unknown_cost_count = 0 WHERE id = ?
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of updates) update.run(item.input, item.output, item.cacheRead, item.cacheCreation, item.requests, item.cost, item.metadata, item.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return {
    project: project.name,
    source,
    mode: options.apply ? 'applied' : 'dry-run',
    sessions: sessions.length,
    rowsUpdated: updates.length,
    unassignedSessions: unassigned.map((session) => session.id),
    before: { ...before, input: inclusiveInput(before), total: inclusiveInput(before) + before.output, cost: Number(beforeCost.toFixed(6)) },
    after: { ...after, input: inclusiveInput(after), total: inclusiveInput(after) + after.output, cost: Number(afterCost.toFixed(6)) },
  };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const db = new DatabaseSync(options.db);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const results = options.projects.map((selector) => runProject(db, selectProject(db, selector), options));
    console.log(JSON.stringify(results, null, 2));
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
