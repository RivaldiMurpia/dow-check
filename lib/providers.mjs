// External providers: web search, Meta Model API verdicts, transcription, and extraction.
// Every provider sits behind a small interface so vendors can be swapped (TRD Section 4).
// Without keys the app still runs: search degrades honestly and the verdict
// builder becomes extractive over whatever real sources were found.

function independenceKeyFor(url, title) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const slug = String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60);
    return `${host}:${slug}`;
  } catch {
    return String(url || title || "");
  }
}

function normalizeSources(items) {
  return (items || []).slice(0, 6).map((item, index) => ({
    id: index + 1,
    url: item.url,
    title: item.title || item.url,
    publisher: item.publisher || (() => {
      try { return new URL(item.url).hostname.replace(/^www\./, ""); } catch { return "web"; }
    })(),
    publishedAt: item.publishedAt || item.published_at || null,
    snippet: item.snippet || item.content || "",
    fetchedText: item.fetchedText || item.content || item.snippet || "",
    fetchedAt: new Date().toISOString(),
    independenceKey: independenceKeyFor(item.url, item.title),
  }));
}

async function searchTavily(query, apiKey) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query,
      max_results: 6,
      search_depth: "advanced",
      time_range: "month",
      include_answer: false,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`tavily_${response.status}`);
  const data = await response.json();
  return normalizeSources((data.results || []).map((r) => ({
    url: r.url, title: r.title, content: r.content, publishedAt: r.published_date,
  })));
}

// Fetch a page and return readable text. Search snippets alone rarely contain
// the actual price numbers, so top sources are enriched with full text (TRD 4).
async function fetchPageText(url) {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 dow-check/0.1" },
      signal: AbortSignal.timeout(12000),
      redirect: "follow",
    });
    if (!response.ok) return "";
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) return "";
    const html = await response.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);
  } catch {
    return "";
  }
}

// Enrich the top sources with fetched page text when it beats the snippet.
export async function enrichSources(sources, topN = 3) {
  const enriched = [...(sources || [])];
  await Promise.all(
    enriched.slice(0, topN).map(async (source) => {
      const text = await fetchPageText(source.url);
      if (text.length > String(source.fetchedText || "").length) {
        source.fetchedText = text;
      }
    }),
  );
  return enriched;
}

async function searchBrave(query, apiKey) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6`;
  const response = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`brave_${response.status}`);
  const data = await response.json();
  return normalizeSources(((data.web && data.web.results) || []).map((r) => ({
    url: r.url, title: r.title, content: r.description, publishedAt: r.age,
  })));
}

async function searchSerper(query, apiKey) {
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify({ q: query, num: 6 }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`serper_${response.status}`);
  const data = await response.json();
  return normalizeSources((data.organic || []).map((r) => ({
    url: r.link, title: r.title, content: r.snippet, publishedAt: r.date,
  })));
}

// Keyless fallback: DuckDuckGo HTML results. Best-effort only; failures return [].
async function searchKeyless(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 dow-check/0.1" },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return [];
    const html = await response.text();
    const items = [];
    const pattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = pattern.exec(html)) && items.length < 6) {
      const rawUrl = match[1].replace(/&amp;/g, "&");
      const title = match[2].replace(/<[^>]+>/g, "").trim();
      let realUrl = rawUrl;
      try {
        const parsed = new URL(rawUrl, "https://duckduckgo.com");
        realUrl = parsed.searchParams.get("uddg") || rawUrl;
      } catch { /* keep raw URL */ }
      if (title && realUrl.startsWith("http")) items.push({ url: realUrl, title });
    }
    return normalizeSources(items);
  } catch {
    return [];
  }
}

// Search the web for a normalized question. Returns [] when nothing usable is found.
export async function searchWeb(query) {
  const provider = (process.env.SEARCH_PROVIDER || "").toLowerCase();
  const apiKey = process.env.SEARCH_API_KEY || "";
  try {
    if (provider === "tavily" && apiKey) return await searchTavily(query, apiKey);
    if (provider === "brave" && apiKey) return await searchBrave(query, apiKey);
    if (provider === "serper" && apiKey) return await searchSerper(query, apiKey);
  } catch {
    // Fall through to the keyless path, then to an honest empty result.
  }
  return searchKeyless(query);
}

function metaConfig() {
  return {
    apiKey: process.env.MODEL_API_KEY || process.env.META_API_KEY || "",
    baseUrl: (process.env.META_BASE_URL || "https://api.meta.ai/v1").replace(/\/$/, ""),
    model: process.env.META_MODEL_ID || "muse-spark-1.3",
  };
}

export function hasMetaKey() {
  return Boolean(metaConfig().apiKey);
}

const VERDICT_INSTRUCTIONS = [
  "You are the verdict engine for dow-check, a proof-first assistant for Indonesian small merchants.",
  "Answer ONLY from the numbered sources provided. Never use memory for factual claims.",
  "Output ONLY valid JSON with this shape:",
  '{"verdict":"<=60 words, simple Bahasa Indonesia","claims":[{"text":"...","source_ids":[1]}],"risk_flags":["max 3"],"next_action":"exactly one concrete action","confidence":"CONFIDENT|MODERATE|INSUFFICIENT_EVIDENCE","confidence_reason":"one sentence"}',
  "Every claim must cite source numbers. If sources are fewer than 2, conflicting, or missing, set confidence to INSUFFICIENT_EVIDENCE and say what is missing.",
  "Never output percentage confidence. Keep the verdict short.",
].join("\n");

// Ask Muse Spark (Meta Model API) for a structured verdict over ranked sources.
export async function buildVerdictWithMeta({ question, kind, context, sources }) {
  const { apiKey, baseUrl, model } = metaConfig();
  const sourceBlock = sources
    .map((s) => `[${s.id}] ${s.title} (${s.publisher}${s.publishedAt ? `, ${s.publishedAt}` : ""})\n${String(s.fetchedText || s.snippet || "").slice(0, 1200)}`)
    .join("\n\n");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "developer", content: VERDICT_INSTRUCTIONS },
        {
          role: "user",
          content: `Question type: ${kind}\nQuestion: ${question}\nContext: ${JSON.stringify(context || {})}\n\nSources:\n${sourceBlock || "(no sources found)"}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error(`meta_${response.status}`);
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || "";
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < 0) throw new Error("meta_invalid_json");
  return { parsed: JSON.parse(text.slice(jsonStart, jsonEnd + 1)), provider: "meta", model };
}

// Extractive fallback used without a Meta key: it only restates found sources.
// It never invents facts, and the deterministic grader still decides confidence.
export function buildVerdictExtractive({ question, sources }) {
  if (!sources.length) return null;
  const top = sources.slice(0, 3);
  const claims = top.map((s) => ({
    text: String(s.snippet || s.title || "").slice(0, 180),
    source_ids: [s.id],
  })).filter((claim) => claim.text);
  if (!claims.length) return null;
  return {
    parsed: {
      verdict: `Berdasarkan sumber yang ditemukan soal "${question}", buktinya masih perlu dicek lebih lanjut di bawah.`,
      claims,
      risk_flags: ["Mode demo tanpa Meta API key: verdict disusun langsung dari cuplikan sumber."],
      next_action: "Buka sumber aslinya di bawah, lalu putuskan setelah membandingkan tanggalnya.",
      confidence: "MODERATE",
      confidence_reason: "Verdict demo disusun dari cuplikan sumber yang ditemukan.",
    },
    provider: "extractive-demo",
    model: "none",
  };
}

// Convert arbitrary audio to 16 kHz mono WAV with ffmpeg (the ASR endpoint
// only accepts WAV). Returns null when conversion is unavailable.
async function convertToWav(buffer, mimeType) {
  const { execFile } = await import("node:child_process");
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "dow-check-asr-"));
  try {
    const inputPath = join(dir, "input.audio");
    const outputPath = join(dir, "output.wav");
    writeFileSync(inputPath, buffer);
    await new Promise((resolve, reject) => {
      execFile(
        "ffmpeg",
        ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", outputPath],
        { timeout: 30000 },
        (error) => (error ? reject(error) : resolve()),
      );
    });
    return readFileSync(outputPath);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Transcribe an audio buffer with Muse Voice Transcribe (Meta Model API).
// The endpoint requires multipart parts named "request" (JSON settings) and
// "audio" (a WAV clip); see the official Voice API reference.
export async function transcribeAudio({ buffer, mimeType, filename }) {
  const { apiKey, baseUrl } = metaConfig();
  if (!apiKey) return null;

  const isWav = /wav|x-wav|wave/i.test(mimeType || "") || /\.wav$/i.test(filename || "");
  let audioBuffer = buffer;
  if (!isWav) {
    audioBuffer = await convertToWav(buffer, mimeType);
    if (!audioBuffer) throw new Error("audio_conversion_failed");
  }

  const settings = JSON.stringify({
    model: "muse-voice-transcribe-1.0",
    audioEncoding: "WAV",
    mode: "PUSH_TO_TALK",
  });
  const form = new FormData();
  form.append("request", new Blob([settings], { type: "application/json" }));
  form.append("audio", new Blob([audioBuffer], { type: "audio/wav" }), "voice.wav");
  const response = await fetch(`${baseUrl}/asr/transcribe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`meta_asr_${response.status}`);
  const data = await response.json();
  const fromTurns = Array.isArray(data.turns)
    ? data.turns.map((turn) => turn.transcript || turn.text || "").join(" ").trim()
    : "";
  const text = String(data.transcript || data.text || fromTurns || "").trim();
  return { text, provider: "meta" };
}

// Extract readable text from a PDF with Muse Spark document input.
// Chat Completions carries the file inline as a base64 data URL in a
// "file" content block (official Meta file-handling format).
export async function extractDocument({ base64, filename }) {
  const { apiKey, baseUrl, model } = metaConfig();
  if (!apiKey) return null;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "developer",
          content: "Extract all readable text from this document, preserving names, dates, item names, and prices exactly as written. Output ONLY the extracted text, no commentary. If the document is unreadable, output nothing.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract the text from this document." },
            {
              type: "file",
              file: {
                filename: filename || "document.pdf",
                file_data: `data:application/pdf;base64,${base64}`,
              },
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`meta_pdf_${response.status}`);
  const data = await response.json();
  const text = String(data?.choices?.[0]?.message?.content || "").trim();
  return { text: text.slice(0, 6000), provider: "meta" };
}

// Extract receipt fields from an image with Muse Spark vision input.
export async function extractReceipt({ base64, mimeType }) {
  const { apiKey, baseUrl, model } = metaConfig();
  if (!apiKey) return null;
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "developer",
          content: "Extract receipt fields. Output ONLY JSON: {\"shop\":string,\"date\":string,\"items\":[{\"name\":string,\"price\":number}],\"uncertain\":[string]}. List field names you are unsure about in uncertain. Never guess unreadable numbers; mark them uncertain.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Read this receipt." },
            { type: "image_url", image_url: { url: `data:${mimeType || "image/jpeg"};base64,${base64}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error(`meta_vision_${response.status}`);
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("meta_vision_invalid_json");
  return { extraction: JSON.parse(text.slice(start, end + 1)), provider: "meta" };
}
