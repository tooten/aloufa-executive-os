import { NextResponse, type NextRequest } from "next/server";
import { supabaseForUser } from "@/lib/supabase/server";

/** Retour du lien de connexion : échange le code contre une session, puis redirige dans l'app. */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const sb = await supabaseForUser();
  if (code && sb) await sb.auth.exchangeCodeForSession(code);
  return NextResponse.redirect(new URL(safeNext, url.origin));
}
