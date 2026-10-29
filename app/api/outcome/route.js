// Outcome API: record what the merchant finally decided after a verdict.
import { NextResponse } from "next/server";
import { isValidOutcome } from "../../../lib/engine.mjs";
import { applyUserCookie, resolveUser } from "../../../lib/session.mjs";
import { recordOutcome } from "../../../lib/store.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  const body = await request.json();
  if (!body.verdictId || !isValidOutcome(body.outcome)) {
    return NextResponse.json({ error: "invalid_outcome" }, { status: 400 });
  }
  const session = await resolveUser(request);
  await recordOutcome({
    verdictId: body.verdictId,
    userId: session.user.id,
    outcome: body.outcome,
  });
  return applyUserCookie(NextResponse.json({ ok: true }), session);
}
