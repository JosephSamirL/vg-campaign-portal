import dotenv from "dotenv";

// Local-only env for integration tests against `supabase start`. Never committed.
dotenv.config({ path: ".env.local" });
