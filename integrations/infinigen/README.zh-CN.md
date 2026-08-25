# Director × Infinigen 集成

> 语言:**中文** · [English](README.md)

把 [Infinigen](https://infinigen.org)（princeton-vl/infinigen，BSD-3-Clause）作为 Director
「生成 3D」管线的**本地程序化 provider**。与 Meshy / Tripo 等远程 API provider 同权：
从生成对话框提交 → 生产作业排队 → 归一化为米制 Y-up GLB → 进入资产库、可直接摆入片场。

## 文件级清单


| 路径                             | 中文用途                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                    | 本文件：安装、配置、使用说明、已知边界。                                                                                                                                                      |
| `director_infinigen_runner.py` | 单资产 runner（447 行）：由网关 `InfinigenGenerated3DProvider` 拉起，原子写入 `status.json`（进度快照）、`model.glb`（烘焙 Y-up 米制 GLB）、`thumbnail.png`（EEVEE 缩略图）、`runner.log`。不联网、不导入 Director 代码。 |
| `factory_catalog.json`         | 工厂目录（66 行）：4 个 `kind=environment` 内置地形预设（环绕群山、山谷、丘陵、沙丘）+ 30+ 个 `kind=asset` Infinigen 工厂（自然类：仙人掌、珊瑚、鱼、鸟、水果、花、树叶等；室内类：椅子、沙发、床、桌子、书架等），含中英文关键词匹配。                           |


> Infinigen provider 代码位于网关内部（`backend/gateway/`），不在 `integrations/infinigen/` 目录中。
> 此目录包含 runner 脚本、工厂目录与集成文档。Provider 通过网关的生成 3D API 端点暴露。



## 工作方式

```
Generated3DDialog ──POST /api/…──▶ Generated3DExecutor
                                        │ submit
                                        ▼
                        InfinigenGenerated3DProvider（网关内 / in gateway）
                                        │ spawn（分离子进程 / detached child process）
                                        ▼
                   director_infinigen_runner.py（infinigen 环境的 Python / Python in infinigen env）
                     工厂生成 → 烘焙材质 → model.glb + thumbnail.png
                      Factory generate → bake materials → model.glb + thumbnail.png
                                        │ status.json（原子快照 / atomic snapshot）
                                        ▼
                     provider 轮询 → 执行器读取 file:// 产物 → 归一化入库
                      provider polls → executor reads file:// artifacts → normalize & ingest
```

- **提示词到工厂**：`factory_catalog.json` 维护一份经上游冒烟测试保证
120 秒内可生成的工厂清单（自然 + 室内），按 id 精确匹配或中英文关键词匹配（如
「一把舒服的椅子」→ `ChairFactory`）。
- **确定性**：作业的 `seed` 直接传给工厂；同参数同 seed 产出一致。
- **取消**：`cancellation: local-only`，网关对 runner 进程发送 SIGTERM
并记录终态。



## 环境场景预设（kind=environment）

除 Infinigen 单资产工厂外，目录还内置四个**环境地形预设**，由同一个 runner 以
bpy + numpy 直接生成（确定性 fBm/脊状噪声高度场 + 海拔/坡度顶点色），**不需要**
Infinigen 的 `[terrain]` 编译组件，秒级出结果：


| 预设                     | 关键词示例      | 形态                  |
| ---------------------- | ---------- | ------------------- |
| `SurroundingMountains` | 环绕的群山 / 山脉 | 环形山脉包围中央平坦舞台区（雪线峰顶） |
| `MountainValley`       | 山谷 / 峡谷    | 两侧山脊夹持的谷地           |
| `RollingHills`         | 丘陵         | 平缓起伏草坡              |
| `DesertDunes`          | 沙丘 / 沙漠    | 各向异性沙丘条纹            |


使用建议：环境类资产在对话框里把**目标高度设为 40–100 米**（默认 1 米会把整座山
缩成桌面模型）。以 60 米为例，「环绕群山」会归一化为约 450 米见方、中央约 150 米
平场的背景山环，可直接作为片场环境摆放。

只想用环境预设、暂不需要 Infinigen 资产工厂时，无须完整安装 Infinigen：

```bash
python3.11 -m venv ~/.venvs/director-bpy && ~/.venvs/director-bpy/bin/pip install bpy numpy
export DIRECTOR_INFINIGEN_PYTHON="$HOME/.venvs/director-bpy/bin/python"
```

想要 Infinigen 原生的完整自然场景（真实地形侵蚀、植被散布、程序化材质），需要
`pip install -e .[terrain]` 并接受小时级耗时，且全场景只支持 USDC 导出——那条
路线建议走 Blender 桥 / `.blend` 审阅导入，而不是资产生成队列。

## 安装（一次性）

Infinigen 需要独立的 Python 3.11 环境（自带 `bpy`，体积较大），与 Director 的 Node
进程完全隔离：

```bash
conda create -n infinigen python=3.11 -y
conda activate infinigen
git clone https://github.com/princeton-vl/infinigen.git
cd infinigen
# 单资产/室内资产用最小安装即可；需要自然地形再装 [terrain]
# Minimal install is sufficient for single/indoor assets; add [terrain] for nature scenes
INFINIGEN_MINIMAL_INSTALL=True pip install -e .
```

验证环境（能打印类名即可）：

```bash
python -c "from infinigen.assets.objects.seating.chairs import ChairFactory; print(ChairFactory)"
```



## 配置 Director


| 环境变量                             | 说明                                              | 默认                    |
| -------------------------------- | ----------------------------------------------- | --------------------- |
| `DIRECTOR_INFINIGEN_PYTHON`      | infinigen 环境的 python 路径（必填，未设置时 provider 显示未配置） | —                     |
| `DIRECTOR_INFINIGEN_WORKDIR`     | 任务工作目录                                          | `data/infinigen-jobs` |
| `DIRECTOR_INFINIGEN_TEXTURE_RES` | 烘焙贴图分辨率                                         | `1024`                |
| `DIRECTOR_3D_PROVIDER`           | 默认 provider，可设为 `infinigen`                     | meshy/tripo           |


```bash
export DIRECTOR_INFINIGEN_PYTHON="$HOME/miniconda3/envs/infinigen/bin/python"
```

配置后重启网关，「生成 3D」对话框的 provider 列表会自动出现「Infinigen（本地程序化）」。

## 手动冒烟测试（不经网关）

```bash
"$DIRECTOR_INFINIGEN_PYTHON" integrations/infinigen/director_infinigen_runner.py \
  --factory ChairFactory --module infinigen.assets.objects.seating.chairs \
  --seed 7 --name "测试椅子" --texture-res 512 --output /tmp/infinigen-smoke
cat /tmp/infinigen-smoke/status.json
```

成功时目录内应有 `model.glb` 与 `thumbnail.png`。

## 已知边界

- 材质烘焙走 Infinigen 官方 bake 管线（FBX 中转再转 GLB）；若烘焙链路不可用，
runner 会降级为直接导出并在 `status.json.warnings` 中说明贴图可能缺失。
- 本集成面向**单资产**生成（分钟级）。整场景生成（`generate_nature` /
`generate_indoors`，小时级、全场景仅支持 USDC 导出）建议走 Blender 桥 /
`.blend` 审阅导入路径，不适合放进资产生成队列。
- 生物类（鱼、鸟等）导出为静态网格；骨骼绑定不在本管线范围内。

