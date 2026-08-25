# WorldEngine 后端

> 语言:**中文** · [English](README.md)

WorldEngine 是仓库根平台。TypeScript 控制面在 `gateway/`：Agent、项目、媒体、
生成任务、协作以及 HTTP/MCP 接口。官方模型源码（LTX-2、Hunyuan3D-2、TRELLIS、ARDY）
是 `vendor/` 下的 Git 子模块；网关在作业需要时 spawn 它们的 Python CLI。

Director 的建模内核是位于
`integrations/blender/live/addons/worldengine_studio/` 的
`worldengine_studio` 插件。文件交换脚本位于
`integrations/blender/interchange/`。该插件不是子模块。
Director 位于 `../frontend/director/`；其 UI 与 Agent 线束
通过带类型的本地协议与无头 Blender 4.2+ 进程通信。

从 WorldEngine 根目录运行集成产品:

```bash
npm run blender
```

该命令在后台启动 Blender(`BLENDER_BIN` 或本地安装),
并加载 WorldEngine Studio 插件。

```bash
npm run blender:test
```
