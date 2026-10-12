import { NextResponse } from "next/server";
import { runTick, isCron } from "@/lib/agents";

export const maxDuration = 800;

/** Toutes les 5 minutes : route les événements, lance les dirigeants, et garde Supabase actif. */
export async function GET(request: Request) {
  if (!isCron(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const report = await runTick(450_000); // 7 min 30 de travail au plus : une analyse lancée à la fin a encore 350 s pour finir
  return NextResponse.json(report);
}
