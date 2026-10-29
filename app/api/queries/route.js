// Queries API: create a proof-first question (POST) and list history (GET).
import { NextResponse } from "next/server";
import { runQuery } from "../../../lib/service.mjs";
import { getLocalUser, listHistory } from "../../../lib/store.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = getLocalUser();
  return NextResponse.json({ history: listHistory(user.id) });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const questionText = String(body.questionText || body.question || "").trim();
    if (!questionText) {
      return NextResponse.json({ error: "empty_question" }, { status: 400 });
    }
    const user = getLocalUser();
    const result = await runQuery({
      userId: user.id,
      questionText,
      inputMode: body.inputMode || "text",
      context: body.context || null,
      parentQueryId: body.parentQueryId || null,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: "pipeline_failed", detail: String(error?.message || error) },
      { status: 500 },
    );
  }
}
