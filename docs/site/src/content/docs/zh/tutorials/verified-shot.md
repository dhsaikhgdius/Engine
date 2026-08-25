---
title: 端到端可验证镜头
description: 搭建一个米制白模镜头、完成构图，并生成绑定版本的视觉证据。
---

本教程覆盖最小但完整的 Director 工作流：创建落地对象、添加物理相机、验证项目，并生成
干净交付。这里先使用基本体，避免外部资产问题掩盖控制面问题。

完成后你将得到一个已交付的镜头:一张无辅助元素的 1280×720 干净画面,外加 depth、normal、
object-ID 和 mask 通道,全部绑定到同一个项目修订号。唯一前置条件是
[安装](/zh/getting-started/install/)可正常运行。

## 1. 启动并验证服务

```bash
npm run dev
```

在另一个终端运行：

```bash
curl --fail http://127.0.0.1:8787/health
npm run stage -- director_workbench '{"op":"capabilities"}'
```

保持 <http://127.0.0.1:5175/?workspace=stage> 打开。只有 Director 浏览器连接到 gateway 时，
Agent 才有可写 target。

## 2. 观察精确项目

```bash
npm run stage -- director_workbench '{"op":"observe","fields":["scene","objects","cameras","timeline"]}'
```

保存响应中的 `project_revision`。CLI 能预检并补充缺失 guard，但正式集成应始终显式携带。

这次观察同时确认了绑定关系:它指明了后续 mutation 将写入的精确浏览器目标。

## 3. 原子提交一个意图

运行前替换 `<REVISION>`。字段含义：

```jsonc
{
  "op": "author", // 写入场景的操作名
  "expected_revision": "<REVISION>", // 守卫：必须等于第 2 步 observe 的修订号
  "idempotency_key": "tutorial-verified-shot-v1", // 幂等键：相同请求重试不会重复创建
  "quality_gate": "strict", // 质量门：站不住或构图不合格的批次直接拒绝
  "actions": [ // 本意图一次提交的动作列表
    {
      "action": "start_scene", // 清空当前场景
      "preserve_assets": true // 清空时保留已导入资产
    },
    {
      "action": "add_object", // 添加物体
      "id": "hero-block", // 物体稳定 ID
      "name": "Hero Block", // 编辑器里显示的名称
      "kind": "prop", // 物体类别；基本体用 prop
      "geometry_type": "box", // 基本体形状
      "placement_mode": "grounded", // 按地面锚点放置
      "color": "#d6a341", // 显示颜色
      "transform": { // 世界变换，单位米
        "position": [0, 0, 0], // 位置：地面中心
        "rotation": [0, 0, 0], // 旋转：弧度
        "scale": [1.2, 1.8, 1.2] // 各轴实际尺寸（宽/高/深）
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
      "sensor_format": "super35", // 传感器画幅
      "aspect_ratio": "16:9", // 画幅比例
      "handheld_shake": "off", // 手持抖动：关闭
      "activate": true // 提交后设为活动相机
    }
  ]
}
```

```bash
npm run stage -- director_workbench '{
  "op":"author",
  "expected_revision":"<REVISION>",
  "idempotency_key":"tutorial-verified-shot-v1",
  "quality_gate":"strict",
  "actions":[
    {"action":"start_scene","preserve_assets":true},
    {
      "action":"add_object",
      "id":"hero-block",
      "name":"Hero Block",
      "kind":"prop",
      "geometry_type":"box",
      "placement_mode":"grounded",
      "color":"#d6a341",
      "transform":{"position":[0,0,0],"rotation":[0,0,0],"scale":[1.2,1.8,1.2]}
    },
    {
      "action":"add_camera",
      "id":"main-camera",
      "object_id":"main-camera-rig",
      "name":"Main Camera",
      "position":[4.5,2.4,6.5],
      "target":[0,0.9,0],
      "target_object_id":"hero-block",
      "focal_length_mm":50,
      "sensor_format":"super35",
      "aspect_ratio":"16:9",
      "handheld_shake":"off",
      "activate":true
    }
  ]
}'
```

完整编辑器中的基本体契约是 `kind:"prop"` 加 `geometry_type:"box"`。`kind:"cube"` 属于
compact Stage 兼容协议，不能用在这里。

批次提交后,打开的浏览器标签页里会立即出现金色方块和新相机。响应返回新的
`project_revision`;第 2 步观察到的那个修订号此时已经过期。

## 4. 验证状态与构图

再次观察并保存新 revision：

```bash
npm run stage -- director_workbench '{"op":"observe","fields":["objects","cameras","graph_issues"]}'
npm run stage -- director_workbench '{"op":"audit","camera_id":"main-camera","subject_id":"hero-block"}'
```

若 audit 返回可确定性修复的问题，携带其 `audit_token` 和最新 revision 调用 `correct`，
然后再次观察与审计。不要为了消除落地错误而把高处对象错误标成 `floating`。

## 5. 交付视觉证据

将 `<LATEST_REVISION>` 替换为最后一次观察得到的 revision。字段含义：

```jsonc
{
  "op": "deliver", // 按相机交付干净画面与通道
  "expected_revision": "<LATEST_REVISION>", // 守卫：必须等于最新项目修订号
  "camera_id": "main-camera", // 用哪台相机拍
  "subject_id": "hero-block", // 构图主体
  "quality_profile": "video-gen", // 交付质量档
  "width": 1280, // 输出宽度（像素）
  "height": 720, // 输出高度（像素）
  "render_passes": ["clean", "depth", "normal", "object-id", "mask"] // 要输出的通道
}
```

```bash
npm run stage -- director_workbench '{
  "op":"deliver",
  "expected_revision":"<LATEST_REVISION>",
  "camera_id":"main-camera",
  "subject_id":"hero-block",
  "quality_profile":"video-gen",
  "width":1280,
  "height":720,
  "render_passes":["clean","depth","normal","object-id","mask"]
}'
```

只有响应包含 `ready:true`、`status:"delivered"`、`capture_verified:true`、通过的 audit，
且 revision/package fingerprint 正确时才能验收。还要检查 clean PNG：相机必须正确，画面
不能含网格、标签、操纵器、相机锥体或选中描边。

## 6. 换成真实人物

基本体链路通过后，先检索目录，不要猜人物与动作 ID：

```bash
npm run stage -- director_workbench '{"op":"catalog","catalog":"character_assets","query":"X Bot","limit":10}'
npm run stage -- director_workbench '{"op":"catalog","catalog":"character_motions","query":"walk","limit":10}'
```

按照[资产发现](/zh/agents/assets/)和[人物](/zh/editor/characters/)指南，原样复用返回的 asset
action，用真实 `assetRefId` 创建人物，再安全叠加动作、姿势和 IK。

## 故障恢复

| 结果                     | 下一步                                                   |
| ------------------------ | -------------------------------------------------------- |
| `stale_project_revision` | 重新观察，计算剩余意图，使用新幂等键                     |
| `outcome_unknown`        | 先 observe/diff；确认不存在后才用原 key 重放字节等价请求 |
| `target_unavailable`     | 重新打开/绑定目标 Director 标签页，不能退到其他场景      |
| audit 未就绪             | 只修复报告的问题，再次 audit                             |
| capture 未验证           | 不得声称完成；针对最新精确 revision 重新 deliver         |

完整的逐错误码契约见 [Agent 工作台的恢复表](/zh/agents/workbench/#冲突与不确定结果)。
