// Unit tests for the deterministic proof-first rules (TRD Section 6).
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCitationGate,
  classifyQuestion,
  countWords,
  gradeConfidence,
  resolveTranscript,
  QUESTION_KINDS,
} from "../lib/engine.mjs";

const sources = [
  { id: 1, independenceKey: "a.example:one" },
  { id: 2, independenceKey: "b.example:two" },
  { id: 3, independenceKey: "c.example:three" },
];

test("classifies supplier, price, news, and out-of-scope questions", () => {
  assert.equal(classifyQuestion("Supplier ini aman nggak?"), QUESTION_KINDS.SUPPLIER);
  assert.equal(classifyQuestion("Harga cabai naik nggak?"), QUESTION_KINDS.PRICE);
  assert.equal(classifyQuestion("Berita viral ini hoaks?"), QUESTION_KINDS.NEWS);
  assert.equal(classifyQuestion("Saham apa yang bagus?"), QUESTION_KINDS.OUT_OF_SCOPE);
});

test("grader refuses weak evidence and caps conflicts", () => {
  assert.equal(
    gradeConfidence({ proposed: "CONFIDENT", sources: [sources[0]], hasConflict: false }),
    "INSUFFICIENT_EVIDENCE",
  );
  assert.equal(
    gradeConfidence({ proposed: "CONFIDENT", sources, hasConflict: true }),
    "MODERATE",
  );
  assert.equal(
    gradeConfidence({ proposed: "CONFIDENT", sources, hasConflict: false }),
    "CONFIDENT",
  );
  assert.equal(
    gradeConfidence({ proposed: "CONFIDENT", sources: sources.slice(0, 2), hasConflict: false }),
    "MODERATE",
  );
  // The grader never upgrades a model judgment of insufficient evidence.
  assert.equal(
    gradeConfidence({ proposed: "INSUFFICIENT_EVIDENCE", sources, hasConflict: false }),
    "INSUFFICIENT_EVIDENCE",
  );
});

test("citation gate rejects uncited claims and long verdicts", () => {
  const uncited = applyCitationGate({
    verdict: "Harga naik.",
    claims: [{ text: "Harga naik", source_ids: [] }],
    risk_flags: [],
    next_action: "Cek lagi besok.",
    confidence: "CONFIDENT",
  }, sources);
  assert.equal(uncited.fatal, true);

  const valid = applyCitationGate({
    verdict: "Harga cabai naik minggu ini.",
    claims: [{ text: "Harga cabai naik", source_ids: [1, 2] }],
    risk_flags: [],
    next_action: "Stok secukupnya untuk 3 hari.",
    confidence: "MODERATE",
    confidence_reason: "Dua sumber mendukung.",
  }, sources);
  assert.equal(valid.ok, true);
  assert.equal(countWords(valid.verdict.verdict) <= 60, true);
});

test("empty transcription falls back to manual entry, never invented text", () => {
  for (const empty of ["", "   ", null, undefined]) {
    const resolved = resolveTranscript(empty);
    assert.equal(resolved.ok, false);
    assert.equal(resolved.transcript, "");
    assert.match(resolved.message, /rekam ulang|ketik/i);
  }
  const resolved = resolveTranscript("  Harga cabai naik nggak?  ");
  assert.equal(resolved.ok, true);
  assert.equal(resolved.transcript, "Harga cabai naik nggak?");
});
