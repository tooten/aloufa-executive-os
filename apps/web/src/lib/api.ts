import "server-only";
import { NextResponse } from "next/server";
import { getViewer, type Viewer } from "./auth";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function fail(code: string, status: number, detail?: string) {
  return NextResponse.json({ error: code, detail }, { status });
}

/** Contrôle le rôle opérateur ; renvoie soit l'utilisateur, soit la réponse d'erreur à retourner. */
export async function requireOperator(): Promise<Viewer | NextResponse> {
  const viewer = await getViewer();
  if (!viewer) return fail("unauthorized", 401);
  if (viewer.role !== "operator") return fail("forbidden", 403);
  return viewer;
}

/** Lit le fichier CSV d'un formulaire multipart. */
export async function readCsv(form: FormData): Promise<{ name: string; text: string; bytes: Uint8Array } | NextResponse> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return fail("noFile", 400);
  if (file.size > MAX_UPLOAD_BYTES) return fail("tooLarge", 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { name: file.name, text: new TextDecoder("utf-8").decode(bytes), bytes };
}
