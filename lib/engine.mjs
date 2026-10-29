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

// Extract plausible Indonesian price amounts (in rupiah) from source text.
// Handles "Rp45.000", "Rp 45rb", "Rp100 ribu", and plain "45000 per kg".
export function extractPrices(text) {
  const value = String(text || "");
  const prices = [];
  const patterns = [
    /rp\s?(\d{1,3}(?:\.\d{3})+|\d{4,6})(?!\d)/gi,
    /rp\s?(\d+(?:[.,]\d+)?)\s?(rb|ribu)/gi,
    /(\d{1,3}(?:\.\d{3})+|\d{4,6})\s?(?:per\s?kg|\/kg|rupiah)/gi,
  ];
  for (const match of value.matchAll(patterns[0])) {
    prices.push(Number(match[1].replace(/\./g, "")));
  }
  for (const match of value.matchAll(patterns[1])) {
    prices.push(Math.round(Number(match[1].replace(",", ".")) * 1000));
  }
  for (const match of value.matchAll(patterns[2])) {
    prices.push(Number(match[1].replace(/\./g, "")));
  }
  return [...new Set(prices.filter((price) => price >= 1000 && price <= 2000000))];
}

// Pick a market price for one receipt item from fetched source texts.
// Returns the median candidate so one outlier page cannot dominate. When the
// receipt price is known, candidates far outside its range (bulk packs,
// unrelated products) are discarded first.
export function pickMarketPrice(texts, receiptPrice) {
  const all = (texts || []).flatMap((text) => extractPrices(text));
  if (!all.length) return null;
  let candidates = all;
  if (receiptPrice) {
    const plausible = all.filter(
      (price) => price >= receiptPrice * 0.3 && price <= receiptPrice * 3,
    );
    if (plausible.length) candidates = plausible;
  }
  const sorted = [...candidates].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Compare one receipt price against a market price (null market = no benchmark).
export function comparePrice(receiptPrice, marketPrice) {
  if (!marketPrice || !receiptPrice) return "no_benchmark";
  const ratio = receiptPrice / marketPrice;
  if (ratio >= 1.15) return "above_market";
  if (ratio <= 0.85) return "below_market";
  return "fair";
}

// Encode mono Float32 samples as a 16-bit PCM WAV file (pure, testable).
// The browser uses this to convert voice notes to WAV before upload, so the
// server never needs ffmpeg for transcription (Meta ASR only accepts WAV).
export function encodeWav(samples, sampleRate = 16000) {
  const dataLength = samples.length * 2;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataLength, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return bytes;
}

// Extract a supplier/shop name from a supplier question, for memory lookups.
// Returns a display name or null when no name can be identified honestly.
const SUPPLIER_STOPWORDS = new Set([
  "nawarin", "menawarkan", "kasih", "jual", "harga", "aman", "nggak", "tidak",
  "buat", "untuk", "transfer", "dp", "per", "kg", "liter", "murah", "promo",
]);

export function extractSupplierName(question) {
  const value = String(question || "");
  const match = value.match(
    /(?:supplier|pemasok|distributor|agen|toko|pt\.?|cv\.?|ud\.?)\s+([A-Za-z0-9&'. ]{3,48})/i,
  );
  if (!match) return null;
  const tokens = match[1].trim().split(/\s+/);
  const kept = [];
  for (const token of tokens) {
    if (SUPPLIER_STOPWORDS.has(token.toLowerCase())) break;
    kept.push(token);
    if (kept.length >= 4) break;
  }
  const name = kept.join(" ").replace(/[.,]+$/, "").trim();
  return name.length >= 3 ? name : null;
}

// Normalize a supplier name into a stable memory key.
export function supplierKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Outcome tracking: what the merchant finally decided after a verdict.
// This closes the decision loop that plain Q&A products never have.
export const OUTCOMES = {
  BOUGHT: "bought",
  NOT_BOUGHT: "not_bought",
  UNDECIDED: "undecided",
};

export function isValidOutcome(value) {
  return Object.values(OUTCOMES).includes(value);
}

export const OUTCOME_LABELS = {
  bought: "Jadi beli / transfer",
  not_bought: "Nggak jadi",
  undecided: "Belum mutusin",
};

// Build the WhatsApp share text and URL for a verdict (pure, testable).
export function buildWhatsAppShare({ statusLabel, verdictText, nextAction, checkedAt }) {
  const text = [
    `*DOW Check* — ${statusLabel}`,
    "",
    verdictText,
    "",
    `Langkah berikutnya: ${nextAction}`,
    "",
    `Dicek pada ${String(checkedAt || "").slice(0, 10)} · Buktinya ada di aplikasi DOW Check.`,
  ].join("\n");
  return { text, url: `https://wa.me/?text=${encodeURIComponent(text)}` };
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
