import { create } from "zustand";
import type { CharacterPoseJointId } from "./characterPoseJoints";

interface CharacterPoseEditorState {
  objectId: string | null;
  jointId: CharacterPoseJointId;
  activate: (objectId: string) => void;
  deactivate: (objectId?: string) => void;
  selectJoint: (jointId: CharacterPoseJointId) => void;
}

/** Transient viewport selection for the character pose tool. */
export const useCharacterPoseEditorStore = create<CharacterPoseEditorState>((set) => ({
  objectId: null,
  jointId: "torso",
  activate: (objectId) => set((state) => (state.objectId === objectId ? state : { objectId, jointId: "torso" })),
  deactivate: (objectId) => set((state) => (!objectId || state.objectId === objectId ? { objectId: null } : state)),
  selectJoint: (jointId) => set((state) => (state.jointId === jointId ? state : { jointId })),
}));
