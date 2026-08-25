import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeDirectorCollaborationGatewayPayload } from "../../../../../../packages/protocol/src/directorCollaborationGatewayProtocol";
import { GatewayWebSocketDirectorTransport } from "../../../../src/comprehensive/editor/collaboration/directorCollaborationGatewayTransport";

type SocketListener = (event: Event | MessageEvent) => void;

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: TestWebSocket[] = [];

  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<SocketListener>>();
  readyState = TestWebSocket.CONNECTING;
  closeCode: number | undefined;

  constructor(readonly url: string) {
    TestWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener, _options?: AddEventListenerOptions | boolean) {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener as SocketListener);
    this.listeners.set(type, listeners);
  }

  send(value: string) {
    this.sent.push(value);
  }

  close(code?: number) {
    if (this.readyState === TestWebSocket.CLOSED) return;
    this.closeCode = code;
    this.readyState = TestWebSocket.CLOSED;
    this.emit("close", new Event("close"));
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.emit("open", new Event("open"));
  }

  receive(value: unknown) {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  private emit(type: string, event: Event | MessageEvent) {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

beforeEach(() => {
  TestWebSocket.instances = [];
  vi.stubGlobal("WebSocket", TestWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GatewayWebSocketDirectorTransport", () => {
  it("authenticates, joins before sending, decodes packets, and leaves cleanly", async () => {
    const transport = new GatewayWebSocketDirectorTransport("scene/shot-1", 42, {
      gatewayUrl: "https://director.example/gateway/",
      getBrowserToken: async () => "secret browser token",
      createWebSocket: (url) => new TestWebSocket(url) as unknown as WebSocket,
      reconnect: false,
    });
    const received: Array<{ type: string; payload: Uint8Array }> = [];
    transport.subscribe((message) => received.push(message));
    transport.send({ type: "document-update", payload: new Uint8Array([1, 2, 3]) });

    await waitFor(() => expect(TestWebSocket.instances).toHaveLength(1));
    const socket = TestWebSocket.instances[0]!;
    expect(socket.url).toContain("wss://director.example/gateway/ws?browser_token=secret+browser+token");
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: "collab.join",
      room: "scene/shot-1",
      awareness_client_id: 42,
    });
    expect(socket.sent).toHaveLength(1);

    socket.receive({ type: "collab.ready", room: "scene/shot-1" });
    transport.send({ type: "document-update", payload: new Uint8Array([1, 2, 3]) });
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      type: "collab.document-update",
      room: "scene/shot-1",
    });

    socket.receive({
      type: "collab.sync-request",
      room: "scene/shot-1",
      payload: encodeDirectorCollaborationGatewayPayload(new Uint8Array([0]))!,
    });
    expect(received).toEqual([{ type: "sync-request", payload: new Uint8Array([0]) }]);

    transport.close();
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "collab.leave", room: "scene/shot-1" });
    expect(socket.closeCode).toBe(1000);
  });
});
