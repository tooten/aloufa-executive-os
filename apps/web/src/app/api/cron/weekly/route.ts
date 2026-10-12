import { NextResponse } from "next/server";
import { db, runTick, isCron } from "@/lib/agents";

export const maxDuration = 800;

/** Lundi matin : crée l'événement de la semaine (une seule fois), puis lance les dirigeants. */
export async function GET(request: Request) {
  if (!isCron(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [row] = await db()<{ id: string | null }[]>`select create_weekly_event() as id`;
  const report = await runTick(450_000);
  return NextResponse.json({ weeklyEvent: row?.id ?? null, ...report });
}
