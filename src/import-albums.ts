import { errorMessage } from "./lib.ts";
import { ALBUMS, runImport } from "./library-import.ts";

try {
  process.exitCode = await runImport(
    ALBUMS,
    process.argv.slice(2),
    process.env,
  );
} catch (error) {
  console.error(`Error: ${errorMessage(error)}`);
  process.exitCode = 1;
}
