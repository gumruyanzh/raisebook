import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

/**
 * Open Graph card renderer (1200×630), used by the marketing opengraph-image routes. Rendered
 * at build time. The image renderer cannot read CSS variables, so the light-theme token values
 * from design/SYSTEM.md §1 are repeated here; keep them in sync with app/globals.css.
 * Fonts are the OFL-licensed WOFF files next to this module (satori does not read WOFF2).
 */

export const OG_SIZE = { width: 1200, height: 630 };

const T = {
  canvas: "#F3F5F8",
  surface: "#FFFFFF",
  sunk: "#E8ECF2",
  line: "#D5DCE6",
  fg: "#16202E",
  muted: "#5B6778",
  accent: "#2F55D4",
  good: "#15803D",
  stages: ["#8994A5", "#7C5CD6", "#2F55D4", "#0E8A9E", "#B7791F", "#C2410C", "#15803D", "#9AA3B0"],
  counts: [12, 8, 9, 4, 6, 2, 4, 7],
};

async function font(file: string): Promise<ArrayBuffer> {
  const buf = await readFile(join(process.cwd(), "components/marketing/og/fonts", file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export async function renderOg({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
}): Promise<ImageResponse> {
  const [display, body, mono] = await Promise.all([
    font("bricolage-grotesque-latin-700-normal.woff"),
    font("ibm-plex-sans-latin-400-normal.woff"),
    font("ibm-plex-mono-latin-500-normal.woff"),
  ]);
  const total = T.counts.reduce((a, b) => a + b, 0);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: T.canvas,
          padding: "56px 64px",
          fontFamily: "Plex",
          color: T.fg,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontFamily: "Bricolage", fontSize: 40, letterSpacing: "-0.02em" }}>
            Raisebook
          </div>
          <div style={{ fontFamily: "PlexMono", fontSize: 20, color: T.muted }}>raisebook.org</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: 44 }}>
          <div
            style={{
              fontFamily: "PlexMono",
              fontSize: 20,
              letterSpacing: "0.08em",
              color: T.muted,
              textTransform: "uppercase",
            }}
          >
            {eyebrow}
          </div>
          <div
            style={{
              fontFamily: "Bricolage",
              fontSize: 76,
              lineHeight: 1.02,
              letterSpacing: "-0.03em",
              marginTop: 18,
              maxWidth: 1000,
              textWrap: "balance",
            }}
          >
            {title}
          </div>
          {subtitle ? (
            <div style={{ fontSize: 26, color: T.muted, marginTop: 20, maxWidth: 900, lineHeight: 1.4 }}>
              {subtitle}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: "auto",
            background: T.surface,
            border: `1px solid ${T.line}`,
            borderRadius: 8,
            padding: "18px 22px",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "baseline" }}>
              <span style={{ fontFamily: "Bricolage", fontSize: 30 }}>$750,000</span>
              <span style={{ fontSize: 20, color: T.muted, marginLeft: 10 }}>of $2,000,000</span>
            </div>
            <span style={{ fontFamily: "PlexMono", fontSize: 16, color: T.muted }}>
              COMMITTED TOWARD SEED
            </span>
          </div>
          <div
            style={{
              display: "flex",
              height: 8,
              background: T.sunk,
              borderRadius: 999,
              marginTop: 12,
              overflow: "hidden",
            }}
          >
            <div style={{ width: "37.5%", background: T.good }} />
          </div>
          <div style={{ display: "flex", height: 22, borderRadius: 6, overflow: "hidden", marginTop: 14 }}>
            {T.counts.map((c, i) => (
              <div key={i} style={{ width: `${(c / total) * 100}%`, background: T.stages[i] }} />
            ))}
          </div>
        </div>
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: [
        { name: "Bricolage", data: display, weight: 700, style: "normal" },
        { name: "Plex", data: body, weight: 400, style: "normal" },
        { name: "PlexMono", data: mono, weight: 500, style: "normal" },
      ],
    },
  );
}
