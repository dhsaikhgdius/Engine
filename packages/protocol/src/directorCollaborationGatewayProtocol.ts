import { z } from "zod";

/** Maximum payload size in bytes for collaboration messages (16 MiB). */
export const DIRECTOR_COLLABORATION_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
/** Maximum length of a collaboration room identifier. */
export const DIRECTOR_COLLABORATION_MAX_ROOM_LENGTH = 180;
/** Empty state vector used as a default for Yjs document sync. */
export const DIRECTOR_COLLABORATION_EMPTY_STATE_VECTOR = new Uint8Array([0]);

const MAX_BASE64_PAYLOAD_CHARS = Math.ceil(DIRECTOR_COLLABORATION_MAX_PAYLOAD_BYTES / 3) * 4;
const base64PayloadSchema = z
  .string()
  .min(4)
  .max(MAX_BASE64_PAYLOAD_CHARS)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

/** Validates a collaboration room name: alphanumeric with dots, underscores, colons, at-signs, slashes, and hyphens. */
export const directorCollaborationRoomSchema = z
  .string()
  .trim()
  .min(1)
  .max(DIRECTOR_COLLABORATION_MAX_ROOM_LENGTH)
  .regex(/^[\p{L}\p{N}._:@/-]+$/u);

const routedPayloadSchema = z.strictObject({
  room: directorCollaborationRoomSchema,
  payload: base64PayloadSchema,
});

/** Messages the client sends to the collaboration gateway: join, leave, document updates, awareness, and sync. */
export const directorCollaborationGatewayClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("collab.join"),
    room: directorCollaborationRoomSchema,
    awareness_client_id: z.number().int().nonnegative().max(0xffff_ffff),
  }),
  z.strictObject({ type: z.literal("collab.leave"), room: directorCollaborationRoomSchema }),
  routedPayloadSchema.extend({ type: z.literal("collab.document-update") }).strict(),
  routedPayloadSchema.extend({ type: z.literal("collab.awareness-update") }).strict(),
  routedPayloadSchema.extend({ type: z.literal("collab.sync-request") }).strict(),
]);

/** Messages the server sends to collaboration clients: ready, document updates, awareness, sync, and errors. */
export const directorCollaborationGatewayServerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("collab.ready"),
    room: directorCollaborationRoomSchema,
  }),
  routedPayloadSchema.extend({ type: z.literal("collab.document-update") }).strict(),
  routedPayloadSchema.extend({ type: z.literal("collab.awareness-update") }).strict(),
  routedPayloadSchema.extend({ type: z.literal("collab.sync-request") }).strict(),
  z.strictObject({
    type: z.literal("collab.error"),
    room: directorCollaborationRoomSchema.optional(),
    code: z.enum([
      "invalid_message",
      "join_required",
      "room_mismatch",
      "room_full",
      "client_id_conflict",
      "invalid_payload",
    ]),
    message: z.string().trim().min(1).max(400),
  }),
]);

/** A parsed client-to-server collaboration message. */
export type DirectorCollaborationGatewayClientMessage = z.infer<typeof directorCollaborationGatewayClientMessageSchema>;
/** A parsed server-to-client collaboration message. */
export type DirectorCollaborationGatewayServerMessage = z.infer<typeof directorCollaborationGatewayServerMessageSchema>;

/**
 * Encodes a binary payload to base64 for wire transport.
 *
 * Splits large payloads into 32 KiB chunks for `String.fromCharCode` compatibility.
 *
 * @param payload - The raw binary payload to encode.
 * @returns A base64 string, or null if the payload is empty or exceeds the size limit.
 */
export function encodeDirectorCollaborationGatewayPayload(payload: Uint8Array) {
  if (!(payload instanceof Uint8Array) || payload.byteLength === 0) return null;
  if (payload.byteLength > DIRECTOR_COLLABORATION_MAX_PAYLOAD_BYTES) return null;
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < payload.byteLength; offset += chunkSize) {
    const chunk = payload.subarray(offset, Math.min(payload.byteLength, offset + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return globalThis.btoa(binary);
}

/**
 * Decodes a base64-encoded collaboration payload back to a `Uint8Array`.
 *
 * @param encoded - The base64 string, validated against the payload schema.
 * @returns The decoded binary payload, or null if the input is invalid or exceeds the size limit.
 */
export function decodeDirectorCollaborationGatewayPayload(encoded: string) {
  const parsed = base64PayloadSchema.safeParse(encoded);
  if (!parsed.success) return null;
  try {
    const binary = globalThis.atob(parsed.data);
    if (binary.length === 0 || binary.length > DIRECTOR_COLLABORATION_MAX_PAYLOAD_BYTES) return null;
    const payload = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) payload[index] = binary.charCodeAt(index);
    return payload;
  } catch {
    return null;
  }
}
