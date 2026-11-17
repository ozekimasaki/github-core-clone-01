// Entry point: the contest lifecycle around the forge's HTTP surface.
//
// app.ts builds the whole surface (git smart HTTP, REST v3, GraphQL v4, MCP)
// but binds nothing. This file is the part that talks to the contest env:
//
//   1. listen on an ephemeral port (the kernel picks it; never 8080),
//   2. announce that port with POST {"port": N} to $MAKEFUN_ENV_URL/register,
//   3. poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true},
//   4. close the server and exit 0.
//
// The env derives the address to dial from the register request's peer
// address, so the announcement must come from this same process after the
// listener is up. Nothing here depends on a clock reading or a random
// choice: the only value ever sent to the env is the bound port itself.

import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';

/** The env's origin, with no trailing slash. Empty when the variable is unset. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** Poll cadence for /done: start fast, back off to a 2 s ceiling. */
const FIRST_POLL_DELAY_MS = 250;
const LONGEST_POLL_DELAY_MS = 2_000;
/** A single /done request is abandoned after this long; the next poll retries. */
const POLL_REQUEST_TIMEOUT_MS = 30_000;
/** Register attempts give up once this much time has passed without an answer. */
const REGISTER_GIVE_UP_MS = 120_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envUrl(path: string): string {
  return `${envOrigin}${path}`;
}

/**
 * Announce the listening port. The env may still be coming up when this
 * process starts, so a refused or failed attempt is retried with the same
 * backoff as the done poll. A 409 means a registration is already on record
 * for this trial (an earlier attempt of ours whose answer was lost), and the
 * port it names is this same listener's, so it counts as announced.
 */
async function announcePort(port: number): Promise<void> {
  const startedAt = Date.now();
  let delay = FIRST_POLL_DELAY_MS;
  for (;;) {
    try {
      const response = await fetch(envUrl('/register'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok || response.status === 409) {
        await response.text().catch(() => '');
        return;
      }
      console.error(`register: env answered ${response.status}; retrying`);
    } catch (error) {
      console.error(`register: ${error instanceof Error ? error.message : String(error)}; retrying`);
    }
    if (Date.now() - startedAt > REGISTER_GIVE_UP_MS) {
      throw new Error('register: the env never accepted the announcement');
    }
    await wait(delay);
    delay = Math.min(LONGEST_POLL_DELAY_MS, delay * 2);
  }
}

/**
 * Poll /done until the env says the suite is over. A failed poll (the env
 * restarting its listener, a timeout) is not fatal: the next poll decides.
 */
async function waitUntilDone(): Promise<void> {
  let delay = FIRST_POLL_DELAY_MS;
  for (;;) {
    let finished = false;
    try {
      const response = await fetch(envUrl('/done'), {
        signal: AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const body: unknown = await response.json();
        finished =
          typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true;
      }
    } catch {
      finished = false;
    }
    if (finished) return;
    await wait(delay);
    delay = Math.min(LONGEST_POLL_DELAY_MS, delay * 2);
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  if (envOrigin === '') {
    // No env to report to (a local run): serve until the process is stopped.
    console.error(`forge listening on port ${address.port}; MAKEFUN_ENV_URL is unset`);
    await new Promise<void>(() => {});
    return;
  }

  await announcePort(address.port);
  await waitUntilDone();

  // The suite is finished and its export is written: shut down cleanly.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
