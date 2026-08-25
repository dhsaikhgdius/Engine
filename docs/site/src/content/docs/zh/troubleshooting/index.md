---
title: 故障排除
description: 诊断安装、渲染、资产、Agent 和捕获问题。
---

## UI 无法加载

1. 确认 Node.js 与依赖：

   ```bash
   node -v
   npm install
   ```

2. 使用 `npm run dev` 启动两个服务；
3. 检查 <http://127.0.0.1:8787/health>；
4. 检查浏览器控制台是否有 Vite overlay 或 WebGL 错误。

UI 使用严格端口 `5175`；若端口已被占用，启动会失败，而不会静默换到其他地址。

## Gateway 不可用

运行：

```bash
npm run dev:gateway
```

如果客户端使用非默认地址，把 `STAGE_GATEWAY_URL` 设置为准确的 gateway URL。

## MCP 工具缺失

1. 确认 `.mcp.json` 指向当前 checkout；
2. 运行 `npm run build:mcp-plugin`；
3. 运行 `npm run validate:agent-plugin`；
4. 重启或重新加载 MCP host。

## Agent provider 被禁用

在普通 shell 中运行 provider 命令：

```bash
codex --version
claude --version
```

如果可执行文件不在 `PATH`，配置覆盖命令。

## Agent 命令指向错误项目

Workbench 和 Creative 写入都是精确目标操作。观察目标 tab，并保留返回的 `target.token`。缺少 token 返回 `target_required`；tab 关闭或场景/scope 改变返回 `target_unavailable`。
Director 有意不会回退到另一个可见 tab。重新观察，并针对新的 revision 或 fingerprint 重建请求。

## Creative mutation 报告 conflict

- snapshot fingerprint 改变：另一个人或 Agent 在观察后编辑了 Canvas/Video。重新观察，用当前 ID 重建操作；
- 幂等 key 被用于不同输入：为新的意图选择新 key；
- 只有精确的网络重试才复用原 key，成功 replay 不会再次应用 mutation；
- 失败批次已经回滚，修复失败步骤后重新发送完整意图。

## Workbench mutation 报告过期 revision

`stale_project_revision` 表示 Agent 观察后实时绑定项目发生了变化。重新观察同一目标，将请求意图与当前状态合并，用最新 revision 和新 idempotency key 构建 mutation。
不要只用 `unconditional:true` 让错误消失，否则会把检测到的冲突变成覆盖。

## 超时后 mutation 结果未知

`outcome_unknown` 表示浏览器可能在确认丢失前已经提交 mutation。它不同于 `target_unavailable`，不能触发盲目重试：

1. 停止发送 mutation；
2. 再次观察精确绑定目标；
3. 使用 `diff`/`inspect`，或比较准确的 Canvas/Video 实体，判断效果是否存在；
4. 如果效果存在，从新状态继续，不要重试；
5. 如果效果不存在且原始 revision/fingerprint 仍然成立，用相同幂等 key 重发字节完全相同的 payload；
6. 如果当前状态要求修改 payload 或保护条件，将它重新规划为新意图并使用新 key。

`command_timeout` 用于被取消的读取和证据请求。保持目标可见，必要时刷新 revision/fingerprint，再重试；不要声称预览或捕获已存在。

## 审计通过但结果看起来不对

结构审计不能代替视觉审阅。Creative audit 始终要求检查 Canvas 布局或 Video 预览。Workbench 交付必须包含无辅助线 clean frame 和匹配的 revision；不要仅凭 `success:true` 或 `ready:true` 报告视觉完成。

Canvas 或 Video Editor 使用 `director_creative` 的 `op:"preview"`，并传入最终观察的 fingerprint。返回 `stale_snapshot` 表示渲染前或渲染中工作区发生变化；重新观察并请求新预览，不要接受旧像素。

## 资产预览为空

- 确认源文件仍存在，URL 是本地或允许的 URL；
- 检查浏览器控制台的 loader 或 decoder 错误；
- 在加载大量资产前，先尝试聚焦的预览对话框；
- 在其他 GLTF viewer 中验证法线、材质和模型尺度。

## 拖入的资产在地下

- 重新计算或检查其可视边界；
- 确认场景地面高度与场景 transform；
- 检查模型是否含有远低于可见网格的隐藏几何；
- 把模型 origin 与可视 transform 中心分开检查。

## 道具尺寸不对

模型资产按以米为单位的真实尺寸缩放。打开道具检查器查看 **真实尺寸**：字段为空表示该资产回退到旧的 2 m 显示归一化，对明显更小或更大的物体都是错的。填入真实尺寸（米）即可。Agent 侧对应的是 `asset_missing_real_world_size` 审计告警。

保留作者米制尺度的资产（例如晋升后的生成 3D 模型和导入的场景包）不显示该字段，这类资产请改用对象 transform 调整。

## 变换 gizmo 不在中心

gizmo 应使用对象在世界空间中的可视中心。修改保存的对象 transform 之前，检查嵌套 transform、skinned-mesh bounds、group bounds 和过期的缓存边界。

## 相机捕获包含辅助线

确认使用的是相机/视口 capture path，而不是普通屏幕截图。编辑器辅助线必须带 capture-hidden 标记，并在捕获后恢复。

## 性能不稳定

Director 固定使用 **High quality**：3D Stage、四视图、视口 gizmo 与资产预览共用最高画质。
旧的 Auto 或 Fluid 偏好会迁移为 High quality，帧时间采样也不会降低渲染分辨率或关闭阴影。

稳定采样窗口后，报告按钮才可用。浏览器后台 tab 不参与采样。

## ComfyUI 任务一直处于 prepared

`prepare` 不需要 ComfyUI；提交必须同时配置：

```bash
COMFYUI_URL
COMFYUI_VIDEO_WORKFLOW_PATH
```

工作流文件必须是 Director 仓库内的 API 格式 JSON。

## 持久化项目无法恢复

Director 会拒绝格式错误的项目快照。可以时先导出有效项目，检查浏览器存储 scope（`instanceId`），并确认旧快照是否不符合当前 schema 或图完整性检查。
