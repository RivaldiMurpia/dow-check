// Query orchestration: normalize -> classify -> search -> verdict -> gate -> persist.
// The deterministic grader always makes the final confidence call (TRD Section 6).
import {
  applyCitationGate,
  buildRefusal,
  classifyQuestion,
  extractSupplierName,
  gradeConfidence,
  supplierKey,
  QUESTION_KINDS,
  CONFIDENCE,
} from "./engine.mjs";
import {
  buildVerdictExtractive,
  buildVerdictWithMeta,
  enrichSources,
  hasMetaKey,
  searchWeb,
} from "./providers.mjs";
import {
  addJob,
  createQuery,
  getQueryDetail,
  getSupplierMemory,
  rememberSupplier,
  saveVerdict,
  updateQuery,
} from "./store.mjs";

const REFUSAL_NEXT_ACTIONS = {
  supplier_check: "Minta video call di gudang supplier dan foto faktur pembelian terakhir sebelum transfer apa pun.",
  price_trend: "Sebutkan pasar atau daerahnya, lalu coba cek lagi agar harganya bisa dibandingkan.",
  news_claim: "Tunggu konfirmasi dari media yang bisa dicek namanya, jangan teruskan dulu ke grup lain.",
  default: "Tambahkan info yang lebih lengkap, lalu coba cek lagi.",
};

// Run one full question through the proof-first pipeline.
export async function runQuery({ userId, questionText, inputMode, context, parentQueryId }) {
  const startedAt = Date.now();
  const kind = classifyQuestion(questionText);
  const query = await createQuery({
    userId,
    kind,
    inputMode: inputMode || "text",
    questionText,
    context,
    parentQueryId,
  });

  // Follow-ups inherit the parent question and its context (receipt/document),
  // so "how about next week?" is answered against the same evidence base.
  let effectiveContext = context || null;
  if (parentQueryId) {
    const parent = await getQueryDetail(parentQueryId);
    if (parent?.query) {
      effectiveContext = {
        ...(parent.query.context || {}),
        ...(effectiveContext || {}),
        parentQuestion: parent.query.questionText,
      };
    }
  }

  // Supplier memory: look up prior checks for the same named supplier.
  const supplierName = kind === QUESTION_KINDS.SUPPLIER ? extractSupplierName(questionText) : null;
  const key = supplierName ? supplierKey(supplierName) : null;
  const priorMemory = key ? await getSupplierMemory(key) : null;
  const supplierMemory = priorMemory && priorMemory.lastQueryId !== query.id ? priorMemory : null;
  const remember = async (confidence) => {
    if (key && supplierName) {
      await rememberSupplier({ key, name: supplierName, queryId: query.id, confidence });
    }
  };

  if (kind === QUESTION_KINDS.OUT_OF_SCOPE) {
    const refusal = buildRefusal({
      reason: "Pertanyaan ini di luar cek supplier, harga, dan berita dagang.",
      nextAction: "Coba tanyakan soal supplier, harga bahan, atau berita dagang yang mau dicek.",
    });
    refusal.verdict = "Yang ini di luar yang bisa saya cek. Saya bisa bantu cek supplier, harga, atau berita dagang.";
    const saved = await saveVerdict({ queryId: query.id, sources: [], verdict: refusal, provider: "none", model: "none" });
    await updateQuery(query.id, { status: "out_of_scope", completedAt: new Date().toISOString() });
    return { ...(await getQueryDetail(query.id)), savedVerdict: saved.verdict };
  }

  await updateQuery(query.id, { status: "searching" });
  const found = await searchWeb(`${questionText} Indonesia`);
  const sources = await enrichSources(found);
  await addJob({ queryId: query.id, jobType: "search_and_fetch", status: sources.length ? "succeeded" : "failed", errorCode: sources.length ? null : "no_sources" });

  if (sources.length < 2) {
    const refusal = buildRefusal({
      reason: sources.length === 1
        ? "Baru ditemukan 1 sumber, belum cukup untuk jawaban yang aman."
        : "Belum ditemukan sumber publik yang bisa dicek untuk pertanyaan ini.",
      nextAction: REFUSAL_NEXT_ACTIONS[kind] || REFUSAL_NEXT_ACTIONS.default,
    });
    if (sources.length === 1) refusal.riskFlags = ["Baru ada 1 sumber, belum ada pembanding."];
    const saved = await saveVerdict({ queryId: query.id, sources, verdict: refusal, provider: "none", model: "none" });
    await updateQuery(query.id, { status: "done_weak", completedAt: new Date().toISOString() });
    await remember(refusal.confidence);
    return { ...(await getQueryDetail(query.id)), savedVerdict: saved.verdict, supplierMemory, latencyMs: Date.now() - startedAt };
  }

  await updateQuery(query.id, { status: "verifying" });
  let built = null;
  let providerError = null;
  if (hasMetaKey()) {
    try {
      built = await buildVerdictWithMeta({
        question: questionText,
        kind,
        context: supplierMemory
          ? { ...(effectiveContext || {}), supplierMemory }
          : effectiveContext,
        sources,
      });
    } catch (error) {
      providerError = String(error?.message || error);
    }
  }
  if (!built) built = buildVerdictExtractive({ question: questionText, sources });

  if (!built) {
    const refusal = buildRefusal({
      reason: "Sumber ditemukan, tapi belum bisa disusun jadi jawaban yang aman.",
      nextAction: REFUSAL_NEXT_ACTIONS[kind] || REFUSAL_NEXT_ACTIONS.default,
    });
    const saved = await saveVerdict({ queryId: query.id, sources, verdict: refusal, provider: "none", model: "none" });
    await updateQuery(query.id, { status: "done_weak", completedAt: new Date().toISOString() });
    await remember(refusal.confidence);
    return { ...(await getQueryDetail(query.id)), savedVerdict: saved.verdict, supplierMemory, latencyMs: Date.now() - startedAt };
  }

  const gate = applyCitationGate(built.parsed, sources);
  if (gate.fatal) {
    const refusal = buildRefusal({
      reason: "Jawaban awal tidak lolos cek sitasi, jadi ditahan demi keamanan.",
      nextAction: REFUSAL_NEXT_ACTIONS[kind] || REFUSAL_NEXT_ACTIONS.default,
    });
    const saved = await saveVerdict({ queryId: query.id, sources, verdict: refusal, provider: built.provider, model: built.model });
    await updateQuery(query.id, { status: "done_weak", completedAt: new Date().toISOString() });
    await addJob({ queryId: query.id, jobType: "build_verdict", status: "failed", errorCode: gate.errors.join(",") });
    await remember(refusal.confidence);
    return { ...(await getQueryDetail(query.id)), savedVerdict: saved.verdict, supplierMemory, latencyMs: Date.now() - startedAt };
  }

  const finalVerdict = {
    ...gate.verdict,
    claims: gate.verdict.claims.map((claim) => ({
      text: claim.text,
      sourceIds: claim.sourceIds || claim.source_ids || [],
    })),
    confidence: gradeConfidence({
      proposed: gate.verdict.confidence,
      sources,
      hasConflict: false,
    }),
  };
  if (finalVerdict.confidence === CONFIDENCE.INSUFFICIENT) {
    finalVerdict.confidenceReason = "Bukti yang ditemukan belum cukup kuat setelah dicek ulang.";
    // An insufficient verdict must not read as a settled claim (PRD Section 6.1).
    if (!/^(bukti|belum)/i.test(finalVerdict.verdict)) {
      finalVerdict.verdict = `Bukti belum cukup kuat untuk memastikan ini. ${finalVerdict.verdict}`;
    }
  } else if (!finalVerdict.confidenceReason) {
    finalVerdict.confidenceReason = "Didukung sumber yang bisa dicek di bawah.";
  }
  if (providerError) {
    finalVerdict.riskFlags = [...new Set([...(finalVerdict.riskFlags || []), "Model utama sempat gagal, jawaban disusun dari sumber yang ditemukan."])].slice(0, 3);
  }

  const saved = await saveVerdict({ queryId: query.id, sources, verdict: finalVerdict, provider: built.provider, model: built.model });
  await addJob({ queryId: query.id, jobType: "build_verdict", status: "succeeded" });
  await updateQuery(query.id, {
    status: finalVerdict.confidence === CONFIDENCE.INSUFFICIENT ? "done_weak" : "done",
    completedAt: new Date().toISOString(),
  });
  await remember(finalVerdict.confidence);
  return { ...(await getQueryDetail(query.id)), savedVerdict: saved.verdict, supplierMemory, latencyMs: Date.now() - startedAt };
}
