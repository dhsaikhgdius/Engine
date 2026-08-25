/**
 * @director/project-schema — barrel export.
 *
 * Re-exports every public type, schema, and utility from the project schema
 * package in a single import target.
 *
 * @module @director/project-schema
 */

// @ts-nocheck
export * from "./directorProject";
export * from "./directorProjectSchema";
export * from "./directorProjectRevision";
export * from "./cameraGeometry";
// Resolve the legacy cameraGeometry name collision in favour of the protocol ID tuple.
export { DIRECTOR_CAMERA_SENSOR_FORMATS } from "./directorProject";
export * from "./directorProduction";
export * from "./poseSchema";
export * from "./directorAnimation";
export * from "./animationEasing";
export * from "./frameRate";
export * from "./frameTime";
export * from "./proceduralGait";
export * from "./trajectoryMath";
export * from "./mannequinPosePresets";
export * from "./directorPrevizPalette";
export * from "./primitiveGeometry";
export * from "./characterBodyAnchors";
export * from "./directorLighting";
export * from "./animationRecipes";
