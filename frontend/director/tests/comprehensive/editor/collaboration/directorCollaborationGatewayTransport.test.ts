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

  it("stops reconnecting after unauthorized and does not re-open a socket", async () => {
    const timers: Array<{ callback: () => void }> = [];
    const transport = new GatewayWebSocketDirectorTransport("scene/shot-1", 42, {
      gatewayUrl: "https://director.example/gateway/",
      getBrowserToken: async () => "secret browser token",
      createWebSocket: (url) => new TestWebSocket(url) as unknown as WebSocket,
      reconnect: true,
      setReconnectTimer: (callback) => {
        timers.push({ callback });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearReconnectTimer: () => undefined,
    });
    await waitFor(() => expect(TestWebSocket.instances).toHaveLength(1));
    const socket = TestWebSocket.instances[0]!;
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "collab.join" });

    socket.receive({
      type: "collab.error",
      room: "scene/shot-1",
      code: "unauthorized",
      message: "Invite required.",
    });
    expect(socket.closeCode).toBe(4000);
    for (const timer of [...timers]) timer.callback();
    expect(TestWebSocket.instances).toHaveLength(1);

    transport.close();
  });

  it("honors viewer role: document updates are suppressed while awareness still sends", async () => {
    const transport = new GatewayWebSocketDirectorTransport("scene/shot-1", 42, {
      gatewayUrl: "https://director.example/gateway/",
      getBrowserToken: async () => "secret browser token",
      createWebSocket: (url) => new TestWebSocket(url) as unknown as WebSocket,
      reconnect: false,
      inviteToken: "viewer-invite",
    });
    await waitFor(() => expect(TestWebSocket.instances).toHaveLength(1));
    const socket = TestWebSocket.instances[0]!;
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: "collab.join",
      invite_token: "viewer-invite",
    });
    socket.receive({ type: "collab.ready", room: "scene/shot-1", role: "viewer" });
    expect(transport.grantedRole).toBe("viewer");
    expect(transport.canWriteDocuments).toBe(false);

    const sentBefore = socket.sent.length;
    transport.send({ type: "document-update", payload: new Uint8Array([9, 9]) });
    expect(socket.sent).toHaveLength(sentBefore);
    transport.send({ type: "awareness-update", payload: new Uint8Array([1]) });
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ type: "collab.awareness-update" });

    transport.close();
  });

  it("stops reconnecting after an operator closes the room", async () => {
    const timers: Array<{ callback: () => void }> = [];
    const transport = new GatewayWebSocketDirectorTransport("scene/shot-1", 42, {
      gatewayUrl: "https://director.example/gateway/",
      getBrowserToken: async () => "secret browser token",
      createWebSocket: (url) => new TestWebSocket(url) as unknown as WebSocket,
      reconnect: true,
      setReconnectTimer: (callback) => {
        timers.push({ callback });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearReconnectTimer: () => undefined,
    });
    await waitFor(() => expect(TestWebSocket.instances).toHaveLength(1));
    const socket = TestWebSocket.instances[0]!;
    socket.open();
    socket.receive({ type: "collab.ready", room: "scene/shot-1", role: "editor" });
    transport.send({ type: "document-update", payload: new Uint8Array([1]) });
    const sentBeforeClose = socket.sent.length;

    socket.receive({
      type: "collab.error",
      room: "scene/shot-1",
      code: "room_closed",
      message: "This collaboration room was closed by an operator.",
    });
    transport.send({ type: "document-update", payload: new Uint8Array([2]) });
    expect(socket.sent).toHaveLength(sentBeforeClose);
    for (const timer of [...timers]) timer.callback();
    expect(TestWebSocket.instances).toHaveLength(1);

    transport.close();
  });
});
