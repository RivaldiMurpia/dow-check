// Media API: receipt photo extraction and voice-note transcription.
// Without a Meta API key it returns an honest needs-manual-entry result
// instead of guessing numbers or audio content (TRD Sections 3.2 and 3.3).
import { NextResponse } from "next/server";
import { resolveTranscript } from "../../../lib/engine.mjs";
import { extractDocument, extractReceipt, hasMetaKey, transcribeAudio } from "../../../lib/providers.mjs";
import { saveMedia } from "../../../lib/store.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const mediaType = String(form.get("mediaType") || "");
    if (!file || typeof file.arrayBuffer !== "function") {
      return NextResponse.json({ error: "missing_file" }, { status: 400 });
    }
    const buffer = Buffer.from(await file.arrayBuffer());

    if (mediaType === "receipt_photo") {
      if (!hasMetaKey()) {
        const media = await saveMedia({ mediaType, extraction: null });
        return NextResponse.json({
          mediaId: media.id,
          needsManualEntry: true,
          extraction: { shop: "", date: "", items: [], uncertain: ["all"] },
          message: "Meta API key belum terisi, jadi struk belum bisa dibaca otomatis. Isi manual dulu ya.",
        });
      }
      const result = await extractReceipt({
        base64: buffer.toString("base64"),
        mimeType: file.type || "image/jpeg",
      });
      const media = await saveMedia({ mediaType, extraction: result.extraction });
      return NextResponse.json({ mediaId: media.id, needsManualEntry: false, extraction: result.extraction });
    }

    if (mediaType === "voice_note") {
      if (!hasMetaKey()) {
        const media = await saveMedia({ mediaType, extraction: null });
        return NextResponse.json({
          mediaId: media.id,
          needsManualEntry: true,
          transcript: "",
          message: "Meta API key belum terisi, jadi suara belum bisa ditranskrip otomatis. Ketik pertanyaannya dulu ya.",
        });
      }
      let result = null;
      try {
        result = await transcribeAudio({
          buffer,
          mimeType: file.type || "audio/webm",
          filename: file.name || "voice.webm",
        });
      } catch {
        result = null;
      }
      const resolved = resolveTranscript(result?.text);
      if (!resolved.ok) {
        // Non-speech or unreadable audio must never become an invented transcript.
        const media = await saveMedia({ mediaType, extraction: null });
        return NextResponse.json({
          mediaId: media.id,
          needsManualEntry: true,
          transcript: "",
          message: resolved.message,
        });
      }
      const media = await saveMedia({ mediaType, extraction: { transcript: resolved.transcript } });
      return NextResponse.json({ mediaId: media.id, needsManualEntry: false, transcript: resolved.transcript });
    }

    if (mediaType === "document_pdf") {
      if (!hasMetaKey()) {
        const media = await saveMedia({ mediaType, extraction: null });
        return NextResponse.json({
          mediaId: media.id,
          needsManualEntry: true,
          documentText: "",
          message: "Meta API key belum terisi, jadi PDF belum bisa dibaca otomatis.",
        });
      }
      let result = null;
      try {
        result = await extractDocument({
          base64: buffer.toString("base64"),
          filename: file.name || "document.pdf",
        });
      } catch {
        result = null;
      }
      if (!result || !result.text) {
        const media = await saveMedia({ mediaType, extraction: null });
        return NextResponse.json({
          mediaId: media.id,
          needsManualEntry: true,
          documentText: "",
          message: "PDF-nya belum bisa dibaca. Coba foto halamannya aja ya.",
        });
      }
      const media = await saveMedia({ mediaType, extraction: { chars: result.text.length } });
      return NextResponse.json({
        mediaId: media.id,
        needsManualEntry: false,
        documentText: result.text,
      });
    }

    return NextResponse.json({ error: "unsupported_media_type" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: "media_failed", detail: String(error?.message || error) },
      { status: 500 },
    );
  }
}
