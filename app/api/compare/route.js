// Receipt price comparison API: each receipt item is checked against
// current market sources. No benchmark found is reported honestly.
import { NextResponse } from "next/server";
import { comparePrice, pickMarketPrice } from "../../../lib/engine.mjs";
import { enrichSources, searchWeb } from "../../../lib/providers.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json();
    const items = Array.isArray(body.items) ? body.items.slice(0, 5) : [];
    if (!items.length) {
      return NextResponse.json({ error: "no_items" }, { status: 400 });
    }
    const comparisons = [];
    for (const item of items) {
      const name = String(item.name || "").trim();
      const receiptPrice = Number(item.price) || null;
      if (!name) continue;
      const found = await searchWeb(`harga ${name} terbaru Indonesia`);
      const sources = await enrichSources(found, 2);
      const marketPrice = pickMarketPrice(
        sources.map((s) => s.fetchedText || s.snippet || ""),
        receiptPrice,
      );
      comparisons.push({
        name,
        receiptPrice,
        marketPrice,
        status: comparePrice(receiptPrice, marketPrice),
        sources: sources.slice(0, 2).map((s) => ({
          id: s.id, title: s.title, publisher: s.publisher, url: s.url,
        })),
      });
    }
    return NextResponse.json({ comparisons });
  } catch (error) {
    return NextResponse.json(
      { error: "compare_failed", detail: String(error?.message || error) },
      { status: 500 },
    );
  }
}
