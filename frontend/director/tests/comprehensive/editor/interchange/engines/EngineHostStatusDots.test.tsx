import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LanguageProvider } from "../../../../../src/comprehensive/i18n/language";

const providerClient = vi.hoisted(() => ({ discover: vi.fn() }));

vi.mock("../../../../../src/comprehensive/editor/api/dccProviderClient", () => ({
  discoverDirectorDccProviders: providerClient.discover,
}));

import { EngineHostStatusDots } from "../../../../../src/comprehensive/editor/interchange/engines/EngineHostStatusDots";

afterEach(() => {
  vi.clearAllMocks();
});

function catalogWith(states: Record<string, { nativeReady: boolean; exchangeReady: boolean }>) {
  return {
    contract: "director-dcc-provider-catalog-v1",
    providers: Object.entries(states).map(([id, readiness]) => ({
      provider: { id, label: id, category: "engine", integration: "engine-headless" },
      installed: readiness.nativeReady,
      executable: null,
      version: null,
      nativeReady: readiness.nativeReady,
      exchangeReady: readiness.exchangeReady,
      reason: null,
    })),
  };
}

it("colors one dot per host from the discovered readiness and never fakes native", async () => {
  providerClient.discover.mockResolvedValue(
    catalogWith({
      blender: { nativeReady: true, exchangeReady: true },
      unreal: { nativeReady: false, exchangeReady: true },
      unity: { nativeReady: false, exchangeReady: true },
      godot: { nativeReady: false, exchangeReady: false },
    }),
  );
  const { container } = render(
    <LanguageProvider>
      <EngineHostStatusDots />
    </LanguageProvider>,
  );
  await waitFor(() => expect(container.querySelectorAll(".director-host-status-dots i")).toHaveLength(4));
  const states = [...container.querySelectorAll(".director-host-status-dots i")].map((dot) =>
    dot.getAttribute("data-state"),
  );
  expect(states).toEqual(["native", "exchange", "exchange", "unavailable"]);
  expect(screen.getByTitle(/Blender 原生就绪/)).toBeInTheDocument();
  expect(screen.getByTitle(/Godot 不可用/)).toBeInTheDocument();
});

it("hides the whole cluster when discovery fails instead of showing stale dots", async () => {
  providerClient.discover.mockRejectedValue(new Error("gateway down"));
  const { container } = render(
    <LanguageProvider>
      <EngineHostStatusDots />
    </LanguageProvider>,
  );
  await waitFor(() => expect(providerClient.discover).toHaveBeenCalled());
  expect(container.querySelector(".director-host-status-dots")).toBeNull();
});
