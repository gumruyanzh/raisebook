// Test-only resolver for `npm run test:unit` (node --test; Node >= 23.6 strips TypeScript
// types natively). The app imports modules the bundler way (no extension, "@/" alias); these
// hooks map such specifiers to files on disk. No dependencies.
import { existsSync, statSync } from "node:fs";
import * as mod from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB = new URL("../../", import.meta.url);

function withExtension(url) {
  const path = fileURLToPath(url);
  if (existsSync(path) && statSync(path).isFile()) return url;
  for (const ext of [".ts", ".tsx", "/index.ts"]) {
    if (existsSync(path + ext)) return pathToFileURL(path + ext).href;
  }
  return url;
}

function mapSpecifier(specifier, parentURL) {
  if (specifier.startsWith("@/")) return withExtension(new URL(specifier.slice(2), WEB).href);
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && parentURL?.startsWith("file:")) {
    return withExtension(new URL(specifier, parentURL).href);
  }
  return specifier;
}

if (typeof mod.registerHooks === "function") {
  mod.registerHooks({
    resolve: (specifier, context, next) => next(mapSpecifier(specifier, context.parentURL), context),
  });
} else {
  mod.register("./resolve.mjs", import.meta.url);
}
