/**
 * Blender 材质节点编辑器，用于在活动网格上创建、连接、配置和删除材质节点。
 *
 * @module blender-material-nodes-editor
 */

import { useEffect, useMemo, useState } from "react";
import type {
  BlenderAgentOperation,
  BlenderEffectReceipt,
  BlenderMaterialGraph,
  BlenderObjectInspection,
} from "../../../../../../packages/protocol/src/blenderLiveProtocol";
import { useLanguage } from "../../i18n/language";
import {
  blenderConnectMaterialNodesOperation,
  blenderCreateMaterialNodeOperation,
  blenderDeleteMaterialNodeOperation,
  blenderDisconnectMaterialNodeInputOperation,
  blenderSetMaterialNodeInputOperation,
  type BlenderMaterialNodeInputValue,
  type BlenderMaterialNodeType,
} from "../api/blenderLiveClient";

type MaterialNode = BlenderMaterialGraph["nodes"][number];
type MaterialSocket = MaterialNode["inputs"][number];

interface BlenderMaterialNodesEditorProps {
  activeMeshId: string;
  busy: boolean;
  inspection: BlenderObjectInspection | null;
  materialName: string;
  onApply: (
    label: string,
    operations: BlenderAgentOperation[],
    preferredMeshId?: string,
  ) => Promise<BlenderEffectReceipt | null>;
}

const NODE_TYPES: BlenderMaterialNodeType[] = [
  "PRINCIPLED_BSDF",
  "MATERIAL_OUTPUT",
  "MIX_COLOR",
  "NORMAL_MAP",
  "BUMP",
  "TEX_COORD",
  "MAPPING",
  "NOISE_TEXTURE",
];

const NODE_TYPE_LABELS: Record<BlenderMaterialNodeType, string> = {
  PRINCIPLED_BSDF: "原理化 BSDF",
  MATERIAL_OUTPUT: "材质输出",
  MIX_COLOR: "颜色混合",
  NORMAL_MAP: "法线贴图",
  BUMP: "凹凸",
  TEX_COORD: "纹理坐标",
  MAPPING: "映射",
  NOISE_TEXTURE: "噪波纹理",
};

function editableSocketValue(value: unknown): BlenderMaterialNodeInputValue | null {
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= 4 &&
    value.every((component) => typeof component === "number")
  ) {
    return value as BlenderMaterialNodeInputValue;
  }
  return null;
}

function nodeTitle(node: MaterialNode, t: (value: string) => string) {
  if (node.label) return node.label;
  if (node.nodeType === "CUSTOM") return node.name || node.blenderType;
  return t(NODE_TYPE_LABELS[node.nodeType]);
}

function nextNodeRef(type: BlenderMaterialNodeType, nodes: MaterialNode[]) {
  const base = type.toLowerCase().replaceAll("_", "-");
  if (!nodes.some((node) => node.nodeRef === base)) return base;
  let suffix = 2;
  while (nodes.some((node) => node.nodeRef === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function MaterialSocketValueEditor({
  busy,
  onCommit,
  socket,
}: {
  busy: boolean;
  onCommit: (value: BlenderMaterialNodeInputValue) => Promise<boolean>;
  socket: MaterialSocket;
}) {
  const { t } = useLanguage();
  const sourceValue = useMemo(() => editableSocketValue(socket.defaultValue), [socket.defaultValue]);
  const [draft, setDraft] = useState(sourceValue);

  useEffect(() => setDraft(sourceValue), [sourceValue]);

  if (sourceValue === null || draft === null) return <small>{socket.type}</small>;

  async function commit() {
    if (!(await onCommit(draft!))) setDraft(sourceValue);
  }

  return (
    <div aria-label={`${t("输入")} ${socket.name}`} className="blender-node-socket-value" role="group">
      {typeof draft === "boolean" ? (
        <label className="blender-node-socket-boolean">
          <input
            checked={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>{draft ? t("开") : t("关")}</span>
        </label>
      ) : Array.isArray(draft) ? (
        <div className="blender-node-socket-vector">
          {draft.map((component, index) => (
            <input
              aria-label={`${socket.name} ${index + 1}`}
              disabled={busy}
              key={index}
              onChange={(event) => {
                const next = [...draft] as number[];
                next[index] = Number(event.currentTarget.value);
                setDraft(next as BlenderMaterialNodeInputValue);
              }}
              step={0.01}
              type="number"
              value={component}
            />
          ))}
        </div>
      ) : (
        <input
          aria-label={socket.name}
          disabled={busy}
          onChange={(event) => setDraft(Number(event.currentTarget.value))}
          step={0.01}
          type="number"
          value={draft}
        />
      )}
      <button aria-label={`${t("设置")} ${socket.name}`} disabled={busy} onClick={() => void commit()} type="button">
        {t("设置")}
      </button>
    </div>
  );
}

/**
 * 材质节点编辑器，用于在活动网格的指定材质上添加、删除、连接节点和编辑输入值。
 * @param activeMeshId - 当前活动网格的 ID。
 * @param busy - 是否正在执行操作。
 * @param inspection - 当前对象的检查数据。
 * @param materialName - 要编辑的材质名称。
 * @param onApply - 应用操作的回调，接收标签和操作列表。
 */
export function BlenderMaterialNodesEditor({
  activeMeshId,
  busy,
  inspection,
  materialName,
  onApply,
}: BlenderMaterialNodesEditorProps) {
  const { t } = useLanguage();
  const graph = useMemo(
    () => inspection?.materialGraphs.find((entry) => entry.materialName === materialName) ?? null,
    [inspection, materialName],
  );
  const nodes = useMemo(() => graph?.nodes ?? [], [graph]);
  const [nodeType, setNodeType] = useState<BlenderMaterialNodeType>("MIX_COLOR");
  const [newNodeLabel, setNewNodeLabel] = useState("");
  const [selectedNodeRef, setSelectedNodeRef] = useState("");
  const [sourceNodeRef, setSourceNodeRef] = useState("");
  const [sourceSocketRef, setSourceSocketRef] = useState("");
  const [targetNodeRef, setTargetNodeRef] = useState("");
  const [targetSocketRef, setTargetSocketRef] = useState("");

  const sourceNodes = useMemo(() => nodes.filter((node) => node.outputs.some((socket) => socket.enabled)), [nodes]);
  const targetNodes = useMemo(() => nodes.filter((node) => node.inputs.some((socket) => socket.enabled)), [nodes]);
  const selectedNode = nodes.find((node) => node.nodeRef === selectedNodeRef) ?? null;
  const sourceNode = sourceNodes.find((node) => node.nodeRef === sourceNodeRef) ?? null;
  const targetNode = targetNodes.find((node) => node.nodeRef === targetNodeRef) ?? null;
  const sourceSockets = useMemo(() => sourceNode?.outputs.filter((socket) => socket.enabled) ?? [], [sourceNode]);
  const targetSockets = useMemo(() => targetNode?.inputs.filter((socket) => socket.enabled) ?? [], [targetNode]);

  useEffect(() => {
    setSelectedNodeRef((current) =>
      nodes.some((node) => node.nodeRef === current) ? current : (nodes[0]?.nodeRef ?? ""),
    );
    setSourceNodeRef((current) =>
      sourceNodes.some((node) => node.nodeRef === current) ? current : (sourceNodes[0]?.nodeRef ?? ""),
    );
    setTargetNodeRef((current) =>
      targetNodes.some((node) => node.nodeRef === current) ? current : (targetNodes[0]?.nodeRef ?? ""),
    );
  }, [nodes, sourceNodes, targetNodes]);

  useEffect(() => {
    setSourceSocketRef((current) =>
      sourceSockets.some((socket) => socket.socketRef === current) ? current : (sourceSockets[0]?.socketRef ?? ""),
    );
  }, [sourceSockets]);

  useEffect(() => {
    setTargetSocketRef((current) =>
      targetSockets.some((socket) => socket.socketRef === current) ? current : (targetSockets[0]?.socketRef ?? ""),
    );
  }, [targetSockets]);

  async function applyNode(label: string, operation: BlenderAgentOperation) {
    return Boolean(await onApply(label, [operation], activeMeshId));
  }

  async function createNode() {
    const success = await applyNode(
      t("添加材质节点"),
      blenderCreateMaterialNodeOperation({
        objectId: activeMeshId,
        materialName,
        nodeRef: nextNodeRef(nodeType, nodes),
        nodeType,
        label: newNodeLabel.trim() || undefined,
      }),
    );
    if (success) setNewNodeLabel("");
  }

  const endpointLabel = (nodeRef: string, socketRef: string) => {
    const node = nodes.find((entry) => entry.nodeRef === nodeRef);
    return `${node ? nodeTitle(node, t) : nodeRef} · ${socketRef}`;
  };

  return (
    <details className="blender-material-nodes">
      <summary>
        <span>
          <strong>{t("材质节点")}</strong>
          <small>{graph ? `${nodes.length} ${t("节点")} · ${graph.links.length} ${t("连接")}` : t("尚无节点图")}</small>
        </span>
        {graph ? (
          <small title={graph.objectIds.join(", ")}>
            {graph.objectIds.length} {t("个对象使用")}
          </small>
        ) : null}
      </summary>

      <div aria-label={t("材质节点编辑")} className="blender-material-nodes-body" role="region">
        {!materialName ? <p>{t("请先应用材质")}</p> : null}

        {materialName ? (
          <section className="blender-node-add">
            <select
              aria-label={t("节点类型")}
              disabled={busy}
              onChange={(event) => setNodeType(event.currentTarget.value as BlenderMaterialNodeType)}
              value={nodeType}
            >
              {NODE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(NODE_TYPE_LABELS[type])}
                </option>
              ))}
            </select>
            <input
              aria-label={t("节点标签")}
              disabled={busy}
              onChange={(event) => setNewNodeLabel(event.currentTarget.value)}
              placeholder={t("可选标签")}
              value={newNodeLabel}
            />
            <button disabled={busy} onClick={() => void createNode()} type="button">
              {t("添加节点")}
            </button>
          </section>
        ) : null}

        {nodes.length > 0 ? (
          <>
            <section className="blender-node-focus">
              <label>
                <span>{t("节点")}</span>
                <select
                  disabled={busy}
                  onChange={(event) => setSelectedNodeRef(event.currentTarget.value)}
                  value={selectedNodeRef}
                >
                  {nodes.map((node) => (
                    <option key={node.nodeRef} value={node.nodeRef}>
                      {nodeTitle(node, t)}
                    </option>
                  ))}
                </select>
              </label>
              {selectedNode ? (
                <button
                  aria-label={`${t("删除节点")} ${nodeTitle(selectedNode, t)}`}
                  disabled={busy}
                  onClick={() =>
                    void applyNode(
                      t("删除材质节点"),
                      blenderDeleteMaterialNodeOperation({
                        objectId: activeMeshId,
                        materialName,
                        nodeRef: selectedNode.nodeRef,
                      }),
                    )
                  }
                  type="button"
                >
                  {t("删除")}
                </button>
              ) : null}
            </section>

            {selectedNode ? (
              <section className="blender-node-sockets">
                <header>
                  <span>{nodeTitle(selectedNode, t)}</span>
                  <small>
                    {selectedNode.activeOutput ? `${t("活动输出")} · ` : ""}
                    {selectedNode.inputs.length} in · {selectedNode.outputs.length} out
                  </small>
                </header>
                {selectedNode.inputs.map((socket) => (
                  <div className="blender-node-socket-row" key={socket.socketRef}>
                    <div>
                      <span>{socket.name}</span>
                      <small>{socket.type}</small>
                    </div>
                    {socket.linked ? (
                      <button
                        aria-label={`${t("断开")} ${socket.name}`}
                        disabled={busy}
                        onClick={() =>
                          void applyNode(
                            t("断开材质节点"),
                            blenderDisconnectMaterialNodeInputOperation({
                              objectId: activeMeshId,
                              materialName,
                              nodeRef: selectedNode.nodeRef,
                              inputSocketRef: socket.socketRef,
                            }),
                          )
                        }
                        type="button"
                      >
                        {t("断开")}
                      </button>
                    ) : socket.enabled ? (
                      <MaterialSocketValueEditor
                        busy={busy}
                        onCommit={(value) =>
                          applyNode(
                            t("设置节点输入"),
                            blenderSetMaterialNodeInputOperation({
                              objectId: activeMeshId,
                              materialName,
                              nodeRef: selectedNode.nodeRef,
                              inputSocketRef: socket.socketRef,
                              value,
                            }),
                          )
                        }
                        socket={socket}
                      />
                    ) : (
                      <small>{t("不可用")}</small>
                    )}
                  </div>
                ))}
                {selectedNode.outputs.length > 0 ? (
                  <div className="blender-node-output-list">
                    <small>{t("输出")}</small>
                    {selectedNode.outputs.map((socket) => (
                      <span key={socket.socketRef}>{socket.name}</span>
                    ))}
                  </div>
                ) : null}
              </section>
            ) : null}

            {sourceNodes.length > 0 && targetNodes.length > 0 ? (
              <section className="blender-node-connect">
                <strong>{t("连接节点")}</strong>
                <div>
                  <select
                    aria-label={t("源节点")}
                    disabled={busy}
                    onChange={(event) => setSourceNodeRef(event.currentTarget.value)}
                    value={sourceNodeRef}
                  >
                    {sourceNodes.map((node) => (
                      <option key={node.nodeRef} value={node.nodeRef}>
                        {nodeTitle(node, t)}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={t("输出插槽")}
                    disabled={busy}
                    onChange={(event) => setSourceSocketRef(event.currentTarget.value)}
                    value={sourceSocketRef}
                  >
                    {sourceSockets.map((socket) => (
                      <option key={socket.socketRef} value={socket.socketRef}>
                        {socket.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={t("目标节点")}
                    disabled={busy}
                    onChange={(event) => setTargetNodeRef(event.currentTarget.value)}
                    value={targetNodeRef}
                  >
                    {targetNodes.map((node) => (
                      <option key={node.nodeRef} value={node.nodeRef}>
                        {nodeTitle(node, t)}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={t("输入插槽")}
                    disabled={busy}
                    onChange={(event) => setTargetSocketRef(event.currentTarget.value)}
                    value={targetSocketRef}
                  >
                    {targetSockets.map((socket) => (
                      <option key={socket.socketRef} value={socket.socketRef}>
                        {socket.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  disabled={busy || !sourceNodeRef || !sourceSocketRef || !targetNodeRef || !targetSocketRef}
                  onClick={() =>
                    void applyNode(
                      t("连接材质节点"),
                      blenderConnectMaterialNodesOperation({
                        objectId: activeMeshId,
                        materialName,
                        from: {
                          nodeRef: sourceNodeRef,
                          socketRef: sourceSocketRef,
                        },
                        to: {
                          nodeRef: targetNodeRef,
                          socketRef: targetSocketRef,
                        },
                      }),
                    )
                  }
                  type="button"
                >
                  {t("连接")}
                </button>
              </section>
            ) : null}

            {graph?.links.length ? (
              <section className="blender-node-links">
                <strong>{t("连接")}</strong>
                {graph.links.map((link) => (
                  <div key={`${link.from.nodeRef}:${link.from.socketRef}:${link.to.nodeRef}:${link.to.socketRef}`}>
                    <span>
                      {endpointLabel(link.from.nodeRef, link.from.socketRef)} →{" "}
                      {endpointLabel(link.to.nodeRef, link.to.socketRef)}
                    </span>
                    <button
                      aria-label={`${t("断开")} ${endpointLabel(link.to.nodeRef, link.to.socketRef)}`}
                      disabled={busy}
                      onClick={() =>
                        void applyNode(
                          t("断开材质节点"),
                          blenderDisconnectMaterialNodeInputOperation({
                            objectId: activeMeshId,
                            materialName,
                            nodeRef: link.to.nodeRef,
                            inputSocketRef: link.to.socketRef,
                          }),
                        )
                      }
                      type="button"
                    >
                      {t("断开")}
                    </button>
                  </div>
                ))}
              </section>
            ) : null}
          </>
        ) : materialName ? (
          <p>{t("该材质尚无节点，可添加常用节点开始搭建。")}</p>
        ) : null}
      </div>
    </details>
  );
}
