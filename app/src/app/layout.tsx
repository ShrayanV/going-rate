import type { Metadata } from "next";
import { Fraunces, Instrument_Sans } from "next/font/google";
import "./globals.css";

const display = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  axes: ["opsz", "SOFT"],
  weight: "variable",
});
const body = Instrument_Sans({ subsets: ["latin"], variable: "--font-body", weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "Going Rate · what will this flat rent for?",
  description: "Fair weekly rent for any City of Sydney flat, with and without the car space, and the evidence behind it.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <head>
        {/* eslint-disable-next-line @next/next/no-css-tags -- static copy of maplibre-gl.css, see Map3D.tsx */}
        <link rel="stylesheet" href="/maplibre-gl.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
