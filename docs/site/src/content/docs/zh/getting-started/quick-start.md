---
title: 快速上手
description: 创建、构图、制作动画并验证你的第一个 Director 场景。
---

本页用两种方式搭建同一个最小场景:先在编辑器里手动完成,再通过 Agent 契约完成。两条路径
以同样的证据收尾——由真实相机渲染、构图完整的主体画面。

## 在编辑器中

1. 用 `npm run dev` 启动 Director,打开 <http://127.0.0.1:5175>。
2. 打开**资产**面板,添加基本体、角色或本地模型。
3. 将资产拖入视口。Director 会计算世界空间位置,并依据可视边界把资产放到地面上——它应该
   稳稳落地,而不是悬空或陷入地面。
4. 选中对象,使用变换操纵器或属性面板微调位置、旋转和缩放。
5. 添加或选中一个相机,设置焦距和宽高比,然后让它瞄准目标或取景。相机预览会显示镜头画面,
   而不会改变你的编辑器视角。
6. 添加变换轨道或相机轨道,在帧时间线上放置关键帧。
7. 捕获当前相机,或录制选定的 IN/OUT 范围。

**检查点。** 捕获的画面应当显示你配置的相机所拍摄的主体,并且不含网格、gizmo、标签等任何
[编辑器辅助元素](/zh/concepts/glossary/#证据与交付)。这张无辅助元素的画面就是 Director
关心的证据。

## 通过 Agent 契约

所有 provider 都遵循同一个循环:

```text
发现 → 观察精确目标/守卫 → 原子修改 → 再次观察 → 审计 → 预览或交付 → 检查像素
```

先读取能力并做一次选择性观察:

```jsonc
{ "op": "capabilities" } // 查询当前可用操作与能力
```

```jsonc
{
  "op": "observe", // 读取当前绑定目标的状态
  "fields": ["scene", "objects", "cameras", "selection", "timeline"] // 只要这些切片
}
```

**检查点。** observe 会返回已绑定的目标和 `project_revision`。保存这个修订号——下面每个
mutation 都要携带它作为守卫。

把一个意图作为一个原子批次提交:

```jsonc
{
  "op": "author", // 写入场景的操作名
  "expected_revision": "<来自 observe 的 project_revision>", // 守卫：必须等于当前项目修订号
  "idempotency_key": "first-director-shot-v1", // 幂等键：相同请求重试不会重复创建
  "quality_gate": "strict", // 质量门：站不住或构图不合格的批次直接拒绝
  "actions": [ // 本意图一次提交的动作列表
    {
      "action": "start_scene", // 清空当前场景
      "preserve_assets": true // 清空时保留已导入资产
    },
    {
      "action": "add_object", // 添加物体
      "id": "hero-block", // 物体稳定 ID，后续引用用它
      "name": "Hero Block", // 编辑器里显示的名称
      "kind": "prop", // 物体类别；基本体用 prop
      "geometry_type": "box", // 基本体形状
      "placement_mode": "grounded", // 按地面锚点放置，不要悬空
      "transform": { // 世界变换，单位米
        "position": [0, 0, 0], // 地面枢轴（底部中心），不是几何中心
        "rotation": [0, 0, 0], // 旋转：弧度
        "scale": [1.2, 1.8, 1.2] // 缩放：各轴实际尺寸（宽/高/深）
      }
    },
    {
      "action": "add_camera", // 添加相机
      "id": "main-camera", // 相机 ID
      "object_id": "main-camera-rig", // 相机绑定的场景物体 ID
      "name": "Main Camera", // 编辑器里显示的名称
      "position": [4.5, 2.4, 6.5], // 相机位置（米）
      "target": [0, 0.9, 0], // 瞄准点
      "target_object_id": "hero-block", // 跟随/对准的物体
      "focal_length_mm": 50, // 焦距（毫米）
      "aspect_ratio": "16:9" // 画幅比例
    }
  ]
}
```

这是完整编辑器契约:`kind:"prop"` 加 `geometry_type:"box"`。紧凑 `stage_*` 示例里的
`kind:"cube"` 属于 `StageScene`,不要复制到这里。

**检查点。** 批次会原子提交并返回新的 `project_revision`。在打开的浏览器标签页里,
方块和相机会立即出现。

再次观察取得新修订号,然后在交付边界结束:

```jsonc
{
  "op": "deliver", // 按相机交付干净画面与通道
  "expected_revision": "<最新 project_revision>", // 守卫：必须等于最新项目修订号
  "camera_id": "main-camera", // 用哪台相机拍
  "subject_id": "hero-block", // 构图主体
  "quality_profile": "video-gen", // 交付质量档
  "render_passes": ["clean", "depth", "normal", "object-id"] // 要输出的通道
}
```

**检查点。** 只有当结果报告 `ready:true` 和 `status:"delivered"`,并且返回的干净图像确实
显示了构图完整的主体时,才接受这次交付。如果交付被阻塞,先运行 `audit`,携带审计 token
调用 `correct`,再次审计后重试。

如果 mutation 被拒绝或超时(`stale_project_revision`、`outcome_unknown` 等错误码),请按照
[Agent 工作台的恢复表](/zh/agents/workbench/#冲突与不确定结果)处理,不要盲目重发。画布与
视频编辑器使用独立的[指纹守卫创意循环](/zh/agents/creative-workspaces/)。

## 最小 CLI 冒烟测试

Director 运行时,同一套契约也可以从终端使用:

```bash
npm run stage -- director_workbench '{"op":"observe"}'      # 读取当前场景
npm run stage -- director_workbench '{"op":"capabilities"}' # 列出可用操作
```

第一条命令证明网关可以读取场景,第二条命令证明类型化 workbench 契约可达。`stage_*` 仍是遗留紧凑接口。

如需完整教程——服务健康检查、精确修订号替换、干净多通道交付与冲突恢复——请继续阅读
[端到端可验证镜头](/zh/tutorials/verified-shot/)。
