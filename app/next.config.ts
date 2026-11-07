import type { NextConfig } from "next";

// Tailwind's Turbopack loader (@tailwindcss/turbopack) is not wired in: it failed
// to evaluate CSS on this machine (magic-string ESM require). The app's styling
// is plain CSS in src/app/globals.css, so nothing is lost.
const nextConfig: NextConfig = {
  // Keep the dev-mode "N" indicator out of screen recordings made on `npm run dev`.
  devIndicators: false,
  // The predictions file lives in private/ (never served statically); ship it with the rent routes.
  outputFileTracingIncludes: {
    "/api/rent": ["./private/predictions.csv"],
    "/api/rent/points": ["./private/predictions.csv"],
    "/api/rent/find": ["./private/predictions.csv"],
  },
};

export default nextConfig;
