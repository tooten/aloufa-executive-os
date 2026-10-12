import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { Link } from "@/i18n/navigation";
import { publicEnv } from "@/lib/env";
import { getViewer } from "@/lib/auth";
import "../globals.css";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "app" });
  return { title: t("name") };
}

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations("nav");
  const tSetup = await getTranslations("setup");
  const configured = publicEnv() !== null;
  const viewer = configured ? await getViewer() : null;
  const other = locale === "fr" ? "en" : "fr";

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>
          <header className="shell-header">
            <strong>Aloufa Executive OS</strong>
            <nav>
              <Link href="/">{t("home")}</Link>
              <Link href="/data-room">{t("dataRoom")}</Link>
              {viewer ? <span>{t("signedInAs", { name: viewer.displayName })}</span> : <Link href="/login">{t("login")}</Link>}
              <Link href="/" locale={other}>{t("language")}</Link>
            </nav>
          </header>
          {!configured && (
            <aside className="notice" role="status">
              <strong>{tSetup("title")}</strong>
              <p>{tSetup("body")}</p>
            </aside>
          )}
          <main>{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
