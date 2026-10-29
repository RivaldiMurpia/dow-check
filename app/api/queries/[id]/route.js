// Query detail API: one question with its verdict and sources (S5/S7/S8).
import { NextResponse } from "next/server";
import { getQueryDetail } from "../../../../lib/store.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request, { params }) {
  const { id } = await params;
  const detail = await getQueryDetail(id);
  if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(detail);
}
