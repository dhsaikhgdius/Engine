import { beforeEach, describe, expect, it } from "vitest";
import { applyDirectorAuthoringActions } from "@director/agent-engine/authoring";
import { getDirectorProjectRevision } from "@director/project-schema";
import { createInitialDirectorState, useDirectorStore } from "../../src/comprehensive/editor/store/directorStore";
import {
  compileDirectorDeleteObjectActions,
  dispatchDirectorAuthoringActions,
} from "../../src/agent/dispatchDirectorAuthoringActions";

function resetDirectorStore() {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    clipboard: [],
    clipboardPasteCount: 0,
    undoStack: [],
    redoStack: [],
    undoBatchDepth: 0,
    undoBatchSnapshot: null,
    undoBatchHasTrackedChanges: false,
  });
}

function seedProp(objectId: string, position: [number, number, number] = [0, 0, 0]) {
  const seeded = applyDirectorAuthoringActions(useDirectorStore.getState().project, [
    {
      action: "add_object",
      id: objectId,
      name: objectId,
      kind: "prop",
      geometry_type: "box",
      placement_mode: "grounded",
      transform: {
        position,
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    },
  ]);
  useDirectorStore.getState().applyAuthoredProject(seeded.project);
}

describe("dispatchDirectorAuthoringActions", () => {
  beforeEach(() => {
    resetDirectorStore();
  });

  it("matches the project revision of a direct authoring apply for the same delete_objects batch", () => {
    seedProp("parity-box");

    const before = structuredClone(useDirectorStore.getState().project);
    const actions = compileDirectorDeleteObjectActions(before, ["parity-box"]);
    const agentApplied = applyDirectorAuthoringActions(before, actions);
    useDirectorStore.getState().applyAuthoredProject(agentApplied.project);
    const agentRevision = getDirectorProjectRevision(useDirectorStore.getState().project);

    useDirectorStore.getState().applyAuthoredProject(before);
    const uiReceipt = dispatchDirectorAuthoringActions(actions, {
      idempotencyKey: "parity-delete-v1",
    });

    expect(uiReceipt.ok).toBe(true);
    if (!uiReceipt.ok) throw new Error(uiReceipt.error);
    expect(uiReceipt.project_revision).toBe(agentRevision);
    expect(useDirectorStore.getState().project.objects.some((object) => object.id === "parity-box")).toBe(false);
  });

  it("detaches children before deleting a parent so UI delete stays non-cascading", () => {
    seedProp("parent-box", [0, 0, 0]);
    const withChild = applyDirectorAuthoringActions(useDirectorStore.getState().project, [
      {
        action: "add_object",
        id: "child-box",
        name: "child-box",
        kind: "prop",
        geometry_type: "box",
        placement_mode: "grounded",
        parent_id: "parent-box",
        transform: {
          position: [1, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
      },
    ]);
    useDirectorStore.getState().applyAuthoredProject(withChild.project);

    const actions = compileDirectorDeleteObjectActions(useDirectorStore.getState().project, ["parent-box"]);
    expect(actions).toEqual([
      {
        action: "update_object",
        object_id: "child-box",
        patch: { parent_id: null },
        force: true,
      },
      {
        action: "delete_objects",
        object_ids: ["parent-box"],
        force: true,
      },
    ]);

    const receipt = dispatchDirectorAuthoringActions(actions, { idempotencyKey: "parity-detach-delete-v1" });
    expect(receipt.ok).toBe(true);
    const project = useDirectorStore.getState().project;
    expect(project.objects.some((object) => object.id === "parent-box")).toBe(false);
    expect(project.objects.find((object) => object.id === "child-box")?.parentObjectId).toBeUndefined();
  });

  it("routes store.deleteObjects through the shared authoring dispatch path", () => {
    seedProp("store-delete-box", [1, 0, 0]);

    useDirectorStore.getState().deleteObjects(["store-delete-box"]);

    expect(useDirectorStore.getState().project.objects.some((object) => object.id === "store-delete-box")).toBe(false);
  });

  it("rejects an empty action list without mutating the project", () => {
    const before = structuredClone(useDirectorStore.getState().project);
    const beforeRevision = getDirectorProjectRevision(before);

    const receipt = dispatchDirectorAuthoringActions([]);

    expect(receipt.ok).toBe(false);
    if (receipt.ok) throw new Error("expected failure");
    expect(receipt.error).toMatch(/No authoring actions/);
    expect(getDirectorProjectRevision(useDirectorStore.getState().project)).toBe(beforeRevision);
  });

  it("rejects a stale expectedRevision without mutating the project", () => {
    seedProp("stale-guard-box");
    const before = structuredClone(useDirectorStore.getState().project);
    const actions = compileDirectorDeleteObjectActions(before, ["stale-guard-box"]);

    const receipt = dispatchDirectorAuthoringActions(actions, {
      expectedRevision: "stale-revision",
      idempotencyKey: "parity-stale-v1",
    });

    expect(receipt.ok).toBe(false);
    if (receipt.ok) throw new Error("expected failure");
    expect(receipt.error).toMatch(/Stale project revision/);
    expect(useDirectorStore.getState().project.objects.some((object) => object.id === "stale-guard-box")).toBe(true);
  });
});
