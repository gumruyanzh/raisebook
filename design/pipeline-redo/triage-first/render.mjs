// Renders the mockups to PNG. Usage: node render.mjs <playwright-core index.mjs path>
// (any playwright-core works; it drives the local Google Chrome).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const pw = await import(pathToFileURL(process.argv[2]).href);
const dir = path.dirname(new URL(import.meta.url).pathname);
const jobs = [
  ["triage-1440.html", "", 1440, 900, "after-triage-1440-light.png"],
  ["triage-1440.html", "?dark&done=16", 1440, 900, "after-triage-1440-dark-midsession.png"],
  ["board-1440.html", "", 1440, 900, "after-board-1440-mature.png"],
  ["mobile-390.html", "?v=triage", 390, 844, "after-390-triage.png"],
  ["mobile-390.html", "?v=mature", 390, 844, "after-390-mature.png"],
];
const only = process.argv[3];
const browser = await pw.chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
for (const [file, qs, w, h, out] of jobs) {
  if (only && !out.includes(only)) continue;
  if (!fs.existsSync(path.join(dir, file))) continue;
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(path.join(dir, file)).href + qs);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(dir, out) });
  await page.close();
  console.log("wrote", out);
}
await browser.close();
