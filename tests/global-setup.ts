import type { TestProject } from "vitest/node";
import { startProviderMock, type RunningMock } from "./provider-mock";

/**
 * Story 4.3 — Vitest globalSetup: start the provider mock once for the whole run on PROVIDER_MOCK_PORT (8787),
 * where a locally served `dispatch-send` (`supabase functions serve … --env-file supabase/mock.env`, whose
 * PROVIDER_BASE_URL is http://host.docker.internal:8787) reaches it. If something already listens there — a
 * standalone `pnpm tsx tests/provider-mock.ts` kept up while developing — that one is used instead.
 * Runs in Vitest's main process, so the server outlives every worker; torn down at the end of the run.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const port = Number(process.env.PROVIDER_MOCK_PORT ?? 8787);
  let mock: RunningMock | null = null;
  try {
    mock = await startProviderMock(port);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EADDRINUSE") throw error;
    process.stderr.write(`tests/global-setup.ts: port ${port} is busy — assuming a provider mock is already running there.\n`);
  }
  const url = `http://127.0.0.1:${port}`;
  process.env.PROVIDER_MOCK_URL = url;
  project.provide("providerMockUrl", url);
  return async () => {
    if (mock) await mock.close();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    providerMockUrl: string;
  }
}
