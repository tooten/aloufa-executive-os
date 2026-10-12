import { getTranslations, setRequestLocale } from "next-intl/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseForUser } from "@/lib/supabase/server";

async function sendLink(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").trim();
  const locale = formData.get("locale") === "en" ? "en" : "fr";
  const sb = await supabaseForUser();
  if (!sb || !email) redirect(`/${locale}/login?error=config`);
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  // shouldCreateUser: false : seuls les comptes créés à la main dans Supabase peuvent se connecter
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: `${origin}/auth/callback?next=/${locale}` },
  });
  redirect(`/${locale}/login?${error ? `error=${encodeURIComponent(error.message)}` : "sent=1"}`);
}

export default async function LoginPage({
  params, searchParams,
}: { params: Promise<{ locale: string }>; searchParams: Promise<{ sent?: string; error?: string }> }) {
  const { locale } = await params;
  const { sent, error } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("login");
  return (
    <>
      <h1>{t("title")}</h1>
      <form action={sendLink}>
        <input type="hidden" name="locale" value={locale} />
        <label htmlFor="email">{t("email")}</label>
        <input id="email" name="email" type="email" required autoComplete="email" />
        <button type="submit">{t("submit")}</button>
      </form>
      {sent && <p role="status">{t("sent")}</p>}
      {error && <p role="alert" className="error">{t("error", { message: error })}</p>}
    </>
  );
}
