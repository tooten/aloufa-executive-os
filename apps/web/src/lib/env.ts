import { z } from "zod";

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
});

const serverSchema = publicSchema.extend({
  SUPABASE_SECRET_KEY: z.string().min(20),
  IMPORT_HASH_SALT: z.string().min(32, "IMPORT_HASH_SALT doit faire au moins 32 caractères"),
  STORE_TIME_ZONE: z.string().default("America/New_York"),
});

/** Variables publiques, ou null si Supabase n'est pas encore configuré. */
export function publicEnv() {
  const r = publicSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  return r.success ? r.data : null;
}

/** Variables serveur. Lève une erreur lisible si l'une manque. */
export function serverEnv() {
  return serverSchema.parse(process.env);
}
