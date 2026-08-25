---
title: 白模到视频
description: 把经过校验的 Director 镜头打包，并提交到 LTX-2.3 或可配置的 ComfyUI 工作流。
---

Director 把视频生成视为下游渲染阶段。3D 项目仍是布局、尺度、主体位置、镜头、宽高比和相机运动的真相来源。

## Agent 顺序

1. 创建或加载场景；
2. 校验 Stage 场景；
3. 选择并检查目标相机；
4. 捕获 clean reference frame；
5. 为精确相机/帧导出 `director_workbench {"op":"shot_ir", ...}`；
6. 当生成器或合成器需要 clean/depth/normal/object-ID/mask 时导出 `shot_package`；
7. 调用 `stage_video prepare`；
8. 检查任务 manifest，并保留 Shot IR 的 `revisionFingerprint`；
9. 调用 `capabilities` 检查真实 provider 状态；
10. 调用 `render` 或 `submit`，使用 `status` 轮询，并在需要时调用 `cancel`。

Shot IR 与 provider 无关。它记录求值后的对象、相机、目标、真实 sensor gate/crop、镜头、曝光/对焦元数据、宽高比、运动意图和可移植引用。
传入 `take_id` 与 `coverage_shot_id` 时，纯制作求值器会先解析共享 take 和 coverage 所有的相机，再生成 Shot IR。provider 适配器可以把这个契约转换成 prompt 或 workflow，
但生成 prompt 永远不是场景真相。

## LTX-2.3 Python 推理 Worker

:::caution[实验性集成]
HTTP/队列/provider 契约已有 fake-executor 测试，但当前 checkout 还没有经过验证的本地 GPU
成片回执。源码校验已同时支持普通 `.git` 目录和 submodule/worktree 的 `.git` 文件，并检查
固定 origin、commit、LICENSE blob、必需 package 与 tracked clean state。权重、兼容 CUDA 环境和
持久化的真实推理回执仍是上线前置条件；不能把 prepare 成功或 contract test 写成已生成视频。
:::

LTX-2.3 由网关按作业 spawn `tools/scripts/ltx23-generate.py`，对着 `vendor/ltx-2` 跑一次
官方 DistilledPipeline。没有常驻 FastAPI worker。该进程加载模型、把 mp4 写到
`data/video-jobs/<id>/output.mp4`，然后退出。

Director 直接运行未经修改的官方源码 checkout，不使用自制推理实现或浮动的 PyPI 包。上游 URL、commit、
package 版本、LICENSE blob 与模型 revision 固定在 `vendor/ltx-2.lock.json`。启用前先审阅
LTX-2 Community License：

```bash
export DIRECTOR_ACCEPT_LTX2_LICENSE=1
npm run setup:ltx2
```

这里的 `LTX2` 是上游 LTX-2 系列 / 许可证名称。Director 的 provider id 仍是 `ltx-2.3`。

下载固定 revision 的权重后，配置 TypeScript 控制面：

```bash
export DIRECTOR_VIDEO_PROVIDER=ltx-2.3
export DIRECTOR_ACCEPT_LTX2_LICENSE=1
export LTX23_DISTILLED_CHECKPOINT_PATH=/models/ltx-2.3/ltx-2.3-22b-distilled-1.1.safetensors
export LTX23_SPATIAL_UPSAMPLER_PATH=/models/ltx-2.3/ltx-2.3-spatial-upscaler-x2-1.1.safetensors
export LTX23_GEMMA_ROOT=/models/gemma-3-12b
```

spawn 会再次强制校验：宽高必须是 64 的倍数，帧数必须满足 `8k+1`。`manifest.json`
同时保留请求的交付画幅、实际推理画幅、精确 seed、音频开关、prompt 增强开关、场景摘要、警告和 provider receipt。

当前 LTX adapter 只发送 clean reference frame，尚不消费 Director 的 depth、normal、object-ID
或 mask pass。它们仍保留在控制包中，供其他或未来 conditioning adapter 使用。

## 可选 ComfyUI Provider

以 ComfyUI API 格式导出工作流，并保存在仓库内：

```bash
export COMFYUI_URL=http://127.0.0.1:8188
export COMFYUI_VIDEO_WORKFLOW_PATH=workflows/director-video-api.json
```

## 工作流 token

| Token                      | 替换内容                                  |
| -------------------------- | ----------------------------------------- |
| `{{PROMPT}}`               | 正向渲染 prompt                           |
| `{{NEGATIVE_PROMPT}}`      | 负向 prompt                               |
| `{{REFERENCE_IMAGE}}`      | 上传到 ComfyUI 输入存储的 Director 相机帧 |
| `{{WIDTH}}`                | 输出宽度                                  |
| `{{HEIGHT}}`               | 输出高度                                  |
| `{{FPS}}`                  | 输出 FPS                                  |
| `{{DURATION_SECONDS}}`     | 请求时长                                  |
| `{{SEED}}`                 | 确定性 seed                               |
| `{{SCENE_STRUCTURE_JSON}}` | 紧凑的对象类型、名称、位置和缩放          |
| `{{CAMERA_PLAN_JSON}}`     | 镜头、目标和按顺序排列的时间线动作        |

如果某个值恰好是一个数值 token，替换会保留 JSON number 类型。

## 只准备、不消耗额度

```bash
npm run stage -- stage_video '{
  "op": "prepare",
  "prompt": "Preserve the exact white-box composition and camera; cinematic rainy street at night",
  "duration_s": 5,
  "fps": 24
}'
```

`prepare` 不会联系模型 provider。

## 准备并提交

```bash
npm run stage -- stage_video '{
  "op": "render",
  "prompt": "Preserve the exact white-box composition and camera; cinematic rainy street at night",
  "negative_prompt": "geometry drift, flicker, warped architecture",
  "duration_s": 5,
  "fps": 24
}'
```

## 轮询任务

```bash
npm run stage -- stage_video '{"op":"status","job_id":"video-..."}'
```

每个任务会保存：

```text
data/video-jobs/<job_id>/manifest.json
data/video-jobs/<job_id>/scene.json
data/video-jobs/<job_id>/<reference-frame>
```

确定性的 shot-package 管线通过离屏 WebGL target 渲染无辅助线的 `clean`、打包的 `depth`、view-space `normal` 和稳定的 `object-id` RGBA pass。
即使 GPU 出错，也会恢复 renderer、scene、material 和辅助线状态。浏览器 PNG 编码只在逐行翻转像素后执行。package manifest 不包含二进制 payload，
为每个真实 artifact 保存 SHA-256，并派生稳定的 package fingerprint。

```json
{
  "op": "shot_package",
  "expected_revision": "director-project-revision:v1:sha256:...",
  "take_id": "take-main",
  "coverage_shot_id": "coverage-close",
  "frame": 48,
  "width": 1280,
  "height": 720,
  "render_passes": ["clean", "depth", "normal", "object-id", "mask"]
}
```

这是确定性的单帧捕获与打包。要导出完整时间线范围，编辑器的**确定性帧包**会按 IN/OUT（包含两端）顺序捕获 PNG，写入明确的微秒 timestamp 和 duration，
然后把每帧 SHA-256 与 package fingerprint 写入确定性 ZIP。这是交给视频生成器的合适白模序列交接。浏览器 `MediaRecorder` 仍可用于快速审阅，
但它是独立的实时、非确定性契约。只有配置真实 WebCodecs encoder 与 container muxer 后，Director 才会生成可播放的确定性 MP4/WebM；否则诚实的输出仍是 PNG ZIP。

## 审阅清单

- reference frame 不包含编辑器辅助线；
- 当前相机、镜头和宽高比正确；
- 对象已落地，尺度有明确意图；
- IN/OUT 范围与请求时长一致；
- 负向 prompt 命名了可能的失败模式；
- 最终结果已与保存的白模参考比较。
