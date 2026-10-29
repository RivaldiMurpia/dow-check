// Feedback API: one-tap Helpful / Not helpful per verdict.
import { NextResponse } from "next/server";
import { applyUserCookie, resolveUser } from "../../../lib/session.mjs";
import { saveFeedback } from "../../../lib/store.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const body = await request.json();
  if (!body.verdictId || typeof body.helpful !== "boolean") {
    return NextResponse.json({ error: "invalid_feedback" }, { status: 400 });
  }
  const session = await resolveUser(request);
  await saveFeedback({ verdictId: body.verdictId, userId: session.user.id, helpful: body.helpful });
  return applyUserCookie(NextResponse.json({ ok: true }), session);
}
