// Seed loader entry point (local machine only — needs the service-role key).
// Step 1 (Story 1.4): provision the allow-listed logins. Epic 2 adds the CSV import.
import { provisionUsers } from "./users";

async function main() {
  await provisionUsers();
  console.log("seed: nothing more to load yet");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("seed failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
