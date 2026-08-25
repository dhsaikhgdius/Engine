# Director：Agent-Planned 4D Blockout → Controllable Video 新颖性审计

**Version:** 1.0  
**Search cutoff:** 2026-08-08  
**Recommended paper identity:** _Director: Compiling Agent-Planned 4D Blockouts into Controllable Video_

## 0. 结论

项目真正有价值的 insight 是：

> **Plan in 4D, render in pixels.** Agent 不直接用语言“猜”最终视频，而是先把导演意图编译成可执行、可检查、可编辑的 4D 白膜；确定性 3D 引擎负责验证布局、走位、摄影机和时序；Video Generator 只负责将已经成立的控制程序渲染成高保真像素。

但是，仅表述为“Agent + 3D 白膜 + VideoGen renderer”不足以支撑顶会 novelty。三个组成部分已分别被大量工作覆盖，且存在四个非常直接的冲突项：

- **Generative Rendering** 已经把无材质动态 3D mesh 渲染为 diffusion video；
- **VideoFrom3D / I2V3D** 已经使用 coarse geometry、相机轨迹和参考图生成高质量视频；
- **Scene2Scene** 已直接提出 LLM-driven 3D spatial blockout for guided AI video synthesis；
- **LAMP** 已让 LLM 把自然语言编译为物体和摄影机的 3D motion program。

因此，投稿版本必须将贡献收紧为以下联合问题：

> **把高层导演意图编译为经过引擎验证的统一 4D Shot Program，再依据不同 Video Generator 的能力，把同一个程序编译为 backend-specific multi-pass control packet，并把最终视频中的控制误差定位回可编辑的 3D program，而不是继续修改 prompt。**

建议把论文身份从“Agentic video generation system”改为：

> **An agentic compiler and feedback system for executable 4D control of heterogeneous video generators.**

## 1. 研究对象的重新定义

### 1.1 不是三个模块的简单拼装

不安全的系统描述：

```text
Text → Agent → 3D Blockout → Video Generator → Video
```

这个描述与 Scene2Scene、LAMP、VideoFrom3D 的能力高度重合。

论文需要研究的对象应当是一个编译问题：

```text
Creative Brief
  → Agent Frontend
  → Executable 4D Shot IR
  → Deterministic Verification
  → Capability-Aware Control Compiler
  → Video Backend / Neural Renderer
  → Control Evaluator
  → Program-Space Repair
```

其中：

- **4D Shot IR** 是跨 backend 的 source of truth；
- **Control Compiler** 决定使用 RGB proxy、depth、normal、ID mask、pose、flow、camera token、首尾帧或 reference video 中的哪些控制载体，以及各自强度；
- **Program-Space Repair** 把 framing、occlusion、trajectory、timing 等错误回投到相机、物体、骨骼和时间线变量；
- **Prompt** 只负责 style、appearance 和未显式建模的细节，不承担几何规划。

### 1.2 科学问题

核心科学问题不是“能否生成一个漂亮视频”，而是：

1. 高层导演约束能否可靠转化为可执行的 4D program？
2. 一个 backend-independent shot program 如何编译为不同视频模型可消费的控制信号？
3. Video Generator 在渲染过程中保留了多少原始控制？
4. 当控制丢失时，应修改 prompt、control packet，还是 3D program？
5. 这种分工能否同时提升 controllability、editability 和生成质量？

## 2. 最接近工作的冲突矩阵

| Work | 已经覆盖 | 与 Director 的直接重合 | 必须建立的差异 |
| --- | --- | --- | --- |
| [Generative Rendering](https://openaccess.thecvf.com/content/CVPR2024/html/Cai_Generative_Rendering_Controllable_4D-Guided_Video_Generation_with_2D_Diffusion_Models_CVPR_2024_paper.html) | animated low-fidelity mesh → stylized diffusion frames | 3D animation 作为 generative renderer 输入 | Agent 自动规划、统一 Shot IR、backend compiler、program-space feedback |
| [I2V3D](https://arxiv.org/abs/2503.09733) | coarse 3D render + image/video diffusion | 3D 控制高质量视频 | 不只是特定两阶段生成器；需要 intent-to-program 与控制保留评测 |
| [VideoFrom3D](https://arxiv.org/abs/2509.17985) | coarse geometry + camera + reference image → video | 与“白膜作为渲染条件”几乎同构 | 用户不手工提供最终 blockout；统一 actor/camera/timing；跨 backend 编译和闭环 |
| [Scene2Scene](https://doi.org/10.1145/3807895.3807932) | LLM-driven 3D spatial blockout → guided AI video | 与“Agent 做白膜 planner”直接冲突 | 从 spatial blockout 扩展到 executable 4D shot program 仍不够；必须有 compiler、verification、反馈和 benchmark |
| [LAMP](https://openaccess.thecvf.com/content/CVPR2026/html/Kizil_LAMP_Language-Assisted_Motion_Planning_for_Controllable_Video_Generation_CVPR_2026_paper.html) | LLM 把语言编译为物体/相机 3D trajectory DSL | Agent 规划 camera/object motion | Director 还需布局、骨骼、镜头、遮挡、时序、可见性、multi-pass compilation 与 renderer feedback |
| [MotionAgent](https://arxiv.org/abs/2502.03207) | Agent 把文本运动转为对象轨迹、相机外参和 flow | Agent 规划显式 motion field | Director 使用可执行场景而非单一 flow，并验证物理/摄影约束与输出控制保持 |
| [StoryBlender](https://arxiv.org/abs/2604.03315) | 多 Agent、continuity graph、可编辑 3D storyboard | Agent + 3D + multi-shot + verifier | StoryBlender 的主要输出是 3D storyboard；Director 研究如何把 program 编译并保留到最终生成视频 |
| [SimWorlds](https://arxiv.org/abs/2607.01766) | 多 Agent 创建并验证 dynamic 4D Blender scene | Agent 规划可执行 4D scene | Director 的目标是 generative rendering 与控制保留，不是高质量 4D asset 本身 |
| [CinemaTraj](https://arxiv.org/abs/2607.26910) | LLM 基于 3D scene graph 组合 cinematographic camera trajectory | Agent 摄影机规划 | Director 联合场面调度、演员、相机和时间，并向视频 backend 编译 |
| [GEN3C](https://openaccess.thecvf.com/content/CVPR2025/html/Ren_GEN3C_3D-Informed_World-Consistent_Video_Generation_with_Precise_Camera_Control_CVPR_2025_paper.html) | 3D cache rendering + camera path 控制视频 | 3D-aware neural rendering | cache 来自图像/已生成帧；不解决导演意图到 editable program |
| [Geometry-as-context](https://openaccess.thecvf.com/content/CVPR2026/html/Hu_Geometry-as-context_Modulating_Explicit_3D_in_Scene-consistent_Video_Generation_to_Geometry_CVPR_2026_paper.html) | explicit 3D geometry 调制 scene-consistent video | 显式几何作为 context | 不规划完整 shot program，也不研究跨 renderer control compilation |
| [ShotDirector](https://openaccess.thecvf.com/content/CVPR2026/html/Wu_ShotDirector_Directorially_Controllable_Multi-Shot_Video_Generation_with_Cinematographic_Transitions_CVPR_2026_paper.html) | 6DoF/intrinsic camera control 与 multi-shot patterns | directorial camera control | Director 的控制源是可执行 4D scene；需要 actor/layout/timing 与输出误差回投 |
| [Free-Form Motion Control](https://openaccess.thecvf.com/content/ICCV2025/html/Shuai_Free-Form_Motion_Control_Controlling_the_6D_Poses_of_Camera_and_ICCV_2025_paper.html) | 联合控制 camera/object 6D pose | 3D-aware camera/object control | Director 不训练单一 motion model，而编译完整 shot program 到多个 backend |
| [Motion Prompting](https://openaccess.thecvf.com/content/CVPR2025/html/Geng_Motion_Prompting_Controlling_Video_Generation_with_Motion_Trajectories_CVPR_2025_paper.html) | 稀疏/稠密 motion trajectory condition | program 到 trajectory control | 只覆盖 motion carrier，不覆盖完整 production control stack |

## 3. 可以和不可以使用的 claim

### 3.1 禁止使用

- first 3D-guided video generation；
- first video generator as renderer；
- first coarse geometry to photorealistic video；
- first LLM-generated 3D blockout；
- first agentic camera/object motion planner；
- first editable 3D storyboard；
- first multi-pass control for video generation；
- first verifier loop for agentic 3D creation。

### 3.2 相对安全但必须实验验证

- **Executable Shot IR:** 用统一、可执行、可版本化的 4D shot program 表达 layout、actor blocking、camera、timing 和 control contracts；
- **Capability-aware control compilation:** 同一 Shot IR 针对 heterogeneous video backends 自动选择控制载体、强度和降级策略；
- **Control retention:** 显式测量从 3D program 到最终视频有多少 directorial constraints 被 renderer 保留；
- **Program-space feedback:** 将成片错误定位回 program variable 或 compiler decision，并比较 prompt-only repair；
- **End-to-end intent controllability:** 评测 brief → valid 4D program → rendered video，而非只评测给定轨迹或给定白膜后的生成；
- **Renderer interchangeability:** 在不重新规划 shot 的情况下替换 video backend 或 style，并维持几何/时序意图。

“首次”仍不建议作为摘要用语。更稳健的写法是“we formulate, implement, and benchmark the joint problem of...”并用最强基线证明组合后的新问题不是模块堆叠。

## 4. 建议的方法核心

### 4.1 Executable 4D Shot Program

定义：

$$
P=(\mathcal{S},\mathcal{O},\mathcal{A},\mathcal{C},\mathcal{T},\mathcal{K}),
$$

其中：

- $\mathcal{S}$：scene layout、metric scale、support 和 spatial relations；
- $\mathcal{O}$：对象、角色、语义 identity 与 visibility；
- $\mathcal{A}$：actor/object animation、pose 和 trajectory；
- $\mathcal{C}$：camera extrinsic、intrinsic、target 和 movement；
- $\mathcal{T}$：shot duration、beats、keyframes 与 edit boundaries；
- $\mathcal{K}$：必须满足的 directorial constraints。

Program 必须能由确定性 Stage runtime 执行，而不是自然语言或未验证 JSON。

### 4.2 Engine-verified planning

Agent 通过结构化操作创建和修改 program。每一步可调用确定性工具验证：

- 对象和角色是否在画面内；
- screen-space size、headroom、lead room 和 composition；
- camera/actor collision；
- support、contact 和 occlusion order；
- actor path 是否在规定时间命中 blocking mark；
- 180-degree rule、eyeline 和相邻镜头 continuity；
- 帧数、相机和必需资产是否完整。

这些验证结果不是 VLM 主观评价，而是来自 scene state、camera projection 和 timeline simulation 的 privileged signals。

### 4.3 Capability-aware Control Packet Compiler

对 program $P$ 渲染候选控制集合：

$$
\mathcal{R}(P)=\{I^{rgb},D,N,M,F,Q,C\},
$$

分别表示 RGB proxy、depth、normal、instance/mask、optical or scene flow、pose/skeleton 和 camera parameters。

给定 backend capability card $b$，compiler 选择控制集合与强度：

$$
(z^*,\alpha^*)=\arg\min_{z,\alpha}
\mathbb{E}[L_{ctrl}+\lambda_qL_{quality}+\lambda_aL_{artifact}+\lambda_cC].
$$

建议实现一个 capability-conditioned router，而不是固定把所有 pass 全部喂给模型。过多或不兼容控制可能损害画质，正好形成可研究的 controllability–quality frontier。

### 4.4 Program-space feedback

Evaluator 将错误分解为：

| 成片错误 | 优先修改变量 | 不应首先做什么 |
| --- | --- | --- |
| 主体太小/偏框 | camera position、lens、target | 继续强化文本中的“close-up” |
| 遮挡顺序错误 | object/actor transform、camera | 加长 prompt 描述左右关系 |
| 行走轨迹漂移 | animation path、timing、motion pass | 随机重抽 seed |
| 动作 beat 太早/太晚 | timeline keyframes | 只改动作副词 |
| 风格不匹配 | style reference、render prompt | 改动 3D layout |
| 模型不支持某控制 | compiler carrier/strength/backend | 破坏正确的 shot program |

反馈策略应直接与 prompt-only retry、seed retry 和 control-strength-only retry 对照。

## 5. 建议的新 benchmark：ShotProgram-Bench

### 5.1 三个子任务

1. **Program Synthesis:** Creative brief → executable 4D shot program；
2. **Control Rendering:** Ground-truth program → controlled video；
3. **Program Repair:** Failed controlled video + diagnostics → revised program/control packet。

这种分解可以把 Agent planning 错误与 VideoGen control loss 分开，避免端到端结果无法归因。

### 5.2 场景与约束维度

| 维度 | 示例 |
| --- | --- |
| Layout | A 在桌左侧，B 在窗前，桌保持前景遮挡 |
| Composition | medium two-shot，A 位于左三分线，保留 headroom |
| Camera | 35mm，2m dolly-in，无 roll，始终看向 A |
| Actor blocking | A 从 mark 1 行至 mark 2，在第 48 帧转身 |
| Object motion | 杯子由 A 递给 B，并在第 72 帧完成交接 |
| Timing | 先开门，再转头，最后 camera push-in |
| Visibility | 钥匙必须在 30–60 帧可见，之后允许遮挡 |
| Multi-shot | shot/reverse-shot 维持 eyeline 和 screen direction |

### 5.3 分层评测

- **Level A — Oracle Program:** 人工或程序生成的正确 4D program，单独测 renderer/compiler；
- **Level B — Agent Program:** 从 brief 自动规划，测 planner + renderer；
- **Level C — Interactive Revision:** 修改 program 变量后重新渲染，测编辑局部性与可重复控制。

### 5.4 指标

#### Program validity

- executable rate；
- constraint satisfaction before generation；
- collision-free rate；
- visibility/framing/timing violations；
- Agent tool calls、repair turns 和 planning latency。

#### Final-video directorial control

- screen-space centroid、size 和 framing error；
- ordinal depth 和 occlusion-order accuracy；
- camera trajectory / recovered pose error；
- actor keypoint and object trajectory error；
- action beat timing error；
- identity、appearance、temporal consistency 和 visual quality；
- multi-shot screen direction、eyeline 和 state continuity。

#### Control Retention

定义每个约束 $k$ 在 proxy render 和 final video 上的满足度 $s_k^{proxy}$ 与 $s_k^{video}$。报告：

$$
CR=1-\frac{\sum_k w_k\max(0,s_k^{proxy}-s_k^{video})}{\sum_k w_k}.
$$

它回答：3D program 本来已经正确的控制，有多少在 VideoGen 渲染时丢失。

#### Editability

对单变量 intervention 报告：目标属性变化、非目标属性保持、再次满足约束所需操作数和重新生成成本。原 CineDelta 的增量 revision 可缩减为这个实验，而不是主论文问题。

## 6. 必须包含的基线

### 6.1 Planning baselines

- text-only prompt expansion；
- multi-agent screenplay/storyboard planning；
- direct LLM → Shot JSON，无工具反馈；
- Scene2Scene-style spatial blockout；
- LAMP-style motion DSL；
- Agent + 3D program，无 engine verifier；
- Oracle 4D program。

### 6.2 Rendering baselines

- text-to-video；
- reference image / first-frame I2V；
- RGB white-model video-to-video；
- depth-only、pose-only、camera-only；
- Motion Prompting / MotionAgent / FMC 类 trajectory control；
- Generative Rendering、I2V3D、VideoFrom3D（可复现条件允许时）；
- fixed all-pass packet；
- proposed capability-aware compiler。

### 6.3 Repair baselines

- seed retry；
- prompt rewrite；
- control strength tuning；
- regenerate full shot；
- proposed program-space repair。

## 7. 决定能否投稿的实验

### Gate A — 3D control 是否真的保留到 VideoGen

至少在两个 backend、四类控制和 100 个 shot variants 上，full system 相比 text/I2V/RGB-proxy baseline 显著降低控制误差，同时画质不出现明显下降。如果只有 camera 有提升，论文应改投 camera-control 方向而不是 general directorial control。

### Gate B — Agent 是否比直接 LLM program 更强

Engine feedback 必须显著提高 executable rate、constraint satisfaction 和首次渲染成功率。否则 Agent planner 只是系统包装，不应列为方法贡献。

### Gate C — Compiler 是否比固定控制包更强

Capability-aware routing 必须在至少两个能力不同的 backend 上改善 control–quality Pareto frontier。否则不要把 compiler 写成核心算法，只保留工程接口。

### Gate D — Program-space repair 是否比 prompt retry 更有效

在结构性失败上，program repair 应以更少轮数提高目标控制，同时减少 collateral drift。若无法做到，则闭环只能作为未来工作。

## 8. 推荐论文贡献表述

1. We formulate **intent-to-executable-shot rendering**, where directorial intent is grounded in a validated 4D program before pixel generation.
2. We present an **agentic 4D shot compiler** that jointly plans scene layout, actor blocking, camera, and timing through structured tools and privileged engine feedback.
3. We introduce **capability-aware control compilation** that translates one backend-independent shot program into renderer-specific multi-pass conditioning while optimizing control retention and visual quality.
4. We develop **program-space feedback** and **ShotProgram-Bench** to diagnose whether failures arise from planning, compilation, or generative rendering.

## 9. 推荐标题与一句话 claim

### 首选标题

> **Director: Compiling Agent-Planned 4D Blockouts into Controllable Video**

### 备选标题

- _Plan in 4D, Render in Pixels: Agentic Shot Programs for Controllable Video Generation_
- _Director: Executable 4D Previsualization as a Control Interface for Video Generators_
- _ShotCompiler: From Directorial Intent to Engine-Verified Generative Rendering_

### 一句话 claim

> **Director turns a video model from an unreliable planner into a controllable neural renderer by grounding directorial intent in an engine-verified 4D shot program, compiling that program into backend-specific control signals, and repairing control failures in program space.**

## 10. 参考工作清单

### 3D / 4D guided generative rendering

1. [Generative Rendering](https://openaccess.thecvf.com/content/CVPR2024/html/Cai_Generative_Rendering_Controllable_4D-Guided_Video_Generation_with_2D_Diffusion_Models_CVPR_2024_paper.html), CVPR 2024.
2. [I2V3D](https://arxiv.org/abs/2503.09733), ICCV 2025.
3. [VideoFrom3D](https://arxiv.org/abs/2509.17985), SIGGRAPH Asia 2025.
4. [GEN3C](https://openaccess.thecvf.com/content/CVPR2025/html/Ren_GEN3C_3D-Informed_World-Consistent_Video_Generation_with_Precise_Camera_Control_CVPR_2025_paper.html), CVPR 2025.
5. [Geometry-as-context](https://openaccess.thecvf.com/content/CVPR2026/html/Hu_Geometry-as-context_Modulating_Explicit_3D_in_Scene-consistent_Video_Generation_to_Geometry_CVPR_2026_paper.html), CVPR 2026.
6. [BulletTime](https://openaccess.thecvf.com/content/CVPR2026/html/Wang_BulletTime_Decoupled_Control_of_Time_and_Camera_Pose_for_Video_CVPR_2026_paper.html), CVPR 2026.

### Agent planning and 3D authoring

7. [Scene2Scene](https://doi.org/10.1145/3807895.3807932), I3D Companion 2026.
8. [LAMP](https://openaccess.thecvf.com/content/CVPR2026/html/Kizil_LAMP_Language-Assisted_Motion_Planning_for_Controllable_Video_Generation_CVPR_2026_paper.html), CVPR 2026.
9. [MotionAgent](https://arxiv.org/abs/2502.03207), ICCV 2025.
10. [StoryBlender](https://arxiv.org/abs/2604.03315), 2026.
11. [SimWorlds](https://arxiv.org/abs/2607.01766), 2026.
12. [CinemaTraj](https://arxiv.org/abs/2607.26910), 2026.
13. [Scenethesis](https://arxiv.org/abs/2505.02836), 2025.
14. [FilmAgent](https://arxiv.org/abs/2501.12909), 2025.

### Camera, trajectory, and multi-condition control

15. [Motion Prompting](https://openaccess.thecvf.com/content/CVPR2025/html/Geng_Motion_Prompting_Controlling_Video_Generation_with_Motion_Trajectories_CVPR_2025_paper.html), CVPR 2025.
16. [Free-Form Motion Control](https://openaccess.thecvf.com/content/ICCV2025/html/Shuai_Free-Form_Motion_Control_Controlling_the_6D_Poses_of_Camera_and_ICCV_2025_paper.html), ICCV 2025.
17. [MotionPro](https://openaccess.thecvf.com/content/CVPR2025/html/Zhang_MotionPro_A_Precise_Motion_Controller_for_Image-to-Video_Generation_CVPR_2025_paper.html), CVPR 2025.
18. [Tora](https://openaccess.thecvf.com/content/CVPR2025/html/Zhang_Tora_Trajectory-oriented_Diffusion_Transformer_for_Video_Generation_CVPR_2025_paper.html), CVPR 2025.
19. [MagicMotion](https://openaccess.thecvf.com/content/ICCV2025/html/Li_MagicMotion_Controllable_Video_Generation_with_Dense-to-Sparse_Trajectory_Guidance_ICCV_2025_paper.html), ICCV 2025.
20. [PoseTraj](https://openaccess.thecvf.com/content/CVPR2025/html/Ji_PoseTraj_Pose-Aware_Trajectory_Control_in_Video_Diffusion_CVPR_2025_paper.html), CVPR 2025.
21. [ShotDirector](https://openaccess.thecvf.com/content/CVPR2026/html/Wu_ShotDirector_Directorially_Controllable_Multi-Shot_Video_Generation_with_Cinematographic_Transitions_CVPR_2026_paper.html), CVPR 2026.
22. [SymphoMotion](https://openaccess.thecvf.com/content/CVPR2026/html/Zhang_SymphoMotion_Joint_Control_of_Camera_Motion_and_Object_Dynamics_for_CVPR_2026_paper.html), CVPR 2026.
23. [AC3D](https://openaccess.thecvf.com/content/CVPR2025/html/Bahmani_AC3D_Analyzing_and_Improving_3D_Camera_Control_in_Video_Diffusion_CVPR_2025_paper.html), CVPR 2025.

## 11. 最后判断

这条方向比 CineDelta 更贴近 Director 已经实现的技术资产：StageScene 是几何真值，Agent 具备结构化场景、相机和动画操作，Shot Package 已能导出 clean/depth/normal/object-ID/mask，Video Generation pipeline 已经把 LTX-2.3 放在下游 render stage。

但现阶段最缺的不是再写一个 Agent，而是：

1. 把现有 Stage state 固化为论文级 4D Shot IR；
2. 真正接通 multi-pass / motion / camera control，而不只传 clean first frame；
3. 实现 control retention evaluator；
4. 在两个不同 backend 上证明 compiler 的必要性；
5. 用 program-space repair 对照 prompt retry。

完成这五项，才有足够证据把“VideoGen 作为 renderer”从产品理念变成顶会可检验的方法贡献。
