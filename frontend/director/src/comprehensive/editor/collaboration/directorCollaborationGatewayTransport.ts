import { bootstrapDirectorAgent } from "../assistant/agentGatewayClient";
import {
  decodeDirectorCollaborationGatewayPayload,
  directorCollaborationGatewayServerMessageSchema,
  directorCollaborationRoomSchema,
  encodeDirectorCollaborationGatewayPayload,
} from "../../../../../../packages/protocol/src/directorCollaborationGatewayProtocol";
import type { DirectorCollaborationTransport, DirectorCollaborationWireMessage } from "./directorCollaboration";

const DEFAULT_GATEWAY_URL = import.meta.env.VITE_STAGE_GATEWAY_URL ?? "http://127.0.0.1:8787";
const INITIAL_RECONNECT_DELAY_MS = 350;
const MAX_RECONNECT_DELAY_MS = 5_000;

type GatewayTransportOptions = {
  gatewayUrl?: string;
  getBrowserToken?: () => Promise<string>;
  createWebSocket?: (url: string) => WebSocket;
  reconnect?: boolean;
  setReconnectTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearReconnectTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  /**
   * Room invite capability token, required when the gateway runs with
   * `DIRECTOR_COLLAB_ROOM_AUTH=required`. Local trust gateways ignore it.
   */
  inviteToken?: string;
};

/**
 * Session-ending denials: access revoked/expired/missing, or the operator closed
 * the room. Compliant clients must drop membership and stop reconnecting.
 *
 * `forbidden` is intentionally absent — the hub only emits it for an in-session
 * viewer write refusal; the peer remains a valid room member and must keep
 * awareness / catch-up flowing (and still reconnect on network drops).
 */
const PERMANENT_COLLAB_ERROR_CODES = new Set(["unauthorized", "room_closed"]);

/**
 * Join-time capacity conflicts. The peer was never admitted (or lost the race);
 * close the socket so backoff reconnect can retry instead of leaving a half-open
 * non-joined WebSocket that never re-sends `collab.join`.
 */
const TRANSIENT_JOIN_DENIAL_CODES = new Set(["room_full", "client_id_conflict"]);

/** Resolves the deployment-provided invite token, if any. */
function defaultCollaborationInviteToken(): string | undefined {
  const configured: unknown = import.meta.env.VITE_DIRECTOR_COLLAB_INVITE_TOKEN;
  return typeof configured === "string" && configured.trim() ? configured.trim() : undefined;
}

function toWebSocketUrl(gatewayUrl: string, browserToken: string) {
  const url = new URL(gatewayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  url.search = "";
  url.searchParams.set("browser_token", browserToken);
  return url.toString();
}

function gatewayType(type: DirectorCollaborationWireMessage["type"]) {
  return `collab.${type}` as const;
}

/** Authenticated, reconnecting adapter for the transport-neutral Yjs contract. */
export class GatewayWebSocketDirectorTransport implements DirectorCollaborationTransport {
  private readonly listeners = new Set<(message: DirectorCollaborationWireMessage) => void>();
  private readonly options: Required<
    Pick<
      GatewayTransportOptions,
      "gatewayUrl" | "getBrowserToken" | "createWebSocket" | "reconnect" | "setReconnectTimer" | "clearReconnectTimer"
    >
  >;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private generation = 0;
  private joined = false;
  private closed = false;
  /** When set, scheduleReconnect becomes a no-op (permanent join denial / room close). */
  private haltReconnect = false;
  /** Capability role from the latest `collab.ready`; null until joined. */
  private role: "editor" | "viewer" | null = null;
  private readonly inviteToken: string | undefined;

  readonly roomId: string;

  constructor(
    roomId: string,
    readonly awarenessClientId: number,
    options: GatewayTransportOptions = {},
  ) {
    this.roomId = directorCollaborationRoomSchema.parse(roomId);
    this.inviteToken = options.inviteToken ?? defaultCollaborationInviteToken();
    this.options = {
      gatewayUrl: options.gatewayUrl ?? DEFAULT_GATEWAY_URL,
      getBrowserToken: options.getBrowserToken ?? (async () => (await bootstrapDirectorAgent()).browserToken),
      createWebSocket: options.createWebSocket ?? ((url) => new WebSocket(url)),
      reconnect: options.reconnect ?? true,
      setReconnectTimer: options.setReconnectTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs)),
      clearReconnectTimer: options.clearReconnectTimer ?? ((timer) => globalThis.clearTimeout(timer)),
    };
    void this.connect();
  }

  /**
   * Viewers must not push document updates; awareness and sync-request stay
   * allowed so presence and catch-up still work. Defaults to true until the
   * gateway reports a role (legacy ready packets without `role`).
   */
  get canWriteDocuments(): boolean {
    return this.role !== "viewer";
  }

  /** Latest capability role from `collab.ready`, or null before join. */
  get grantedRole(): "editor" | "viewer" | null {
    return this.role;
  }

  send(message: DirectorCollaborationWireMessage) {
    const socket = this.socket;
    if (this.closed || !this.joined || !socket || socket.readyState !== WebSocket.OPEN) return;
    if (message.type === "document-update" && !this.canWriteDocuments) return;
    const payload = encodeDirectorCollaborationGatewayPayload(message.payload);
    if (!payload) return;
    socket.send(
      JSON.stringify({
        type: gatewayType(message.type),
        room: this.roomId,
        payload,
      }),
    );
  }

  subscribe(listener: (message: DirectorCollaborationWireMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.clearPendingReconnect();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "collab.leave", room: this.roomId }));
      socket.close(1000, "collaboration transport closed");
    } else {
      socket?.close();
    }
    this.joined = false;
    this.role = null;
    this.listeners.clear();
  }

  private clearPendingReconnect() {
    if (this.reconnectTimer !== null) {
      this.options.clearReconnectTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private haltOnPermanentError() {
    this.joined = false;
    this.haltReconnect = true;
    this.clearPendingReconnect();
  }

  private async connect() {
    const generation = ++this.generation;
    try {
      const browserToken = await this.options.getBrowserToken();
      if (this.closed || this.haltReconnect || generation !== this.generation) return;
      const socket = this.options.createWebSocket(toWebSocketUrl(this.options.gatewayUrl, browserToken));
      this.socket = socket;
      this.joined = false;
      this.role = null;
      socket.addEventListener("open", () => {
        if (this.closed || this.haltReconnect || generation !== this.generation || this.socket !== socket) return;
        socket.send(
          JSON.stringify({
            type: "collab.join",
            room: this.roomId,
            awareness_client_id: this.awarenessClientId,
            ...(this.inviteToken ? { invite_token: this.inviteToken } : {}),
          }),
        );
      });
      socket.addEventListener("message", (event) => {
        if (this.closed || generation !== this.generation || this.socket !== socket) return;
        try {
          const parsed = directorCollaborationGatewayServerMessageSchema.safeParse(JSON.parse(String(event.data)));
          if (!parsed.success || (parsed.data.room && parsed.data.room !== this.roomId)) return;
          if (parsed.data.type === "collab.ready") {
            this.joined = true;
            this.role = parsed.data.role ?? "editor";
            this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
            return;
          }
          if (parsed.data.type === "collab.error") {
            if (PERMANENT_COLLAB_ERROR_CODES.has(parsed.data.code)) {
              // Access denials and operator closes must not spin reconnect
              // loops against the gateway. Drop membership and stop reconnect.
              this.haltOnPermanentError();
              socket.close(4000, parsed.data.code);
              return;
            }
            if (TRANSIENT_JOIN_DENIAL_CODES.has(parsed.data.code) && !this.joined) {
              // Capacity / awareness-id conflicts on join: close so the
              // reconnect path re-sends collab.join after backoff.
              socket.close(4001, parsed.data.code);
            }
            // `forbidden` and other in-session protocol errors leave membership
            // and reconnect policy unchanged.
            return;
          }
          const payload = decodeDirectorCollaborationGatewayPayload(parsed.data.payload);
          if (!payload) return;
          const message: DirectorCollaborationWireMessage = {
            type: parsed.data.type.slice("collab.".length) as DirectorCollaborationWireMessage["type"],
            payload,
          };
          this.listeners.forEach((listener) => listener(message));
        } catch {
          // The gateway is an untrusted boundary. Ignore malformed packets.
        }
      });
      const reconnect = () => {
        if (this.closed || generation !== this.generation || this.socket !== socket) return;
        this.socket = null;
        this.joined = false;
        this.role = null;
        this.scheduleReconnect();
      };
      socket.addEventListener("close", reconnect, { once: true });
      socket.addEventListener("error", () => socket.close(), { once: true });
    } catch {
      if (!this.closed && !this.haltReconnect && generation === this.generation) this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.closed || this.haltReconnect || !this.options.reconnect || this.reconnectTimer !== null) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(MAX_RECONNECT_DELAY_MS, this.reconnectDelayMs * 2);
    this.reconnectTimer = this.options.setReconnectTimer(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}

/**
 * Creates a gateway WebSocket transport for Director collaboration.
 * Returns null when running outside a browser (no WebSocket API).
 *
 * @param roomId - The collaboration room identifier.
 * @param awarenessClientId - The Yjs awareness client ID for this peer.
 * @param options - Optional transport overrides such as a room invite token.
 * @returns A new GatewayWebSocketDirectorTransport or null.
 */
export function createGatewayWebSocketDirectorTransport(
  roomId: string,
  awarenessClientId: number,
  options: GatewayTransportOptions = {},
): GatewayWebSocketDirectorTransport | null {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return null;
  return new GatewayWebSocketDirectorTransport(roomId, awarenessClientId, options);
}
