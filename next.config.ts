import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  // libsql ذات البيناري الأصلية: تُبخر خارج حزمة السيرفر لضمان عملها على Vercel
  serverExternalPackages: ["@libsql/client", "libsql"],
};

export default nextConfig;
