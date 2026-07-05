import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { email, phone, priceMin, priceMax, bedsMin, bedsMax, neighborhoods, zips } = body;

    if (!email && !phone) {
      return NextResponse.json({ error: "Email or phone required" }, { status: 400 });
    }

    await db.execute(sql`
      INSERT INTO waitlist (email, phone, price_min, price_max, beds_min, beds_max, neighborhoods, zips)
      VALUES (
        ${email || null},
        ${phone || null},
        ${priceMin || null},
        ${priceMax || null},
        ${bedsMin || null},
        ${bedsMax || null},
        ${neighborhoods ? sql`${neighborhoods}::text[]` : null},
        ${zips ? sql`${zips}::text[]` : null}
      )
    `);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Waitlist error:", err);
    return NextResponse.json({ error: "Failed to join waitlist" }, { status: 500 });
  }
}
