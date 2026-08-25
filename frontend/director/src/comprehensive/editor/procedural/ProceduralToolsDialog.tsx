/**
 * @module ProceduralToolsDialog
 * @description Modal dialog for authoring procedural modelling operations
 *   (arrays, scatter, terrain, L-system, etc.) with a live preview plan before
 *   applying to the project.
 */

import "./proceduralTools.css";
import { Boxes, Check, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  applyDirectorAuthoringActions,
  previewDirectorProceduralRecipe,
  type DirectorApplyProceduralAction,
} from "@director/agent-engine";
import type { DirectorProceduralOperation } from "@director/protocol/procedural";
import type { DirectorProject } from "../schema/directorProject";
import { useDirectorStore } from "../store/directorStore";
import { useSuppressViewportChromeWhileMounted } from "../canvas/viewportChromeSuppression";
import { useModalDialogFocus } from "../../app/layout/useModalDialogFocus";

type OperationKind = DirectorProceduralOperation["kind"];
type OperationOf<Kind extends OperationKind> = Extract<DirectorProceduralOperation, { kind: Kind }>;

const OPERATION_LABELS: Record<OperationKind, string> = {
  "linear-array": "线性阵列",
  "radial-array": "环形阵列",
  mirror: "镜像副本",
  scatter: "种子散布",
  staircase: "楼梯生成",
  terrain: "地形体块",
  "l-system": "L-system 植物",
  "fragment-scaffold": "碎裂脚手架",
};

let recipeSequence = 0;

function createRecipeId() {
  recipeSequence += 1;
  return `procedural-${Date.now().toString(36)}-${recipeSequence.toString(36)}`;
}

function eligibleSourceObjects(project: DirectorProject) {
  return project.objects.filter(
    (object) =>
      (object.kind === "prop" || object.kind === "scene") &&
      !object.isCompositeParent &&
      Boolean(object.geometryType || object.assetRefId),
  );
}

function defaultOperation(kind: OperationKind, project: DirectorProject): DirectorProceduralOperation {
  const sources = eligibleSourceObjects(project);
  const source = sources[0];
  const sourceObjectId = source?.id ?? "";
  const center = [...(source?.transform.position ?? [0, project.scene.groundHeight, 0])] as [number, number, number];
  switch (kind) {
    case "linear-array":
      return { kind, sourceObjectId, copies: 4, offset: [2, 0, 0] };
    case "radial-array":
      return {
        kind,
        sourceObjectId,
        copies: 8,
        center,
        radius: 4,
        startAngleDegrees: 0,
        arcDegrees: 360,
        orientation: "outward",
      };
    case "mirror":
      return { kind, sourceObjectId, axis: "x", pivot: 0, mirrorGeometry: true };
    case "scatter":
      return {
        kind,
        sourceObjectId,
        copies: 12,
        center,
        size: [12, 12],
        heightJitter: 0,
        yawDegrees: 180,
        scaleMin: 0.8,
        scaleMax: 1.2,
        seed: 42,
      };
    case "staircase":
      return {
        kind,
        shape: "straight",
        steps: 12,
        center: [0, project.scene.groundHeight, 0],
        width: 2.4,
        depth: 0.45,
        risePerStep: 0.18,
        runPerStep: 0.42,
        radius: 2,
        turns: 1.5,
        includePillar: true,
        stepColor: "#9aa3ad",
        pillarColor: "#e8e6e0",
      };
    case "terrain":
      return {
        kind,
        center: [0, project.scene.groundHeight, 0],
        size: 12,
        resolution: 8,
        heightScale: 2.5,
        octaves: 4,
        seed: 1,
        color: "#4a6a3a",
      };
    case "l-system":
      return {
        kind,
        center: [0, project.scene.groundHeight, 0],
        iterations: 3,
        branches: 2,
        branchLength: 1,
        lengthDecay: 0.68,
        branchRadius: 0.12,
        angleDegrees: 34,
        seed: 11,
        trunkColor: "#5a3a1a",
        foliageColor: "#2d8a3e",
      };
    case "fragment-scaffold":
      return { kind, sourceObjectId, fragments: 8, spread: 0.7, seed: 5, deleteSource: false };
  }
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="procedural-field">
      <span>{label}</span>
      <input
        aria-label={label}
        max={max}
        min={min}
        step={step}
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
  );
}

function VectorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: [number, number, number];
  onChange: (value: [number, number, number]) => void;
}) {
  return (
    <fieldset className="procedural-vector">
      <legend>{label}</legend>
      {(["X", "Y", "Z"] as const).map((axis, index) => (
        <label key={axis}>
          <span data-axis={axis}>{axis}</span>
          <input
            aria-label={`${label} ${axis}`}
            step="0.1"
            type="number"
            value={value[index]}
            onChange={(event) => {
              const next = [...value] as [number, number, number];
              next[index] = Number(event.currentTarget.value);
              onChange(next);
            }}
          />
        </label>
      ))}
    </fieldset>
  );
}

function SourceField({
  project,
  value,
  onChange,
}: {
  project: DirectorProject;
  value: string;
  onChange: (value: string) => void;
}) {
  const sources = eligibleSourceObjects(project);
  return (
    <label className="procedural-field procedural-span-2">
      <span>源物体</span>
      <select aria-label="程序化源物体" value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {!sources.length ? <option value="">当前片场没有可复制的道具或场景物体</option> : null}
        {sources.map((source) => (
          <option key={source.id} value={source.id}>
            {source.name} · {source.id}
          </option>
        ))}
      </select>
    </label>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="procedural-field">
      <span>{label}</span>
      <input aria-label={label} type="color" value={value} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

function OperationFields({
  operation,
  project,
  onChange,
}: {
  operation: DirectorProceduralOperation;
  project: DirectorProject;
  onChange: (operation: DirectorProceduralOperation) => void;
}) {
  if (operation.kind === "linear-array") {
    return (
      <>
        <SourceField
          project={project}
          value={operation.sourceObjectId}
          onChange={(sourceObjectId) => onChange({ ...operation, sourceObjectId })}
        />
        <NumberField
          label="副本数"
          min={1}
          max={64}
          value={operation.copies}
          onChange={(copies) => onChange({ ...operation, copies })}
        />
        <VectorField
          label="每份偏移"
          value={operation.offset}
          onChange={(offset) => onChange({ ...operation, offset })}
        />
      </>
    );
  }
  if (operation.kind === "radial-array") {
    return (
      <>
        <SourceField
          project={project}
          value={operation.sourceObjectId}
          onChange={(sourceObjectId) => onChange({ ...operation, sourceObjectId })}
        />
        <NumberField
          label="副本数"
          min={1}
          max={64}
          value={operation.copies}
          onChange={(copies) => onChange({ ...operation, copies })}
        />
        <NumberField
          label="半径"
          min={0.01}
          max={1000}
          step={0.1}
          value={operation.radius}
          onChange={(radius) => onChange({ ...operation, radius })}
        />
        <NumberField
          label="起始角度"
          min={-360}
          max={360}
          value={operation.startAngleDegrees}
          onChange={(startAngleDegrees) => onChange({ ...operation, startAngleDegrees })}
        />
        <NumberField
          label="弧度范围（度）"
          min={-360}
          max={360}
          value={operation.arcDegrees}
          onChange={(arcDegrees) => onChange({ ...operation, arcDegrees })}
        />
        <label className="procedural-field">
          <span>朝向</span>
          <select
            aria-label="环形阵列朝向"
            value={operation.orientation}
            onChange={(event) =>
              onChange({
                ...operation,
                orientation: event.currentTarget.value as OperationOf<"radial-array">["orientation"],
              })
            }
          >
            <option value="preserve">保留</option>
            <option value="outward">向外</option>
            <option value="inward">向内</option>
            <option value="tangent">切向</option>
          </select>
        </label>
        <VectorField
          label="阵列中心"
          value={operation.center}
          onChange={(center) => onChange({ ...operation, center })}
        />
      </>
    );
  }
  if (operation.kind === "mirror") {
    return (
      <>
        <SourceField
          project={project}
          value={operation.sourceObjectId}
          onChange={(sourceObjectId) => onChange({ ...operation, sourceObjectId })}
        />
        <label className="procedural-field">
          <span>镜像轴</span>
          <select
            aria-label="镜像轴"
            value={operation.axis}
            onChange={(event) => onChange({ ...operation, axis: event.currentTarget.value as "x" | "y" | "z" })}
          >
            <option value="x">X</option>
            <option value="y">Y</option>
            <option value="z">Z</option>
          </select>
        </label>
        <NumberField
          label="镜像平面位置"
          step={0.1}
          value={operation.pivot}
          onChange={(pivot) => onChange({ ...operation, pivot })}
        />
        <label className="procedural-check procedural-span-2">
          <input
            type="checkbox"
            checked={operation.mirrorGeometry}
            onChange={(event) => onChange({ ...operation, mirrorGeometry: event.currentTarget.checked })}
          />
          <span>同时镜像几何手性（使用负缩放轴）</span>
        </label>
      </>
    );
  }
  if (operation.kind === "scatter") {
    return (
      <>
        <SourceField
          project={project}
          value={operation.sourceObjectId}
          onChange={(sourceObjectId) => onChange({ ...operation, sourceObjectId })}
        />
        <NumberField
          label="副本数"
          min={1}
          max={64}
          value={operation.copies}
          onChange={(copies) => onChange({ ...operation, copies })}
        />
        <NumberField label="种子" value={operation.seed} onChange={(seed) => onChange({ ...operation, seed })} />
        <NumberField
          label="区域宽度"
          min={0.01}
          step={0.1}
          value={operation.size[0]}
          onChange={(value) => onChange({ ...operation, size: [value, operation.size[1]] })}
        />
        <NumberField
          label="区域深度"
          min={0.01}
          step={0.1}
          value={operation.size[1]}
          onChange={(value) => onChange({ ...operation, size: [operation.size[0], value] })}
        />
        <NumberField
          label="高度抖动"
          min={0}
          step={0.1}
          value={operation.heightJitter}
          onChange={(heightJitter) => onChange({ ...operation, heightJitter })}
        />
        <NumberField
          label="最大偏航角"
          min={0}
          max={360}
          value={operation.yawDegrees}
          onChange={(yawDegrees) => onChange({ ...operation, yawDegrees })}
        />
        <NumberField
          label="最小缩放"
          min={0.01}
          step={0.05}
          value={operation.scaleMin}
          onChange={(scaleMin) => onChange({ ...operation, scaleMin })}
        />
        <NumberField
          label="最大缩放"
          min={0.01}
          step={0.05}
          value={operation.scaleMax}
          onChange={(scaleMax) => onChange({ ...operation, scaleMax })}
        />
        <VectorField
          label="散布中心"
          value={operation.center}
          onChange={(center) => onChange({ ...operation, center })}
        />
      </>
    );
  }
  if (operation.kind === "staircase") {
    return (
      <>
        <label className="procedural-field">
          <span>楼梯形态</span>
          <select
            aria-label="楼梯形态"
            value={operation.shape}
            onChange={(event) => onChange({ ...operation, shape: event.currentTarget.value as "straight" | "spiral" })}
          >
            <option value="straight">直线</option>
            <option value="spiral">螺旋</option>
          </select>
        </label>
        <NumberField
          label="台阶数"
          min={3}
          max={64}
          value={operation.steps}
          onChange={(steps) => onChange({ ...operation, steps })}
        />
        <NumberField
          label="宽度"
          min={0.01}
          step={0.1}
          value={operation.width}
          onChange={(width) => onChange({ ...operation, width })}
        />
        <NumberField
          label="踏步深度"
          min={0.01}
          step={0.05}
          value={operation.depth}
          onChange={(depth) => onChange({ ...operation, depth })}
        />
        <NumberField
          label="每级高度"
          min={0.01}
          step={0.01}
          value={operation.risePerStep}
          onChange={(risePerStep) => onChange({ ...operation, risePerStep })}
        />
        <NumberField
          label="每级进深"
          min={0.01}
          step={0.05}
          value={operation.runPerStep}
          onChange={(runPerStep) => onChange({ ...operation, runPerStep })}
        />
        {operation.shape === "spiral" ? (
          <>
            <NumberField
              label="螺旋半径"
              min={0.01}
              step={0.1}
              value={operation.radius}
              onChange={(radius) => onChange({ ...operation, radius })}
            />
            <NumberField
              label="圈数"
              min={0.01}
              max={8}
              step={0.1}
              value={operation.turns}
              onChange={(turns) => onChange({ ...operation, turns })}
            />
            <label className="procedural-check procedural-span-2">
              <input
                type="checkbox"
                checked={operation.includePillar}
                onChange={(event) => onChange({ ...operation, includePillar: event.currentTarget.checked })}
              />
              <span>生成中央支柱</span>
            </label>
          </>
        ) : null}
        <ColorField
          label="踏步颜色"
          value={operation.stepColor}
          onChange={(stepColor) => onChange({ ...operation, stepColor })}
        />
        <ColorField
          label="支柱颜色"
          value={operation.pillarColor}
          onChange={(pillarColor) => onChange({ ...operation, pillarColor })}
        />
        <VectorField
          label="楼梯起点"
          value={operation.center}
          onChange={(center) => onChange({ ...operation, center })}
        />
      </>
    );
  }
  if (operation.kind === "terrain") {
    return (
      <>
        <NumberField
          label="地形边长"
          min={1}
          max={200}
          step={0.5}
          value={operation.size}
          onChange={(size) => onChange({ ...operation, size })}
        />
        <NumberField
          label="网格分辨率"
          min={2}
          max={12}
          value={operation.resolution}
          onChange={(resolution) => onChange({ ...operation, resolution })}
        />
        <NumberField
          label="高度幅度"
          min={0.05}
          max={50}
          step={0.1}
          value={operation.heightScale}
          onChange={(heightScale) => onChange({ ...operation, heightScale })}
        />
        <NumberField
          label="噪声层数"
          min={1}
          max={6}
          value={operation.octaves}
          onChange={(octaves) => onChange({ ...operation, octaves })}
        />
        <NumberField label="种子" value={operation.seed} onChange={(seed) => onChange({ ...operation, seed })} />
        <ColorField label="地形颜色" value={operation.color} onChange={(color) => onChange({ ...operation, color })} />
        <VectorField
          label="地形中心"
          value={operation.center}
          onChange={(center) => onChange({ ...operation, center })}
        />
      </>
    );
  }
  if (operation.kind === "l-system") {
    return (
      <>
        <NumberField
          label="迭代层数"
          min={1}
          max={4}
          value={operation.iterations}
          onChange={(iterations) => onChange({ ...operation, iterations })}
        />
        <NumberField
          label="每层分支"
          min={2}
          max={3}
          value={operation.branches}
          onChange={(branches) => onChange({ ...operation, branches })}
        />
        <NumberField
          label="主枝长度"
          min={0.1}
          step={0.1}
          value={operation.branchLength}
          onChange={(branchLength) => onChange({ ...operation, branchLength })}
        />
        <NumberField
          label="长度衰减"
          min={0.35}
          max={0.9}
          step={0.01}
          value={operation.lengthDecay}
          onChange={(lengthDecay) => onChange({ ...operation, lengthDecay })}
        />
        <NumberField
          label="枝干半径"
          min={0.01}
          step={0.01}
          value={operation.branchRadius}
          onChange={(branchRadius) => onChange({ ...operation, branchRadius })}
        />
        <NumberField
          label="分叉角度"
          min={5}
          max={75}
          value={operation.angleDegrees}
          onChange={(angleDegrees) => onChange({ ...operation, angleDegrees })}
        />
        <NumberField label="种子" value={operation.seed} onChange={(seed) => onChange({ ...operation, seed })} />
        <ColorField
          label="枝干颜色"
          value={operation.trunkColor}
          onChange={(trunkColor) => onChange({ ...operation, trunkColor })}
        />
        <ColorField
          label="叶簇颜色"
          value={operation.foliageColor}
          onChange={(foliageColor) => onChange({ ...operation, foliageColor })}
        />
        <VectorField
          label="植物根部"
          value={operation.center}
          onChange={(center) => onChange({ ...operation, center })}
        />
      </>
    );
  }
  return (
    <>
      <SourceField
        project={project}
        value={operation.sourceObjectId}
        onChange={(sourceObjectId) => onChange({ ...operation, sourceObjectId })}
      />
      <NumberField
        label="碎片数"
        min={2}
        max={30}
        value={operation.fragments}
        onChange={(fragments) => onChange({ ...operation, fragments })}
      />
      <NumberField
        label="散开距离"
        min={0}
        step={0.1}
        value={operation.spread}
        onChange={(spread) => onChange({ ...operation, spread })}
      />
      <NumberField label="种子" value={operation.seed} onChange={(seed) => onChange({ ...operation, seed })} />
      <label className="procedural-check procedural-span-2">
        <input
          type="checkbox"
          checked={operation.deleteSource}
          onChange={(event) => onChange({ ...operation, deleteSource: event.currentTarget.checked })}
        />
        <span>应用时删除源物体（锁定或含子级时会拒绝整批操作）</span>
      </label>
    </>
  );
}

export function ProceduralToolsDialog({
  onClose,
  onApplied,
}: {
  onClose: () => void;
  onApplied?: (message: string) => void;
}) {
  useSuppressViewportChromeWhileMounted("procedural-tools");
  const dialogRef = useModalDialogFocus<HTMLElement>({ onClose });
  const project = useDirectorStore((state) => state.project);
  const replaceProject = useDirectorStore((state) => state.replaceProject);
  const selectObjects = useDirectorStore((state) => state.selectObjects);
  const [recipeId] = useState(createRecipeId);
  const [createdAt] = useState(() => new Date().toISOString());
  const [name, setName] = useState(OPERATION_LABELS["linear-array"]);
  const [operation, setOperation] = useState<DirectorProceduralOperation>(() =>
    defaultOperation("linear-array", project),
  );
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const action: DirectorApplyProceduralAction = useMemo(
    () => ({ action: "apply_procedural", recipe_id: recipeId, name, created_at: createdAt, operation }),
    [createdAt, name, operation, recipeId],
  );
  const preview = useMemo(() => {
    try {
      return { value: previewDirectorProceduralRecipe(project, action), error: null };
    } catch (error) {
      return { value: null, error: error instanceof Error ? error.message : "程序化参数无效" };
    }
  }, [action, project]);

  function changeKind(kind: OperationKind) {
    setOperation(defaultOperation(kind, project));
    setName(OPERATION_LABELS[kind]);
    setApplyError(null);
  }

  function apply() {
    if (!preview.value) return;
    setBusy(true);
    setApplyError(null);
    try {
      const result = applyDirectorAuthoringActions(project, [preview.value.action]);
      replaceProject(result.project);
      selectObjects(preview.value.recipe.outputObjectIds);
      onApplied?.(
        `已生成 ${preview.value.recipe.outputObjectIds.length} 个可编辑物体，并保存程序化 recipe；可用撤销回退。`,
      );
      onClose();
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : "程序化操作应用失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="procedural-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        aria-label="程序化建模工具"
        aria-modal="true"
        className="procedural-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <header className="procedural-header">
          <div>
            <span className="procedural-brand" aria-hidden="true">
              <Boxes size={15} strokeWidth={1.9} />
            </span>
            <span>
              <strong>程序化建模工具</strong>
              <small>参数实时形成只读计划；应用后作为一笔撤销记录写入片场</small>
            </span>
          </div>
          <button aria-label="关闭程序化建模" className="ui-icon-button" onClick={onClose} type="button">
            <X aria-hidden size={16} />
          </button>
        </header>

        <div className="procedural-body">
          <aside className="procedural-controls">
            <label className="procedural-field procedural-span-2">
              <span>操作</span>
              <select
                aria-label="程序化操作"
                value={operation.kind}
                onChange={(event) => changeKind(event.currentTarget.value as OperationKind)}
              >
                {(Object.keys(OPERATION_LABELS) as OperationKind[]).map((kind) => (
                  <option key={kind} value={kind}>
                    {OPERATION_LABELS[kind]}
                  </option>
                ))}
              </select>
            </label>
            <label className="procedural-field procedural-span-2">
              <span>Recipe 名称</span>
              <input
                aria-label="程序化 Recipe 名称"
                maxLength={240}
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <OperationFields operation={operation} project={project} onChange={setOperation} />
          </aside>

          <main className="procedural-preview">
            <div className="procedural-preview-heading">
              <span>实时计划</span>
              <strong>{preview.value ? `${preview.value.outputObjects.length} 个输出` : "参数待修正"}</strong>
            </div>
            {preview.value ? (
              <>
                <dl className="procedural-receipt">
                  <div>
                    <dt>配方 ID</dt>
                    <dd>{preview.value.recipe.id}</dd>
                  </div>
                  <div>
                    <dt>确定性</dt>
                    <dd>{"seed" in operation ? `seed ${operation.seed}` : "纯参数"}</dd>
                  </div>
                  <div>
                    <dt>来源</dt>
                    <dd>{preview.value.recipe.sourceObjectIds.join(", ") || "程序生成"}</dd>
                  </div>
                </dl>
                {preview.value.recipe.warnings.length ? (
                  <div className="procedural-warnings" role="note">
                    {preview.value.recipe.warnings.map((warning) => (
                      <p key={warning}>{warning}</p>
                    ))}
                  </div>
                ) : null}
                <ol className="procedural-output-list" aria-label="程序化输出预览">
                  {preview.value.outputObjects.slice(0, 48).map((object) => (
                    <li key={object.id}>
                      <span>{object.name}</span>
                      <small>
                        {object.geometryType ?? "导入模型"} · [
                        {object.transform.position.map((value) => value.toFixed(2)).join(", ")}]
                      </small>
                    </li>
                  ))}
                </ol>
                {preview.value.outputObjects.length > 48 ? (
                  <p className="procedural-more">
                    另有 {preview.value.outputObjects.length - 48} 个输出，已纳入同一 recipe。
                  </p>
                ) : null}
              </>
            ) : (
              <p className="procedural-empty">{preview.error}</p>
            )}
          </main>
        </div>

        {applyError ? (
          <p className="procedural-error" role="alert">
            {applyError}
          </p>
        ) : null}
        <footer className="procedural-footer">
          <span>碎裂、地形和植物是明确标注的可编辑 blocking，不冒充布尔网格或最终资产。</span>
          <div>
            <button className="procedural-secondary" onClick={onClose} type="button">
              取消
            </button>
            <button className="procedural-primary" disabled={!preview.value || busy} onClick={apply} type="button">
              <Check aria-hidden size={14} />
              应用到片场
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
