export interface BrowserClientRequestOptions<Client, Result> {
  /**
   * `undefined` means no lease exists yet. `null` means an explicit lease was
   * supplied but its browser is gone; that distinction prevents fallback.
   */
  exactClient?: Client | null;
  /** Clients ordered by preference (most recently seen first). */
  rankedClients: readonly Client[];
  /** When true, iterate through ranked clients on failure; otherwise only try the top client. */
  allowDiscoveryFallback: boolean;
  /** Execute the request against a single client. Returns `null` when the client cannot serve it. */
  request: (client: Client) => Promise<Result | null>;
  /** Returns true when the error is transient and the next candidate should be tried. */
  isRetryableDiscoveryError: (error: unknown) => boolean;
}

/**
 * Resolve an unbound read against ranked browser candidates. Once an exact
 * client is supplied, this function executes only against that client and
 * never redirects the request, even when it times out or disconnects.
 */
export async function requestFromBrowserClients<Client, Result>(
  options: BrowserClientRequestOptions<Client, Result>,
): Promise<Result | null> {
  if (options.exactClient !== undefined) {
    return options.exactClient === null ? null : options.request(options.exactClient);
  }

  const candidates = options.allowDiscoveryFallback ? options.rankedClients : options.rankedClients.slice(0, 1);
  let lastRetryableError: unknown;
  for (const client of candidates) {
    try {
      const result = await options.request(client);
      if (result !== null) return result;
    } catch (error) {
      if (!options.allowDiscoveryFallback || !options.isRetryableDiscoveryError(error)) throw error;
      lastRetryableError = error;
    }
  }
  if (lastRetryableError !== undefined) throw lastRetryableError;
  return null;
}
