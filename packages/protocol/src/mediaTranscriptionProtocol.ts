import { z } from "zod";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

/**
 * A single timed transcript segment with speaker attribution and confidence.
 *
 * Cross-validates that endSec is strictly greater than startSec.
 */
export const directorMediaTranscriptSegmentSchema = z
  .strictObject({
    startSec: z.number().finite().nonnegative(),
    endSec: z.number().finite().positive(),
    text: boundedText(8_000),
    speaker: z.string().trim().min(1).max(160).nullable().default(null),
    confidence: z.number().finite().min(0).max(1).nullable().default(null),
  })
  .refine((segment) => segment.endSec > segment.startSec, {
    message: "Transcript segment endSec must be greater than startSec",
    path: ["endSec"],
  });

/**
 * A complete media transcript with ordered segments, job provenance, and
 * source media metadata.
 *
 * Validates that segments are monotonically ordered by startSec and that
 * no segment extends beyond the source duration (with a 50 ms tolerance
 * for rounding).
 */
export const directorMediaTranscriptSchema = z
  .strictObject({
    version: z.literal(1),
    jobId: boundedText(240),
    sourceMediaId: boundedText(512),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    provider: boundedText(200),
    model: boundedText(240),
    language: z.string().trim().min(1).max(80).nullable(),
    durationSec: z
      .number()
      .finite()
      .positive()
      .max(24 * 60 * 60)
      .nullable(),
    text: z.string().max(1_000_000),
    segments: z.array(directorMediaTranscriptSegmentSchema).max(20_000),
    createdAt: z.string().datetime(),
  })
  .superRefine((transcript, context) => {
    let previousStart = -1;
    transcript.segments.forEach((segment, index) => {
      if (segment.startSec < previousStart) {
        context.addIssue({
          code: "custom",
          path: ["segments", index, "startSec"],
          message: "Transcript segments must be ordered by startSec",
        });
      }
      if (transcript.durationSec !== null && segment.endSec > transcript.durationSec + 0.05) {
        context.addIssue({
          code: "custom",
          path: ["segments", index, "endSec"],
          message: "Transcript segment exceeds the source duration",
        });
      }
      previousStart = segment.startSec;
    });
  });

/** Input payload for a media transcription job. */
export const mediaTranscriptionJobInputSchema = z.strictObject({
  sourceMediaId: boundedText(512),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceMimeType: boundedText(200),
  sourceFileName: boundedText(255),
  durationSec: z
    .number()
    .finite()
    .positive()
    .max(24 * 60 * 60)
    .nullable()
    .default(null),
  model: boundedText(240),
  language: z.string().trim().min(1).max(80).optional(),
});

/** Advertised capabilities of the media transcription provider. */
export const mediaTranscriptionCapabilitiesSchema = z.strictObject({
  version: z.literal(1),
  configured: z.boolean(),
  provider: z.literal("openai-compatible"),
  model: boundedText(240),
  endpointHost: z.string().max(500).nullable(),
  maxInputBytes: z.number().int().positive(),
  supportsSegments: z.literal(true),
  supportsVtt: z.literal(true),
  supportsLongMedia: z.literal(true),
  longMediaStrategy: z.literal("adaptive-chunking"),
  chunkThresholdSec: z.number().int().positive(),
  chunkDurationSec: z.number().int().positive(),
  chunkConcurrency: z.number().int().min(1).max(4),
});

export type DirectorMediaTranscript = z.infer<typeof directorMediaTranscriptSchema>;
export type DirectorMediaTranscriptSegment = z.infer<typeof directorMediaTranscriptSegmentSchema>;
export type MediaTranscriptionJobInput = z.infer<typeof mediaTranscriptionJobInputSchema>;
export type MediaTranscriptionCapabilities = z.infer<typeof mediaTranscriptionCapabilitiesSchema>;

/** Formats a floating-point second value as a WebVTT timestamp (HH:MM:SS.mmm). */
function vttTime(seconds: number) {
  const milliseconds = Math.max(0, Math.round(seconds * 1_000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** Deterministic WebVTT projection used by downloads, project bundles, and the Video Editor. */
export function serializeDirectorMediaTranscriptVtt(input: DirectorMediaTranscript) {
  const transcript = directorMediaTranscriptSchema.parse(input);
  return [
    "WEBVTT",
    "",
    ...transcript.segments.flatMap((segment, index) => [
      String(index + 1),
      `${vttTime(segment.startSec)} --> ${vttTime(segment.endSec)}`,
      `${segment.speaker ? `<v ${segment.speaker}>` : ""}${segment.text}`,
      "",
    ]),
  ].join("\n");
}
