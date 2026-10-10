import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // deploy/web.Dockerfile copies .next/standalone (SPEC §11).
  output: "standalone",
  devIndicators: false,
  poweredByHeader: false,
  async redirects() {
    return [
      // The component inventory lives at /design (SYSTEM §3); /kit is a short alias.
      { source: "/kit", destination: "/design", permanent: false },
    ];
  },
};

export default nextConfig;
