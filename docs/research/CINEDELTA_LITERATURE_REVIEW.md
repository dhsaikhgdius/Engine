# CineDelta 文献调研与新颖性审计

**English title:** _CineDelta Literature Review and Novelty Audit_  
**Version:** 1.0  
**Search cut-off:** 2026-08-08  
**Purpose:** 为顶会 proposal 提供可追溯的相关工作、差异定位、反例检验与实验约束

---

## 0. 先给结论

经过对 2024–2026 年相关工作的补充检索，原 proposal 的大方向仍有研究价值，但原始表述过宽，不能再使用以下 claim：

- “首次在长视频中使用生产图或依赖图”；
- “首次对视频进行选择性重生成”；
- “首次把编辑表示为最小修改”；
- “首次支持可编辑且跨镜头一致的 3D storyboard”；
- “首次在共享历史上组合多镜头生成与编辑”；
- “首次将中间生产产物作为可追踪对象”。

这些组成部分已经分别被 CoAgent、Edit-As-Act、StoryBlender、ContextMaster、Crayotter 和 VideoAgent 覆盖。

CineDelta 仍可成立的、更精确的研究问题是：

> **给定一个已经完成并接受的多镜头生成式作品、完整生产 provenance，以及一项可能发生在任意历史时刻的创作修改，如何预测并验证跨叙事状态、3D 世界状态、镜头条件、生成任务、媒体产物和剪辑时间线的最小充分重执行计划，使新约束成立，同时量化保护未受影响内容和真实执行成本？**

这个问题与最近工作的关键差异不是“能不能编辑”，而是四个联合条件：

1. **Retroactive revision**：修改可发生在已完成作品的历史节点，而不是只向前追加下一镜；
2. **Cross-artifact impact localization**：输出不仅是编辑后的视频，还包括受影响的状态、镜头、任务和产物集合；
3. **Minimal sufficient re-execution**：优化对象是可执行的重计算计划，而不是单镜头 verifier retry 或单场景动作序列；
4. **Process-level evaluation**：同时评估编辑成功、必要节点召回、无关内容保持、边界连续性和实际成本。

因此更稳健的论文定位应从“incremental film production”进一步收缩为：

> **Counterfactual impact localization and provenance-aware re-execution for retroactive revision of multi-shot generative productions.**

---

## 1. 调研方法

### 1.1 检索问题

本轮调研围绕六个问题展开：

1. 现有 agentic video 系统是否已经维护生产图、执行图或中间产物？
2. 现有 long/multi-shot 方法是否支持交互式编辑、历史记忆更新或旧镜头替换？
3. 是否已有方法根据 verifier 只重生成失败镜头？
4. 是否已有 3D 编辑方法以最小动作和保持未编辑区域为目标？
5. 是否已有 benchmark 同时测量编辑传播、未修改内容保持和成本？
6. “依赖传播与最小重计算”在系统领域是否早已解决，CineDelta 的新增难点是什么？

### 1.2 检索源与纳入标准

优先使用以下一手来源：

- arXiv 原始论文页及论文 HTML/PDF；
- CVF Open Access 的 CVPR/ICCV 正式论文页；
- USENIX 官方论文页；
- 作者项目页仅用于确认代码、数据或交互能力。

纳入工作需至少覆盖以下一项：长视频/多镜头生成、agentic 电影制作、生成式视频编辑、3D 场景编辑、跨镜头记忆、视频 benchmark、增量计算或 workflow provenance。二手博客不作为技术结论依据。

### 1.3 检索词族

- `agentic video generation`, `multi-agent movie generation`, `long-form video agent`；
- `multi-shot video generation`, `interactive multi-shot`, `cross-shot memory`；
- `video editing preservation`, `multi-shot video editing`, `edit-aware memory`；
- `editable 3D storyboard`, `3D scene editing minimal actions`；
- `video editing benchmark`, `multi-shot benchmark`, `long-form diagnostic evaluation`；
- `self-adjusting computation`, `incremental build`, `workflow provenance`, `dependency graph recomputation`。

### 1.4 限制

这是一份面向 proposal 决策的 scoping review，不是正式的系统综述或 meta-analysis。2026 年相关论文增长很快，投稿前仍需进行一次同期工作刷新、引用图追踪和代码可用性核验。

---

## 2. 任务边界：必须先区分六类问题

| 问题类型               | 输入                           | 输出                       | 主要优化目标                       | 与 CineDelta 的关系                              |
| ---------------------- | ------------------------------ | -------------------------- | ---------------------------------- | ------------------------------------------------ |
| 一次性长视频生成       | 故事/脚本                      | 完整视频                   | 叙事、质量、一致性                 | 提供基础生产系统，不等于 revision                |
| 在线下一镜生成         | 历史镜头 + 新 prompt           | 下一镜                     | 低延迟、历史一致性                 | 只向前，不处理已完成作品的反向影响               |
| 视频内容编辑           | 源视频 + 指令                  | 编辑后视频                 | 编辑准确、源保持、时序一致         | 解决像素/latent 变换，不输出生产影响集           |
| 3D 场景编辑            | 3D 场景 + 指令                 | 新 3D 场景/动作序列        | 目标满足、物理合理、局部保持       | 与最小修改最接近，但缺少多镜头产物链             |
| verifier-driven repair | 生成结果 + 质量检查            | 重试后的结果               | 纠错、质量、收敛                   | CoAgent 已覆盖 shot-level selective regeneration |
| 生产级增量修订         | 已完成作品 + provenance + edit | 影响集、重执行计划、新作品 | 充分性、最小性、保持、连续性、成本 | CineDelta 应限定在这一行                         |

如果论文只展示“修改一个镜头后重生成相关镜头”，审稿人会认为它只是 CoAgent、ContextMaster 或传统依赖失效机制的组合。必须让任务输入、系统输出和评测协议都显式体现“已完成作品上的跨产物反事实影响分析”。

---

## 3. 研究版图

### 3.1 Agentic 长视频与自动电影制作

| Work                                                                                                                                           | 已解决的问题                     | 核心机制                                               | 对 CineDelta 的直接约束                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| [AesopAgent](https://arxiv.org/abs/2403.07952)                                                                                                 | 故事到视频的工具编排             | RAG 驱动的工作流演化与多模态 utilities                 | “Agent 编排生产流程”不是创新                    |
| [Mora](https://arxiv.org/abs/2403.13248)                                                                                                       | 多任务通用视频生成               | 多 Agent 协作、数据合成、人类反馈                      | “多 Agent + 多模型”不是创新                     |
| [FilmAgent](https://arxiv.org/abs/2501.12909)                                                                                                  | 3D 虚拟空间中的端到端电影制作    | 导演、编剧、演员、摄影等角色协同                       | 3D 电影制作和角色分工已被提出                   |
| [MovieAgent](https://arxiv.org/abs/2503.07314)                                                                                                 | 自动多场景、多镜头电影生成       | 分层 CoT 规划场景、摄影与角色                          | 分层制作计划不是创新                            |
| [VideoGen-of-Thought](https://arxiv.org/abs/2503.15138)                                                                                        | 从一句话自动生成多镜头视频       | 动态故事线、身份传播、相邻 latent transition           | 身份传播和边界机制已有强基线                    |
| [AniMaker](https://arxiv.org/abs/2506.10540)                                                                                                   | 多镜头动画生产与候选选择         | MCTS-Gen、前后镜头感知的 AniEval                       | 成本感知候选搜索和邻镜评价已有先例              |
| [AniME](https://arxiv.org/abs/2508.18781)                                                                                                      | 长篇动画生产                     | 全局记忆、MCP 工具选择、多 Agent                       | 全工作流状态和工具选择不是创新                  |
| [Hollywood Town](https://arxiv.org/abs/2510.22431)                                                                                             | 长视频跨模态多 Agent 协作        | 图/超图、有限循环和反思                                | DAG/有环生产图本身不是创新                      |
| [CoAgent](https://arxiv.org/abs/2512.22536)                                                                                                    | 闭环一致性生成                   | plan–synthesize–verify、实体记忆、失败镜头选择性重生成 | “选择性重生成”已被明确提出，是最强冲突项        |
| [VISTA](https://openaccess.thecvf.com/content/CVPR2026/html/Long_VISTA_A_Test-Time_Self-Improving_Video_Generation_Agent_CVPR_2026_paper.html) | 测试时自改进视频生成             | 候选锦标赛、视觉/音频/语境 critic、prompt 迭代         | 自评估和重试循环不是创新                        |
| [CineAGI](https://arxiv.org/abs/2604.23579)                                                                                                    | 多角色、多模态电影生成           | 层次 Agent、角色实例追踪、音画同步                     | 角色与音画层次生产已有系统                      |
| [Crayotter](https://arxiv.org/abs/2606.07636)                                                                                                  | 可追踪的长视频编辑工作流         | 中间产物、调度事件、工具调用、恢复和异步执行           | first-class artifacts、trace 与恢复机制不是创新 |
| [VideoAgent](https://arxiv.org/abs/2606.23327)                                                                                                 | 长视频理解和三十余编辑工具编排   | intent filtering、textual-gradient graph optimization  | 编辑管线图优化已有相邻工作                      |

#### 小结

Agentic 系统已经覆盖“规划—执行—检查—重试”、层次生产、图式编排和中间产物可追踪。CineDelta 必须把研究单位从“生成 workflow”转到“修改发生后的影响集合与重执行计划”，并用任务级 benchmark 证明这不是简单工程缓存。

### 3.2 原生多镜头、长程记忆与交互式生成

| Work                                                                                                                                                                                               | 主要能力                               | 记忆/一致性机制                                      | 尚未覆盖的 CineDelta 变量                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [ShotAdapter](https://arxiv.org/abs/2505.07652)                                                                                                                                                    | 文本到多镜头视频                       | 在单镜头扩散模型上增加多镜头适配                     | 无历史修订与生产成本                                                                                                        |
| [Context as Memory](https://arxiv.org/abs/2506.03141)                                                                                                                                              | 场景一致的交互式长视频                 | 基于相机 FOV 重叠检索历史帧                          | 检索上下文，不预测修改影响集                                                                                                |
| [MultiShotMaster](https://arxiv.org/abs/2512.03041)                                                                                                                                                | 可控镜头数量、时长、主体与场景         | Narrative RoPE、位置感知参考注入                     | 一次性生成，不是事后 revision                                                                                               |
| [HoloCine](https://openaccess.thecvf.com/content/CVPR2026/html/Meng_HoloCine_Holistic_Generation_of_Cinematic_Multi-Shot_Long_Video_Narratives_CVPR_2026_paper.html)                               | 分钟级整体多镜头生成                   | Window Cross-Attention、稀疏跨镜头注意力             | 双向全局生成，不输出可执行 edit plan                                                                                        |
| [OneStory](https://openaccess.thecvf.com/content/CVPR2026/html/An_OneStory_Coherent_Multi-Shot_Video_Generation_with_Adaptive_Memory_CVPR_2026_paper.html)                                         | 自回归一致多镜头生成                   | 语义帧选择和 adaptive memory                         | 下一镜生成，不修订已接受产物                                                                                                |
| [STAGE](https://openaccess.thecvf.com/content/CVPR2026/html/Zhang_STAGE_Storyboard-Anchored_Generation_for_Cinematic_Multi-shot_Narrative_CVPR_2026_paper.html)                                    | storyboard 锚定的多镜头叙事            | 首尾帧对和 multi-shot memory pack                    | 解决生成锚点，不处理历史修改传播                                                                                            |
| [ShotDirector](https://openaccess.thecvf.com/content/CVPR2026/html/Wu_ShotDirector_Directorially_Controllable_Multi-Shot_Video_Generation_with_Cinematographic_Transitions_CVPR_2026_paper.html)   | 电影化转场控制                         | 6DoF/内参控制、editing-pattern prompt                | 可作为相机和边界质量强基线                                                                                                  |
| [Narrative Weaver](https://openaccess.thecvf.com/content/CVPR2026/html/Yao_Narrative_Weaver_Towards_Controllable_Long-Range_Visual_Consistency_with_Multi-Modal_Conditioning_CVPR_2026_paper.html) | 长程可控视觉叙事                       | MLLM 规划和动态 memory bank                          | 不评价重执行最小性                                                                                                          |
| [ShotStream](https://arxiv.org/abs/2603.25746)                                                                                                                                                     | 实时流式多镜头生成                     | global/local dual cache、自蒸馏                      | 允许在线新 prompt，但不回滚旧作品                                                                                           |
| [CausalCine](https://arxiv.org/abs/2605.12496)                                                                                                                                                     | 实时在线导演与动态 prompt              | content-aware KV memory routing                      | 明确复用历史且不重生成旧镜头；不解决旧状态修改后的反向失效                                                                  |
| [EntityBench / EntityMem](https://arxiv.org/abs/2605.15199)                                                                                                                                        | 最长 50 镜头的实体一致性               | verified per-entity reference memory                 | 提供长程一致性评测，不测 revision locality                                                                                  |
| [Memento](https://arxiv.org/abs/2606.14667)                                                                                                                                                        | 长视频主体长期保持                     | 基于重建的双查询记忆                                 | 记忆充分性可启发 boundary packet，但不是生产 impact                                                                         |
| [PermaVid](https://arxiv.org/abs/2606.16449)                                                                                                                                                       | 编辑后仍保持长程一致                   | RGB/depth 解耦记忆、edit-aware update/retrieval      | 处理记忆失效，但不产生跨任务重执行集合                                                                                      |
| [ContextMaster](https://arxiv.org/abs/2608.04956)                                                                                                                                                  | 在共享历史中组合生成、参考和多镜头编辑 | role-aware context、固定预算稀疏路由、ConstraintSink | 最接近 interactive editing；只生成当前 target，accepted output 追加到历史，不做任意历史节点的 retroactive dependency repair |

#### 小结

2026 年的前沿已从“能否生成多个镜头”推进到“共享历史中的实时生成与编辑”。因此，CineDelta 不能以“interactive multi-shot editing”为任务名。真正的空隙是：对已经存在的多镜头项目进行非尾部修改，并判断哪些已接受的下游状态与产物失效。

### 3.3 生成式视频编辑与编辑 Agent

| Work                                                                                                                                                                          | 任务与指标                                                               | 对 CineDelta 的价值                      | 未覆盖部分                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------- |
| [M3L](https://openaccess.thecvf.com/content/CVPR2022/html/Fu_M3L_Language-Based_Video_Editing_via_Multi-Modal_Multi-Level_Transformers_CVPR_2022_paper.html)                  | 语言驱动源视频到目标视频，要求场景保持                                   | 早期 task definition                     | 单视频、无跨镜头/生产 provenance               |
| [FiVE-Bench](https://openaccess.thecvf.com/content/ICCV2025/html/Li_FiVE-Bench_A_Fine-grained_Video_Editing_Benchmark_for_Evaluating_Emerging_Diffusion_ICCV_2025_paper.html) | 100 视频、6 类编辑、420 prompt pairs、15 指标                            | 背景保持、文本一致和时间一致性指标可复用 | 不标注受影响生产节点和成本                     |
| [Aurora](https://arxiv.org/abs/2605.18748)                                                                                                                                    | 工具增强 VLM 将欠指定请求转为编辑计划                                    | Edit Delta Compiler 的强基线             | 规划模型条件，不做跨产物依赖失效               |
| [VIVA](https://openaccess.thecvf.com/content/CVPR2026/html/Cong_VIVA_VLM-Guided_Instruction-Based_Video_Editing_with_Reward_Optimization_CVPR_2026_paper.html)                | instruction fidelity、content preservation、aesthetics                   | 视觉编辑后端和保持指标                   | 不判断哪些镜头应重执行                         |
| [CoT-Edit](https://openaccess.thecvf.com/content/CVPR2026/html/Liang_CoT-Edit_Let_CoT_Guide_Instruction_Video_Editing_CVPR_2026_paper.html)                                   | CoT 规划 box、属性和 mask                                                | 证明“LLM 结构化编辑计划”已存在           | 仍是单视频空间定位                             |
| [V-RGBX](https://openaccess.thecvf.com/content/CVPR2026/html/Fang_V-RGBX_Video_Editing_with_Accurate_Controls_over_Intrinsic_Properties_CVPR_2026_paper.html)                 | intrinsic-aware 逆渲染与关键帧编辑传播                                   | 可作为材质/光照编辑后端                  | 不处理故事和工件依赖                           |
| [FFP-300K](https://arxiv.org/abs/2601.01720)                                                                                                                                  | 首帧编辑传播，平衡外观与源运动保持                                       | 提供 propagation/preservation 对照       | 传播范围预定义为单视频帧序列                   |
| [UniEditBench](https://arxiv.org/abs/2604.15871)                                                                                                                              | 统一图像/视频编辑，结构、文本、背景、自然度、时空一致性                  | 可借鉴多维 judge 与低成本 evaluator      | 不评估计划最小性与跨镜头因果影响               |
| [ContextMaster](https://arxiv.org/abs/2608.04956)                                                                                                                             | 50 个多镜头视频编辑 cases，测 task fulfillment 与 inter-shot consistency | 当前最强多镜头编辑冲突项                 | 不评价 required/optional/protected impact sets |

#### 小结

编辑领域已经把“编辑准确 + 源内容保持 + 时间一致性”作为标准目标。CineDelta-Eval 的价值只能来自新增的过程层信号：必要节点召回、保护节点违规、影响范围过度、边界修复和实测执行成本，而不能只是重复现有视觉指标。

### 3.4 3D/4D 一致性、可编辑场景与世界状态

| Work                                                                                                                                                                    | 主要贡献                                                               | 与 CineDelta 的关系                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| [GEN3C](https://arxiv.org/abs/2503.03751)                                                                                                                               | 3D cache、精确相机轨迹和世界一致视频                                   | 可作为 3D boundary conditioning 后端                          |
| [StoryBlender](https://arxiv.org/abs/2604.03315)                                                                                                                        | continuity memory graph、统一坐标资产、引擎验证、可编辑 3D storyboard  | “3D 可编辑 + 跨镜头一致”已被直接覆盖                          |
| [WorldDirector](https://arxiv.org/abs/2607.02517)                                                                                                                       | LLM 协调对象/相机 3D 轨迹，持久动态对象记忆                            | 可提供显式世界状态和重现条件                                  |
| [WorldReel](https://openaccess.thecvf.com/content/CVPR2026/html/Fang_WorldReel_4D_Video_Generation_with_Consistent_Geometry_and_Motion_Modeling_CVPR_2026_paper.html)   | 联合生成 RGB、pointmaps、camera 和 dense flow                          | 说明几何/运动 consistency 可由 4D 表示解决                    |
| [CineScene](https://openaccess.thecvf.com/content/CVPR2026/html/Huang_CineScene_Implicit_3D_as_Effective_Scene_Representation_for_Cinematic_Video_CVPR_2026_paper.html) | 静态场景多图的隐式 3D 条件与相机控制                                   | 可作为 scene consistency 后端                                 |
| [Vinedresser3D](https://openaccess.thecvf.com/content/CVPR2026/html/Chi_Vinedresser3D_Towards_Agentic_Text-guided_3D_Editing_CVPR_2026_paper.html)                      | Agent 定位 3D 资产编辑并保持未编辑区域                                 | “Agentic 3D 局部编辑与保持”不是创新                           |
| [Edit-As-Act](https://arxiv.org/abs/2603.17583)                                                                                                                         | 把语言 3D 场景编辑定义为最小动作的目标回归规划；EditLang 显式前提/效果 | 与“最小修改”概念最接近，必须作为 planning baseline 和差异说明 |

#### Edit-As-Act 为什么是严重 novelty threat

Edit-As-Act 已经明确提出：用户指令定义目标世界状态，编辑应以最小动作序列实现目标并保持其余内容；其 source-aware regression 只传播未满足前提，并由 validator 检查物理可行性。它还展示了移除支撑物时对子物体的必要调整。

CineDelta 与它的可保留差异是：

- Edit-As-Act 研究单个静态室内 3D 场景；CineDelta 研究随时间演化的多镜头制作与已渲染媒体；
- Edit-As-Act 的动作直接改变场景几何；CineDelta 的动作可能改变脚本状态、镜头条件、生成作业、媒体版本和时间线替换；
- Edit-As-Act 不处理随机生成后端、边界 continuity、缓存/seed/provenance 和实际生成成本；
- CineDelta 的“最小”不是最短动作序列，而是满足质量与保护约束的最小充分重执行计划。

但如果 CineDelta 的实验只包含“移动桌子后移动杯子”这类静态 3D 例子，它会被认为是 Edit-As-Act 的电影化扩展，贡献不足。主实验必须包含跨镜头、跨时间和跨媒体产物的影响。

### 3.5 Benchmark 与评价

| Benchmark                                                                                                                                                                     | 覆盖范围                                     | 已有指标                                      | CineDelta-Eval 必须新增什么           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------- | ------------------------------------- |
| [VBench](https://openaccess.thecvf.com/content/CVPR2024/html/Huang_VBench_Comprehensive_Benchmark_Suite_for_Video_Generative_Models_CVPR_2024_paper.html)                     | 通用视频生成                                 | 主体/背景一致、运动、画质、美学等             | 不能替代 revision 指标                |
| [FiVE-Bench](https://openaccess.thecvf.com/content/ICCV2025/html/Li_FiVE-Bench_A_Fine-grained_Video_Editing_Benchmark_for_Evaluating_Emerging_Diffusion_ICCV_2025_paper.html) | 细粒度单视频编辑                             | 背景保持、对齐、时间一致、质量                | 影响集与执行成本                      |
| [UniVBench](https://openaccess.thecvf.com/content/CVPR2026/html/Wei_UniVBench_Towards_Unified_Evaluation_for_Video_Foundation_Models_CVPR_2026_paper.html)                    | 200 个人工多镜头视频；理解、生成、编辑、重建 | 统一 agentic evaluator                        | 项目 provenance 和修改传播            |
| [DirectorBench](https://arxiv.org/abs/2605.30090)                                                                                                                             | 长视频工作流诊断                             | 40 checkpoints，脚本/视觉/音频/跨模态/稳定性  | edit episode、受影响集合、保持/成本   |
| [EntityBench](https://arxiv.org/abs/2605.15199)                                                                                                                               | 最长 50 镜头的实体一致性                     | 镜头内质量、prompt、跨镜头一致性              | 状态修改后的依赖召回和局部性          |
| [UniEditBench](https://arxiv.org/abs/2604.15871)                                                                                                                              | 统一图像/视频编辑                            | 结构、文本、背景、自然度、时空一致性          | 过程级最小重执行指标                  |
| CoAgent evaluation                                                                                                                                                            | verifier 重试效率                            | 首次通过率、附加重试数、三轮收敛              | 哪些节点应该重试、错误重试和遗漏成本  |
| ContextMaster evaluation                                                                                                                                                      | 多镜头生成/参考/编辑                         | task fulfillment、inter-shot consistency、FPS | retroactive edit 和已接受下游产物修复 |

#### 评价缺口

没有已核验 benchmark 同时提供以下标注：

1. 修改前的完整生产状态和 artifact lineage；
2. 修改请求对应的目标状态差分；
3. 必要、可选、禁止修改的状态/镜头/作业/产物集合；
4. 每个动作的实际成本；
5. 修改区域两侧的边界条件；
6. 多个同样有效的重执行计划或 Pareto front。

这正是 CineDelta-Eval 最可能形成独立贡献的地方。

### 3.6 增量计算、构建系统与 provenance

依赖图上的增量更新不是新概念，proposal 必须主动承认这一点。

| Lineage                                                                                                 | 已解决问题                                     | 对 CineDelta 的启示                              |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| [Maintaining Views Incrementally](https://sigmodrecord.org/1993/06/03/maintaining-views-incrementally/) | 数据变化后只计算物化视图的增量                 | “delta + incremental update”有成熟理论先例       |
| [Self-adjusting computation](https://arxiv.org/abs/1106.0478)                                           | 记录动态依赖并通过 change propagation 调整计算 | 动态依赖图和 change propagation 不能作为单独创新 |
| [Riker](https://www.usenix.org/conference/atc22/presentation/curtsinger)                                | 自动发现依赖并保证正确、快速的增量构建         | 必须区分已知确定性依赖和不确定语义依赖           |
| [Workflow provenance differencing](https://arxiv.org/abs/1406.0905)                                     | 比较 provenance trace 并定位分歧               | 可用于版本差分和 failure localization            |

传统增量系统通常假定：依赖可观测、转换相对确定、正确性可精确判定。生成式电影制作不同在于：

- 依赖包含语义、叙事、视觉身份、空间、时间和审美关系；
- 相同输入和模型也可能因随机性产生不同媒体；
- 某些依赖只有运行后才显现；
- “正确”不是 bitwise equality，而是约束满足和人类感知；
- 一个 edit 可能有多个同样有效但成本不同的修复计划。

因此，CineDelta 的系统研究问题应是 **uncertain, semantic and perceptual dependency discovery under stochastic generative execution**，而不是一般意义上的 DAG invalidation。

---

## 4. 六个最近工作深度对照

### 4.1 Hollywood Town / FilmAgent / MovieAgent

Hollywood Town、FilmAgent 和 MovieAgent 已经用多 Agent 角色、分层场景/摄影规划和图式协作覆盖“从故事到成片”的一次性生产。它们说明依赖图、状态跟踪和角色分工都不能单独作为贡献。

必须做的差异实验：把镜头/摄影机依赖闭包作为规则基线；在相同 production graph 上比较其全下游传播与 CineDelta 的必要性预测和保护约束。

### 4.2 CoAgent

CoAgent 的 verifier 会在单个 shot 质量低于阈值时触发选择性重生成，并报告 72% 镜头首轮通过、其余镜头平均增加 1.4 次重试、最多 3 次时 98% 收敛。它直接否定“首次 selective regeneration”的表述。

关键差异应落在：

- CoAgent 的触发源是当前生成镜头的质量失败；CineDelta 的触发源是用户对已完成制作的状态修改；
- CoAgent 重试当前 shot；CineDelta 必须预测可能非连续、跨类型的影响集合；
- CoAgent 不标注 false-positive regeneration 和 protected-content violation；CineDelta 必须报告；
- CoAgent 的效率是 retry count；CineDelta 的效率是实际 wall-clock、GPU seconds、API cost 和 artifact replacement cost。

### 4.3 ContextMaster

ContextMaster 是截至检索日最直接的多镜头交互编辑冲突项。它在每一轮接收 instruction、optional reference、optional source video 和 accepted shot history；如果有 source，则生成其编辑版本；被接受的输出追加到历史。它还在 50 个 multi-shot source cases 上评测 addition/removal/replacement。

关键边界：ContextMaster 的状态是 append-only accepted history，当前 target 被生成或编辑；它没有定义对历史中任意已接受节点修改后，哪些后来镜头、世界状态、生成任务和 timeline placement 应失效并重执行。CineDelta 必须专门构造“edit shot 2 after shots 3–10 are already accepted”这类 episode，才能与它区分。

### 4.4 Edit-As-Act

Edit-As-Act 已经给出最小编辑、goal regression、显式前提/效果和 validator。CineDelta 应将其改造为强 baseline：把生产节点动作映射成 PDDL-style operators，使用目标回归求计划，再与 typed propagation、learned impact 和 cost-aware selection 比较。

论文中不能把 min-cut 或目标回归本身称为主要新算法；需要证明新的困难来自跨模态依赖学习、随机生成验证和非唯一计划。

### 4.5 StoryBlender 与 PermaVid

StoryBlender 已经把 global assets 与 shot-specific variables 分离，并通过 continuity memory graph 和 engine-verified feedback 获得可编辑 3D storyboard。PermaVid 已经研究外观或几何被编辑后，如何更新失效的 RGB/depth memory。

CineDelta 的实验需要同时覆盖：

- **state invalidation**：哪些 canonical/world states 被改；
- **artifact invalidation**：哪些已生成视频和 timeline assets 失效；
- **memory invalidation**：哪些缓存/参考必须更新；
- **boundary repair**：新旧媒体接缝如何恢复。

只做其中第一或第三项都会与这两项工作重叠。

### 4.6 Crayotter 与 VideoAgent

Crayotter 把 retrieval reports、analyses、editing blueprints、scheduler events、tool calls、intermediate renders 和 exports 视为 first-class artifacts；VideoAgent 用图优化组合大量编辑工具。它们说明“把视频制作做成可观察的工作图”本身已不够新。

CineDelta 的图必须成为可评价的预测对象：每个 edit 都要输出节点级概率、传播理由、保护冲突、选择计划和 execution trace，并能与人工/干预式 ground truth 对比。

---

## 5. 新颖性矩阵

符号：✓ 明确覆盖；△ 部分覆盖；— 未作为核心任务或评测。

| Work                 | 已完成作品的事后修改 | 任意历史节点 | 跨镜头传播 | 跨生产产物 | 最小充分计划 | 未影响内容保持 | 实际成本 | 影响集 ground truth |
| -------------------- | -------------------: | -----------: | ---------: | ---------: | -----------: | -------------: | -------: | ------------------: |
| Hollywood Town       |                    △ |            — |          ✓ |          △ |            — |              — |        — |                   — |
| CoAgent              |                    — |            — |          △ |          — |            — |              △ |        △ |                   — |
| StoryBlender         |                    ✓ |            △ |          ✓ |          △ |            — |              ✓ |        — |                   — |
| Edit-As-Act          |                    ✓ |            ✓ |          — |          — |            ✓ |              ✓ |        — |                   — |
| PermaVid             |                    ✓ |            △ |          ✓ |          — |            — |              △ |        — |                   — |
| ContextMaster        |                    ✓ |            △ |          ✓ |          — |            — |              ✓ |        ✓ |                   — |
| Crayotter            |                    ✓ |            ✓ |          △ |          ✓ |            — |              — |        △ |                   — |
| VideoAgent           |                    ✓ |            △ |          △ |          ✓ |            △ |              — |        ✓ |                   — |
| **CineDelta target** |                    ✓ |            ✓ |          ✓ |          ✓ |            ✓ |              ✓ |        ✓ |                   ✓ |

这张表不能直接用作“我们全都第一个”的证据，因为组合创新很容易被审稿人视为 engineering aggregation。它只说明实验必须同时覆盖最后六列；任何缺列都会让论文退化为已有工作的局部组合。

---

## 6. 可辩护与不可辩护的 claim

### 6.1 不可辩护

- First agentic video editing system.
- First dependency graph for long-video generation.
- First selective regeneration framework.
- First minimal editing framework.
- First editable and consistent 3D storyboard.
- First interactive multi-shot video editor.
- First traceable artifact-based video workflow.

### 6.2 有条件可辩护

下列 claim 必须加上截至检索日和任务限定，并在投稿前重新检索：

- 首个把 **retroactive multi-shot generative revision** 明确定义为影响集预测和可执行重计算计划的 benchmark；
- 首个联合标注 **required / optional / protected** production artifacts 的 edit-episode 数据集；
- 首个联合评估 edit fidelity、impact sufficiency、collateral preservation、boundary continuity 和 measured execution cost 的协议；
- 首个在叙事/世界/镜头/任务/媒体/时间线混合图上研究随机生成执行下的 counterfactual impact localization。

### 6.3 最稳妥的贡献表达

1. **Task:** Production Revision Impact Localization，输入是已完成制作和 edit delta，输出是 set-valued impact plan；
2. **Benchmark:** CineDelta-Eval，包含可干预的 production provenance、多个有效计划和保护集合；
3. **Method:** provenance-aware hybrid planner，将显式依赖、学习式语义影响和执行后验证结合；
4. **System:** boundary-conditioned re-execution，用相同后端验证计划能否以更少成本保持质量；
5. **Finding:** 分析何种编辑需要局部传播、何种依赖可安全截断、何种情况下应拒绝保护要求。

其中 task + benchmark 应是主贡献，method 是验证任务价值的核心技术，Director 集成只是实验平台。

---

## 7. Reviewer-style novelty stress test

### Attack 1：这只是 build system 用在视频上

**风险成立的条件：** 图边完全由手工规则给出，算法只是 downstream closure 或 min-cut。

**必须补强：**

- 将依赖分为 deterministic、observed、semantic 和 latent 四类；
- 测量未知边预测、跨 edit-type 泛化和 calibration；
- 用干预实验生成 necessity labels；
- 展示传统 build invalidation 在隐式身份/叙事/边界依赖上漏召回。

### Attack 2：CoAgent 已经 selective regeneration

**风险成立的条件：** 只根据 verifier 低分重试当前或相邻 shot。

**必须补强：**

- 使用已完成项目上的 retroactive edit；
- 预测非连续、跨类型的受影响节点；
- 对 CoAgent-style local retry 报告 impact recall、protected violation 和 cost；
- 展示“当前镜头质量合格，但因早期状态变化而语义过期”的案例。

### Attack 3：ContextMaster 已经 multi-shot editing

**风险成立的条件：** edit 一个 multi-shot source 并直接生成全部编辑结果。

**必须补强：**

- base production 先完成并冻结；
- edit 发生在任意过去节点；
- 后续镜头有些应保持、有些应替换；
- 系统输出显式 impact plan，而不是只输出视频；
- 以 ContextMaster-style full V2MV edit 作为强视觉 baseline。

### Attack 4：Edit-As-Act 已经最小编辑和因果传播

**风险成立的条件：** 数据仅是静态 3D 布局，或算法只是 PDDL goal regression。

**必须补强：**

- 引入时间状态、shot coverage、媒体版本和 timeline；
- 设计同一世界状态映射到多个不同镜头/后端产物的案例；
- 评估 stochastic execution 下计划是否充分；
- 比较最短 action plan 与最低真实生成成本并证明二者不同。

### Attack 5：影响集没有唯一 ground truth

**这是实质性问题，不应回避。** 同一修改可通过多种摄影、剪辑或生成方式满足。

**解决方案：**

- 不强制单一 gold set；
- 标注 required、optional、protected 三类节点；
- 对小图通过枚举或受控干预构建 Pareto-valid plans；
- 将预测评价为 constraint-validity + domination gap，而不是只测 exact match；
- 人工 adjudication 只处理多个可行方案之间的电影语言合理性。

### Attack 6：视觉改进来自更强后端而不是 planner

**必须补强：**

- 所有 impact baselines 使用同一生成/编辑后端、seed budget 和 verifier budget；
- 将 planning 和 rendering 结果分开报告；
- 先在确定性 3D render 上验证因果正确性，再在随机视频后端上验证外部有效性；
- 报告 matched-cost 与 matched-quality 两套比较。

### Attack 7：只做小型 synthetic benchmark，无法说明真实价值

**必须补强：** 两层 benchmark：

- **Controlled tier:** 3D/规则世界，具有准确状态和干预式标签；
- **Open tier:** 生成式多镜头短片，由双人标注 + 第三人裁决产生 set-valued labels；
- 分别报告内部因果有效性和真实视觉有效性，不混成单一分数。

---

## 8. 对任务定义的修改建议

### 8.1 新任务名

建议使用：

> **Production Revision Impact Localization (PRIL)**

避免使用过宽的 `interactive video editing` 或已经高度拥挤的 `agentic video generation`。

### 8.2 输入

一个 episode 应包含：

- base production graph \(G^0\)；
- accepted artifact versions \(A^0\)；
- execution provenance \(P^0\)，包括模型、参数、seed、reference、耗时和费用；
- retroactive edit request \(u\)；
- protected constraints \(L\)；
- evaluation budget \(B\)。

### 8.3 输出

系统输出不应只有视频，应至少包含：

- normalized edit delta \(\Delta\)；
- node/edge impact scores；
- selected re-execution plan \(\pi\)；
- protected-conflict report；
- boundary-conditioning packet；
- new artifact versions和 execution trace；
- localized constraint report。

### 8.4 Ground truth

使用集合值标签：

- \(R\)：任何有效计划都必须修改的 required nodes；
- \(O\)：至少一个有效计划可能修改的 optional nodes；
- \(P\)：在目标设定下应保持的 protected nodes；
- \(\Pi^*\)：在小规模 controlled tier 中枚举得到的 Pareto-valid plans。

对 open tier，采用双人独立标注、第三人裁决，并记录分歧而非强制抹平。标注者需要看到 production graph、base render、edit request 和 candidate counterfactuals。

### 8.5 Counterfactual necessity test

对候选节点 \(v\)，将其锁定后执行其余计划：

1. 若在统一预算和多 seed 下均无法满足目标约束，则 \(v\) 为 required；
2. 若存在有效计划修改 \(v\)，也存在有效计划保持 \(v\)，则为 optional；
3. 若修改 \(v\) 不增加目标满足且导致可感知漂移，则为 protected；
4. 若结果不稳定，标注 uncertainty 而不是强制二值化。

这个过程比“专家凭感觉圈受影响镜头”更适合顶会审稿。

---

## 9. 必须加入的 baseline

### 9.1 Planning baselines

1. **Target-only**：只执行用户点名节点；
2. **Full regeneration**：重执行完整项目或完整场景；
3. **Fixed temporal window**：目标镜头前后固定 \(k\) 个镜头；
4. **Naive downstream closure**：沿全部显式边传播；
5. **Typed rule closure**：按 edit type 使用手工传播规则；
6. **CoAgent-style verifier repair**：只对 verifier 标记失败的镜头重试；
7. **Edit-As-Act-style goal regression**：使用显式动作前提/效果生成最小 action plan；
8. **ContextMaster-style broad multi-shot edit**：对包含目标的整个 multi-shot source 执行一致编辑；
9. **LLM-only impact selection**：给定 serialized graph 直接选节点；
10. **Learned graph predictor**：不使用 cost-aware optimizer；
11. **Oracle/Pareto lower bound**：controlled tier 的有效最小计划。

### 9.2 Execution controls

- 相同编辑/生成后端；
- 相同候选数与 verifier 调用数；
- 相同随机 seed pool；
- matched-cost 和 matched-quality 两种预算；
- 缓存命中、模型加载和失败重试计入真实成本；
- 单独报告 graph inference 成本和 rendering 成本。

---

## 10. 必须新增的评价指标

### 10.1 Impact sufficiency

- Required-node recall；
- required edge/path recall；
- constraint success after execution；
- under-repair rate。

### 10.2 Locality and preservation

- Protected-node violation rate；
- optional over-selection rate；
- artifact replacement ratio；
- untouched-shot perceptual drift；
- identity/composition/camera/timing preservation。

### 10.3 Plan efficiency

- GPU seconds、wall-clock、API cost；
- generated frames/tokens；
- number of jobs and retries；
- cost over Pareto oracle；
- quality under fixed cost；
- cost under fixed quality。

### 10.4 Boundary quality

- entry/exit identity consistency；
- prop/world-state continuity；
- pose/motion continuity；
- camera and cut compatibility；
- human pairwise preference on boundary-only clips。

### 10.5 Calibration

- impact probability ECE/Brier score；
- risk–coverage curve；
- selective abstention：当 planner 不确定时扩大范围或请求用户解除保护。

---

## 11. 建议的论文实验主线

### Experiment A：图级因果正确性

在 controlled tier 上比较所有 planning baselines，不运行昂贵视频模型。回答：是否能找到 required nodes，同时避免 protected nodes？

### Experiment B：随机后端下的计划充分性

在固定视频后端上执行计划，回答：图级高 F1 是否真正转化为 edit success、continuity 和 preservation？

### Experiment C：成本—质量 Pareto front

比较 target-only、CoAgent-style、ContextMaster-style broad edit、full regeneration 与 CineDelta。主图不是单一 SOTA 表，而是 cost–quality–drift Pareto 曲线。

### Experiment D：未知编辑与未知生产图

按 story/asset/model backend/edit type 分组留出，测试 semantic dependency predictor 是否跨项目泛化。

### Experiment E：边界条件消融

移除 3D state、邻镜 anchor、identity memory、motion boundary、camera constraint 和 protected locks，定位视觉收益来源。

### Experiment F：多轮 revision

执行 3–5 轮编辑，测试 stale provenance、记忆污染、误差累积和计划膨胀。单轮有效不能说明真实制作可用。

---

## 12. 投稿定位建议

### CVPR / ICCV

适合条件：任务和 benchmark 是主贡献；有充分视频结果；method 包含可泛化的 impact predictor；与 CoAgent、ContextMaster、Edit-As-Act、UniVBench 有强实验比较。

### SIGGRAPH / SIGGRAPH Asia

适合条件：3D/4D 世界状态、可编辑制作图、边界重渲染和艺术家工作流更强；有真实创作者 user study 与复杂 production demo。

### ACM Multimedia

适合条件：系统与多模态管线完成度高，但方法/benchmark 新颖性未达到 CVPR 标准。

### 当前判断

以现有 Director 代码基础，最现实的顶会路线是：

1. 先把 CineDelta-Eval controlled tier 和强 baseline 做扎实；
2. 如果 impact predictor 明显优于 typed closure 和 goal regression，主投 CVPR/ICCV；
3. 如果算法提升一般，但 3D 制作、可视化溯源和创作者交互很强，转 SIGGRAPH Asia；
4. 若只得到系统集成和少量案例，不应直接以顶会主会为目标。

---

## 13. Go / no-go 标准

进入大规模视频实验前，必须在至少 100 个 controlled edit episodes 上同时达到：

- required-node recall 显著高于 typed closure 或在相同 recall 下显著降低 cost；
- protected violation 低于 target-only 以外所有范围型 baseline；
- 相比 full regeneration 至少节省 50% 实测执行成本；
- 相比 target-only 显著提升约束成功和边界连续性；
- Edit-As-Act-style baseline 不能解释全部收益；
- 对至少一个 held-out edit type 保持有效。

如果 learned planner 不优于 hand-coded typed closure，应把论文转为 benchmark paper，弱化方法 claim；如果连 benchmark 标注一致性都不足，则停止扩大视频生成成本，先重做任务定义。

---

## 14. 同期工作监控清单

投稿前每两周更新一次以下检索：

- `retroactive multi-shot video editing`；
- `long-form video revision`；
- `production graph video generation`；
- `selective regeneration video agent`；
- `edit propagation cross-shot`；
- `artifact provenance generative video`；
- `minimal re-rendering generative workflow`；
- `interactive multi-shot editing`。

重点跟踪 ContextMaster、PermaVid、CausalCine、CoAgent、StoryBlender 和 VideoAgent 的后续版本、代码与 benchmark release。任何一篇新增“retroactive repair”或“impact-set annotation”都会直接改变 CineDelta 的 claim。

---

## 15. 最终研究判断

CineDelta 不是一个“在现有一次性生产管线上加编辑按钮”的题目。经过文献压力测试后，它只有在以下形式下才值得投入顶会级资源：

> **把生成式电影修订定义成一个可测量的 counterfactual impact localization 问题，并证明在不确定语义依赖和随机生成执行下，系统能找到足够但不过度的重执行计划。**

如果做成，贡献会横跨生成式视频、3D 制作、agent planning 与 systems provenance；如果只实现类型规则、缓存和局部 rerender，则更像一个优秀产品功能，而不是顶会论文。
