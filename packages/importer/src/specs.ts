// Spécifications des datasets importables : champs attendus et synonymes d'en-têtes.
// Les synonymes couvrent les exports en français et en anglais. Ce sont des suppositions
// tant qu'un vrai export n'a pas été déposé : l'écran de mapping permet de corriger.

export type DatasetType =
  | "instagram_account"
  | "instagram_media"
  | "meta_ads"
  | "woocommerce_orders";

export type FieldKind = "string" | "number" | "int" | "date" | "datetime" | "percent" | "email";

export interface FieldSpec {
  key: string;
  kind: FieldKind;
  required: boolean;
  synonyms: string[];
}

export interface DatasetSpec {
  type: DatasetType;
  table: string;
  fields: FieldSpec[];
  /** Au moins un champ de chaque groupe doit être mappé (ex. email ou nom du client). */
  oneOf?: string[][];
}

const f = (key: string, kind: FieldKind, required: boolean, synonyms: string[]): FieldSpec => ({
  key,
  kind,
  required,
  synonyms,
});

export const SPECS: Record<DatasetType, DatasetSpec> = {
  instagram_account: {
    type: "instagram_account",
    table: "instagram_account_daily",
    fields: [
      f("day", "date", true, ["date", "jour", "day"]),
      f("reach", "int", false, ["reach", "couverture", "portée", "comptes touchés", "accounts reached"]),
      f("views", "int", false, ["views", "vues", "impressions"]),
      f("accounts_engaged", "int", false, ["accounts engaged", "comptes ayant interagi", "comptes engagés"]),
      f("profile_visits", "int", false, ["profile visits", "visites du profil", "visites sur le profil", "profile views"]),
      f("follows", "int", false, ["follows", "new followers", "abonnements", "nouveaux abonnés", "follower gains"]),
      f("unfollows", "int", false, ["unfollows", "désabonnements", "follower losses"]),
      f("profile_links_taps", "int", false, ["link clicks", "external link taps", "clics sur le lien", "appuis sur le lien", "website clicks", "profile links taps"]),
    ],
  },
  instagram_media: {
    type: "instagram_media",
    table: "content_metrics",
    fields: [
      f("ig_media_id", "string", true, ["post id", "media id", "id de la publication", "identifiant", "id"]),
      f("permalink", "string", false, ["permalink", "lien permanent", "url", "lien"]),
      f("format", "string", false, ["post type", "type de publication", "type", "media type", "format"]),
      f("published_at", "datetime", true, ["publish time", "heure de publication", "date de publication", "published", "timestamp", "date"]),
      f("views", "int", false, ["views", "vues", "plays", "impressions"]),
      f("reach", "int", false, ["reach", "couverture", "portée", "comptes touchés"]),
      f("saved", "int", false, ["saves", "saved", "enregistrements"]),
      f("shares", "int", false, ["shares", "partages"]),
      f("comments", "int", false, ["comments", "commentaires"]),
      f("likes", "int", false, ["likes", "j'aime", "mentions j'aime"]),
      f("profile_visits", "int", false, ["profile visits", "visites du profil"]),
      f("follows", "int", false, ["follows", "abonnements"]),
      f("avg_watch_time_s", "number", false, ["average watch time", "temps de visionnage moyen", "avg watch time"]),
      f("skip_rate", "percent", false, ["skip rate", "taux de passage", "taux d'abandon"]),
    ],
  },
  meta_ads: {
    type: "meta_ads",
    table: "ad_spend_daily",
    fields: [
      f("day", "date", true, ["day", "jour", "date", "reporting starts", "début des rapports"]),
      f("campaign", "string", true, ["campaign name", "nom de la campagne", "campagne", "campaign"]),
      f("spend", "number", true, ["amount spent (usd)", "amount spent", "montant dépensé (usd)", "montant dépensé", "spend"]),
      f("impressions", "int", false, ["impressions"]),
      f("results", "int", false, ["results", "résultats"]),
    ],
  },
  woocommerce_orders: {
    type: "woocommerce_orders",
    table: "orders",
    fields: [
      f("external_id", "string", true, ["order id", "order number", "order #", "numéro de commande", "commande n°", "commande", "id"]),
      f("ordered_at", "datetime", true, ["order date", "date de commande", "date created", "date"]),
      f("status", "string", true, ["order status", "statut de la commande", "statut", "status"]),
      f("total", "number", true, ["order total", "total de la commande", "net sales", "ventes nettes", "total"]),
      f("currency", "string", false, ["currency", "devise", "order currency"]),
      f("plan", "string", false, ["product(s)", "produit(s)", "item name", "nom du produit", "products", "produits", "plan"]),
      f("customer_email", "email", false, ["billing email", "e-mail de facturation", "email", "customer email", "e-mail"]),
      f("customer_name", "string", false, ["customer", "client", "customer name", "nom du client"]),
      f("coupon", "string", false, ["coupon(s)", "coupons", "coupon code", "code promo", "coupon"]),
      f("utm_source", "string", false, ["utm source", "utm_source", "origin", "attribution", "source"]),
      f("utm_campaign", "string", false, ["utm campaign", "utm_campaign", "campaign"]),
    ],
    oneOf: [["customer_email", "customer_name"]],
  },
};

export const DATASET_TYPES = Object.keys(SPECS) as DatasetType[];
