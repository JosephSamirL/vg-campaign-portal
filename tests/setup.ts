import dotenv from "dotenv";

// Local-only env for integration tests against `supabase start`. Never committed.
// `.env.test` carries the local-stack test logins (Story 1.5); `.env.local` the app's own
// URL/key. dotenv never overrides a variable that is already set.
dotenv.config({ path: ".env.test" });
dotenv.config({ path: ".env.local" });
