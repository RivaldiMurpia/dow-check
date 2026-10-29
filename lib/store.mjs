// Local JSON persistence for the MVP. It mirrors docs/05-background-schema.md
// (users, queries, media_uploads, sources, verdicts, citations, feedback,
// background_jobs) so the data model can move to Postgres without reshaping.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DB_PATH = join(process.cwd(), "data", "db.json");

function emptyDb() {
  return {
    users: [],
    queries: [],
    mediaUploads: [],
    sources: [],
    verdicts: [],
    citations: [],
    feedback: [],
    backgroundJobs: [],
  };
}

function loadDb() {
  try {
    if (!existsSync(DB_PATH)) return emptyDb();
    return { ...emptyDb(), ...JSON.parse(readFileSync(DB_PATH, "utf8")) };
  } catch {
    return emptyDb();
  }
}

function saveDb(db) {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// Return the single local demo user, creating it on first use.
export function getLocalUser() {
  const db = loadDb();
  let user = db.users[0];
  if (!user) {
    user = { id: randomUUID(), displayName: null, phoneHash: null, createdAt: new Date().toISOString() };
    db.users.push(user);
    saveDb(db);
  }
  return user;
}

export function createQuery({ userId, kind, inputMode, questionText, context, parentQueryId }) {
  const db = loadDb();
  const query = {
    id: randomUUID(),
    userId,
    kind,
    inputMode,
    questionText,
    context: context || null,
    status: "submitted",
    parentQueryId: parentQueryId || null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  db.queries.push(query);
  saveDb(db);
  return query;
}

export function updateQuery(id, patch) {
  const db = loadDb();
  const query = db.queries.find((item) => item.id === id);
  if (!query) return null;
  Object.assign(query, patch);
  saveDb(db);
  return query;
}

export function addJob({ queryId, jobType, status, errorCode }) {
  const db = loadDb();
  const job = {
    id: randomUUID(),
    queryId: queryId || null,
    jobType,
    status: status || "succeeded",
    attempts: 1,
    errorCode: errorCode || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.backgroundJobs.push(job);
  saveDb(db);
  return job;
}

// Persist one full answer: sources, verdict, and the claim-to-source citations.
export function saveVerdict({ queryId, sources, verdict, provider, model }) {
  const db = loadDb();
  const savedSources = (sources || []).map((source) => ({
    ...source,
    dbId: randomUUID(),
    queryId,
  }));
  for (const source of savedSources) db.sources.push(source);

  const savedVerdict = {
    id: randomUUID(),
    queryId,
    verdictText: verdict.verdict,
    riskFlags: verdict.riskFlags || [],
    nextAction: verdict.nextAction,
    confidence: verdict.confidence,
    confidenceReason: verdict.confidenceReason,
    modelProvider: provider,
    modelId: model,
    isRefusal: Boolean(verdict.isRefusal),
    createdAt: new Date().toISOString(),
  };
  db.verdicts.push(savedVerdict);

  for (const [index, claim] of (verdict.claims || []).entries()) {
    const ids = claim.sourceIds || claim.source_ids || [];
    for (const sourceId of ids) {
      const source = savedSources.find((item) => item.id === sourceId);
      if (!source) continue;
      db.citations.push({
        verdictId: savedVerdict.id,
        sourceId: source.dbId,
        claimText: claim.text,
        claimIndex: index,
      });
    }
  }
  saveDb(db);
  return { verdict: savedVerdict, sources: savedSources };
}

export function getQueryDetail(id) {
  const db = loadDb();
  const query = db.queries.find((item) => item.id === id);
  if (!query) return null;
  const verdict = [...db.verdicts].reverse().find((item) => item.queryId === id) || null;
  const sources = db.sources.filter((item) => item.queryId === id);
  return { query, verdict, sources };
}

export function listHistory(userId, limit = 30) {
  const db = loadDb();
  return db.queries
    .filter((item) => item.userId === userId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit)
    .map((query) => {
      const verdict = [...db.verdicts].reverse().find((item) => item.queryId === query.id);
      return {
        id: query.id,
        kind: query.kind,
        inputMode: query.inputMode,
        questionText: query.questionText,
        status: query.status,
        createdAt: query.createdAt,
        confidence: verdict ? verdict.confidence : null,
      };
    });
}

export function saveFeedback({ verdictId, userId, helpful }) {
  const db = loadDb();
  const existing = db.feedback.find((item) => item.verdictId === verdictId && item.userId === userId);
  if (existing) {
    existing.helpful = helpful;
  } else {
    db.feedback.push({ verdictId, userId, helpful, createdAt: new Date().toISOString() });
  }
  saveDb(db);
  return { ok: true };
}

export function saveMedia({ queryId, mediaType, extraction }) {
  const db = loadDb();
  const media = {
    id: randomUUID(),
    queryId: queryId || null,
    mediaType,
    extraction: extraction || null,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    deletedAt: null,
    createdAt: new Date().toISOString(),
  };
  db.mediaUploads.push(media);
  saveDb(db);
  return media;
}
