import { getTranslations, setRequestLocale, getFormatter } from "next-intl/server";
import { getViewer } from "@/lib/auth";
import { supabaseForUser } from "@/lib/supabase/server";
import { ImportForm } from "@/components/ImportForm";

export default async function DataRoomPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("dataRoom");
  const format = await getFormatter();
  const viewer = await getViewer();

  if (!viewer) return (<><h1>{t("title")}</h1><p>{t("signIn")}</p></>);

  const sb = await supabaseForUser();
  const { data: datasets } = sb
    ? await sb.from("datasets").select("id, type, status, row_count, rejected_count, period_start, period_end, created_at").order("created_at", { ascending: false }).limit(20)
    : { data: null };

  return (
    <>
      <h1>{t("title")}</h1>
      <p>{t("intro")}</p>
      {viewer.role === "operator" ? <ImportForm /> : <p>{t("forbidden")}</p>}
      <section>
        <h2>{t("history")}</h2>
        {!datasets?.length ? (
          <p>{t("empty")}</p>
        ) : (
          <div className="scroll">
            <table>
              <tbody>
                {datasets.map((d) => (
                  <tr key={d.id}>
                    <td>{format.dateTime(new Date(d.created_at), { dateStyle: "medium", timeStyle: "short" })}</td>
                    <td>{t(`types.${d.type}` as "types.meta_ads")}</td>
                    <td>{t(`datasetStatus.${d.status}` as "datasetStatus.loaded")}</td>
                    <td>{d.row_count} / {d.rejected_count}</td>
                    <td>{d.period_start ?? ""} → {d.period_end ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
