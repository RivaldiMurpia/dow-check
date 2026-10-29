// Queries API: create a proof-first question (POST) and list history (GET).
// Identity is an anonymous per-browser cookie (see lib/session.mjs).
import { NextResponse } from "next/server";
import { runQuery } from "../../../lib/service.mjs";
import { applyUserCookie, resolveUser } from "../../../lib/session.mjs";
import { listHistory } from "../../../lib/store.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const session = await resolveUser(request);
  const response = NextResponse.json({ history: await listHistory(session.user.id) });
  return applyUserCookie(response, session);
}

export async function POST(request) {
  try {
    const body = await request.json();
    const questionText = String(body.questionText || body.question || "").trim();
    if (!questionText) {
      return NextResponse.json({ error: "empty_question" }, { status: 400 });
    }
    const session = await resolveUser(request);
    const result = await runQuery({
      userId: session.user.id,
      questionText,
      inputMode: body.inputMode || "text",
      context: body.context || null,
      parentQueryId: body.parentQueryId || null,
    });
    return applyUserCookie(NextResponse.json(result), session);
  } catch (error) {
    return NextResponse.json(
      { error: "pipeline_failed", detail: String(error?.message || error) },
      { status: 500 },
    );
  }
}
