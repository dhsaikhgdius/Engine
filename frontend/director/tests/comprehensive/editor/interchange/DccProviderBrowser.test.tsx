import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DirectorDccProviderCatalog, DirectorDccProviderStatus } from "../../../../src/dcc/directorDccProviderContract";
import { LanguageProvider } from "../../../../src/comprehensive/i18n/language";

const client = vi.hoisted(() => ({ discover: vi.fn(), exportPackage: vi.fn() }));
vi.mock("../../../../src/comprehensive/editor/api/dccProviderClient", () => ({
  discoverDirectorDccProviders: client.discover,
  exportDirectorDccExchangePackage: client.exportPackage,
}));

import { DccProviderBrowser } from "../../../../src/comprehensive/editor/interchange/DccProviderBrowser";

const hash = "a".repeat(64);

function status(
  id: string,
  options: { nativeReady?: boolean; exchangeReady?: boolean; installed?: boolean } = {},
): DirectorDccProviderStatus {
  const nativeReady = options.nativeReady ?? false;
  const exchangeReady = options.exchangeReady ?? true;
  const blender = id === "blender";
  return {
    provider: {
      id,
      label: blender ? "Blender" : id === "maya" ? "Autodesk Maya" : "Godot",
      category: id === "godot" ? "engine" : "dcc",
      integration: blender ? "native-roundtrip" : "exchange-package",
      preferredFormat: blender ? "blend" : id === "godot" ? "glb" : "usda",
      exchangeFormats: blender ? ["blend", "usda", "glb"] : id === "godot" ? ["glb"] : ["usda", "glb"],
      capabilities: [
        nativeReady
          ? { id: "scene", level: "native", layer: "connector" }
          : {
              id: "scene",
              level: "exchange",
              layer: "exchange-format",
              formats: id === "godot" ? ["glb"] : ["usda", "glb"],
            },
        nativeReady
          ? { id: "camera", level: "native", layer: "connector" }
          : {
              id: "camera",
              level: "exchange",
              layer: "exchange-format",
              formats: id === "godot" ? ["glb"] : ["usda", "glb"],
            },
        { id: "live_link", level: "planned", layer: "connector" },
      ],
      connectorDirectory: `integrations/${id}`,
    },
    installed: options.installed ?? nativeReady,
    executable: nativeReady ? `/opt/${id}` : null,
    version: nativeReady ? "1.0" : null,
    nativeReady,
    exchangeReady,
    reason: nativeReady ? null : `${id} native connector is not ready.`,
  };
}

function catalog(): DirectorDccProviderCatalog {
  return {
    contract: "director-dcc-provider-catalog-v1",
    providers: [
      status("blender", { nativeReady: true, installed: true }),
      status("maya", { nativeReady: false, installed: true }),
      status("godot", { nativeReady: false, exchangeReady: false }),
    ],
  };
}

function exportResult(provider = "maya") {
  return {
    contract: "director-dcc-exchange-result-v1" as const,
    jobId: "550e8400-e29b-41d4-a716-446655440000",
    provider,
    packagePath: `/workspace/data/dcc-jobs/exchange/${provider}`,
    manifestPath: `/workspace/data/dcc-jobs/exchange/${provider}/manifest.json`,
    manifestSha256: hash,
    packageDigest: hash,
    sourceRevision: `director-project-revision:v1:sha256:${hash}`,
    formats: [
      {
        format: "usda" as const,
        fileName: "scene.usda",
        path: `/workspace/data/dcc-jobs/exchange/${provider}/scene.usda`,
        mimeType: "model/vnd.usda" as const,
        sha256: hash,
        byteLength: 1024,
      },
    ],
    assets: [],
    warnings: [],
  };
}

beforeEach(() => {
  window.localStorage.clear();
  client.discover.mockResolvedValue(catalog());
  client.exportPackage.mockResolvedValue(exportResult());
});

afterEach(() => vi.clearAllMocks());

function renderBrowser(onPackageExported = vi.fn()) {
  render(
    <LanguageProvider>
      <DccProviderBrowser onPackageExported={onPackageExported} />
    </LanguageProvider>,
  );
  return onPackageExported;
}

it("discovers providers dynamically and never presents detected exchange adapters as native-ready", async () => {
  renderBrowser();

  const list = await screen.findByRole("list", { name: "DCC 提供方列表" });
  expect(list.children).toHaveLength(3);

  const blender = screen.getByText("Blender").closest("li");
  const maya = screen.getByText("Autodesk Maya").closest("li");
  expect(blender).not.toBeNull();
  expect(maya).not.toBeNull();
  expect(within(blender!).getByText("原生连接就绪")).toBeInTheDocument();
  expect(within(maya!).getByText("原生连接未就绪")).toBeInTheDocument();
  expect(within(maya!).getByText("交换包就绪")).toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "Blender 能力" })).not.toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "Autodesk Maya 能力" })).not.toBeInTheDocument();
  const godot = screen.getByText("Godot").closest("li");
  expect(godot).not.toBeNull();
  expect(within(godot!).getByText("交换包不可用")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "为 Godot 生成 GLB 交换包" })).toBeDisabled();
});

it("replaces raw backend reasons with a localized status summary while preserving diagnostics as a tooltip", async () => {
  renderBrowser();

  const maya = (await screen.findByText("Autodesk Maya")).closest("li");
  expect(maya).not.toBeNull();
  expect(within(maya!).queryByText("maya native connector is not ready.")).not.toBeInTheDocument();
  const summary = within(maya!).getByText("已检测安装；原生连接尚未就绪，可使用可移植交换包。");
  expect(summary.parentElement).toHaveAttribute("title", "maya native connector is not ready.");
});

it("localizes generated provider summaries in English without exposing raw gateway prose", async () => {
  window.localStorage.setItem("director.ui.locale", "en-US");
  renderBrowser();

  expect(await screen.findByText("Godot")).toBeInTheDocument();
  const maya = screen.getByText("Autodesk Maya").closest("li");
  expect(maya).not.toBeNull();
  expect(
    within(maya!).getByText("Installation detected; use portable exchange while the native connector is unavailable."),
  ).toBeInTheDocument();
  expect(within(maya!).queryByText("maya native connector is not ready.")).not.toBeInTheDocument();
  expect(screen.queryByRole("list", { name: "Autodesk Maya Capabilities" })).not.toBeInTheDocument();
});

it("chooses a portable format per provider and reports the generated package", async () => {
  const user = userEvent.setup();
  const onPackageExported = renderBrowser();
  await screen.findByText("Autodesk Maya");

  // Blender's preferred native format is .blend, but the generic exchange
  // action must choose its first portable format instead of implying a native export.
  expect(screen.getByRole("button", { name: "为 Blender 生成 USD 交换包" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "为 Autodesk Maya 生成 USD 交换包" }));

  expect(client.exportPackage).toHaveBeenCalledWith({ provider: "maya", formats: ["usda"] });
  await waitFor(() => expect(onPackageExported).toHaveBeenCalledWith(exportResult()));
  expect(screen.getByText(/USD 交换包已生成/)).toHaveTextContent(
    "USD 交换包已生成 · /workspace/data/dcc-jobs/exchange/maya",
  );
});

it("shows discovery errors and retries without manufacturing provider state", async () => {
  const user = userEvent.setup();
  client.discover.mockRejectedValueOnce(new Error("Gateway is offline")).mockResolvedValueOnce(catalog());
  renderBrowser();

  expect(await screen.findByRole("alert")).toHaveTextContent("Gateway is offline");
  expect(screen.queryByText("Autodesk Maya")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("Autodesk Maya")).toBeInTheDocument();
  expect(client.discover).toHaveBeenCalledTimes(2);
});
