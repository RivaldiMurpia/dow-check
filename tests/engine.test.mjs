// Unit tests for the deterministic proof-first rules (TRD Section 6).
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCitationGate,
  buildWhatsAppShare,
  classifyQuestion,
  comparePrice,
  countWords,
  extractPrices,
  gradeConfidence,
  pickMarketPrice,
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

test("extracts rupiah prices and compares them against the market", () => {
  assert.deepEqual(extractPrices("Cabai Rp45.000 per kg, bawang Rp 30rb"), [45000, 30000]);
  assert.equal(pickMarketPrice(["Harga Rp40.000", "Harga Rp44.000", "Harga Rp42.000"]), 42000);
  assert.equal(pickMarketPrice(["tidak ada angka di sini"]), null);
  // Bulk-pack outliers far from the receipt price are discarded first.
  assert.equal(
    pickMarketPrice(["Rp38.000", "Rp323.000 satu dus", "Rp41.000"], 38500),
    41000,
  );
  assert.equal(comparePrice(45000, 42000), "fair");
  assert.equal(comparePrice(55000, 42000), "above_market");
  assert.equal(comparePrice(30000, 42000), "below_market");
  assert.equal(comparePrice(45000, null), "no_benchmark");
});

test("builds an encoded WhatsApp share URL with the full verdict", () => {
  const { text, url } = buildWhatsAppShare({
    statusLabel: "SEDANG — hati-hati ya.",
    verdictText: "Harga cabai naik minggu ini.",
    nextAction: "Stok secukupnya untuk 3 hari.",
    checkedAt: "2026-10-29T03:59:05.509Z",
  });
  assert.match(text, /DOW Check/);
  assert.match(text, /Harga cabai naik/);
  assert.match(text, /Dicek pada 2026-10-29/);
  assert.ok(url.startsWith("https://wa.me/?text="));
  assert.equal(decodeURIComponent(url.slice("https://wa.me/?text=".length)), text);
});
