import { describe, expect, it, vi } from "vitest";
import { requestFromBrowserClients } from "../../browserClientDiscovery";

class RetryableDiscoveryError extends Error {}

const retryable = (error: unknown) => error instanceof RetryableDiscoveryError;

describe("browser client discovery", () => {
  it("tries the next ranked candidate when an unbound discovery read times out", async () => {
    const request = vi.fn(async (client: string) => {
      if (client === "first") throw new RetryableDiscoveryError("timed out");
      return { client };
    });

    await expect(
      requestFromBrowserClients({
        rankedClients: ["first", "second", "third"],
        allowDiscoveryFallback: true,
        request,
        isRetryableDiscoveryError: retryable,
      }),
    ).resolves.toEqual({ client: "second" });
    expect(request.mock.calls.map(([client]) => client)).toEqual(["first", "second"]);
  });

  it("also advances when a candidate rotates its lease before replying", async () => {
    const request = vi.fn(async (client: string) => (client === "first" ? null : { client }));

    await expect(
      requestFromBrowserClients({
        rankedClients: ["first", "second"],
        allowDiscoveryFallback: true,
        request,
        isRetryableDiscoveryError: retryable,
      }),
    ).resolves.toEqual({ client: "second" });
  });

  it("never falls back after an exact target has been bound", async () => {
    const request = vi.fn(async (_client: string) => {
      throw new RetryableDiscoveryError("bound target timed out");
    });

    await expect(
      requestFromBrowserClients({
        exactClient: "bound",
        rankedClients: ["other-visible-tab"],
        allowDiscoveryFallback: true,
        request,
        isRetryableDiscoveryError: retryable,
      }),
    ).rejects.toThrow("bound target timed out");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("bound");
  });

  it("returns unavailable without discovery when an explicit target is gone", async () => {
    const request = vi.fn(async (client: string) => ({ client }));
    await expect(
      requestFromBrowserClients({
        exactClient: null,
        rankedClients: ["other-visible-tab"],
        allowDiscoveryFallback: true,
        request,
        isRetryableDiscoveryError: retryable,
      }),
    ).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not hide non-timeout failures behind another candidate", async () => {
    const request = vi.fn(async (_client: string) => {
      throw new Error("protocol failure");
    });
    await expect(
      requestFromBrowserClients({
        rankedClients: ["first", "second"],
        allowDiscoveryFallback: true,
        request,
        isRetryableDiscoveryError: retryable,
      }),
    ).rejects.toThrow("protocol failure");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
