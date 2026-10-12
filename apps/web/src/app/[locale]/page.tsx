import { getTranslations, setRequestLocale } from "next-intl/server";
import { supabaseForUser } from "@/lib/supabase/server";
import { getViewer } from "@/lib/auth";

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("home");
  const tTypes = await getTranslations("dataRoom.types");
  const viewer = await getViewer();
  const sb = viewer ? await supabaseForUser() : null;
  const { data: executives } = sb
    ? await sb.from("executives").select("key, name, mission, status, required_datasets").order("key")
    : { data: null };

  return (
    <>
      <h1>{t("title")}</h1>
      <p>{t("placeholder")}</p>
      {viewer && (
        <section>
          <h2>{t("executives")}</h2>
          {!executives?.length ? (
            <p>{t("noData")}</p>
          ) : (
            <ul>
              {executives.map((e) => (
                <li key={e.key}>
                  <strong>{e.name}</strong> · {t(`status.${e.status}` as "status.active")} · {e.mission}
                  {e.status === "dormant" && (e.required_datasets as string[]).length > 0 && (
                    <> · {t("waitsFor", { datasets: (e.required_datasets as string[]).map((d) => tTypes(d as "meta_ads")).join(", ") })}</>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
