
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';


const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY env var is required');
  process.exit(1);
}

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMS = 1536;
const BATCH_SIZE = 8;
const BATCH_DELAY_MS = 200;

const DB_PATH = path.join(os.homedir(), '.lionclaw', 'data', 'lionclaw.db');


const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
sqliteVec.load(db);


const selectMissing = db.prepare<[]>(
  `SELECT id, content FROM semantic_memories WHERE embedding IS NULL AND content IS NOT NULL`
);

const updateEmbedding = db.prepare<[Buffer, number]>(
  `UPDATE semantic_memories SET embedding = ? WHERE id = ?`
);

const deleteVec = db.prepare<[string]>(
  `DELETE FROM semantic_memories_vec WHERE id = ?`
);

const insertVec = db.prepare<[string, Buffer]>(
  `INSERT INTO semantic_memories_vec (id, embedding) VALUES (?, ?)`
);


async function fetchEmbeddings(texts: string[]): Promise<number[][]> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
      dimensions: EMBEDDING_DIMS,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${body}`);
  }

  const json = (await res.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
  };

  return json.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}


function normalizeL2(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}


interface Row {
  id: number;
  content: string;
}

async function main(): Promise<void> {
  const rows = selectMissing.all() as Row[];
  const total = rows.length;

  if (total === 0) {
    console.log('No rows with missing embeddings. Nothing to do.');
    return;
  }

  console.log(`Found ${total} rows with missing embeddings.\n`);

  let success = 0;
  let failures = 0;

  for (let i = 0; i < total; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    let embeddings: number[][];
    try {
      embeddings = await fetchEmbeddings(batch.map((r) => r.content));
    } catch (err) {
      console.error(`Batch ${i}-${i + batch.length - 1} failed:`, err);
      failures += batch.length;
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      const row = batch[j];
      try {
        const normalized = normalizeL2(embeddings[j]);
        const buf = Buffer.from(new Float32Array(normalized).buffer);
        const vecId = String(row.id);

        db.transaction(() => {
          updateEmbedding.run(buf, row.id);
          try { deleteVec.run(vecId); } catch { /* may not exist */ }
          insertVec.run(vecId, buf);
        })();

        success++;
        console.log(`Reindexed ${success + failures}/${total} (id=${row.id})`);
      } catch (err) {
        failures++;
        console.error(`Row id=${row.id} failed:`, err);
      }
    }

    if (i + BATCH_SIZE < total) {
      await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  console.log(`\nDone. Total: ${total} | Success: ${success} | Failures: ${failures}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
}).finally(() => {
  db.close();
});
