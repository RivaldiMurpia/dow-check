// Core proof-first engine: classification, citation gate, and confidence grading.
// This module is pure (no network, no filesystem) so it can be unit-tested directly.

export const CONFIDENCE = {
  CONFIDENT: "CONFIDENT",
  MODERATE: "MODERATE",
  INSUFFICIENT: "INSUFFICIENT_EVIDENCE",
};

export const QUESTION_KINDS = {
  SUPPLIER: "supplier_check",
  PRICE: "price_trend",
  NEWS: "news_claim",
  OUT_OF_SCOPE: "out_of_scope",
};

const OUT_OF_SCOPE_PATTERNS = [
  /saham|stock|crypto|kripto|bitcoin|forex|pinjaman online|pinjol/i,
  /obat|diagnos|penyakit|resep dokter/i,
];

const SUPPLIER_PATTERNS = /supplier|pemasok|agen|distributor|kulakan|toko|penjual|aman nggak|aman tidak|percaya|penipu|scam/i;
const PRICE_PATTERNS = /harga|naik|turun|mahal|murah|stok|tren|price|rp\s?\d/i;
const NEWS_PATTERNS = /berita|hoaks|hoax|viral|klaim|broadcast|isu|katanya|benar nggak|bener nggak/i;

// Classify a normalized Indonesian question into one of the supported kinds.
export function classifyQuestion(text) {
  const value = String(text || "").trim();
  if (!value) return QUESTION_KINDS.OUT_OF_SCOPE;
  if (OUT_OF_SCOPE_PATTERNS.some((pattern) => pattern.test(value))) {
    return QUESTION_KINDS.OUT_OF_SCOPE;
  }
  if (SUPPLIER_PATTERNS.test(value)) return QUESTION_KINDS.SUPPLIER;
  if (NEWS_PATTERNS.test(value)) return QUESTION_KINDS.NEWS;
  if (PRICE_PATTERNS.test(value)) return QUESTION_KINDS.PRICE;
  return QUESTION_KINDS.PRICE;
}

// Count words the way the Answer Contract does (citations excluded by caller).
export function countWords(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

// Two sources are independent when their independence keys differ.
export function countIndependentSources(sources) {
  const keys = new Set();
  for (const source of sources || []) {
    keys.add(source.independenceKey || source.publisher || source.url || "");
  }
  keys.delete("");
  return keys.size;
}

// Deterministic confidence grading (see TRD Section 6). The model may propose
// a level, but this function makes the final call.
export function gradeConfidence({ proposed, sources, hasConflict }) {
  const independent = countIndependentSources(sources);
  if (independent < 2) return CONFIDENCE.INSUFFICIENT;
  // The grader may downgrade, never upgrade: a model judgment that the
  // evidence does not prove the claim stands even with many sources.
  if (proposed === CONFIDENCE.INSUFFICIENT) return CONFIDENCE.INSUFFICIENT;
  if (hasConflict) return CONFIDENCE.MODERATE;
  if (proposed === CONFIDENCE.CONFIDENT && independent >= 3) {
    return CONFIDENCE.CONFIDENT;
  }
  return CONFIDENCE.MODERATE;
}

// Citation gate (TRD Section 6): reject or downgrade answers that break the contract.
// Returns { ok, errors, verdict } where verdict is a corrected copy when possible.
export function applyCitationGate(rawVerdict, sources) {
  const errors = [];
  const verdict = {
    verdict: String(rawVerdict?.verdict || "").trim(),
    claims: Array.isArray(rawVerdict?.claims) ? rawVerdict.claims : [],
    riskFlags: Array.isArray(rawVerdict?.riskFlags)
      ? rawVerdict.riskFlags.slice(0, 3)
      : Array.isArray(rawVerdict?.risk_flags)
        ? rawVerdict.risk_flags.slice(0, 3)
        : [],
    nextAction: String(rawVerdict?.nextAction || rawVerdict?.next_action || "").trim(),
    confidence: rawVerdict?.confidence || CONFIDENCE.INSUFFICIENT,
    confidenceReason: String(
      rawVerdict?.confidenceReason || rawVerdict?.confidence_reason || "",
    ).trim(),
  };

  const validSourceIds = new Set((sources || []).map((source) => source.id));
  for (const claim of verdict.claims) {
    const ids = claim.sourceIds || claim.source_ids || [];
    if (!ids.length || !ids.every((id) => validSourceIds.has(id))) {
      errors.push("claim_without_valid_citation");
      break;
    }
  }
  if (!verdict.claims.length) errors.push("no_claims");
  if (countWords(verdict.verdict) > 60) errors.push("verdict_too_long");
  if (!verdict.nextAction) errors.push("missing_next_action");

  // A claim-level failure means the answer cannot be rendered as fact.
  const fatal = errors.includes("claim_without_valid_citation") || errors.includes("no_claims");
  return { ok: !fatal, fatal, errors, verdict };
}

// Resolve a transcription attempt into usable text or an honest manual path.
// Empty or failed transcription must never become an invented transcript.
export function resolveTranscript(transcribedText) {
  const text = String(transcribedText || "").trim();
  if (!text) {
    return {
      ok: false,
      transcript: "",
      message: "Suaranya belum bisa dibaca. Coba rekam ulang di tempat lebih sepi, atau ketik pertanyaannya ya.",
    };
  }
  return { ok: true, transcript: text, message: "" };
}

// Build the honest refusal used whenever evidence is too weak (PRD Section 6.3).
export function buildRefusal({ reason, nextAction }) {
  return {
    verdict: "Bukti belum cukup untuk menjawab ini dengan aman.",
    claims: [],
    riskFlags: [],
    nextAction:
      nextAction ||
      "Tambahkan info yang lebih lengkap, lalu coba cek lagi.",
    confidence: CONFIDENCE.INSUFFICIENT,
    confidenceReason: reason || "Sumber yang ditemukan belum cukup kuat.",
    isRefusal: true,
  };
}
