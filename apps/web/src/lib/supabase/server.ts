import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { publicEnv } from "../env";

/** Client Supabase au nom de l'utilisateur connecté (RLS appliquée). Null si Supabase n'est pas configuré. */
export async function supabaseForUser() {
  const env = publicEnv();
  if (!env) return null;
  const store = await cookies();
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // appelé depuis un composant serveur : le proxy rafraîchit la session
        }
      },
    },
  });
}
