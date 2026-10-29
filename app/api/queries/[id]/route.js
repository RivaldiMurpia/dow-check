// Query detail API: one question with its verdict, sources, citations,
// supplier memory, and the recorded outcome for the current browser.
import { NextResponse } from "next/server";
import { resolveUser } from "../../../../lib/session.mjs";
import { getOutcome, getQueryDetail } from "../../../../lib/store.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  const { id } = await params;
  const detail = await getQueryDetail(id);
  if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const session = await resolveUser(request);
  const outcome = detail.verdict
    ? await getOutcome(detail.verdict.id, session.user.id)
    : null;
  return NextResponse.json({ ...detail, outcome });
}
