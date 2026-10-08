import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Read from the installed package in both src/ and dist/. */
export const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8"),
).version;
