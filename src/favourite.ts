import { errorMessage } from "./lib.ts";
import { SONGS, runImport } from "./library-import.ts";

try {
  process.exitCode = await runImport(SONGS, process.argv.slice(2), process.env);
} catch (error) {
  console.error(`Error: ${errorMessage(error)}`);
  process.exitCode = 1;
}
