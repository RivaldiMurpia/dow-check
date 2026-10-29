// Persistence for dow-check. When DATABASE_URL (or POSTGRES_URL) is set, data
// lives in Neon Postgres (durable, including on Vercel). Without it, the store
// falls back to a local JSON file so development keeps working offline.
// Both modes expose the same async API and mirror docs/05-background-schema.md.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractSupplierName, supplierKey } from "./engine.mjs";

const databaseUrl =
  process.env.DATABASE_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_URL ||
  process.env.NEON_DATABASE_URL ||
  "";

let sqlPromise = null;

// Lazily create the Neon client so local JSON mode never loads the driver.
function getSql() {
  if (!databaseUrl) return Promise.resolve(null);
  if (!sqlPromise) {
    sqlPromise = import("@neondatabase/serverless").then(({ neon }) => neon(databaseUrl));
  }
  return sqlPromise;
}

export function usingDatabase() {
  return Boolean(databaseUrl);
}

// ---------------------------------------------------------------------------
// Postgres (Neon) mode
// ---------------------------------------------------------------------------

let schemaReady = null;

function ensureSchema(sql) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`create table if not exists users (
        id uuid primary key, display_name text, phone_hash text, created_at timestamptz)`;
      await sql`create table if not exists queries (
        id uuid primary key, user_id uuid, kind text, input_mode text,
        question_text text, context jsonb, status text, parent_query_id uuid,
        created_at timestamptz, completed_at timestamptz)`;
      await sql`create table if not exists media_uploads (
        id uuid primary key, query_id uuid, media_type text, extraction jsonb,
        expires_at timestamptz, deleted_at timestamptz, created_at timestamptz)`;
      await sql`create table if not exists sources (
        db_id uuid primary key, query_id uuid, source_no int, url text, title text,
        publisher text, published_at text, snippet text, fetched_text text,
        fetched_at text, independence_key text)`;
      await sql`create table if not exists verdicts (
        id uuid primary key, query_id uuid, verdict_text text, risk_flags jsonb,
        next_action text, confidence text, confidence_reason text,
        model_provider text, model_id text, is_refusal boolean, created_at timestamptz)`;
      await sql`create table if not exists citations (
        verdict_id uuid, source_id uuid, claim_text text, claim_index int)`;
      await sql`create table if not exists feedback (
        verdict_id uuid, user_id uuid, helpful boolean, created_at timestamptz,
        unique (verdict_id, user_id))`;
      await sql`create table if not exists background_jobs (
        id uuid primary key, query_id uuid, job_type text, status text,
        attempts int, error_code text, created_at timestamptz, updated_at timestamptz)`;
      await sql`create table if not exists suppliers (
        key text primary key, name text, check_count int, first_checked_at timestamptz,
        last_confidence text, last_checked_at timestamptz, last_query_id uuid)`;
      await sql`create index if not exists idx_queries_user on queries (user_id, created_at desc)`;
      await sql`create index if not exists idx_sources_query on sources (query_id)`;
    })();
  }
  return schemaReady;
}

// Return the Neon client with the schema in place, or null in JSON mode.
async function db() {
  const sql = await getSql();
  if (!sql) return null;
  await ensureSchema(sql);
  return sql;
}

async function pgGetLocalUser() {
  const sql = await db();
  const rows = await sql`select id, display_name, phone_hash, created_at from users limit 1`;
  if (rows.length) {
    const r = rows[0];
    return { id: r.id, displayName: r.display_name, phoneHash: r.phone_hash, createdAt: new Date(r.created_at).toISOString() };
  }
  const user = { id: randomUUID(), displayName: null, phoneHash: null, createdAt: new Date().toISOString() };
  await sql`insert into users (id, display_name, phone_hash, created_at)
    values (${user.id}, ${user.displayName}, ${user.phoneHash}, ${user.createdAt})`;
  return user;
}

function rowToQuery(r) {
  if (!r) return null;
  return {
    id: r.id, userId: r.user_id, kind: r.kind, inputMode: r.input_mode,
    questionText: r.question_text, context: r.context || null, status: r.status,
    parentQueryId: r.parent_query_id || null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
  };
}

function rowToVerdict(r) {
  if (!r) return null;
  return {
    id: r.id, queryId: r.query_id, verdictText: r.verdict_text,
    riskFlags: r.risk_flags || [], nextAction: r.next_action,
    confidence: r.confidence, confidenceReason: r.confidence_reason,
    modelProvider: r.model_provider, modelId: r.model_id,
    isRefusal: Boolean(r.is_refusal),
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  };
}

function rowToSource(r) {
  return {
    id: r.source_no, dbId: r.db_id, queryId: r.query_id, url: r.url, title: r.title,
    publisher: r.publisher, publishedAt: r.published_at, snippet: r.snippet,
    fetchedText: r.fetched_text, fetchedAt: r.fetched_at,
    independenceKey: r.independence_key,
  };
}

async function pgCreateQuery({ userId, kind, inputMode, questionText, context, parentQueryId }) {
  const sql = await db();
  const query = {
    id: randomUUID(), userId, kind, inputMode, questionText,
    context: context || null, status: "submitted",
    parentQueryId: parentQueryId || null,
    createdAt: new Date().toISOString(), completedAt: null,
  };
  await sql`insert into queries (id, user_id, kind, input_mode, question_text, context, status, parent_query_id, created_at, completed_at)
    values (${query.id}, ${userId}, ${kind}, ${inputMode}, ${questionText},
      ${context ? JSON.stringify(context) : null}::jsonb, ${query.status},
      ${query.parentQueryId}, ${query.createdAt}, ${query.completedAt})`;
  return query;
}

async function pgUpdateQuery(id, patch) {
  const sql = await db();
  const current = rowToQuery((await sql`select * from queries where id = ${id}`)[0]);
  if (!current) return null;
  const next = { ...current, ...patch };
  await sql`update queries set status = ${next.status},
      completed_at = ${next.completedAt}, question_text = ${next.questionText},
      context = ${next.context ? JSON.stringify(next.context) : null}::jsonb
    where id = ${id}`;
  return next;
}

async function pgAddJob({ queryId, jobType, status, errorCode }) {
  const sql = await db();
  const job = {
    id: randomUUID(), queryId: queryId || null, jobType,
    status: status || "succeeded", attempts: 1, errorCode: errorCode || null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await sql`insert into background_jobs (id, query_id, job_type, status, attempts, error_code, created_at, updated_at)
    values (${job.id}, ${job.queryId}, ${jobType}, ${job.status}, 1, ${job.errorCode}, ${job.createdAt}, ${job.updatedAt})`;
  return job;
}

async function pgSaveVerdict({ queryId, sources, verdict, provider, model }) {
  const sql = await db();
  const savedSources = [];
  for (const source of sources || []) {
    const saved = { ...source, dbId: randomUUID(), queryId };
    await sql`insert into sources (db_id, query_id, source_no, url, title, publisher, published_at, snippet, fetched_text, fetched_at, independence_key)
      values (${saved.dbId}, ${queryId}, ${source.id}, ${source.url}, ${source.title},
        ${source.publisher}, ${source.publishedAt || null}, ${source.snippet || ""},
        ${source.fetchedText || ""}, ${source.fetchedAt || new Date().toISOString()},
        ${source.independenceKey || ""})`;
    savedSources.push(saved);
  }
  const savedVerdict = {
    id: randomUUID(), queryId, verdictText: verdict.verdict,
    riskFlags: verdict.riskFlags || [], nextAction: verdict.nextAction,
    confidence: verdict.confidence, confidenceReason: verdict.confidenceReason,
    modelProvider: provider, modelId: model, isRefusal: Boolean(verdict.isRefusal),
    createdAt: new Date().toISOString(),
  };
  await sql`insert into verdicts (id, query_id, verdict_text, risk_flags, next_action, confidence, confidence_reason, model_provider, model_id, is_refusal, created_at)
    values (${savedVerdict.id}, ${queryId}, ${savedVerdict.verdictText},
      ${JSON.stringify(savedVerdict.riskFlags)}::jsonb, ${savedVerdict.nextAction},
      ${savedVerdict.confidence}, ${savedVerdict.confidenceReason},
      ${provider}, ${model}, ${savedVerdict.isRefusal}, ${savedVerdict.createdAt})`;
  for (const [index, claim] of (verdict.claims || []).entries()) {
    const ids = claim.sourceIds || claim.source_ids || [];
    for (const sourceId of ids) {
      const source = savedSources.find((item) => item.id === sourceId);
      if (!source) continue;
      await sql`insert into citations (verdict_id, source_id, claim_text, claim_index)
        values (${savedVerdict.id}, ${source.dbId}, ${claim.text}, ${index})`;
    }
  }
  return { verdict: savedVerdict, sources: savedSources };
}

async function pgGetSupplierMemory(key) {
  if (!key) return null;
  const sql = await db();
  const r = (await sql`select * from suppliers where key = ${key}`)[0];
  if (!r) return null;
  return {
    name: r.name, checkCount: r.check_count, lastConfidence: r.last_confidence,
    lastCheckedAt: r.last_checked_at ? new Date(r.last_checked_at).toISOString() : null,
    lastQueryId: r.last_query_id,
  };
}

async function pgRememberSupplier({ key, name, queryId, confidence }) {
  if (!key || !name) return null;
  const sql = await db();
  const now = new Date().toISOString();
  await sql`insert into suppliers (key, name, check_count, first_checked_at, last_confidence, last_checked_at, last_query_id)
    values (${key}, ${name}, 1, ${now}, ${confidence}, ${now}, ${queryId})
    on conflict (key) do update set name = excluded.name,
      check_count = suppliers.check_count + 1,
      last_confidence = excluded.last_confidence,
      last_checked_at = excluded.last_checked_at,
      last_query_id = excluded.last_query_id`;
  return pgGetSupplierMemory(key);
}

async function pgGetQueryDetail(id) {
  const sql = await db();
  const query = rowToQuery((await sql`select * from queries where id = ${id}`)[0]);
  if (!query) return null;
  const verdict = rowToVerdict(
    (await sql`select * from verdicts where query_id = ${id} order by created_at desc limit 1`)[0],
  );
  const sources = (await sql`select * from sources where query_id = ${id} order by source_no asc`).map(rowToSource);
  let supplierMemory = null;
  if (query.kind === "supplier_check") {
    const name = extractSupplierName(query.questionText);
    const memory = name ? await pgGetSupplierMemory(supplierKey(name)) : null;
    if (memory && (memory.checkCount > 1 || memory.lastQueryId !== id)) supplierMemory = memory;
  }
  return { query, verdict, sources, supplierMemory };
}

async function pgListHistory(userId, limit = 30) {
  const sql = await db();
  const rows = await sql`select q.*, v.confidence as v_confidence, v.verdict_text as v_text
    from queries q
    left join lateral (
      select confidence, verdict_text from verdicts
      where query_id = q.id order by created_at desc limit 1
    ) v on true
    where q.user_id = ${userId}
    order by q.created_at desc limit ${limit}`;
  return rows.map((r) => ({
    id: r.id, kind: r.kind, inputMode: r.input_mode, questionText: r.question_text,
    status: r.status,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    confidence: r.v_confidence || null, verdictText: r.v_text || null,
  }));
}

async function pgSaveFeedback({ verdictId, userId, helpful }) {
  const sql = await db();
  await sql`insert into feedback (verdict_id, user_id, helpful, created_at)
    values (${verdictId}, ${userId}, ${helpful}, ${new Date().toISOString()})
    on conflict (verdict_id, user_id) do update set helpful = excluded.helpful`;
  return { ok: true };
}

async function pgSaveMedia({ queryId, mediaType, extraction }) {
  const sql = await db();
  const media = {
    id: randomUUID(), queryId: queryId || null, mediaType,
    extraction: extraction || null,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    deletedAt: null, createdAt: new Date().toISOString(),
  };
  await sql`insert into media_uploads (id, query_id, media_type, extraction, expires_at, deleted_at, created_at)
    values (${media.id}, ${media.queryId}, ${mediaType},
      ${extraction ? JSON.stringify(extraction) : null}::jsonb,
      ${media.expiresAt}, ${media.deletedAt}, ${media.createdAt})`;
  return media;
}

// ---------------------------------------------------------------------------
// Local JSON fallback (no DATABASE_URL): file on disk locally, /tmp plus
// in-memory on serverless. Data here is ephemeral by design.
// ---------------------------------------------------------------------------

const DB_PATH = process.env.VERCEL
  ? join(tmpdir(), "dow-check-db.json")
  : join(process.cwd(), "data", "db.json");

let memoryDb = null;

function emptyDb() {
  return {
    users: [], queries: [], mediaUploads: [], sources: [], verdicts: [],
    citations: [], feedback: [], backgroundJobs: [], suppliers: [],
  };
}

function loadDb() {
  if (memoryDb) return memoryDb;
  try {
    if (!existsSync(DB_PATH)) return emptyDb();
    return { ...emptyDb(), ...JSON.parse(readFileSync(DB_PATH, "utf8")) };
  } catch {
    return emptyDb();
  }
}

function saveDbFile(dbData) {
  memoryDb = dbData;
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    writeFileSync(DB_PATH, JSON.stringify(dbData, null, 2));
  } catch { /* keep serving from memory */ }
}

function jsonGetLocalUser() {
  const dbData = loadDb();
  let user = dbData.users[0];
  if (!user) {
    user = { id: randomUUID(), displayName: null, phoneHash: null, createdAt: new Date().toISOString() };
    dbData.users.push(user);
    saveDbFile(dbData);
  }
  return user;
}

function jsonCreateQuery({ userId, kind, inputMode, questionText, context, parentQueryId }) {
  const dbData = loadDb();
  const query = {
    id: randomUUID(), userId, kind, inputMode, questionText,
    context: context || null, status: "submitted",
    parentQueryId: parentQueryId || null,
    createdAt: new Date().toISOString(), completedAt: null,
  };
  dbData.queries.push(query);
  saveDbFile(dbData);
  return query;
}

function jsonUpdateQuery(id, patch) {
  const dbData = loadDb();
  const query = dbData.queries.find((item) => item.id === id);
  if (!query) return null;
  Object.assign(query, patch);
  saveDbFile(dbData);
  return query;
}

function jsonAddJob({ queryId, jobType, status, errorCode }) {
  const dbData = loadDb();
  const job = {
    id: randomUUID(), queryId: queryId || null, jobType,
    status: status || "succeeded", attempts: 1, errorCode: errorCode || null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  dbData.backgroundJobs.push(job);
  saveDbFile(dbData);
  return job;
}

function jsonSaveVerdict({ queryId, sources, verdict, provider, model }) {
  const dbData = loadDb();
  const savedSources = (sources || []).map((source) => ({ ...source, dbId: randomUUID(), queryId }));
  for (const source of savedSources) dbData.sources.push(source);
  const savedVerdict = {
    id: randomUUID(), queryId, verdictText: verdict.verdict,
    riskFlags: verdict.riskFlags || [], nextAction: verdict.nextAction,
    confidence: verdict.confidence, confidenceReason: verdict.confidenceReason,
    modelProvider: provider, modelId: model, isRefusal: Boolean(verdict.isRefusal),
    createdAt: new Date().toISOString(),
  };
  dbData.verdicts.push(savedVerdict);
  for (const [index, claim] of (verdict.claims || []).entries()) {
    const ids = claim.sourceIds || claim.source_ids || [];
    for (const sourceId of ids) {
      const source = savedSources.find((item) => item.id === sourceId);
      if (!source) continue;
      dbData.citations.push({ verdictId: savedVerdict.id, sourceId: source.dbId, claimText: claim.text, claimIndex: index });
    }
  }
  saveDbFile(dbData);
  return { verdict: savedVerdict, sources: savedSources };
}

function jsonGetSupplierMemory(key) {
  if (!key) return null;
  const dbData = loadDb();
  const supplier = (dbData.suppliers || []).find((item) => item.key === key);
  if (!supplier) return null;
  return {
    name: supplier.name, checkCount: supplier.checkCount,
    lastConfidence: supplier.lastConfidence, lastCheckedAt: supplier.lastCheckedAt,
    lastQueryId: supplier.lastQueryId,
  };
}

function jsonRememberSupplier({ key, name, queryId, confidence }) {
  if (!key || !name) return null;
  const dbData = loadDb();
  dbData.suppliers = dbData.suppliers || [];
  let supplier = dbData.suppliers.find((item) => item.key === key);
  const now = new Date().toISOString();
  if (!supplier) {
    supplier = { key, name, checkCount: 0, firstCheckedAt: now, lastConfidence: null, lastCheckedAt: null, lastQueryId: null };
    dbData.suppliers.push(supplier);
  }
  supplier.name = name;
  supplier.checkCount += 1;
  supplier.lastConfidence = confidence;
  supplier.lastCheckedAt = now;
  supplier.lastQueryId = queryId;
  saveDbFile(dbData);
  return supplier;
}

function jsonGetQueryDetail(id) {
  const dbData = loadDb();
  const query = dbData.queries.find((item) => item.id === id);
  if (!query) return null;
  const verdict = [...dbData.verdicts].reverse().find((item) => item.queryId === id) || null;
  const sources = dbData.sources.filter((item) => item.queryId === id);
  let supplierMemory = null;
  if (query.kind === "supplier_check") {
    const name = extractSupplierName(query.questionText);
    const memory = name ? jsonGetSupplierMemory(supplierKey(name)) : null;
    if (memory && (memory.checkCount > 1 || memory.lastQueryId !== id)) supplierMemory = memory;
  }
  return { query, verdict, sources, supplierMemory };
}

function jsonListHistory(userId, limit = 30) {
  const dbData = loadDb();
  return dbData.queries
    .filter((item) => item.userId === userId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit)
    .map((query) => {
      const verdict = [...dbData.verdicts].reverse().find((item) => item.queryId === query.id);
      return {
        id: query.id, kind: query.kind, inputMode: query.inputMode,
        questionText: query.questionText, status: query.status, createdAt: query.createdAt,
        confidence: verdict ? verdict.confidence : null,
        verdictText: verdict ? verdict.verdictText : null,
      };
    });
}

function jsonSaveFeedback({ verdictId, userId, helpful }) {
  const dbData = loadDb();
  const existing = dbData.feedback.find((item) => item.verdictId === verdictId && item.userId === userId);
  if (existing) existing.helpful = helpful;
  else dbData.feedback.push({ verdictId, userId, helpful, createdAt: new Date().toISOString() });
  saveDbFile(dbData);
  return { ok: true };
}

function jsonSaveMedia({ queryId, mediaType, extraction }) {
  const dbData = loadDb();
  const media = {
    id: randomUUID(), queryId: queryId || null, mediaType,
    extraction: extraction || null,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    deletedAt: null, createdAt: new Date().toISOString(),
  };
  dbData.mediaUploads.push(media);
  saveDbFile(dbData);
  return media;
}

// ---------------------------------------------------------------------------
// Public async API: Neon when configured, JSON fallback otherwise.
// ---------------------------------------------------------------------------

export async function getLocalUser() {
  return (await db()) ? pgGetLocalUser() : jsonGetLocalUser();
}
export async function createQuery(input) {
  return (await db()) ? pgCreateQuery(input) : jsonCreateQuery(input);
}
export async function updateQuery(id, patch) {
  return (await db()) ? pgUpdateQuery(id, patch) : jsonUpdateQuery(id, patch);
}
export async function addJob(input) {
  return (await db()) ? pgAddJob(input) : jsonAddJob(input);
}
export async function saveVerdict(input) {
  return (await db()) ? pgSaveVerdict(input) : jsonSaveVerdict(input);
}
export async function getSupplierMemory(key) {
  return (await db()) ? pgGetSupplierMemory(key) : jsonGetSupplierMemory(key);
}
export async function rememberSupplier(input) {
  return (await db()) ? pgRememberSupplier(input) : jsonRememberSupplier(input);
}
export async function getQueryDetail(id) {
  return (await db()) ? pgGetQueryDetail(id) : jsonGetQueryDetail(id);
}
export async function listHistory(userId, limit) {
  return (await db()) ? pgListHistory(userId, limit) : jsonListHistory(userId, limit);
}
export async function saveFeedback(input) {
  return (await db()) ? pgSaveFeedback(input) : jsonSaveFeedback(input);
}
export async function saveMedia(input) {
  return (await db()) ? pgSaveMedia(input) : jsonSaveMedia(input);
}
