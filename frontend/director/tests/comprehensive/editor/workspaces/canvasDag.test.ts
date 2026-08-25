import { describe, expect, it } from "vitest";
import { analyzeDirectorCanvasDag, layoutDirectorCanvasDag, wouldCreateDirectorCanvasCycle } from "../../../../src/comprehensive/editor/workspaces/canvasDag";

const nodes = ["idea", "image", "voice", "edit"].map((id) => ({ id, width: 240, height: 160 }));
const edges = [
  { id: "edge-1", sourceNodeId: "idea", targetNodeId: "image" },
  { id: "edge-2", sourceNodeId: "idea", targetNodeId: "voice" },
  { id: "edge-3", sourceNodeId: "image", targetNodeId: "edit" },
  { id: "edge-4", sourceNodeId: "voice", targetNodeId: "edit" },
];

describe("Canvas dependency DAG", () => {
  it("builds deterministic topological and parallel execution levels", () => {
    expect(analyzeDirectorCanvasDag(nodes, edges)).toMatchObject({
      valid: true,
      roots: ["idea"],
      leaves: ["edit"],
      topologicalOrder: ["idea", "image", "voice", "edit"],
      parallelLevels: [["idea"], ["image", "voice"], ["edit"]],
      issues: [],
    });
  });

  it("reports malformed edges and the exact strongly connected component", () => {
    const analysis = analyzeDirectorCanvasDag(nodes, [
      ...edges,
      { id: "edge-5", sourceNodeId: "edit", targetNodeId: "image" },
      { id: "edge-6", sourceNodeId: "missing", targetNodeId: "idea" },
      { id: "edge-7", sourceNodeId: "idea", targetNodeId: "idea" },
      { id: "edge-8", sourceNodeId: "idea", targetNodeId: "image" },
    ]);
    expect(analysis.valid).toBe(false);
    expect(analysis.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "cycle", nodeIds: ["edit", "image"] }),
        expect.objectContaining({ code: "dangling_source", edgeId: "edge-6" }),
        expect.objectContaining({ code: "self_edge", edgeId: "edge-7" }),
        expect.objectContaining({ code: "duplicate_edge", edgeId: "edge-8" }),
      ]),
    );
  });

  it("rejects only connections that would introduce a cycle", () => {
    expect(wouldCreateDirectorCanvasCycle(nodes, edges, "edit", "idea")).toBe(true);
    expect(wouldCreateDirectorCanvasCycle(nodes, edges, "image", "voice")).toBe(false);
  });

  it("lays parallel nodes in one dependency column", () => {
    const layout = layoutDirectorCanvasDag(nodes, edges, {
      direction: "horizontal",
      originX: 10,
      originY: 20,
      layerGap: 100,
      nodeGap: 40,
    });
    expect(layout.analysis.valid).toBe(true);
    expect(layout.positions.get("idea")).toEqual({ x: 10, y: 20 });
    expect(layout.positions.get("image")?.x).toBe(layout.positions.get("voice")?.x);
    expect(layout.positions.get("image")?.y).not.toBe(layout.positions.get("voice")?.y);
    expect(layout.positions.get("edit")!.x).toBeGreaterThan(layout.positions.get("image")!.x);
  });
});
