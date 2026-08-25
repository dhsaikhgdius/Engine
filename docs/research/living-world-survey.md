# Living World — Research Survey

Dynamic/4D world generation, real-time ambient-world techniques, and the open-source /
asset landscape, surveyed for Director's **Living World** initiative.

- **Date**: 2026-08-13. All arXiv IDs were verified by fetching their abstract pages; all
  npm versions/dates via `npm view`; all GitHub licenses/activity via the GitHub API on
  this date. Anything not verified first-hand is explicitly marked **unverified**.
- **Scope**: informs the three Living World tiers — **System tier** (seeded fixed-timestep
  evolution at `DIRECTOR_WORLD_SIMULATION_HZ = 30`: wind, weather, time-of-day, later fire
  propagation and ecosystems), **View tier** (per-frame stateless GPU: analytic particles,
  Gerstner/flow water, sky dome, instanced wildlife with checkpointed replay), and
  **Authoring tier** (`packages/protocol/src/worldSystemsProtocol.ts` zod schemas, agent
  actions, audit loops).
- **Hard constraints applied to every verdict**: WebGL2 today (WebGPU/TSL is a future
  track), three `^0.184` / R3F `^8.17` / drei `^9.122` / zod `4.4.3` (from the repo's
  `package.json`), every visual a pure function of `(seed, frame)`, no wall-clock
  randomness, ~800 KiB main-chunk budget.

---

## 1. 中文执行摘要

本调研为 Living World 各层给出可执行结论。

**立即采用（P0/P1）**：视图层坚持“`hash(seed, particleIndex)` + `uTime` 的无状态解析粒子”路线——与 Unity VFX Graph 固定随机（Constant + Seed）同构，是唯一天然支持任意帧随机访问、零重模拟成本的方案；WebGL2 上的有状态 compute/transform-feedback 粒子（three.js GPGPU birds 属此类）与洗时间轴冲突，放弃。水面沿用 Gerstner（GPU Gems 第 1 章，3–6 个波、总陡度 ≤1、深水色散 c=√(gλ/2π)），泡沫用陡度阈值＋岸线深度差；天空保持 three.js/drei 的 Preetham 模型，P1 叠加 suncalc（BSD-2、活跃）驱动的太阳方位与色温曲线；野生动物用 Reynolds boids＋空间哈希网格、30 Hz 固定步进＋环形检查点回放（RTS lockstep“1500 Archers”先例）。P1 动物资产首选 Quaternius CC0 动物包与鱼包（已核验 CC0 与 glTF 动画）；≤8 只近景用蒙皮克隆＋`mixer.setTime`，群体走 Blender 烘焙 VAT（顶点动画纹理）实例化——完全无状态、单 draw call。

**稍后（P2/P3）**：火焰传播采用 Far Cry 2 网格法（燃点/生命值/风向点积）＋ Rothermel 风·坡系数 ＋ BotW“元素改变材料状态”规则的最小确定性元胞自动机；湿度/积雪按 Lagarde 湿润 BRDF（反照率↓、光滑度↑、孔隙度感知）与 Far Cry 6 天气状态机过渡；FFT 海洋（Tessendorf）、体积云（Nubis 路线）、Bruneton 预计算大气（takram 库，要求 R3F 9/WebGPU）归入 P3。

**不做**：Genie 3 / RTFM / Marble / Hunyuan / Cosmos 等神经世界模型不进渲染路径（非确定、无可导出场景图或成本过高），仅作竞品认知与语义标注灵感；three-nebula、enable3d（LGPL）、wawa-vfx（peer 不兼容）跳过；three.quarks 仅作 authoring 预设参考。跨 GPU 位级精确不可承诺——采用“视觉容差决定论”（金帧＋SSIM 阈值）验收，权威模拟态保留在 CPU/JS 侧。

---

## 2. Dynamic/4D world generation research (2024–2026)

None of these systems enters Director's render path. Their value is architectural: they
validate Director's "program + engine in the loop, agent-audited" approach and provide
ideas for the authoring tier and for worldclaw semantic binding.

### 2.1 GS-Agent — [arXiv 2607.21522](https://arxiv.org/abs/2607.21522) (verified)

**What it does.** *"GS-Agent: Creating 4D Physical Worlds With Generative Simulation"*
(UMass Amherst + Genesis AI). An end-to-end multi-agent framework — Manager, Entity, and
Render agents — that puts the [Genesis](https://github.com/Genesis-Embodied-AI/Genesis)
physics engine in the loop to build 4D worlds from natural language. The Entity agent
retrieves assets (BlenderKit/PolyHaven semantic index), falls back to Meshy text-to-3D,
places objects under non-interpenetration constraints, and tunes continuum material
parameters (Young's modulus, yield stress) against real solver feedback (MPM for
deformables, SPH for fluids). The Render agent expresses camera trajectories and lighting
*as code* synchronized to simulation timesteps. Because ground-truth state is available,
they introduce State-PIS (physical-invariance measured on exact center-of-mass
kinematics), beating Sora-2/Wan2.2 and SWE-Agent baselines on physical plausibility.

**Relevance to Director.** Strong validation of the Authoring tier's shape: specialized
agents + typed tool interfaces + engine feedback loops is exactly
`set_world_settings`/`add_world_effect` + audit loops. Two portable ideas: (1) express
camera/lighting moves as re-parameterizable code over sim time rather than baked frames —
Director's timeline already does this; keep world effects equally programmatic. (2)
State-space metrics: Director's audit loop can assert on System-tier state (weather state,
burnt-cell count) rather than only on rendered pixels. The physics stack itself
(MPM/SPH, minutes per shot) is not real-time and stays out of scope.

### 2.2 SimWorlds — [arXiv 2607.01766](https://arxiv.org/abs/2607.01766) (verified)

**What it does.** *"SimWorlds: A Multi-Agent System for Dynamic 3D Scene Creation"* (CMU /
Harvard / UC Merced). Planner–coder–reviewer agents build dynamic Blender scenes from
text through a fixed ordered sequence of typed stages, each closed by a **deterministic
verifier** that checks a layered scene protocol against the *live engine state* —
modifier stacks, physics caches, f-curves, motion deltas — not just rendered previews.
Their key insight: in dynamic scenes, identical pixels can hide wrong mechanisms (cloth
solver vs keyframed mesh), so "mechanism correctness" must be audited at engine level.
Ships 4DBuildBench (50 scenes across cloth/fluid/rigid/particle/soft-body solvers).

**Relevance to Director.** The closest published analogue to Director's contract
philosophy. Direct adoptions for the Authoring tier: (a) a **deterministic protocol
verifier** that inspects Living World state (does the `fire` effect actually have an
emitter bound to a flammable-tagged object? is `weather.wetness` actually evolving?)
rather than VLM-only screenshot review; (b) typed stage decomposition for complex agent
edits (settings → effects → water → wildlife), with localized retries. Also relevant to
the Blender bridge: SimWorlds' engine-state tool suite (read modifier stacks/caches) is a
good template for Director's Blender-side audit tools.

### 2.3 Code2Worlds — [arXiv 2602.11757](https://arxiv.org/abs/2602.11757) (verified)

**What it does.** *"Code2Worlds: Empowering Coding LLMs for 4D World Generation"* (Peking
University; [code](https://github.com/AIGeeksGroup/Code2Worlds)). Formulates 4D
generation as language-to-simulation-code generation with a dual-stream architecture:
a retrieval-augmented **object stream** (local structural fidelity) decoupled from a
hierarchical **scene stream** (terrain, atmosphere, lighting orchestration), then a
PostProcess Agent scripts dynamics and a VLM-Motion Critic closes the loop on rendered
rollouts to kill "physical hallucinations". Their showcase is exactly Director territory:
a forest time-lapse with coherent sunrise → noon → sunset atmospheric evolution. Reports
+41% scene-graph score and +49% richness over static code-to-scene baselines on their
Code4D benchmark.

**Relevance to Director.** The dual-stream split mirrors Director's separation of
worldgen/worldclaw (static world program) from the Living World layer (dynamics program),
and argues for keeping them as separately-audited programs rather than one monolithic
generation. The day-cycle-as-code example maps 1:1 onto
`directorWorldTimeOfDaySchema` (`mode: "cycle"`, `cycleMinutes`, `drivesSky`) — evidence
that a small parametric schema, not free-form code, is enough for atmospheric arcs. Their
VLM-Motion Critic supports adding a *motion-aware* audit pass (sample 3–5 frames across
`worldSeconds`, not a single still) to Director's audit loop.

### 2.4 WildFireGS — [arXiv 2608.11100](https://arxiv.org/abs/2608.11100) (verified)

**What it does.** *"WildFireGS: Physics-Based Wildfire Simulation in Large-Scale
Semantics-Enriched Gaussian Splatting Forest Scenes"* (TU Delft, Kiel, AMU Poznań,
KAUST). Augments 3DGS forest reconstructions with per-Gaussian semantic vegetation
classes, material properties, and fuel characteristics, then runs a Lagrangian
particle-based combustion model natively on the Gaussians: ignition, radiative +
convective heat transfer, temperature-dependent pyrolysis, and mass loss — no mesh or
voxel conversion. Rain particles act as modular energy sinks (extinguishment). Validated
against characteristic wildfire dynamics: spread scales with vegetation density, wind
speed, and terrain slope; includes firebreak and biomass-loss experiments.

**Relevance to Director.** The blueprint for the P2 fire-propagation system and the P3
worldclaw binding. Key transferable structure: **fuel is a per-primitive semantic
attribute**, not a per-system hardcode — Director should carry `flammable` +
fuel-class tags on objects (and later auto-derive them from worldclaw's semantic
scattering maps, which already classify vegetation). Their state variables per burning
element (temperature, remaining mass, burning/burnt flags) and rain-as-energy-sink
coupling map directly onto a deterministic grid/graph CA driven by
`directorWorldWeatherSchema.wetness` and the wind field. The full heat-transfer ODEs are
overkill for previz; §4.6 below reduces this to a minimal deterministic model.

### 2.5 Interactive world models (the neural-simulation frontier)

- **DeepMind Genie line** — [Genie 3](https://deepmind.google/blog/genie-3-a-new-frontier-for-world-models/)
  (Aug 2025; [model page](https://deepmind.google/models/genie/)): first real-time
  general-purpose world model; text → explorable environment at 720p / 20–24 fps,
  consistency for a few minutes, ~1 minute of visual memory, "promptable world events"
  (inject weather/objects by prompt). Auto-regressive frame-by-frame generation, no
  explicit 3D. Limited research preview; a Project Genie prototype reportedly reached
  Google Labs users by Jan 2026 (secondary sources; **unverified**). The 11B-parameter
  figure circulating in press is third-party (**unverified**).
- **World Labs** — [RTFM](https://www.worldlabs.ai/blog/rtfm) (Oct 2025): autoregressive
  diffusion transformer generating frames in real time on a single H100, persistent but
  implicit 3D. [Marble](https://techcrunch.com/2025/11/12/fei-fei-lis-world-labs-speeds-up-the-world-model-race-with-marble-its-first-commercial-product/)
  (Nov 2025, commercial): multimodal prompts → persistent, downloadable 3D worlds —
  crucially **exports Gaussian splats, meshes, and collision meshes** (see their
  [world-model taxonomy](https://www.worldlabs.ai/blog/taxonomy-of-world-models):
  renderer vs simulator vs planner).
- **Tencent Hunyuan** — [HunyuanWorld-1.0](https://github.com/Tencent-Hunyuan/HunyuanWorld-1.0)
  (Jul 2025): panoramic world proxies → semantically layered 3D **mesh export**,
  disentangled object representations; 1.1 "WorldMirror" (Oct 2025, video/multi-view →
  3D), 1.5 "WorldPlay" (Dec 2025, real-time play), HY-World 2.0 (Apr 2026, per the 1.0
  README news log). Separately,
  [Hunyuan-GameCraft-1.0](https://github.com/Tencent-Hunyuan/Hunyuan-GameCraft-1.0)
  ([arXiv 2506.17201](https://arxiv.org/abs/2506.17201)): action-controllable game video
  (keyboard/mouse unified into camera-space conditioning, trained on 1M+ AAA gameplay
  recordings), and Hunyuan-GameCraft-2
  ([arXiv 2511.23429](https://arxiv.org/abs/2511.23429)): instruction-driven interaction
  ("open the door", "trigger an explosion") on a 14B MoE image-to-video base.
- **NVIDIA Cosmos** — [github.com/NVIDIA/Cosmos](https://github.com/NVIDIA/Cosmos):
  world-foundation-model platform for Physical AI. Cosmos 3 (2026,
  [technical report](https://research.nvidia.com/labs/cosmos-lab/cosmos3/technical-report.pdf)):
  omnimodal Mixture-of-Transformers (AR reasoning + diffusion generation) across
  text/image/video/audio/action; Nano 16B (workstation) and Super 64B; released under the
  Linux Foundation OpenMDW-1.1 license.
- Also in this space: Decart's Oasis and Odyssey's interactive video demos (named in the
  Marble coverage above; not separately verified here).

**Relevance to Director.** These are **competitive context, not components**. They fail
Director's core contract three ways: outputs are not deterministic functions of
`(seed, frame)`; frame models have no scene graph to bind agent actions or Blender edits
to; and inference cost (H100-class) is incompatible with a browser previz tool. Two
watch-items: (1) Marble/HunyuanWorld both export meshes/splats — as *static world
sources* they slot into the same position as worldgen/worldclaw output, and the Living
World layer is precisely Director's differentiator on top of such imports; (2) Genie 3's
"promptable world events" is convergent evidence that event-level world control
(`add_world_effect`, weather presets) is the right agent-facing granularity.

### 2.6 4D scene generation (neural representations)

The field is mapped by *"Advances in 4D Generation: A Survey"*
([arXiv 2503.14501](https://arxiv.org/abs/2503.14501)): text/image/video/3D-conditioned
pipelines over dynamic NeRFs and 4D Gaussian Splatting, from MAV3D
([arXiv 2301.11280](https://arxiv.org/abs/2301.11280), first text-to-4D via video-SDS)
through 4DGS + diffusion hybrids. Persistent open challenges the survey names —
consistency, controllability, efficiency — are exactly the properties Director gets for
free from a parametric, seeded, program-defined world. **Relevance**: reference-only.
Directorial control + determinism + editability argue for staying programmatic; revisit
only if a shot needs a bespoke captured dynamic element (e.g., a 4DGS explosion plate as
a background card, P3+).

### 2.7 Text-to-simulation and neural surrogates for real-time fluids/weather

- [Hybrid Neural-MPM (arXiv 2505.18926)](https://arxiv.org/abs/2505.18926): neural physics
  with an MPM fallback safeguard for real-time interactive fluids; diffusion-based
  controller for sketch-driven fluid control.
- [NIRFS — Neural Implicit Reduced Fluid Simulation (SIGGRAPH Asia 2024)](https://dl.acm.org/doi/10.1145/3680528.3687628):
  neural-SDF latent spaces + neural ODE dynamics; 10⁴× speedups for *scenario-specific*
  fluids (droplet collisions, splashes, slosh).
- [P3D (ICLR 2026)](https://akanota.github.io/p3d/): CNN-Transformer surrogates for 3D
  physics; 30+ fps at 256³ on an RTX Pro 6000 — impressive but datacenter-GPU class.
- [RNN cumuliform dynamics (Mathematics 13(17):2746, 2025)](https://www.mdpi.com/2227-7390/13/17/2746):
  LSTM/GRU surrogates for real-time cumulus evolution on entry-level GPUs.

**Relevance to Director.** Not now. Every surrogate above is (a) scenario-specific, (b)
weight-heavy against an 800 KiB budget, and (c) non-deterministic across GPUs unless the
inference stack is bit-controlled. The P2 weather evolution needs a state machine over
five presets, not a learned fluid; planetary-scale neural forecasting (GraphCast/GenCast
class) is a different problem entirely. Re-evaluate small learned surrogates only at P3
if WebGPU compute makes a 2D cloud-density field attractive — and even then a seeded
procedural noise field will likely win on determinism per byte.

---

## 3. Real-time technique canon per subsystem

Each subsystem: canonical algorithm(s) → parameters → WebGL2 vs WebGPU feasibility →
recommendation for Director.

### 3.1 GPU particles

- **Stateless analytic vs stateful compute.** Stateful systems integrate velocity each
  frame (compute shaders, or transform feedback on WebGL2 — Babylon's
  [GPUParticleSystem](https://doc.babylonjs.com/features/featuresDeepDive/particles/particle_system/particle_system_intro)
  and three.js's [GPGPU birds](https://threejs.org/examples/webgl_gpgpu_birds.html) are
  existence proofs). They cannot be randomly accessed in time: frame N requires N steps.
  Stateless systems evaluate a closed-form trajectory
  `p(i, t) = spawn(hash(seed, i)) + v₀·τ + ½g·τ² + drift(τ)` with
  `τ = mod(t + phase(i), life(i))` entirely in the vertex shader — O(1) scrub, zero
  GPU→CPU state, bit-repeatable given the same shader. Precedent: Unity VFX Graph's
  [Random Number operator](https://docs.unity3d.com/Packages/com.unity.visualeffectgraph@10.2/manual/Operator-RandomNumber.html)
  in Constant mode ("the Operator generates the same number every time based on the
  Seed... Running the same effect with the same seed allows for deterministic behavior"),
  which is exactly the `hash(seed, particleIndex)` pattern; Houdini's time-driven
  ($T-as-input) evaluation idiom is the same idea in DCC form (general practice;
  no single canonical doc page — **unverified as a citation**).
  **Director: keep stateless analytic as the P0 law.** It is the only approach that
  satisfies pure-function-of-`(seed, frame)` without re-simulation.
- **Curl noise** — Bridson et al.,
  [*Curl-Noise for Procedural Fluid Flow*, SIGGRAPH 2007](https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph2007-curlnoise.pdf).
  Divergence-free velocity from the curl of a noise potential: incompressible-looking
  swirl without simulation. True curl *advection* requires integration (stateful); the
  stateless compromise is to displace the analytic path by a curl-flavored sum of
  2–3 octaves of periodic noise: frequency 0.05–0.3 m⁻¹, amplitude 0.1–0.5 m for smoke
  and dust, advection speed 0.2–1.5 m/s, octave lacunarity 2, gain 0.5. Fully WebGL2
  (pure ALU in the vertex shader).
  **Director: adopt the stateless curl-flavored displacement for `smoke`/`steam`/`dust`;
  wire its advection vector to the wind field × per-effect `windInfluence`.**
- **Flipbook / texture-sheet animation.** 4×4 or 8×8 atlases; frame index
  `floor(fract(τ/life) · N²)`; optional cross-fade between consecutive frames (two
  samples + mix) to hide stepping; motion-vector-warped blending is the AAA refinement
  (skippable at previz quality). Deterministic by construction (pure function of τ).
  WebGL2-trivial. **Director: adopt for fire and smoke sprites; author one 4×4 fire and
  one 8×8 smoke atlas; per-particle random start frame from `hash(seed, i)`.**
- **Soft particles.** Fade sprite alpha by `saturate((sceneDepth − fragDepth) / fadeDist)`
  with `fadeDist` 0.25–1 m; requires a scene depth texture — core in WebGL2
  (`DEPTH_COMPONENT24` render targets). Cost: one extra depth prepass or reuse of the
  existing pipeline depth. **Director: P1 polish; adopt when the depth texture is already
  bound for other passes (heat distortion, water depth fade) so it comes almost free.**

### 3.2 Fire/smoke look

- **Sprite ramps (recommended P0/P1).** Additive-blended flipbook fire modulated by an
  emissive color ramp; physically-anchored ramps follow the blackbody locus
  (~1000 K deep red → 1500 K orange → 2000 K yellow-white core) but artist-driven ramps
  (the `colorTint` field) are standard practice; smoke is alpha-blended, darker, slower,
  and larger (size growth 1.5–3× over life). Canonical treatment: GPU Gems ch. 6,
  [*Fire in the "Vulcan" Demo*](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-6-fire-vulcan-demo)
  (flipbook + ramp compositing).
- **Raymarched volumes.** 3D textures are core WebGL2, so a 32³–64³ noise-driven
  raymarch (32–48 steps) inside an emitter-bounds box *is feasible*, but costs
  ~1–3 ms/emitter at previz resolutions and fights transparency sorting. On
  WebGPU/TSL this moves to compute-composited slabs and becomes attractive.
  **Director: skip on WebGL2 except perhaps one "hero fire" quality toggle; defer real
  volumetrics to P3.**
- **Screen-space heat distortion.** Render distortion sprites (scrolling signed noise as
  a normal/offset map) into a small offscreen buffer; apply as UV displacement over the
  composited frame, strength 0.002–0.01 UV, masked by the soft-particle depth term so
  distant geometry doesn't shimmer through occluders. One fullscreen pass, WebGL2-easy,
  deterministic (noise scrolls by `uTime`). **Director: adopt at P2 alongside wetness
  (both are cheap screen-space passes over `worldSeconds`-driven inputs).**

### 3.3 Water

- **Gerstner waves** — Finch, GPU Gems ch. 1,
  [*Effective Water Simulation from Physical Models*](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models).
  Sum of 3–6 trochoidal waves displacing horizontally + vertically. Parameter canon:
  wavelengths log-spaced ~2–40 m (`waveLengthM` as the median), amplitude ≈ 0.01–0.05·λ
  (protocol clamps `waveAmplitude` ≤ 3 m — keep the ratio, not the cap), per-wave
  steepness Qᵢ with **ΣQᵢ ≤ 1** to avoid loop-over artifacts, deep-water dispersion
  `c = √(gλ/2π)` (do not let speed be a free parameter — dispersion sells scale),
  directions fanned ±30–60° around `flowDirectionDegrees`. Fully analytic in the vertex
  shader ⇒ stateless, scrub-safe, and **CPU-samplable for buoyancy** (evaluate the same
  sum in JS for object bobbing at the System tier — determinism preserved because both
  sides are pure functions of `(seed, worldSeconds)`).
- **Tessendorf FFT spectra** —
  [*Simulating Ocean Water* course notes](https://people.computing.clemson.edu/~jtessen/reports/papers_files/coursenotes2004.pdf).
  Phillips or JONSWAP spectrum → inverse FFT height + displacement fields per frame.
  Statistically rich seas, crest chop via horizontal displacement, foam from the
  Jacobian. **When it becomes worth it**: open-ocean framing where the water occupies a
  large screen fraction, camera near the surface, or shots > ~100 m of visible sea —
  i.e., not Director's current lake/pond/river `waterBodies` (max 5 km sizes but previz
  usage is local). Cost: a 256²–512² complex FFT per frame; WebGL2 implementations exist
  and prove feasibility — [dli/waves](https://github.com/dli/waves) (MIT, 2018, dormant)
  and [jbouny/fft-ocean](https://github.com/jbouny/fft-ocean) (MIT, 2015, dormant,
  three.js) — but both target ancient three versions. Determinism caveat: FFT is still a
  pure function of `(seed, t)` if the spectrum phases come from `hash(seed, k)` and time
  enters analytically (Tessendorf's `h(k,t)` formulation is exactly that), so FFT ocean
  *can* stay scrub-safe. **Director: P3, WebGPU-first (compute FFT), Gerstner until then.**
- **Flow maps** — Vlachos,
  [*Water Flow in Portal 2* (SIGGRAPH 2010)](https://media.steampowered.com/apps/valve/2010/siggraph2010_vlachos_waterflow.pdf).
  A texture of 2D flow vectors distorts normal-map UVs; two staggered samples with a
  0.5-offset phase cycle hide the reset. Flow strength 0.05–0.3 UV/s. For Director's
  rectangular water bodies, a *procedural* flow field (constant `flowDirectionDegrees` +
  seeded noise curl around obstacles later) replaces the authored texture at P0/P1;
  authored flow maps become interesting when worldclaw provides river masks (P3).
- **Foam strategies.** (1) Shore/intersection foam: fade by depth difference between
  water plane and scene depth (needs depth texture; same one as soft particles);
  (2) crest foam: Gerstner steepness proxy `1 − N·up` thresholded ~0.15–0.3, or FFT
  Jacobian < 0 when that lands; (3) advect a tileable foam texture along the flow to
  break static look; `foamIntensity` scales all three. All stateless.
- **Buoyancy coupling.** Sample the same analytic height sum CPU-side; apply as a pure
  per-frame pose offset for floating props (View-tier, stateless) — do **not** integrate
  velocities (that would create hidden state). Good enough for previz boats/debris.

### 3.4 Sky / atmosphere

- **Preetham (1999)** — analytic daylight model; **this is what three.js/drei `<Sky>`
  implements** (verified in the
  [three.js `Sky.js` source](https://github.com/mrdoob/three.js/blob/master/examples/jsm/objects/Sky.js),
  which cites "A Practical Analytic Model for Daylight, aka the Preetham model" and is
  explicitly WebGL-only — WebGPU users are pointed at `SkyMesh`). Parameters: turbidity
  2 (clear) – 10 (hazy), rayleigh ~1–4, mieCoefficient ~0.005, mieDirectionalG ~0.8.
  Note: the current three Sky shader also carries a cheap FBM cloud layer
  (`cloudCoverage`/`cloudSpeed`/`time` uniforms) — driven by a `time` uniform Director
  must feed `worldSeconds`, never wall-clock, to keep exports pure.
- **Hosek–Wilkie (2012)** —
  [project page](https://cgg.mff.cuni.cz/projects/SkylightModelling/): higher-accuracy
  analytic skylight (better horizon/low-sun behavior, ground albedo term). GLSL ports
  exist; a drop-in fragment-shader upgrade over Preetham with the same uniform surface.
  **Upgrade path P2**: worthwhile exactly when the time-of-day cycle makes sunsets a
  first-class shot type.
- **Bruneton (2008) precomputed scattering** —
  [reference implementation](https://github.com/ebruneton/precomputed_atmospheric_scattering):
  LUT-based multiple scattering + aerial perspective; the quality ceiling for real-time
  skies. In the three ecosystem this is
  [`@takram/three-atmosphere`](https://www.npmjs.com/package/@takram/three-atmosphere)
  (verified: "implementation of Eric Bruneton's Precomputed Atmospheric Scattering",
  with WebGPU/TSL docs) — but its peers are R3F ≥ 9 / three ≥ 0.170 / postprocessing,
  so it lands with the P3 migration, not before.
- **Volumetric clouds** — Schneider's Nubis line: the 2015
  *Real-Time Volumetric Cloudscapes of Horizon Zero Dawn* (2.5D raymarched slab from 2D
  instruction textures, < 2 ms on PS4), the 2017 authoring follow-up, GDC 2022
  superstorms, and [Nubis³ (SIGGRAPH 2023 Advances course)](https://advances.realtimerendering.com/s2023/Nubis%20Cubed%20(Advances%202023).pdf)
  which moves to voxel clouds with compressed-SDF march acceleration
  ([Guerrilla abstract](https://www.guerrilla-games.com/read/nubis-cubed)).
  **WebGL2-realistic subset**: (a) drei's `<Cloud>` — verified to be instanced
  billboarded sprite puffs (`cloud.png` + `MeshLambertMaterial`), fine for previz
  blocking; (b) a single 2D raymarched slab (8–16 steps against an FBM coverage
  function) on the sky dome for overcast/storm looks; (c) paraboloid-projected impostor
  domes. Full Nubis-style 3D raymarch is P3/WebGPU
  ([`@takram/three-clouds`](https://www.npmjs.com/package/@takram/three-clouds) already
  exists for that stack).
- **Stars & lightning (deterministic).** Stars: hash-placed points on the dome
  (drei `<Stars>` pattern) — acceptable as-is since placement is seedable; ensure
  twinkle uses `worldSeconds`. Lightning: derive strike events from a seeded Poisson
  process — `strike_k = hash(seed, k)` mapped to inter-arrival times so the k-th strike
  time is a pure function of seed; flash = sky-dome luminance pulse + one directional
  light pulse over 80–250 ms, with a forked line-segment bolt (seeded midpoint
  displacement) only where framed. Storm preset couples strike rate to
  `weather.intensity`.

### 3.5 Weather systems in games

- **The blueprint talk**:
  [*Simulating Tropical Weather in 'Far Cry 6'* (GDC 2022)](https://gdcvault.com/play/1027725/Simulating-Tropical-Weather-in-Far)
  — arbitrary weather-state transitions inside a continuous day-night cycle; wetness on
  static + dynamic objects; terrain puddles; windshield streaks; volumetric clouds/fog;
  interactive rain + lightning particles; wind-driven vegetation and drying-out after
  storms. This is structurally identical to Director's P2 scope (weather evolution +
  wetness + wind coupling) and is the single most useful industry reference.
- **State machines.** Presets (`clear/overcast/rain/snow/storm`) as nodes; transitions
  as timed parameter ramps (cloudCover, precipitation rate, wind gain, fog density,
  exposure trim) — 30–120 s ramps at the System tier's 30 Hz, all driven by seeded
  transition schedules so scrubbing replays identically. Never blend visuals directly;
  blend the *parameter vector* and let every subsystem read parameters.
- **Wetness / snow-cover material response.** Canon: Lagarde's
  [*Water drop 3b — Physically based wet surfaces*](https://seblagarde.wordpress.com/2013/04/14/water-drop-3b-physically-based-wet-surfaces/)
  (albedo darkening + saturation shift and smoothness boost, gated by **porosity**;
  fxguide [summary](https://www.fxguide.com/fxfeatured/game-environments-partc/)),
  and the deferred-pipeline practice in
  [*Assassin's Creed IV: Black Flag* (Wroński, Digital Dragons 2014 slides)](https://bartwronski.com/wp-content/uploads/2014/05/assassin_s-creed-4-digital-dragons-2014-no_notes.pdf):
  wetness stored per-surface, gloss up + albedo down at lighting time, procedural rain
  ripples as a generated normal texture (~0.2–0.6 ms), screen-space reflections as the
  wet-look multiplier. Director translation (forward renderer): a global
  `uWetness` uniform (from `weather.wetness`) into a `three-custom-shader-material`-style
  patch — `albedo *= mix(1.0, 0.55, wetness · porosity)`, `roughness = mix(roughness,
  0.12, wetness · porosity)` + puddle mask from world-space noise in terrain lows.
  Snow cover is the same pattern inverted: blend a snow albedo/roughness layer by
  `saturate(normal.y)` threshold + top-down world mask. (Forza Horizon and other
  per-title wetness talks exist on the GDC Vault but were not individually verified
  here — the two sources above are sufficient canon; **unverified** beyond that.)
- **Precipitation occlusion tricks** (from the AC4 deck above): camera-attached emitter
  volume (3×3 grid of rain "clusters" around the camera so drops never pop), a small
  top-down depth map (~128²) around the camera masking rain indoors/under cover, and
  depth-buffer collision to spawn splash sprites. All portable to Director's stateless
  rain: occlusion map sampled in the vertex shader kills occluded drops by scaling them
  to zero — no state involved.

### 3.6 Fire propagation (P2 System-tier)

- **Rothermel surface fire spread model** — Rothermel, R.C. (1972), *A mathematical
  model for predicting fire spread in wildland fuels*, USDA Forest Service Research
  Paper INT-115 ([PDF](https://www.fs.usda.gov/rm/pubs_int/int_rp115.pdf); the USDA
  server rejects non-browser agents — canonical government report, link **unverified by
  bot fetch**). The operational canon: spread rate `R = R₀ · (1 + φ_wind + φ_slope)`
  where wind and slope factors multiply a fuel/moisture-driven base rate. Directly
  usable as the CA neighbor-transition weight.
- **Cellular automata approaches** — the standard discretization (see the CA lineage
  reviewed in WildFireGS §2, verified above): grid cells with states
  Unburnt → Igniting → Burning → Burnt, local transition rules, probabilistic or
  threshold ignition.
- **Far Cry's shipped design** — Lévesque,
  [*Far Cry: How the Fire Burns and Spreads*](https://jflevesque.com/2012/12/06/far-cry-how-the-fire-burns-and-spreads/)
  (+ [Game Developer interview](https://www.gamedeveloper.com/game-platforms/interview-how-i-far-cry-2-i-s-fire-fuels-spreads)):
  2D grid projected on terrain for grass + 3D grid for objects/trees; "spreading points"
  as fire energy budget; per-cell hit points and burn lifetime; wind bias via dot
  product; wet-vs-dry = raise ignition HP, shorten lifetime; cells disabled underwater
  or under occluders; burning cells emit game events (chain reactions).
- **Breath of the Wild chemistry engine** —
  [GDC 2017, *Change and Constant*](https://gdcvault.com/play/1024562/Change-and-Constant-Breaking-Conventions):
  a "rule-based state calculator" — *elements* (fire, water, ice, electricity, wind)
  change the state of *materials* (solids); elements change each other; materials never
  directly change materials. Three rules produce the whole emergent-chemistry surface.
- **Recommendation — minimal deterministic model for Director P2.** Fixed 30 Hz seeded
  simulation (System tier), checkpointed like wildlife:
  1. **Substrate**: one 2D terrain grid (1–2 m cells, only where grass/vegetation
     exists) + a sparse graph over `flammable`-tagged objects (nodes = objects, edges =
     pairs within ignition radius). This is Far Cry's 2D+3D split with WildFireGS's
     per-object fuel semantics.
  2. **Cell state**: `{fuel, hp, state ∈ U/I/B/X, ignitionTick}` — integers only, so the
     sim is trivially bit-deterministic in JS.
  3. **Transition**: each tick, burning cells deal `damage = base · (1 + k_w·max(0, ŵ·d̂)
     + k_s·slope) · (1 − wetness)` to neighbors (Rothermel-shaped weights, `ŵ` from
     `directorWorldWindSchema`); ignite when hp ≤ 0; burn for `fuel` ticks then → Burnt.
     Rain preset drains burning cells (WildFireGS's energy-sink rain, integerized).
  4. **BotW rule surface**: element×material table so water effects extinguish, sparks
     ignite, wind accelerates — three rules, no special cases.
  5. **View binding**: burning cells spawn *stateless* `fire`/`smoke` view emitters keyed
     by `(cellId, ignitionTick)` — the emitter's look needs no history, only its
     ignition time, so scrubbing works: view state = f(checkpointed grid, worldSeconds).

### 3.7 Wildlife / crowds

- **Boids** — Reynolds (1987), *Flocks, Herds and Schools: A Distributed Behavioral
  Model* ([ACM DOI](https://dl.acm.org/doi/10.1145/37402.37406)); separation/alignment/
  cohesion + steering behaviors (Reynolds' GDC 1999 *Steering Behaviors*; his reference
  site red3d.com/cwr/boids was unreachable at survey time — **link unverified**).
  Parameter canon: perception radius 2–5 m (birds), separation radius ~1/3 of that,
  weights ≈ separation 1.5 / alignment 1.0 / cohesion 0.8, max steering force
  2–4 m/s², max speed from species `speedScale`.
- **Neighbor acceleration.** Uniform spatial hash grid with cell size = perception
  radius ⇒ O(n·k). At Director's caps (≤ 256 agents/group, ≤ 16 groups) a flat JS
  grid at 30 Hz is comfortably sub-millisecond; no GPU needed — which is good, because
  GPU flocking (the three.js
  [GPGPU birds example](https://threejs.org/examples/webgl_gpgpu_birds.html)) is
  stateful ping-pong textures and breaks random access.
- **Ambient-AI precedent** — Rockstar's RDR2: ~200 species with habitat/food-chain
  behaviors ([IGN summary of Rockstar's material](https://www.ign.com/articles/2018/09/28/red-dead-redemption-2-hunting-finishing-and-wildlife-detailed));
  the systems deep-dive is
  [*Making the Believable Horses of RDR2* (GDC, AI Summit)](https://www.gdcvault.com/play/1027230/AI-Summit-Making-the-Believable)
  — overlapping gait speed-ranges so locomotion is continuously controllable, which is
  the exact pattern for mapping herd-agent speed → animation clip choice + playback
  rate. Utility-AI scoring (hunger/flee/wander per animal) is the standard extension —
  Director's herd state machine (graze → wander → flee) is a two-need utility AI in
  disguise; keep transitions threshold-based on seeded noise, not RNG-per-frame.
- **Animation-driven vs physics-driven locomotion.** Previz wants kinematic steering:
  agents are points on the terrain (raycast height + slope alignment at P1), animation
  follows velocity (`playbackRate = speed / clipStrideSpeed`, blend walk/run by speed
  band). Physics-driven locomotion (ragdoll/motor) adds nothing at previz fidelity and
  imports nondeterminism.
- **Deterministic replay / checkpoints.** Precedent: lockstep RTS —
  [*1500 Archers on a 28.8* (Age of Empires)](https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond)
  runs identical simulations from identical inputs on every machine; determinism =
  same code + same seed + same tick sequence. Combined with
  [*Fix Your Timestep* (Gaffer On Games)](https://gafferongames.com/post/fix_your_timestep/):
  simulate at exactly 30 Hz, render-interpolate between ticks. For random access,
  keep a ring of full-state checkpoints every 60 ticks (2 s): `seek(t)` = load nearest
  checkpoint ≤ t, re-sim ≤ 60 ticks — worst case ~2 s of sim at sub-ms/tick ≈
  imperceptible. Store agent state as plain arrays (`Float64Array` per field) so
  checkpoints are cheap copies and JS math stays deterministic (IEEE 754 f64 is
  bit-stable across JS engines for +,−,×,÷,√; avoid `Math.sin`-class transcendentals in
  the sim loop or fix them with a polynomial — see §6).

### 3.8 Day/night + lighting mood

- **Solar position.** Full previz accuracy needs only the declination/hour-angle model;
  [`suncalc`](https://github.com/mourner/suncalc) (BSD-2-Clause per GitHub; npm 2.0.1,
  2026-07; the npm manifest's license field is absent — license verified on the repo)
  gives azimuth/elevation from (date, lat, lon) in ~2 KB. Map
  `timeOfDay.hours` + a project latitude preset → sun direction; `drivesSky: true`
  pipes it into the Preetham dome's `sunPosition`.
- **Color-temperature ramps.** Drive a single key-light color ramp by solar elevation:
  ~1850–2500 K below 5° (golden/blue hour), ~3500 K at 10°, 5500–6500 K high sun;
  night = dim 4100 K key tinted toward blue (Purkinje convention, not physics). Keep it
  a 5-stop editable gradient in the protocol rather than a formula — art-directable and
  deterministic.
- **Exposure strategy.** For a film-previz camera, **manual exposure only**: auto-exposure
  is a feedback loop (state!) and breaks pure-function rendering. Use the physical-camera
  EV100 convention from Lagarde & de Rousiers,
  [*Moving Frostbite to PBR* (course notes)](https://seblagarde.files.wordpress.com/2015/07/course_notes_moving_frostbite_to_pbr_v32.pdf):
  expose sky and key light in physical-ish units, store per-shot EV offset on the camera,
  and let the time-of-day system *suggest* (not force) an EV per hour that the DP can
  override per shot.

---

## 4. Related open-source projects (three.js ecosystem first)

All versions/dates/licenses below were verified 2026-08-13 via `npm view` and the GitHub
API. "Compatible" means against Director's pinned three `0.184` / R3F `8.17` / drei `9.122`.

| Project | Version / license | Last activity | Peer requirements | Verdict |
| --- | --- | --- | --- | --- |
| [three.quarks](https://www.npmjs.com/package/three.quarks) | 0.17.1, MIT | npm 2026-05-21; repo 1.0k★ | three ≥ 0.182 ✓ | **Reference-only** |
| [quarks.r3f](https://www.npmjs.com/package/quarks.r3f) | 0.17.1, MIT | npm 2026-05-21 | fiber ≥ 8 ✓, three ≥ 0.182 ✓ | **Reference-only** |
| [three-nebula](https://www.npmjs.com/package/three-nebula) | 12.1.0, MIT | npm 2026-08-09; repo pushed 2026-08-13, 1.2k★ | three ≥ 0.122 < 1 ✓ | **Skip** |
| [wawa-vfx](https://www.npmjs.com/package/wawa-vfx) | 1.2.10, MIT | npm 2025-09-23 | fiber ^9 ✗, react ^19 ✗, leva+zustand | **Reference-only** |
| [@takram/three-atmosphere](https://www.npmjs.com/package/@takram/three-atmosphere) | 0.19.1, MIT | npm 2026-05-06; repo 1.6k★ | fiber ≥ 9 ✗, three ≥ 0.170, postprocessing | **Adopt at P3** |
| [@takram/three-clouds](https://www.npmjs.com/package/@takram/three-clouds) | 0.7.6, MIT | npm 2026-05-06 | fiber ≥ 9 ✗, postprocessing | **Adopt at P3** |
| [drei](https://www.npmjs.com/package/@react-three/drei) internals (v9 in-repo) | 9.122 pinned, MIT | active | already a dependency | **Adopt/keep** |
| [WebGPU-Ocean](https://github.com/matsuoka-601/WebGPU-Ocean) | MIT | pushed 2025-06, 542★ | WebGPU | **Reference-only (P3)** |
| [jbouny/fft-ocean](https://github.com/jbouny/fft-ocean) | MIT | pushed 2015, 349★ | ancient three | **Reference-only** |
| [dli/waves](https://github.com/dli/waves) | MIT | pushed 2018, 1.1k★ | raw WebGL | **Reference-only** |
| [enable3d](https://www.npmjs.com/package/enable3d) | 0.26.1, **LGPL-3.0** | npm 2025-03-08 | ammo.js stack | **Skip** |
| [@dimforge/rapier3d-deterministic](https://www.npmjs.com/package/@dimforge/rapier3d-deterministic) | MIT (Rapier) | active | WASM | **Adopt-candidate (P2/P3)** |
| [suncalc](https://www.npmjs.com/package/suncalc) | 2.0.1, BSD-2-Clause (repo) | npm 2026-07-11, 3.4k★ | none | **Adopt (P1)** |
| Babylon.js particle/weather systems | Apache-2.0 | active | different engine | **Reference-only** |

Reasoning against Director's constraints:

- **three.quarks + quarks.r3f** — the strongest maintained three.js VFX engine
  (emission over shapes, texture-sheet animation, behaviors, batched renderer;
  `quarks.r3f` even supports R3F 8, so it *would* install cleanly). Rejected as a core
  dependency for one architectural reason: it is an `update(deltaTime)` stateful
  simulator, so frame N is only reachable by stepping 0→N — timeline scrubbing and
  deterministic frame export would require fixed-step re-simulation from zero on every
  seek, and its internal RNG/emission bookkeeping is not seed-contracted. **Use it as
  the reference for authoring ergonomics** (its JSON effect format is a good shape for
  Director's effect presets) and for batched-renderer tricks; keep Director's own
  stateless evaluator. Budget note: adopting would also add a second particle code path
  to the main chunk for no visual capability Director lacks.
- **three-nebula** — actively maintained (pushed the day of this survey) and MIT, but
  it is a CPU-integrated particle system with per-frame emitter state, JSON presets
  aside. Same determinism objection as three.quarks with a lower performance ceiling
  (CPU transforms per particle). **Skip.**
- **wawa-vfx** — small, well-taught stateless-ish VFX components from Wawa Sensei, but
  peers hard-require R3F 9 / React 19 / leva / zustand ⇒ incompatible today. Its
  "declare emitter, evaluate in shader" API is close to Director's model and worth a
  read; nothing to install. **Reference-only.**
- **@takram/three-atmosphere / three-clouds** — verified to be a faithful Bruneton
  precomputed-scattering implementation (with WebGPU/TSL documentation) and a serious
  volumetric-cloud system; MIT; actively maintained; the exact quality target for
  Director's sky at P3. Blocked today by R3F 9 + postprocessing peer chain and by main
  -chunk weight (LUT generation + effect passes). **Adopt at the P3 WebGPU/TSL
  migration; until then steal parameter conventions.**
- **drei internals** — already in the tree, zero budget cost: `<Sky>` (Preetham,
  verified), `<Stars>`, `<Cloud>` (instanced billboard puffs, verified in source),
  `<Sparkles>` (shader points — a ready-made fireflies fallback). Keep; ensure every
  time-dependent uniform is fed `worldSeconds`.
- **Ocean repos** — `WebGPU-Ocean` is an SPH/MLS-MPM *interactive fluid* (not ocean
  spectra): the reference for future splash/pour interactions on WebGPU, not for water
  bodies. `jbouny/fft-ocean` and `dli/waves` prove FFT oceans run in WebGL — mine their
  shader structure when P3's FFT ocean lands, vendored and modernized (both dormant,
  do not depend).
- **enable3d** — LGPL-3.0 (license friction for a bundled web app) + ammo.js wall-clock
  physics; Director has no rigid-body need in the Living World scope. **Skip.**
- **Rapier (deterministic build)** — the flagship *deterministic-sim precedent* in the
  JS/WASM world: the `enhanced-determinism` build guarantees bit-identical,
  cross-platform results on IEEE 754-2008 targets
  ([docs](https://rapier.rs/docs/user_guides/rust/determinism/)). Not needed while
  Living World has no rigid bodies, but it is the pre-vetted answer the moment P2/P3
  "player interactions" need physics — and its docs are the best short read on what
  cross-platform float determinism costs (no SIMD, no parallelism).
- **suncalc** — 2 KB, zero deps, BSD-2, active; solves solar position exactly once and
  correctly. **Adopt at P1** for `drivesSky`.
- **Babylon.js** — its
  [particle system](https://doc.babylonjs.com/features/featuresDeepDive/particles/particle_system/particle_system_intro)
  (CPU + GPU variants, node editor) and Sky/fog materials are the most complete
  documented engine-adjacent reference for API surface design; GPU variant uses
  transform feedback on WebGL2 — an existence proof Director deliberately declines
  (statefulness), which is worth recording as a decision.

Deterministic-sim JS libs beyond Rapier: nothing mature surfaced that targets seeded
scene simulation specifically (fixed-point math libs and lockstep netcode kits exist but
are game-server oriented); Director's integer-state CA + typed-array agent sim (§3.6,
§3.7) needs no dependency.

---

## 5. Asset pipeline notes (animated wildlife)

### 5.1 Sources (all CC0 verified except where marked)

- **Quaternius** — [quaternius.com](https://quaternius.com/), all packs explicitly
  "Free to use in personal, educational and commercial projects. (CC0 License)"
  (verified on pack pages). Key packs:
  [Ultimate Animated Animal Pack](https://quaternius.com/packs/ultimateanimatedanimals.html)
  (verified URL) — the P1 workhorse for `deer/rabbits/wolves/sheep` and birds;
  [Animated Fish Pack](https://quaternius.com/packs/animatedfish.html) (verified URL)
  for `fish` schools; also Farm Animal Pack, Animated Cute Fish Pack, and the
  [Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html)
  (120+ humanoid clips on a retarget-ready rig — for Director's *human* characters, not
  wildlife). Formats: `.gltf`/`.fbx`/`.obj` + `.blend` sources.
- **Kenney** — [kenney.nl/assets](https://kenney.nl/assets), CC0 across the catalog;
  strong on props/environments, weak on rigged animals. Secondary source.
- **KayKit** — [github.com/KayKit-Game-Assets](https://github.com/KayKit-Game-Assets)
  (repos carry per-pack license files; GitHub reports custom/"NOASSERTION" SPDX — the
  store pages advertise CC0, but **spot-check the LICENSE file in each pack before
  shipping**; claim partially **unverified**). Dungeon/character/city kits; no animal
  pack — relevant for props, not wildlife.
- **poly.pizza** — mirror/search over CC0/CC-BY low-poly models incl. the Quaternius
  catalog. The site rejects non-browser fetches (Cloudflare), so per-model license
  badges could not be machine-verified here (**unverified**); prefer downloading from
  quaternius.com directly, where CC0 is stated by the author.

### 5.2 glTF animation-clip conventions

Quaternius animal packs ship one armature per animal with multiple named
`AnimationClip`s on a shared timeline (typical names: `Idle`, `Walk`, `Run`, `Attack`,
`Death`, plus species-specific like `Fly`/`Swim`/`Peck`; naming varies per pack —
**verify clip inventory on import**, do not hardcode). Practical import contract for
Director: on asset registration, enumerate `gltf.animations`, classify clips into the
locomotion set {idle, move-slow, move-fast, special} by name heuristics + agent review,
and record each clip's authored stride speed (measured once: root displacement per loop
÷ loop duration) so playback rate can be synced to steering speed (§3.7).

### 5.3 Mapping onto Director's rigged-character machinery

Two viable paths, phased:

1. **Per-instance skinned clones (P1 default for small counts).** `SkeletonUtils.clone`
   per agent + one `AnimationMixer` each, driven **absolutely**:
   `mixer.setTime(worldSeconds · rate + phase(seed, i))` — `setTime` is a pure function
   of time, so scrubbing and export stay deterministic (never `mixer.update(dt)`
   accumulation). Cost: one skinned draw call per agent; fine for ≤ ~32 visible animals
   (Director's herd sizes), too heavy for 256-bird flocks.
2. **Baked vertex-animation textures (VAT) on `InstancedMesh` (P1 target for flocks/
   schools).** Bake each clip's per-frame vertex positions/normals into textures in
   Blender, render the whole group as one `InstancedMesh` whose vertex shader samples
   `frame = f(worldSeconds, clipLength, phase(seed, i))` — fully stateless, one draw
   call per species, and the sampling is exactly Director's particle idiom applied to
   meshes. Sizing: a 1–2k-vertex low-poly animal × 30–60 frames ≈ 0.5–2 MB RGBA16F
   per clip — an *asset* cost, not main-chunk JS. Baking tools (verified):
   [OpenVAT](https://github.com/sharpen3d/openvat) (Blender add-on, GPL-3.0 — the GPL
   covers the add-on code, not your baked outputs; slots into Director's
   Blender-as-kernel pipeline) and the simpler
   [VAT add-on by flement](https://extensions.blender.org/add-ons/vat/)
   ([repo](https://github.com/flement/VAT-blender-addon), explicitly targets three.js
   playback incl. the Z-up→Y-up `texturePos.xzy` swizzle; **no SPDX license file on the
   repo** — confirm before pipeline adoption).
   Recommendation: **hero animals near camera = skinned clones; groups = VAT**; wire
   both to the same steering output. Mixamo-style retargeting is unnecessary for
   quadrupeds/fish (play clips as authored on their own rigs); reserve retargeting for
   humanoids via the Universal Animation Library on the existing character machinery.

---

## 6. Determinism & reproducibility appendix

- **Hash-based stateless GPU particles — prior art.** Unity VFX Graph's
  [Random Number operator](https://docs.unity3d.com/Packages/com.unity.visualeffectgraph@10.2/manual/Operator-RandomNumber.html)
  with `Constant` + `Seed` (and the component-level global seed) is the shipped-engine
  precedent for "randomness = pure function of (seed, index)"; community guidance for
  custom HLSL there is the same integer-hash-per-particle pattern Director uses.
  Houdini's node graphs idiomatically evaluate as functions of `$T`/`@Time` (render any
  frame in isolation), which is the DCC-side statement of the same contract (idiomatic
  practice; no single canonical doc — **unverified as a citation**). For hash quality
  in GLSL, integer hashes (PCG/Wang family) beat `fract(sin(x)·43758.5)` — which the
  three.js Sky cloud layer itself still uses — see the shader-hash articles at
  [iquilezles.org/articles](https://iquilezles.org/articles/); prefer a PCG2D/PCG3D
  port with an explicit `uint` pipeline (WebGL2 has native ints).
- **Fixed timestep + checkpointed replay.**
  [*Fix Your Timestep*](https://gafferongames.com/post/fix_your_timestep/) (accumulate,
  simulate at fixed Δt, interpolate render) is the base pattern; lockstep RTS
  ([*1500 Archers*](https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond))
  proves entire game sims stay identical from (seed, inputs) alone — Director's world
  has no inputs, only the seed and schema, which is strictly easier. Checkpoint ring
  (§3.7) turns "deterministic replay" into "random access with bounded re-sim".
  Rapier's [determinism docs](https://rapier.rs/docs/user_guides/rust/determinism/)
  document the exact tax for *bit-level cross-platform* replay: strict IEEE 754-2008,
  no SIMD/parallelism, and transcendental functions replaced by controlled
  implementations — the same rules apply to Director's JS sim loop (basic f64 ops are
  IEEE-deterministic across JS engines; `Math.sin/cos/pow` are **not** spec-pinned, so
  the System tier should use polynomial approximations or table lookups where it
  matters).
- **Floating-point cross-GPU caveats.** GPU shader math is not bit-portable:
  NVIDIA's [*Floating Point and IEEE 754 Compliance*](https://docs.nvidia.com/cuda/floating-point/index.html)
  documents FMA contraction and rounding differences even within one vendor's toolchain;
  GLSL ES leaves transcendental precision implementation-defined; drivers fuse/reorder
  differently per vendor. Gaffer's
  [*Floating Point Determinism*](https://gafferongames.com/post/floating_point_determinism/)
  is the survey of why bit-exactness across heterogeneous hardware is effectively a
  no-promise. **Consequence for Director**: define determinism as
  (a) **bit-exact System tier** — CPU/JS integer + f64 state, same checkpoint bytes on
  every machine; and (b) **visual-tolerance View tier** — same GPU+driver ⇒ identical
  frames; across GPUs ⇒ golden-frame comparison with a perceptual threshold (e.g. SSIM ≥
  0.99 / small ΔE budget) in CI, exactly how the deterministic-export guarantee should
  be worded to users. Never let View-tier reads feed back into System-tier state, or (b)
  contaminates (a).

---

## 7. Phase mapping table

| Phase | Item | Key findings applied | Definition of done |
| --- | --- | --- | --- |
| **P0** | Stateless analytic particles (8 `WORLD_EFFECT_KINDS`) | §3.1 hash+uTime law; Unity fixed-random precedent; flipbook ramps §3.2 | Any effect renders frame-identical for fixed `(seed, frame)` across seeks; zero per-frame CPU particle work |
| P0 | Gerstner + flow water | §3.3 GPU Gems ch.1 params; ΣQ ≤ 1; dispersion-locked speed | Water body matches schema params; CPU height probe == GPU height at sample points (buoyancy-ready) |
| P0 | Sky dome + solar arc + stars + lightning | §3.4 Preetham (three `Sky` verified); seeded Poisson strikes | `drivesSky` moves sun/sky/stars from `hours`; lightning strike times replay bit-identically from seed |
| P0 | Wildlife boids/herds + checkpoint replay | §3.7 Reynolds + spatial hash; 30 Hz lockstep; ring checkpoints | `seek(t)` reproduces agent poses bit-identically vs continuous play; ≤ 2 s worst-case re-sim |
| P0 | Agent contract + audit | §2.2 SimWorlds deterministic verifier; §2.1 state metrics | Every `set_world_settings`/`add_world_effect` round-trips zod-valid; audit asserts on System-tier state, not only pixels |
| **P1** | Animal glTF assets | §5 Quaternius CC0 (verified); clip-inventory import contract | 7 protocol species render with real models; clip↔speed sync; placeholder silhouettes gone |
| P1 | VAT instancing for flocks/schools | §5.3 OpenVAT/flement bake; stateless frame sampling | 256-bird flock = 1 draw call; VAT playback deterministic under scrub; hero animals stay skinned |
| P1 | Wind-driven vegetation | §3.5/GoW [GDC 2019 wind talk](https://www.gdcvault.com/play/1026036/Interactive-Wind-and-Vegetation-in) (global + gust terms only, no sim volume) | Vegetation sway reads `wind` schema (direction/speed/gustiness/turbulence) via vertex shader; still frames stable for fixed inputs |
| P1 | Terrain raycast grounding | §3.7 kinematic locomotion | Herd agents sit on terrain (height + slope align) incl. worldgen/worldclaw heightfields |
| P1 | Solar position via suncalc | §3.8; BSD-2, 2 KB | Sun azimuth/elevation correct for hours×latitude preset; EV suggestion per hour exposed, DP-overridable |
| **P2** | Fire propagation | §3.6 FC2 grid + Rothermel weights + BotW rules + WildFireGS fuel tags | Integer-state CA at 30 Hz, checkpointed; burn spreads with wind/slope/wetness; view emitters keyed by `(cell, ignitionTick)`; replay bit-identical |
| P2 | Weather evolution | §3.5 FC6 state machine; seeded transition schedule | Preset transitions ramp parameter vector over 30–120 s; `weather.wetness` integrates rain/dry-out; scrub-consistent |
| P2 | Wetness/snow materials | §3.5 Lagarde wet BRDF; AC4 ripple/occlusion tricks | Global wetness uniform darkens albedo + boosts smoothness (porosity-aware); rain occluded under cover; puddle/snow masks deterministic |
| P2 | Player/agent interactions | §3.6 BotW element rules; Rapier deterministic build if physics needed | Extinguish/ignite/gust actions mutate System-tier state through the same audited action surface |
| **P3** | WebGPU/TSL migration | three `SkyMesh`; takram WEBGPU.md; TSL compute | Living World renders on WebGPURenderer with parity screenshots vs WebGL2 goldens |
| P3 | FFT ocean | §3.3 Tessendorf; seeded spectrum phases keep scrub-purity | Open-ocean water body type with Jacobian foam; frame-pure under scrub; Gerstner remains for small bodies |
| P3 | Volumetric clouds | §3.4 Nubis lineage; @takram/three-clouds | Storm/overcast presets drive raymarched clouds ≤ 2 ms at previz res; deterministic under fixed `(seed, frame)` |
| P3 | Bruneton atmosphere | §3.4 @takram/three-atmosphere (Bruneton, verified) | Aerial perspective + physically-scaled sun/sky replace Preetham with per-shot EV intact |
| P3 | worldclaw semantic auto-binding | §2.4 WildFireGS per-primitive fuel semantics | worldclaw scattering/semantic maps auto-populate `flammable`/fuel-class tags and wildlife habitat regions without manual tagging |
| **Never** | Neural world models in the render path | §2.5 — non-deterministic, no scene graph, H100-class cost | — (tracked as competitive context only) |
| Never | Stateful GPU particle sim on WebGL2 | §3.1 — transform feedback breaks random access | — |
| Never | Wall-clock or auto-exposure feedback anywhere | §3.8, §6 — hidden state breaks `(seed, frame)` purity | — |

---

*Survey compiled 2026-08-13 for the Living World initiative. Verification trail: arXiv
abstracts fetched for 2607.21522 / 2607.01766 / 2602.11757 / 2608.11100 / 2503.14501 /
2301.11280 / 2505.18926 / 2506.17201 / 2511.23429; npm registry queried for all package
versions/dates; GitHub API queried for all repo licenses/activity; GDC Vault session
pages, vendor blogs, and primary PDFs fetched where linked. Items that resisted
non-browser access (USDA Rothermel PDF, red3d.com, poly.pizza) are marked unverified.*
