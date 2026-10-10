import { Bricolage_Grotesque, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

/*
 * Fonts are downloaded at build time and served by Raisebook (next/font), so pages make no
 * runtime requests to Google (SPEC §1.6, privacy promise 3). CSS variables: --f-display,
 * --f-body, --f-mono (SYSTEM §1.4), mapped to font-display / font-body / font-mono.
 */

/** Display: Bricolage Grotesque, variable weight with the optical-size axis (12..96). */
export const display = Bricolage_Grotesque({
  subsets: ["latin"],
  axes: ["opsz"],
  display: "swap",
  variable: "--f-display",
});

export const body = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--f-body",
});

export const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--f-mono",
});

export const fontVariables = `${display.variable} ${body.variable} ${mono.variable}`;
