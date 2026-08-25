// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { dispatchDirectorWorkbenchTool } from "../src/gatewayClient";
import {
  DIRECTOR_DSH_HEALTH,
  DIRECTOR_DSH_HEALTH_PATH,
  DIRECTOR_MODEL_ROUTES_TOOL_NAME,
  registerDirectorHarnessHealth,
  registerDirectorWorkbenchPlugin,
} from "../src/register";

const TEST_GATEWAY_TOKEN = "director-test-token-1234567890";

describe("Director DSH workbench plugin gateway client", () => {
  it("posts the tool name and input to the Gateway tools surface", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:8787/api/tools/director_workbench");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-director-browser-token")).toBe(TEST_GATEWAY_TOKEN);
      expect(JSON.parse(String(init?.body))).toEqual({
        input: { op: "observe" },
        session_id: "dsh-sess-1",
        target_token: "target-1",
        omit_scene: true,
      });
      return new Response(JSON.stringify({ success: true, op: "observe" }), { status: 200 });
    });

    await expect(
      dispatchDirectorWorkbenchTool(
        "director_workbench",
        { op: "observe" },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          gatewayToken: TEST_GATEWAY_TOKEN,
          sessionId: "sess-1",
          targetToken: "target-1",
        },
      ),
    ).resolves.toEqual({ status: 200, body: { success: true, op: "observe" } });
  });

  it("retries a transient gateway fetch once", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      }
      return new Response(JSON.stringify({ success: true, op: "observe" }), { status: 200 });
    });

    await expect(
      dispatchDirectorWorkbenchTool(
        "director_workbench",
        { op: "observe" },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          gatewayToken: TEST_GATEWAY_TOKEN,
          sessionId: "sess-retry",
        },
      ),
    ).resolves.toEqual({ status: 200, body: { success: true, op: "observe" } });
    expect(attempts).toBe(2);
  });

  it("bootstraps gateway authorization and refreshes it once after a 401", async () => {
    const gatewayUrl = "http://127.0.0.1:8799";
    const firstToken = "director-bootstrap-token-first";
    const refreshedToken = "director-bootstrap-token-refreshed";
    let bootstrapCount = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/te-man/director/agent/bootstrap")) {
        bootstrapCount += 1;
        return new Response(JSON.stringify({ browserToken: bootstrapCount === 1 ? firstToken : refreshedToken }), {
          status: 200,
        });
      }
      const token = new Headers(init?.headers).get("x-director-browser-token");
      if (token === firstToken) return new Response(JSON.stringify({ success: false }), { status: 401 });
      expect(token).toBe(refreshedToken);
      return new Response(JSON.stringify({ success: true, op: "capabilities" }), { status: 200 });
    });

    await expect(
      dispatchDirectorWorkbenchTool(
        "director_workbench",
        { op: "capabilities" },
        { gatewayUrl, fetchImpl: fetchImpl as unknown as typeof fetch, sessionId: "auth-session" },
      ),
    ).resolves.toEqual({ status: 200, body: { success: true, op: "capabilities" } });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("registers the Director domain tools and model-route catalog through the DSH defineTool seam", async () => {
    const registered: string[] = [];
    const defineTool = vi.fn(
      (options: {
        name: string;
        timeoutMs?: number;
        isConcurrencySafe?: (args: unknown) => boolean;
        presentCall?: (args: unknown) => unknown;
      }) => {
        registered.push(options.name);
        return options;
      },
    );
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));

    registerDirectorWorkbenchPlugin({ tools: { register: (tool) => void tool } }, defineTool as never, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(registered).toEqual([
      "director_creative",
      "director_workbench",
      "stage_video",
      "blender_native",
      DIRECTOR_MODEL_ROUTES_TOOL_NAME,
    ]);
    expect(defineTool).toHaveBeenCalledTimes(5);
    const workbench = defineTool.mock.calls.find((call) => call[0].name === "director_workbench")?.[0];
    expect(workbench?.timeoutMs).toBe(70_000);
    expect(workbench?.isConcurrencySafe?.({ op: "observe" })).toBe(true);
    expect(workbench?.isConcurrencySafe?.({ op: "author" })).toBe(false);
    expect(workbench?.presentCall?.({ op: "observe" })).toEqual({
      card: "generic",
      title: "director_workbench observe",
      kind: "read",
    });
    const blender = defineTool.mock.calls.find((call) => call[0].name === "blender_native")?.[0];
    expect(blender?.timeoutMs).toBe(300_000);
  });

  it("lists exact registered model routes and tells agents to inherit by default", async () => {
    const definitions = new Map<string, any>();
    const section = vi.fn();
    const llm = {
      listProviders: () => [{ id: "epic-relay", name: "Epic Relay" }],
      listModels: async () => [
        { provider: "epic-relay", id: "glm-5.2", name: "GLM 5.2", inputModalities: ["text"] },
        {
          provider: "epic-relay",
          id: "vision-preview",
          name: "Vision Preview",
          inputModalities: ["text", "image"],
        },
      ],
      resolveModelInfo: async () => ({
        provider: "epic-relay",
        id: "glm-5.2",
        name: "GLM 5.2",
        inputModalities: ["text"],
      }),
    };
    registerDirectorWorkbenchPlugin(
      {
        tools: { register: (tool: any) => definitions.set(tool.name, tool) },
        get: (service: string) => (service === "llm" ? llm : service === "systemPrompt" ? { section } : undefined),
      },
      (definition) => definition,
    );

    const result = await definitions.get(DIRECTOR_MODEL_ROUTES_TOOL_NAME).execute(
      {},
      {
        agent: {
          session: { requestHeader: () => ({ config: { provider: "epic-relay", model: "glm-5.2" } }) },
        },
      },
    );

    expect(result).toEqual({
      current: {
        provider: "epic-relay",
        model: "glm-5.2",
        id: "glm-5.2",
        name: "GLM 5.2",
        input_modalities: ["text"],
        image_input: false,
      },
      providers: [
        {
          id: "epic-relay",
          name: "Epic Relay",
          models: [
            {
              id: "glm-5.2",
              name: "GLM 5.2",
              input_modalities: ["text"],
              image_input: false,
            },
            {
              id: "vision-preview",
              name: "Vision Preview",
              input_modalities: ["text", "image"],
              image_input: true,
            },
          ],
        },
      ],
      guidance: "Omit provider/model to inherit the current route. Never guess provider or model ids.",
    });
    expect(section).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "director:workbench",
        text: expect.stringMatching(
          /Load the project skill first[\s\S]*Canonical source order[\s\S]*skill: catalog then load[\s\S]*todo_write[\s\S]*job_list[\s\S]*workflow result of null.*child failed[\s\S]*Shell output.*never mutation evidence[\s\S]*Never claim a workspace was changed[\s\S]*image_attached=false/,
        ),
      }),
    );
  });

  it("uses the live DSH session and returns captures as durable image blocks", async () => {
    const definitions = new Map<string, any>();
    const saveImage = vi.fn(async () => ({
      attachmentId: "capture-1",
      mediaType: "image/png" as const,
      bytes: 5,
      width: 1,
      height: 1,
      name: "director-capture.png",
    }));
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        session_id: "dsh-session-live",
        omit_scene: true,
      });
      return new Response(JSON.stringify({ success: true, capture: { data: "aGVsbG8=", mimeType: "image/png" } }), {
        status: 200,
      });
    });
    const context = {
      tools: { register: (tool: any) => definitions.set(tool.name, tool) },
      get: (service: string) =>
        service === "attachments"
          ? { saveImage }
          : service === "llm"
            ? { resolveModelInfo: async () => ({ inputModalities: ["text", "image"] }) }
            : undefined,
    };
    registerDirectorWorkbenchPlugin(context, (definition) => definition, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gatewayToken: TEST_GATEWAY_TOKEN,
    });

    const definition = definitions.get("director_workbench");
    const value = await definition.execute(
      { op: "capture" },
      { agent: { id: "session-live", options: { provider: "provider", model: "vision-model" } } },
    );
    expect(value.capture).not.toHaveProperty("data");
    expect(saveImage).toHaveBeenCalledOnce();
    expect(definition.output.render({}, value)).toEqual([
      { type: "text", text: JSON.stringify(value) },
      { type: "image", attachment: value.capture },
    ]);
  });

  it("promotes Blender dataBase64 captures without retaining the encoded image", async () => {
    const definitions = new Map<string, any>();
    const saveImage = vi.fn(async () => ({
      attachmentId: "capture-2",
      mediaType: "image/png" as const,
      bytes: 5,
      width: 1,
      height: 1,
      name: "director-capture.png",
    }));
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              result: { dataBase64: "aGVsbG8=", mimeType: "image/png", width: 640, height: 360 },
              capture: { dataBase64: "aGVsbG8=", mimeType: "image/png" },
            },
            capture: { dataBase64: "aGVsbG8=", mimeType: "image/png" },
          }),
          { status: 200 },
        ),
    );
    const context = {
      tools: { register: (tool: any) => definitions.set(tool.name, tool) },
      get: (service: string) =>
        service === "attachments"
          ? { saveImage }
          : service === "llm"
            ? { resolveModelInfo: async () => ({ inputModalities: ["text", "image"] }) }
            : undefined,
    };
    registerDirectorWorkbenchPlugin(context, (definition) => definition, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      gatewayToken: TEST_GATEWAY_TOKEN,
    });

    const value = await definitions
      .get("blender_native")
      .execute(
        { op: "capture" },
        { agent: { id: "session-live", options: { provider: "provider", model: "vision-model" } } },
      );

    expect(JSON.stringify(value)).not.toContain("dataBase64");
    expect(saveImage).toHaveBeenCalledOnce();
    expect(definitions.get("blender_native").output.render({}, value)).toEqual([
      { type: "text", text: JSON.stringify(value) },
      { type: "image", attachment: value.capture },
    ]);
  });

  it("does not report a visual capture when the current route cannot consume images", async () => {
    const definitions = new Map<string, any>();
    const saveImage = vi.fn();
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, capture: { data: "aGVsbG8=", mimeType: "image/png" } }), {
          status: 200,
        }),
    );
    registerDirectorWorkbenchPlugin(
      {
        tools: { register: (tool: any) => definitions.set(tool.name, tool) },
        get: (service: string) =>
          service === "attachments"
            ? { saveImage }
            : service === "llm"
              ? {
                  listProviders: () => [],
                  listModels: async () => [],
                  resolveModelInfo: async () => ({ inputModalities: ["text"] }),
                }
              : undefined,
      },
      (definition) => definition,
      { fetchImpl: fetchImpl as unknown as typeof fetch, gatewayToken: TEST_GATEWAY_TOKEN },
    );

    const definition = definitions.get("director_workbench");
    const value = await definition.execute(
      { op: "capture" },
      { agent: { id: "text-session", options: { provider: "epic-relay", model: "glm-5.2" } } },
    );
    expect(value.capture).toEqual({
      mediaType: "image/png",
      bytes: 5,
      image_attached: false,
      reason: "The current model does not declare image input",
    });
    expect(saveImage).not.toHaveBeenCalled();
    expect(definition.output.render({}, value)).toEqual([{ type: "text", text: JSON.stringify(value) }]);
  });

  it("summarizes an oversized observe before returning it to DSH", async () => {
    const definitions = new Map<string, any>();
    const objects = Array.from({ length: 60 }, (_, index) => ({
      id: `prop-${index}`,
      name: `道具${index}`,
      kind: "prop",
      transform: { position: [index, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    }));
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              project_revision: "rev-big",
              counts: { objects: 60, cameras: 1 },
              objects,
              active_camera_id: "camera-main",
            },
          }),
          { status: 200 },
        ),
    );
    registerDirectorWorkbenchPlugin(
      { tools: { register: (tool: any) => definitions.set(tool.name, tool) } },
      (definition) => definition,
      { fetchImpl: fetchImpl as unknown as typeof fetch, gatewayToken: TEST_GATEWAY_TOKEN },
    );

    const value = await definitions.get("director_workbench").execute({ op: "observe" }, { agent: { id: "big-s" } });

    expect(value.result).toMatchObject({
      observe_mode: "summary",
      projection_reason: "heavy_collection",
      project_revision: "rev-big",
      counts: { objects: 60, cameras: 1 },
      active_camera_id: "camera-main",
      objects: { count: 60, omitted: 36 },
    });
    expect(value.counts).toEqual({ objects: 60, cameras: 1 });
    expect(value.project_revision).toBe("rev-big");
    expect(String(value.result.retrieval_hint)).toContain("inspect");
    expect(JSON.stringify(value)).not.toContain("prop-59");
  });

  it("keeps a small observe result untouched", async () => {
    const definitions = new Map<string, any>();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: {
              project_revision: "rev-small",
              counts: { objects: 1 },
              objects: [{ id: "prop-1", name: "道具", kind: "prop" }],
            },
          }),
          { status: 200 },
        ),
    );
    registerDirectorWorkbenchPlugin(
      { tools: { register: (tool: any) => definitions.set(tool.name, tool) } },
      (definition) => definition,
      { fetchImpl: fetchImpl as unknown as typeof fetch, gatewayToken: TEST_GATEWAY_TOKEN },
    );

    const value = await definitions.get("director_workbench").execute({ op: "observe" }, { agent: { id: "small-s" } });
    expect(value.result.objects).toEqual([{ id: "prop-1", name: "道具", kind: "prop" }]);
    expect(value.result).not.toHaveProperty("observe_mode");
  });

  it("rejects an incomplete catalog call before contacting the Gateway", async () => {
    const definitions = new Map<string, any>();
    const fetchImpl = vi.fn();
    registerDirectorWorkbenchPlugin(
      { tools: { register: (tool: any) => definitions.set(tool.name, tool) } },
      (definition) => definition,
      { fetchImpl: fetchImpl as unknown as typeof fetch, sessionId: "test-session" },
    );
    await expect(definitions.get("director_workbench").execute({ op: "catalog" })).rejects.toThrow(
      /catalog is required/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("summarizes an oversized observe before flattening for the model", async () => {
    const definitions = new Map<string, any>();
    const objects = Array.from({ length: 60 }, (_, index) => ({ id: `prop-${index}`, name: `道具${index}` }));
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            result: { project_revision: "rev-heavy", counts: { objects: 60 }, objects },
          }),
          { status: 200 },
        ),
    );
    registerDirectorWorkbenchPlugin(
      { tools: { register: (tool: any) => definitions.set(tool.name, tool) } },
      (definition) => definition,
      { fetchImpl: fetchImpl as unknown as typeof fetch, gatewayToken: TEST_GATEWAY_TOKEN },
    );
    const value = await definitions
      .get("director_workbench")
      .execute({ op: "observe" }, { agent: { id: "session-heavy" } });
    expect(value.counts).toEqual({ objects: 60 });
    expect(value.project_revision).toBe("rev-heavy");
    expect(value.retrieval_hint).toEqual(expect.stringContaining("inspect"));
    expect(value.observe_mode).toBe("summary");
    expect(Array.isArray((value.result as { objects?: unknown }).objects)).toBe(false);
  });

  it("publishes a Director-specific DSH health contract", () => {
    let route: { handler: (request: { method?: string }, response: any) => void } | undefined;
    const context: any = {
      tools: { register: () => undefined },
      inject: (_services: string[], callback: (value: any) => void) => callback(context),
      effect: (factory: () => () => void) => void factory(),
      webServer: { register: (value: typeof route) => ((route = value), () => undefined) },
    };
    registerDirectorHarnessHealth(context);
    const writeHead = vi.fn();
    const end = vi.fn();
    route?.handler({ method: "GET" }, { writeHead, end });
    expect(writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "access-control-allow-origin": "*" }));
    expect(JSON.parse(String(end.mock.calls[0]?.[0]))).toEqual(DIRECTOR_DSH_HEALTH);
    expect(DIRECTOR_DSH_HEALTH_PATH).toBe("/director/health");
  });
});
