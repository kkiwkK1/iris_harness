/**
 * Building the transport the page decided on.
 *
 * Separated from the decision (`transport.ts`) because this half value-imports
 * both clients, and a module that imports them cannot run outside a bundler.
 * Keeping the rule testable was worth two files.
 *
 * @module iris-web/client/create-client
 */

import { createFakeClient } from '@iris/client-fake'
import { IrisHttpClient } from '@iris/rpc-client'
import type { IrisClient } from '@iris/protocol'

import { chooseTransport, type Transport } from './transport.ts'

/** A built transport, and the label the interface reports. */
export interface BuiltTransport {
  client: IrisClient
  transport: Transport
  /** Where the data comes from, in words a person can check against. */
  origin: string
}

/**
 * Build the transport this page should use.
 *
 * @param onError - receives failures the client survived, so a dead socket
 * becomes something the reader can see rather than a console line.
 * @returns the client, its kind, and a human-readable origin.
 */
export function createClient(onError: (error: Error) => void): BuiltTransport {
  const transport = chooseTransport(window.location.search, import.meta.env.DEV)

  if (transport === 'fake') {
    return {
      client: createFakeClient(),
      transport,
      origin: 'seeded data (no host)',
    }
  }

  // No `baseUrl`: the client defaults to the page's own origin, which is the
  // arrangement to prefer — the host serves both the page and the two RPC paths,
  // so the browser stays same-origin and the host needs no cross-origin exception.
  return {
    client: new IrisHttpClient({ onError }),
    transport,
    origin: window.location.origin,
  }
}
