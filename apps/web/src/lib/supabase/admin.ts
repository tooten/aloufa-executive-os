import "server-only";
import { createClient } from "@supabase/supabase-js";
import { serverEnv } from "../env";

/** Client avec la clé secrète : contourne RLS. Uniquement dans les routes serveur, après contrôle du rôle. */
export function supabaseAdmin() {
  const env = serverEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
