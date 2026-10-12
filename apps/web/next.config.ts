import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  transpilePackages: ["@aloufa/importer", "@aloufa/agents"],
  experimental: { serverActions: { bodySizeLimit: "10mb" } },
};

export default withNextIntl(nextConfig);
