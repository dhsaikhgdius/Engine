import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createDefaultScene } from "@director/stage-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { DirectorAgentTargetWire } from "../../../../packages/protocol/src/agentGatewayProtocol";
import type { FilmRoleId } from "../../../../packages/protocol/src/filmRoles";

const clients: Client[] = [];
const servers: Server[] = [];
const sceneEpoch = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420";

function inheritedEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

async function connectMcp(
  roleId: FilmRoleId | null,
  gatewayUrl = "http://127.0.0.1:9",
  environment: Record<string, string> = {},
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx/esm", resolve(process.cwd(), "backend/gateway/mcp-server.ts")],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      ...inheritedEnvironment(),
      STAGE_GATEWAY_URL: gatewayUrl,
      DIRECTOR_GATEWAY_TOKEN: "director-test-token-000000",
      DIRECTOR_FILM_ROLE: roleId ?? "",
      ...environment,
    },
  });
  const client = new Client({ name: "director-role-policy-test", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolveClose, reject) =>
            server.close((error) => (error ? reject(error) : resolveClose())),
          ),
      ),
  );
});

describe("MCP film-role boundary", () => {
  it("advertises only the typed tool surface and never the stage command tools", async () => {
    const client = await connectMcp(null);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);

    expect(tools.sort()).toEqual(
      [
        "director_creative",
        "director_dcc",
        "director_film",
        "director_game",
        "director_production",
        "director_workbench",
        "stage_video",
        "blender_native",
      ].sort(),
    );
  }, 20_000);

  it("shows visual evidence tools but rejects Blender writes for the visual critic", async () => {
    const client = await connectMcp("visual-critic");
    const tools = (await client.listTools()).tools.map((tool) => tool.name);

    expect(tools).toEqual(expect.arrayContaining(["director_workbench", "director_creative", "blender_native"]));
    expect(tools).not.toContain("stage_read");
    expect(tools).not.toContain("stage_object");
    expect(tools).not.toContain("director_dcc");

    const result = await client.callTool({
      name: "blender_native",
      arguments: {
        op: "apply",
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 4,
        operations: [{ op: "create_primitive", primitive: "cube", id: "critic-must-not-write" }],
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining("tool_policy_rejected") }),
    );
  }, 20_000);

  it("lets the production designer execute a native Blender transaction", async () => {
    let receivedInput: unknown;
    const gateway = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        receivedInput = JSON.parse(body).input;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            success: true,
            receipt: { revisionBefore: 4, revisionAfter: 5 },
            evidence: { revision: 5, objects: [{ id: "designer-wall" }], cameras: [], lights: [] },
          }),
        );
      });
    });
    servers.push(gateway);
    await new Promise<void>((resolveListen) => gateway.listen(0, "127.0.0.1", resolveListen));
    const address = gateway.address() as AddressInfo;
    const client = await connectMcp("production-designer", `http://127.0.0.1:${address.port}`);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);

    expect(tools).toEqual(expect.arrayContaining(["director_workbench", "blender_native"]));
    expect(tools).not.toContain("stage_read");
    expect(tools).not.toContain("stage_object");

    const result = await client.callTool({
      name: "blender_native",
      arguments: {
        op: "apply",
        expectedSceneEpoch: sceneEpoch,
        expectedRevision: 4,
        operations: [{ op: "create_primitive", primitive: "cube", id: "designer-wall" }],
      },
    });
    expect(result.isError).not.toBe(true);
    expect(receivedInput).toMatchObject({ op: "apply", expectedSceneEpoch: sceneEpoch, expectedRevision: 4 });
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining('"revisionAfter":5') }),
    );
  }, 20_000);

  it("shares revision memory and retries only its own stale guard", async () => {
    const target: DirectorAgentTargetWire = {
      token: "mcp-target-token",
      client_id: "mcp-client",
      instance_id: "mcp-instance",
      scene_id: "mcp-scene",
      creative_scope_id: "mcp-creative",
      contract_version: 2,
    };
    const receivedInputs: Array<Record<string, unknown>> = [];
    const gateway = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const input = JSON.parse(body).input as Record<string, unknown>;
        receivedInputs.push(input);
        const authorAttempt = receivedInputs.filter((item) => item.op === "author").length;
        const stale = input.op === "author" && authorAttempt === 1;
        response.writeHead(stale ? 409 : 200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            success: !stale,
            ...(stale ? { code: "revision_conflict" } : {}),
            result: stale
              ? { code: "revision_conflict" }
              : { project_revision: input.op === "observe" ? "revision-1" : "revision-2" },
            scene: createDefaultScene(),
            target,
          }),
        );
      });
    });
    servers.push(gateway);
    await new Promise<void>((resolveListen) => gateway.listen(0, "127.0.0.1", resolveListen));
    const address = gateway.address() as AddressInfo;
    const client = await connectMcp("stage-director", `http://127.0.0.1:${address.port}`, {
      DIRECTOR_TARGET_TOKEN: target.token,
      DIRECTOR_TARGET_DESCRIPTOR: JSON.stringify(target),
    });

    await client.callTool({ name: "director_workbench", arguments: { op: "observe" } });
    const result = await client.callTool({
      name: "director_workbench",
      arguments: { op: "author", action: "create_primitive" },
    });

    expect(result.isError).not.toBe(true);
    expect(receivedInputs).toEqual([
      { op: "observe" },
      { op: "author", action: "create_primitive", expected_revision: "revision-1" },
      { op: "author", action: "create_primitive" },
    ]);
  }, 20_000);

  it("rejects mutating workbench tools when DIRECTOR_PLAN_MODE is on", async () => {
    const receivedPaths: string[] = [];
    const gateway = createServer((request, response) => {
      receivedPaths.push(`${request.method} ${request.url ?? ""}`);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "plan mode must not reach the tool route" }));
    });
    servers.push(gateway);
    await new Promise<void>((resolveListen) => gateway.listen(0, "127.0.0.1", resolveListen));
    const address = gateway.address() as AddressInfo;
    const client = await connectMcp(null, `http://127.0.0.1:${address.port}`, {
      DIRECTOR_PLAN_MODE: "1",
    });

    const result = await client.callTool({
      name: "director_workbench",
      arguments: { op: "author", action: "create_primitive" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining("plan_mode_blocked") }),
    );
    expect(receivedPaths.some((path) => path.startsWith("POST"))).toBe(false);
  }, 20_000);
});
