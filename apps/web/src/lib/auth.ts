import "server-only";
import { supabaseForUser } from "./supabase/server";

export type AppRole = "operator" | "founder";

export interface Viewer { id: string; role: AppRole; displayName: string; }

/** Utilisateur connecté avec son rôle, ou null (pas de session, pas de profil, ou Supabase non configuré). */
export async function getViewer(): Promise<Viewer | null> {
  const sb = await supabaseForUser();
  if (!sb) return null;
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return null;
  const { data } = await sb.from("profiles").select("role, display_name").eq("id", user.id).maybeSingle();
  if (!data) return null;
  return { id: user.id, role: data.role as AppRole, displayName: data.display_name as string };
}
