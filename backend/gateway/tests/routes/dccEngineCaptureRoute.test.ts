import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { BlenderBridge } from "../../dcc/blenderBridge";
import type { DirectorDccEngineFrameRenderer } from "../../dcc/engineCapture";
import { handleDccRoute } from "../../routes/dccRoutes";

function request(): IncomingMessage {
  return { method: "POST", headers: {} } as IncomingMessage;
}

describe("director_dcc engine frame route", () => {
  it("returns a rendered engine frame through the visible capture attachment", async () => {
    const json = vi.fn();
    const imageBase64 = Buffer.from("fixture-png").toString("base64");
    const engineFrames = {
      render: vi.fn().mockResolvedValue({
        receipt: {
          contract: "director-dcc-engine-frame-v1",
          provider: "godot",
          status: "rendered",
          imagePath: "frame.png",
          width: 960,
          height: 540,
          warnings: [],
        },
        imageBase64,
      }),
    } as unknown as DirectorDccEngineFrameRenderer;
    const blender: BlenderBridge = { status: vi.fn(), exportBlend: vi.fn() };

    expect(
      await handleDccRoute(request(), {} as ServerResponse, new URL("http://test/api/tools/director_dcc"), {
        readBody: vi.fn().mockResolvedValue({ input: { op: "render_engine_frame", provider: "godot" } }),
        json,
        getProject: vi.fn(),
        blender,
        engineFrames,
      }),
    ).toBe(true);

    expect(engineFrames.render).toHaveBeenCalledWith("godot", {});
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        capture: { mimeType: "image/png", dataBase64: imageBase64, width: 960, height: 540 },
      }),
    );
  });
});
