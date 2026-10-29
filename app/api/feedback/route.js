// Feedback API: one-tap Helpful / Not helpful per verdict.
import { NextResponse } from "next/server";
import { getLocalUser, saveFeedback } from "../../../lib/store.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const body = await request.json();
  if (!body.verdictId || typeof body.helpful !== "boolean") {
    return NextResponse.json({ error: "invalid_feedback" }, { status: 400 });
  }
  const user = await getLocalUser();
  await saveFeedback({ verdictId: body.verdictId, userId: user.id, helpful: body.helpful });
  return NextResponse.json({ ok: true });
}
