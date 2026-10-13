// Async fallback of register.mjs for Node versions without module.registerHooks.
import { existsSync, statSync } from "node:fs";
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

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) return next(withExtension(new URL(specifier.slice(2), WEB).href), context);
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    return next(withExtension(new URL(specifier, context.parentURL).href), context);
  }
  return next(specifier, context);
}
