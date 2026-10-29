"use client";

// dow-check home: Ask (S1), confirmations (S2/S3), progress (S4),
// verdict (S5), insufficient evidence (S6), history (S7), sources (S8).
// User-facing copy is Bahasa Indonesia; code and comments stay in English.
import { useCallback, useEffect, useRef, useState } from "react";
import { animate, stagger } from "animejs";

const REDUCED_MOTION =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const STATUS_LABEL = {
  CONFIDENT: "KUAT — Buktinya cukup kuat.",
  MODERATE: "SEDANG — Buktinya ada, tapi belum lengkap. Hati-hati ya.",
  INSUFFICIENT_EVIDENCE: "BUKTI BELUM CUKUP — Maaf, buktinya belum cukup buat jawab dengan aman.",
};

const PROGRESS_STEPS = [
  "Lagi cek dari beberapa sumber dulu ya…",
  "Lagi membandingkan buktinya…",
  "Lagi menyusun jawaban…",
];

const EXAMPLES = [
  "Supplier nawarin minyak goreng Rp11.000/liter, aman nggak?",
  "Harga cabai merah lagi naik atau turun minggu ini?",
  "Katanya harga beras mau naik bulan ini, bener nggak?",
];

export default function Home() {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [progressIndex, setProgressIndex] = useState(0);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState(null);
  const [transcript, setTranscript] = useState(null);
  const [openSource, setOpenSource] = useState(null);
  const [feedbackDone, setFeedbackDone] = useState(false);
  const timerRef = useRef(null);

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/queries");
      const data = await response.json();
      setHistory(data.history || []);
    } catch { /* history is best-effort on the home screen */ }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  // Entrance motion for the glass cards (anime.js). Skipped for reduced motion.
  useEffect(() => {
    if (REDUCED_MOTION) return;
    animate(".card", {
      opacity: [0, 1],
      translateY: [14, 0],
      duration: 550,
      delay: stagger(80),
      ease: "outCubic",
    });
  }, []);

  // Verdict entrance: card rises, then source chips stagger in.
  useEffect(() => {
    if (!result || REDUCED_MOTION) return;
    animate(".verdict-card", {
      opacity: [0, 1],
      translateY: [16, 0],
      scale: [0.98, 1],
      duration: 500,
      ease: "outCubic",
    });
    animate(".verdict-card .chip", {
      opacity: [0, 1],
      translateY: [8, 0],
      duration: 400,
      delay: stagger(60, { start: 150 }),
      ease: "outCubic",
    });
  }, [result]);

  // Gentle pulse while checking sources, so waiting never feels frozen.
  useEffect(() => {
    if (!busy || REDUCED_MOTION) return undefined;
    const animation = animate(".progress", {
      opacity: [1, 0.45],
      duration: 700,
      loop: true,
      alternate: true,
      ease: "inOutSine",
    });
    return () => animation.pause();
  }, [busy]);

  useEffect(() => {
    if (!busy) return undefined;
    timerRef.current = setInterval(
      () => setProgressIndex((value) => (value + 1) % PROGRESS_STEPS.length),
      2200,
    );
    return () => clearInterval(timerRef.current);
  }, [busy]);

  async function submit(text, inputMode = "text", context = null, parentQueryId = null) {
    const value = String(text || "").trim();
    if (!value || busy) return;
    setBusy(true); setError(""); setResult(null); setFeedbackDone(false); setOpenSource(null);
    try {
      const response = await fetch("/api/queries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionText: value, inputMode, context, parentQueryId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "failed");
      setResult(data);
      await loadHistory();
    } catch {
      setError("Lagi ada gangguan. Pertanyaanmu sudah disimpan, coba lagi sebentar ya.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadMedia(file, mediaType) {
    if (!file || busy) return;
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("mediaType", mediaType);
      const response = await fetch("/api/media", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || data.error || "failed");
      if (mediaType === "receipt_photo") {
        const extraction = data.extraction || { shop: "", date: "", items: [], uncertain: [] };
        setReceipt({
          shop: extraction.shop || "",
          date: extraction.date || "",
          itemsText: (extraction.items || []).map((item) => `${item.name} ${item.price || ""}`.trim()).join("\n"),
          uncertain: extraction.uncertain || [],
          note: data.message || "",
        });
      } else {
        setTranscript({ text: data.transcript || "", note: data.message || "" });
      }
    } catch {
      setError("Upload gagal. Coba lagi ya.");
    } finally {
      setBusy(false);
    }
  }

  async function sendFeedback(helpful) {
    if (!result?.verdict) return;
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdictId: result.verdict.id, helpful }),
    });
    setFeedbackDone(true);
  }

  async function openHistory(id) {
    const response = await fetch(`/api/queries/${id}`);
    const data = await response.json();
    setResult(data); setFeedbackDone(false); setOpenSource(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const verdict = result?.verdict;
  const sources = result?.sources || [];

  return (
    <main className="shell">
      <h1 className="brand">DOW Check</h1>
      <p className="tagline">Cek dulu, baru putuskan. Jawaban kecil, buktinya bisa dicek.</p>

      {/* S1: Ask */}
      <section className="card">
        <label htmlFor="question"><b>Mau cek apa hari ini?</b></label>
        <textarea
          id="question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Contoh: Supplier nawarin minyak goreng Rp11.000/liter, aman nggak?"
        />
        <div className="row">
          <button className="primary" disabled={busy || !question.trim()} onClick={() => submit(question)}>
            Cek sekarang
          </button>
          <label className="chip" role="button">
            Foto struk
            <input type="file" accept="image/*" hidden onChange={(e) => uploadMedia(e.target.files?.[0], "receipt_photo")} />
          </label>
          <label className="chip" role="button">
            Voice note
            <input type="file" accept="audio/*" hidden onChange={(e) => uploadMedia(e.target.files?.[0], "voice_note")} />
          </label>
        </div>
        <div className="chips">
          {EXAMPLES.map((example) => (
            <button key={example} className="chip" onClick={() => setQuestion(example)}>{example}</button>
          ))}
        </div>
        {busy ? <p className="progress" role="status">{PROGRESS_STEPS[progressIndex]}</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </section>

      {/* S2: Receipt confirmation */}
      {receipt ? (
        <section className="card">
          <h2>Hasil bacaan struk</h2>
          {receipt.note ? <p className="muted">{receipt.note}</p> : null}
          {receipt.uncertain?.length ? <p className="muted">Yang ditandai cek lagi ya: {receipt.uncertain.join(", ")}</p> : null}
          <input type="text" aria-label="Nama toko" placeholder="Nama toko" value={receipt.shop}
            onChange={(e) => setReceipt({ ...receipt, shop: e.target.value })} />
          <input type="text" aria-label="Tanggal struk" placeholder="Tanggal (mis. 2026-10-28)" value={receipt.date}
            onChange={(e) => setReceipt({ ...receipt, date: e.target.value })} />
          <textarea aria-label="Isi struk" placeholder={"Satu baris per barang, mis.:\nCabai merah 45000"} value={receipt.itemsText}
            onChange={(e) => setReceipt({ ...receipt, itemsText: e.target.value })} />
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => {
              const context = { shop: receipt.shop, date: receipt.date, items: receipt.itemsText.split("\n").filter(Boolean) };
              submit(question.trim() || `Harga di struk dari ${receipt.shop || "toko ini"} normal nggak?`, "photo", context);
              setReceipt(null);
            }}>Betul, lanjut</button>
            <button className="quiet" onClick={() => setReceipt(null)}>Batal</button>
          </div>
        </section>
      ) : null}

      {/* S3: Transcript confirmation */}
      {transcript ? (
        <section className="card">
          <h2>Hasil transkrip suara</h2>
          {transcript.note ? <p className="muted">{transcript.note}</p> : null}
          <textarea aria-label="Transkrip" value={transcript.text}
            onChange={(e) => setTranscript({ ...transcript, text: e.target.value })}
            placeholder="Ketik pertanyaannya di sini kalau transkripnya kosong." />
          <div className="row">
            <button className="primary" disabled={busy || !transcript.text.trim()} onClick={() => {
              submit(transcript.text, "voice");
              setTranscript(null);
            }}>Betul, lanjut</button>
            <button className="quiet" onClick={() => setTranscript(null)}>Batal</button>
          </div>
        </section>
      ) : null}

      {/* S5/S6: Verdict or insufficient evidence */}
      {verdict ? (
        <section className="card verdict-card" aria-live="polite">
          <span className={`badge ${verdict.confidence}`}>{STATUS_LABEL[verdict.confidence] || verdict.confidence}</span>
          <p className="verdict">{verdict.verdictText}</p>
          <p className="muted">{verdict.confidenceReason}</p>
          {(verdict.riskFlags || []).map((flag) => <p className="risk" key={flag}>⚠ {flag}</p>)}
          <div className="action-box">
            <b>LANGKAH BERIKUTNYA</b>
            {verdict.nextAction}
          </div>
          <b>Buktinya:</b>
          <div className="chips">
            {sources.length ? sources.map((source) => (
              <button key={source.dbId || source.id} className="chip" onClick={() => setOpenSource(source)}>
                [{source.id}] {source.publisher}
              </button>
            )) : <span className="muted">Belum ada sumber yang cukup kuat.</span>}
          </div>
          {/* S8: Source detail */}
          {openSource ? (
            <div>
              <p><b>{openSource.title}</b></p>
              <p className="muted">{openSource.publisher} · Dicek pada {String(openSource.fetchedAt || "").slice(0, 10)}</p>
              <p>{String(openSource.fetchedText || openSource.snippet || "").slice(0, 500)}</p>
              <a href={openSource.url} target="_blank" rel="noreferrer">Buka situs aslinya</a>
            </div>
          ) : null}
          <div className="row">
            <span>Membantu?</span>
            <button disabled={feedbackDone} onClick={() => sendFeedback(true)}>Ya</button>
            <button disabled={feedbackDone} onClick={() => sendFeedback(false)}>Kurang</button>
            {feedbackDone ? <span className="muted">Makasih ya.</span> : null}
          </div>
          <div className="row">
            <button className="quiet" onClick={() => result?.query && submit(question, "text", null, result.query.id)}>
              Tanya lanjutan soal ini
            </button>
            <button className="quiet" onClick={() => { setResult(null); setQuestion(""); }}>
              Mulai pertanyaan baru
            </button>
          </div>
          <p className="muted">Sumber jawaban: {verdict.modelProvider} · {verdict.modelId}</p>
        </section>
      ) : null}

      {/* S7: History */}
      <section className="card">
        <h2>Riwayat cek</h2>
        {history.length ? history.map((item) => (
          <button key={item.id} className="history-item" onClick={() => openHistory(item.id)}>
            {item.questionText}
            <span className="muted"> · {String(item.createdAt).slice(0, 10)}{item.confidence ? ` · ${item.confidence}` : ""}</span>
          </button>
        )) : <p className="muted">Belum ada riwayat. Coba cek satu hal di atas ya.</p>}
      </section>
    </main>
  );
}
