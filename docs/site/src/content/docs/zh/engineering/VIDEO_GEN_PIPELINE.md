---
title: Director 白模到视频生成
description: 白模、Shot Package、LTX-2.3 worker 与可选 ComfyUI provider 的任务契约。
---

## Agent 序列

```text
observe exact Stage target
  → audit scene / camera / frame
  → capture or build ShotIR
  → stage_video prepare
  → inspect manifest and provider capability
  → submit durable job
  → poll receipt
  → inspect output artifact and pixels
```

生成器消费的是 revision-bound Shot Package，而不是抓取编辑器 DOM 或猜测当前画面。

## LTX-2.3

网关对 `vendor/ltx-2` spawn `tools/scripts/ltx23-generate.py`。没有常驻 FastAPI worker。
LTX 尺寸必须是 64 的倍数，帧数满足 `8k+1`。Director 另外保存交付尺寸和推理尺寸、
seed、audio、prompt enhancement、scene digest、warning 与 provider receipt。成片写在
`data/video-jobs/<id>/output.mp4`。

## 可选 ComfyUI 契约

ComfyUI 是 provider adapter，不是第二套 scene model。工作流必须是仓库内的 API JSON，
并固定 `COMFYUI_URL`、workflow path、输入图像/视频、prompt、seed、尺寸、帧数和输出
artifact。prepare 可以在 provider 不可用时生成 manifest；submit 前必须检查配置。

## 示例调用

```bash
npm run stage -- stage_video '{"op":"prepare","shot_id":"shot-01"}'
npm run stage -- stage_video '{"op":"submit","job_id":"job-01"}'
npm run stage -- stage_video '{"op":"status","job_id":"job-01"}'
```

超时后先查询原 job 和幂等 key，不要新建任务复制可能已经完成的输出。
