# CineDelta: Counterfactual Impact Localization for Provenance-Aware Revision of Multi-Shot Generative Productions

**Anonymous authors**  
**Conference-paper draft · Version 0.1 · 8 August 2026**

> **Draft status.** This manuscript is written as a submission-oriented first draft rather than a proposal. The task, method, benchmark protocol, and evaluation design are specified. All empirical cells marked **TBD** must be replaced by measured results; no result in this draft is fabricated. Target venue positioning: CVPR / ICCV / SIGGRAPH Asia, subject to pilot results and submission timing.

## Abstract

Modern video agents can plan stories, maintain character memories, generate multiple shots, and selectively retry outputs that fail quality checks. Yet revising a completed production remains surprisingly blunt. A retroactive change—such as moving a prop before an interaction, changing a character's temporary appearance, or altering a camera constraint—can invalidate downstream world states, shot conditions, cached generations, and timeline artifacts. Existing systems either edit a target clip, append a new shot to accepted history, or retry an independently failed shot; they do not explicitly determine which accepted production artifacts have become invalid and which must remain untouched.

We formulate **Production Revision Impact Localization (PRIL)**: given a completed multi-shot production, its typed provenance graph, and a retroactive edit, predict a minimally sufficient re-execution plan that satisfies the edit while preserving unaffected content, cross-boundary continuity, and execution budget. We introduce **CineDelta**, a provenance-aware revision framework that (i) compiles natural-language requests into structured edit deltas, (ii) propagates candidate effects through a unified production graph, (iii) selects a cost-aware impact set under semantic and preservation constraints, and (iv) performs boundary-conditioned local re-execution with localized verification and repair. We further propose **CineDelta-Eval**, a benchmark that labels required, optional, and protected production nodes and evaluates both the predicted process and the revised visual result. Unlike a single gold dependency set, the benchmark admits multiple Pareto-valid repair plans and measures necessary-node recall, protected-node violations, overreach, edit fidelity, preservation, boundary continuity, and actual execution cost. On CineDelta-Eval, CineDelta achieves **[TBD]** higher required-node recall and reduces protected-content drift by **[TBD]** relative to full regeneration, verifier-only retry, and graph invalidation baselines, while using **[TBD]** of their generation cost. These results would establish retroactive revision—not one-shot generation—as a first-class problem for agentic video systems.

## 1. Introduction

Generative video systems are becoming production systems. Recent methods decompose stories into scenes and shots, maintain character or world memories, coordinate specialized agents, invoke heterogeneous generation tools, and verify intermediate outputs [1–8]. Multi-shot models have simultaneously improved long-range identity, cinematic transitions, camera control, and interactive continuation [9–15]. These advances support increasingly long and coherent initial productions.

Real creative work, however, is dominated by revision. A director may decide that a key is placed on a table in Shot 2 rather than handed over in Shot 5; an art director may change a character's jacket only during an earlier flashback; an editor may replace a medium shot with an over-the-shoulder composition while preserving the surrounding performance. Such requests are local in language but not necessarily local in effect. The key's later ownership, the character's state ledger, downstream prompts, reference frames, generated clips, sound cues, and timeline transitions may all depend on the changed fact. Conversely, unrelated shots should remain bit-identical whenever possible.

Current systems provide only partial answers. Agentic generation frameworks such as CoAgent track state and verify generated shots, but their selective regeneration is triggered primarily by per-shot quality failures during forward production [2]. Interactive multi-shot systems such as ContextMaster operate over accepted history but generate or edit a current target rather than repairing arbitrary invalidated artifacts in a completed project [9]. Video editors optimize instruction fidelity and source preservation within a target clip [16–19], without exposing the cross-artifact consequences of a change. Edit-As-Act plans minimal actions for a static 3D scene [20], but it does not model stochastic video jobs, temporal boundaries, or production artifacts. Finally, incremental build systems can invalidate deterministic descendants in a dependency graph [21–23], whereas a creative edit propagates through semantic, temporal, and uncertain relations: a changed jacket may affect visually present shots but not shots in which the character is occluded; a moved prop may matter only after a causal interaction; a camera edit may alter a transition without changing the world state.

We argue that the missing abstraction is **counterfactual production impact**. Given the original accepted production and an edit, a system should answer: _Which existing states and artifacts would be invalid under this edit, which computations must be re-executed to restore validity, and which accepted outputs must be protected?_ This question precedes pixel generation. It converts revision from an unconstrained request to rerun a workflow into a structured prediction and constrained execution problem.

We formalize this problem as Production Revision Impact Localization (PRIL). Its input is a completed production state, represented by a typed, versioned provenance graph, together with a structured or natural-language edit. Its output is an executable repair plan over state, shot, artifact, and job nodes. A valid plan must be sufficient to realize the new constraint, conservative with respect to protected content, coherent at the boundaries between retained and regenerated media, and efficient under measured execution cost. Because multiple repair plans can be valid—for example, rerendering one shot with a boundary bridge or rerendering two adjacent shots without one—we evaluate plan validity and Pareto efficiency rather than exact equality to a single gold set.

We instantiate this formulation in CineDelta. The system first compiles an edit into a typed delta with temporal scope, target attributes, hard and soft invariants, and preservation clauses. It then combines rule-based typed propagation with a learned semantic impact predictor over a unified production graph. A constrained selector chooses a minimally sufficient plan by balancing predicted invalidity, transition coupling, preservation risk, uncertainty, and real execution cost. Selected regions are re-executed using compact conditioning packets derived from neighboring retained artifacts. A localized evaluator checks edit fidelity, protected-content preservation, boundary continuity, and artifact integrity, and expands the plan only when a diagnosed violation warrants it.

This paper makes four contributions:

1. **A new task.** We formulate PRIL for retroactive revision of completed multi-shot generative productions, explicitly separating impact prediction from media editing and generation.
2. **A provenance-aware method.** We introduce CineDelta, a hybrid graph and semantic planner that compiles natural-language edits into cost-aware, executable local repair plans with boundary-conditioned re-execution.
3. **A process-level benchmark.** We propose CineDelta-Eval with required, optional, and protected node annotations; counterfactual validity tests; multiple acceptable repair plans; and controlled and open-production tiers.
4. **A joint evaluation protocol.** We measure impact localization, edit success, collateral preservation, cross-boundary continuity, uncertainty, and actual cost, exposing failure modes hidden by output-only video metrics.

## 2. Related Work

### 2.1 Agentic video and film production

Agentic production systems use language and vision models to transform high-level stories into executable workflows. FilmAgent assigns filmmaking roles in virtual 3D environments [3], MovieAgent performs hierarchical scene and cinematography planning [4], and Hollywood Town organizes long-form multi-agent collaboration with graph- and hypergraph-structured workflows [1]. CoAgent couples planning, synthesis, and verification, including selective regeneration of failed shots [2]. Crayotter and VideoAgent treat intermediate artifacts, scheduling events, and tool calls as traceable workflow objects [5,6]. These systems demonstrate that production graphs and verifier loops are feasible, but they focus on initial generation, workflow execution, or quality-driven retry. CineDelta instead begins after a production has been accepted and asks which existing descendants are counterfactually invalidated by a new edit.

### 2.2 Multi-shot generation, memory, and interaction

Multi-shot video generation has advanced from independent clip stitching to explicit long-range memory. HoloCine and MultiShotMaster model holistic narrative structure [10,11]; OneStory selects semantic frames for adaptive memory [12]; STAGE uses storyboard anchors and multi-shot memory [13]; and ShotDirector controls cinematographic transitions and camera parameters [14]. Streaming and interactive methods, including ShotStream and CausalCine, reuse history for efficient next-shot generation [24,25]. ContextMaster is especially close to our setting: it supports generation, reference, and multi-shot editing within a shared accepted history using sparse context routing [9]. PermaVid updates disentangled memories after edits [15]. These methods optimize how history conditions a target generation. PRIL asks the inverse question: after modifying a historical fact, which already accepted artifacts and memories should be invalidated, repaired, or protected?

### 2.3 Instruction-guided editing and scene revision

Instruction-guided video editing balances text alignment, temporal coherence, and preservation of source content [16–19,26]. FiVE-Bench and UniEditBench provide fine-grained output-level evaluation [17,19]. CoT-Edit and Aurora use language or vision-language reasoning to transform underspecified requests into structured edit operations [18,27]. These ideas motivate our Edit Delta Compiler and output metrics, but target-clip editing alone does not expose dependencies among narrative facts, world states, shots, jobs, references, and timeline placements.

Editable 3D representations offer another related direction. StoryBlender creates inter-shot-consistent editable storyboards [28], while Vinedresser3D localizes text-guided asset changes [29]. Edit-As-Act is the closest planning analogue: it represents scene editing as goal-regressive planning and seeks a minimal action sequence while preserving the rest of a static environment [20]. CineDelta differs in the optimization unit. It minimizes a stochastic, cross-artifact re-execution plan over temporally evolving scenes and rendered media, subject to boundary continuity and real generation cost, rather than minimizing direct actions in one 3D scene.

### 2.4 Incremental computation and workflow provenance

Incremental view maintenance, self-adjusting computation, and modern build systems update only computations affected by changed inputs [21–23]. Workflow provenance supports trace comparison and reproducibility analysis [30]. CineDelta inherits the discipline of explicit lineage and change propagation but addresses three conditions that deterministic build systems generally avoid: semantic dependencies may be incomplete or uncertain, regeneration is stochastic and expensive, and output validity is perceptual rather than exact. Therefore, descendant reachability is a useful baseline, not a complete solution.

### 2.5 Evaluation of generated and edited video

VBench evaluates generic quality and consistency dimensions [31]. FiVE-Bench, UniEditBench, and UniVBench extend evaluation to editing and unified video capabilities [17,19,32]. EntityBench measures long-range subject consistency [33], while DirectorBench diagnoses long-form production workflows at multiple checkpoints [34]. None of these benchmarks, to our knowledge at the search cutoff, jointly provides a completed production graph, a retroactive edit, required/optional/protected impact labels, executable repair alternatives, transition boundaries, and real node-level costs. CineDelta-Eval is designed to fill this process-level gap.

## 3. Production Revision Impact Localization

### 3.1 Production state

We represent a completed production as

$$
\mathcal{S}=(G,\mathcal{A},\mathcal{P}), \qquad G=(V,E),
$$

where $G$ is a typed, directed provenance graph, $\mathcal{A}$ is the set of accepted artifact versions, and $\mathcal{P}$ records execution provenance. Each node $v\in V$ belongs to one of five layers:

- **Narrative:** scenes, beats, events, dialogue, causal facts, and temporal intervals;
- **World:** entities, identity, appearance, possession, pose, spatial relations, and persistent state;
- **Shot:** composition, camera, lens, lighting, action, timing, and continuity constraints;
- **Artifact:** storyboards, reference images, masks, depth, video, audio, captions, and timeline segments;
- **Execution:** prompts, tool invocations, model and adapter versions, random seeds, caches, evaluators, and approval events.

An edge $e=(u,v,r,\tau,w)$ records source, destination, relation type $r$, temporal scope $\tau$, and confidence or provenance weight $w$. Relation types include deterministic derivation, semantic conditioning, temporal carry, visual reference, spatial support, timeline placement, and evaluation dependence. Nodes and edges are versioned; accepted artifacts are immutable and new revisions create descendants rather than silently overwriting history.

### 3.2 Edit delta

Given a natural-language instruction $q$, an Edit Delta Compiler produces

$$
\Delta=(T,\Omega,\delta^+,\delta^-,\mathcal{H},\mathcal{Q},\mathcal{B}),
$$

where $T$ is a set of target entities or nodes, $\Omega$ is the temporal or shot scope, $\delta^+$ and $\delta^-$ are facts to assert and retract, $\mathcal{H}$ contains hard constraints, $\mathcal{Q}$ contains soft preferences, and $\mathcal{B}$ contains explicit preservation clauses. For the instruction “place the red key on the desk from Shot 2 onward, but keep the corridor shots unchanged,” the compiler retracts prior ownership and position facts over the relevant interval, asserts the new location, and protects corridor-shot artifacts and their visual attributes.

The compiler may abstain when target identity, temporal scope, or preservation intent is unresolved. Interactive clarification is allowed in the open tier, but the resulting structured delta is logged and scored.

### 3.3 Output repair plan

A repair plan is an ordered, executable subgraph

$$
\pi=(V_{\pi},E_{\pi},\prec,\kappa,\Gamma),
$$

where $V_{\pi}$ are selected nodes, $E_{\pi}$ are required dependencies, $\prec$ is an execution partial order, $\kappa$ assigns an action such as update, regenerate, relink, reuse, or verify, and $\Gamma$ contains conditioning and preservation contracts. The plan must compile to actual production jobs. A set of predicted impacted nodes without execution order, inputs, and replacement semantics is not considered a complete output.

### 3.4 Counterfactual node status

Let $\operatorname{Valid}(v\mid\mathcal{S},\Delta)$ denote whether the accepted version of $v$ remains valid after imposing $\Delta$ while holding other accepted artifacts fixed. Each node is assigned one of three benchmark statuses:

- **Required ($R$):** retaining the old node makes every feasible plan violate at least one hard edit, integrity, or continuity constraint;
- **Optional ($O$):** both retention and replacement occur in valid plans, often reflecting alternative boundary or quality strategies;
- **Protected ($P$):** changing the node is unnecessary and violates an explicit or inferred preservation constraint.

Remaining nodes are neutral. Status is established using controlled interventions, plan validation, and adjudication rather than a single annotator's preferred workflow. This distinction is critical: exact set matching would incorrectly penalize a valid one-shot repair when a two-shot repair is equally acceptable.

### 3.5 Objective

For a plan $\pi$, define edit violation $L_{\mathrm{edit}}$, integrity violation $L_{\mathrm{int}}$, preservation loss $L_{\mathrm{pres}}$, boundary discontinuity $L_{\mathrm{bdry}}$, execution cost $C$, and uncertainty risk $U$. We seek

$$
\pi^*=\arg\min_{\pi\in\Pi(\mathcal{S},\Delta)}
\lambda_e L_{\mathrm{edit}} +
\lambda_i L_{\mathrm{int}} +
\lambda_p L_{\mathrm{pres}} +
\lambda_b L_{\mathrm{bdry}} +
\lambda_c C +
\lambda_u U,
$$

subject to all hard constraints and executable-dependency closure. We report both a fixed operating point and the Pareto frontier over quality, preservation, and cost.

## 4. CineDelta

![Overview of CineDelta. A retroactive instruction is compiled into an edit delta; candidate effects propagate through a typed production graph; a cost-aware planner selects local re-execution jobs; protected artifacts bypass generation; a localized evaluator verifies fidelity, preservation, continuity, and cost.](/Users/ichubai/Documents/Director/docs/research/figures/cinedelta-pipeline-v1.png)

**Figure 2. CineDelta pipeline.** A structured edit delta is propagated across a typed production graph. The planner selects a minimally sufficient local re-execution plan while explicitly routing protected artifacts around the generator. Boundary-conditioned execution and a localized evaluator close the repair loop.

### 4.1 Edit Delta Compiler

The compiler separates request interpretation from execution. It receives the user instruction, selected timeline context, current graph neighborhood, and a compact inventory of entities and shots. It emits a JSON-constrained delta containing canonical node identifiers, attribute paths, before and after values, temporal intervals, certainty, and preservation clauses. A symbolic validator rejects deltas that reference nonexistent entities, create impossible intervals, or contradict explicit hard constraints.

To reduce language-model hallucination, compilation follows three stages. First, **grounding** maps mentions to graph nodes using lexical, visual, and temporal evidence. Second, **difference extraction** produces asserted and retracted facts against the accepted state. Third, **scope inference** determines whether the request is instantaneous, interval-bound, persistent-until-changed, or shot-local. When confidence falls below $\eta_{\Delta}$, the system asks a clarification question or constructs multiple candidate deltas for downstream evaluation.

### 4.2 Unified Typed Production Graph

The graph merges planned dependencies with observed provenance. Planned edges are created during script, world, and shot planning; observed edges are logged during artifact generation, reference retrieval, timeline editing, and verification. We retain the edge source and evidence class so that a predicted semantic dependency is not treated as equivalent to an observed file lineage.

Each state-bearing node supports interval semantics. A fact such as `key.location = desk` is represented over an interval and connected to the event that establishes it and the next event that overwrites it. This prevents indiscriminate forward propagation: a location change affects shots after the establishment event only until a later event resets the state. Visual-presence and occlusion metadata further gate whether a world-state change can affect a shot's pixels.

For every artifact, the execution layer records the exact prompt, model version, seed, conditioning inputs, reference hashes, and quality decisions. This makes preservation testable: a protected artifact can remain byte-identical, be reused as conditioning, or be compared against its prior version.

### 4.3 Hybrid Impact Planner

The planner contains a high-recall candidate stage and a constrained selection stage.

#### Typed candidate propagation

Starting from delta targets, rule-based propagation traverses only relation types compatible with the changed attribute and interval. For example, a camera-focal-length edit propagates to composition, depth or pose conditioning, rendered media, and adjacent transition checks, but not to persistent ownership state. A possession edit propagates through causal state edges and visible downstream shots until a reset event. The candidate set is

$$
\mathcal{C}=\operatorname{Closure}_{\mathcal{R}(\Delta),\Omega}(T),
$$

where $\mathcal{R}(\Delta)$ selects relation types allowed for the edit class and $\Omega$ clips temporal scope. Deterministic descendants required for execution closure are always included.

#### Semantic impact prediction

Rules cannot capture implicit effects such as whether changing a prop color matters in a dim, defocused background. A learned predictor estimates

$$
p_v=P(y_v\in\{R,O\}\mid G_{\mathcal C},\Delta,x_v),
$$

where $x_v$ includes node text, thumbnails, temporal position, visual presence, edge evidence, prior evaluator outcomes, and estimated cost. We use a relation-aware graph encoder with a cross-attention delta token. A calibrated auxiliary head predicts $P(y_v=R)$, $P(y_v=O)$, and preservation risk. Training combines node classification, pairwise ranking of valid versus invalid plans, and calibration loss. Synthetic graph corruptions and controlled counterfactual episodes provide dense supervision before human-labeled open productions are available.

#### Cost-aware constrained selection

The selector uses binary variables $z_v$ indicating replacement or re-execution. Deterministic dependency closure and hard preservation become constraints; semantic and transition couplings become weighted factors. A simplified energy is

$$
E(z)=\sum_v z_v(c_v+\alpha r_v^{\mathrm{pres}})
+\sum_v(1-z_v)r_v^{\mathrm{invalid}}
+\sum_{(u,v)}\beta_{uv}\,[z_u\neq z_v],
$$

where $c_v$ is measured or predicted cost, $r_v^{\mathrm{pres}}$ is collateral-risk, $r_v^{\mathrm{invalid}}$ is risk of retaining an invalid artifact, and $\beta_{uv}$ penalizes unsafe cut boundaries. Hard constraints enforce selected-job inputs, mandatory nodes, protected nodes, and timeline replacement integrity. The implementation uses integer programming for small controlled graphs and a Lagrangian or beam-search approximation for larger projects.

The planner returns a primary plan, confidence, top alternatives, and per-node rationales. Low-confidence plans can expand a verification-only frontier or defer to a conservative operating point.

### 4.4 Boundary-Conditioned Local Re-Execution

A selected temporal region is regenerated using a **conditioning packet** rather than the entire production history. The packet contains:

- the compiled edit delta and relevant narrative beat;
- current entity and world-state entries at region start and end;
- retained visual anchors immediately before and after the region;
- identity, appearance, geometry, and camera references required by selected jobs;
- protected attributes and negative constraints;
- execution provenance needed for deterministic reuse where supported.

The packet is built from the graph cut around the selected subgraph. When only a prompt or timeline link changes, downstream artifacts can be relinked or deterministically reused. When media generation is necessary, neighboring retained frames or 3D state anchor the new boundary. The executor writes new immutable artifact versions and atomically swaps timeline references only after validation.

### 4.5 Localized Constraint Evaluator

The evaluator mirrors the scope of the repair. It first performs cheap structural checks: all new artifacts exist, timeline durations are valid, state intervals are noncontradictory, and protected artifact hashes are unchanged. It then evaluates four perceptual dimensions:

1. **Edit fidelity:** the requested fact or visual change is present within scope;
2. **Preservation:** protected and neutral regions retain identity, layout, motion, and appearance;
3. **Boundary continuity:** entity state, pose, motion, camera, lighting, and audio remain plausible across retained–regenerated cuts;
4. **Global integrity:** the revision does not create new narrative or world-state contradictions.

A failure classifier maps violations back to graph nodes. Repair expands only along diagnosed relations, subject to a retry budget. If no feasible local plan exists, CineDelta abstains and reports that a larger revision is necessary rather than silently drifting protected content.

### 4.6 Training and inference

Training proceeds in three phases. Phase I learns node impact on controlled symbolic graphs with exhaustive counterfactual labels. Phase II adds rendered episodes and uses visual differences plus validators to label perceptual sufficiency. Phase III fine-tunes on open productions with adjudicated plan labels and preference pairs. During inference, the compiler, candidate propagator, predictor, and selector run once; generation and localized evaluation iterate until success, abstention, or budget exhaustion.

## 5. CineDelta-Eval

### 5.1 Evaluation unit

An episode is

$$
e=(\mathcal{S}_0,q,\Delta^*,\mathcal{Y},\Pi^*,\mathcal{M}),
$$

where $\mathcal{S}_0$ is an accepted completed production, $q$ is a retroactive request, $\Delta^*$ is the adjudicated delta, $\mathcal{Y}$ contains node statuses, $\Pi^*$ is a set or frontier of valid repair plans, and $\mathcal{M}$ contains media, boundaries, provenance, and measured costs. Each episode includes the original result so output preservation can be evaluated against the exact accepted version.

### 5.2 Two benchmark tiers

The **Controlled Tier** uses instrumented 3D scenes, deterministic state transitions, and reproducible renderers. It enables exhaustive interventions and high-confidence required/protected labels. The planned release target is 40 productions × 8 edits = 320 episodes, with 8–20 shots per production.

The **Open Tier** uses heterogeneous generative video and image backends under realistic stochasticity. It tests semantic impact, visual preservation, and model/tool generalization. The planned release target is 20 productions × 8 edits = 160 episodes. These counts are design targets and will be frozen only after the pilot power and cost study.

### 5.3 Edit taxonomy

Episodes are balanced across six edit families:

| Family                 | Example                             | Expected propagation pattern                     |
| ---------------------- | ----------------------------------- | ------------------------------------------------ |
| Persistent world state | Move a prop before later use        | Sparse but long-range causal propagation         |
| Interval appearance    | Change clothing in a flashback only | Temporally bounded, visually gated propagation   |
| Character/event logic  | Reverse who gives an object         | Narrative, state, shot, and artifact propagation |
| Spatial/3D relation    | Move a table supporting objects     | Structural propagation plus occlusion effects    |
| Shot/camera            | Change one shot to a close-up       | Mostly local media and transition impact         |
| Timing/audio           | Extend a pause or replace a line    | Cross-modal timeline and boundary impact         |

We additionally stratify by graph distance, affected-shot ratio, number of valid plans, protected-region size, edit ambiguity, and backend determinism.

### 5.4 Ground-truth construction

For the Controlled Tier, we enumerate candidate plan variants around the causal closure, execute them, and evaluate hard state, artifact, and boundary constraints. A node is Required if every valid plan changes it, Optional if some valid plans change it, and Protected if changing it violates a preservation constraint without enabling validity. Minimal valid plans form an empirical Pareto frontier over quality and cost.

For the Open Tier, two annotators independently identify the edit delta and candidate impacts using provenance and side-by-side media. Candidate plans are executed and judged by a third adjudicator under blinded identifiers. Ambiguous nodes are marked Optional rather than forced into Required/neutral. We report inter-annotator agreement for delta fields and node labels, plus adjudication rate.

### 5.5 Splits and leakage control

Train, validation, and test splits are separated by production template, story world, entity identities, and edit phrasing. The open-tier test further withholds at least one generation backend and one edit family combination. Near-duplicate frames, prompts, and story templates are detected by perceptual, text, and graph fingerprints. A hidden test server can execute submitted plans against held-out provenance to discourage manual benchmark-specific rules.

## 6. Evaluation Protocol

### 6.1 Impact localization

Let $\hat I$ denote predicted impacted nodes. Because omitting a required node is usually more damaging than selecting an optional one, the primary planning metric is **Required Recall**:

$$
\operatorname{RRec}=\frac{|\hat I\cap R|}{|R|}.
$$

We also report Required Precision, macro F1, area under the precision–recall curve, and relation-stratified recall. **Protected Violation Rate** is $|\hat I\cap P|/|P|$. **Overreach** measures predicted execution cost spent on neutral or protected nodes. **Executable Closure Rate** tests whether all selected actions can actually run.

### 6.2 Plan validity and Pareto quality

A predicted plan is valid when its execution satisfies all hard edit, world-state, artifact, timeline, and preservation constraints. We report Valid-Plan Rate, normalized distance to the benchmark Pareto frontier, and regret relative to the cheapest valid plan at matched quality. These metrics avoid treating one annotator-preferred plan as the only correct answer.

### 6.3 Visual revision quality

Edit fidelity is assessed with edit-family-specific detectors, VLM judges, and human ratings. Preservation uses masked LPIPS/DINO similarity, identity embeddings, geometric or flow consistency where available, and artifact hashes for exact reuse. Boundary continuity is measured at both sides of each regenerated region using appearance, pose, optical flow, depth/camera consistency, audio discontinuity, and human pairwise preference. Standard video quality and temporal metrics are included only as secondary measures.

### 6.4 Cost and latency

We record wall-clock latency, accelerator time, model calls, generated frames, transferred bytes, peak memory, retries, and monetary API cost. Quality–cost and preservation–cost curves are reported rather than a single aggregate efficiency score. Planning overhead is separated from generation savings.

### 6.5 Human evaluation and statistics

Human raters view the original context, edit instruction, and anonymized revised variants. They answer four independent questions: edit success, unintended change, boundary continuity, and overall preference. We use at least three raters per sample, randomize order, insert attention checks, and report agreement. Main paired comparisons use stratified bootstrap confidence intervals and permutation tests with Holm correction. All operating points and exclusion rules are fixed on validation data.

## 7. Experiments

### 7.1 Research questions

The experiments address four questions:

1. Can CineDelta identify the nodes that must change under a retroactive edit?
2. Does explicit impact planning improve the fidelity–preservation–cost trade-off over full regeneration, target-only editing, and verifier-driven retry?
3. Which components—typed propagation, semantic prediction, cost-aware selection, boundary packets, or localized evaluation—drive the gains?
4. How robust is the method to long graph distance, incomplete provenance, stochastic backends, unseen worlds, and ambiguous edits?

### 7.2 Baselines

We compare against:

- **Full Regen:** rerun the complete production from the revised high-level specification;
- **Target Only:** edit or regenerate only explicitly named shots;
- **Downstream Closure:** invalidate every graph descendant of changed nodes;
- **Typed Rules:** use our relation and temporal rules without learned impact prediction;
- **LLM Direct Plan:** provide a serialized project summary and ask a language model for affected nodes;
- **VLM Direct Plan:** add contact sheets and target clips to direct planning;
- **Verifier Retry:** regenerate named or failed shots and expand only after output-level verification, following CoAgent-style repair [2];
- **Interactive Context Edit:** edit target shots conditioned on accepted history, following ContextMaster-style interaction [9];
- **Goal-Regressive Plan:** adapt Edit-As-Act-style regression to production actions [20];
- **Oracle Impact:** execute the cheapest known valid impact plan, providing an upper bound for the executor.

All methods share media backends, prompts where applicable, retry caps, evaluation budget, and cached inputs. We report results with identical and with individually tuned budgets.

### 7.3 Implementation details

The production graph is stored as versioned typed records with content-addressed artifacts. The initial predictor uses a relation-aware graph transformer with **[TBD]** layers and hidden width **[TBD]**. Text is encoded by **[TBD]**; visual node features use **[TBD]**. Candidate propagation depth is interval-aware and not capped for deterministic dependencies; semantic expansion uses top-$k$ **[TBD]** per relation. The selector is solved by **[TBD]** for controlled graphs and **[TBD]** for open graphs. Training uses **[TBD]** episodes for **[TBD]** steps. Exact backend versions, seeds, prompts, and hardware will be released.

### 7.4 Main impact-localization results

**Table 1. Impact localization on CineDelta-Eval.** Higher is better for RRec, R-F1, valid plan, and executable closure; lower is better for protected violation, overreach, and Pareto gap. All values are placeholders until experiments are run.

| Method               |  RRec ↑ |  R-F1 ↑ | P-Viol. ↓ | Overreach ↓ | Valid Plan ↑ | Pareto Gap ↓ | Closure ↑ |
| -------------------- | ------: | ------: | --------: | ----------: | -----------: | -----------: | --------: |
| Full Regen           |   1.000 |     TBD |       TBD |         TBD |          TBD |          TBD |     1.000 |
| Target Only          |     TBD |     TBD |       TBD |         TBD |          TBD |          TBD |       TBD |
| Downstream Closure   |     TBD |     TBD |       TBD |         TBD |          TBD |          TBD |       TBD |
| Typed Rules          |     TBD |     TBD |       TBD |         TBD |          TBD |          TBD |       TBD |
| LLM Direct Plan      |     TBD |     TBD |       TBD |         TBD |          TBD |          TBD |       TBD |
| Verifier Retry       |     TBD |     TBD |       TBD |         TBD |          TBD |          TBD |       TBD |
| Goal-Regressive Plan |     TBD |     TBD |       TBD |         TBD |          TBD |          TBD |       TBD |
| **CineDelta**        | **TBD** | **TBD** |   **TBD** |     **TBD** |      **TBD** |      **TBD** |   **TBD** |

The final paper should analyze at least three expected regimes rather than only rank methods: deterministic causal edits where rules may suffice, implicit visual edits where learned semantics should matter, and boundary-coupled edits where the cheapest node set may not yield the cheapest valid visual repair.

### 7.5 Revision quality and efficiency

**Table 2. End-to-end revision quality and measured cost.** Report separate controlled/open results or a two-panel table in the final manuscript.

| Method                   | Edit Fidelity ↑ | Preservation ↑ | Boundary ↑ | Human Pref. ↑ | GPU-min ↓ | Frames Gen. ↓ |  Cost ↓ |
| ------------------------ | --------------: | -------------: | ---------: | ------------: | --------: | ------------: | ------: |
| Full Regen               |             TBD |            TBD |        TBD |           TBD |       TBD |           TBD |     TBD |
| Target Only              |             TBD |            TBD |        TBD |           TBD |       TBD |           TBD |     TBD |
| Verifier Retry           |             TBD |            TBD |        TBD |           TBD |       TBD |           TBD |     TBD |
| Interactive Context Edit |             TBD |            TBD |        TBD |           TBD |       TBD |           TBD |     TBD |
| Downstream Closure       |             TBD |            TBD |        TBD |           TBD |       TBD |           TBD |     TBD |
| **CineDelta**            |         **TBD** |        **TBD** |    **TBD** |       **TBD** |   **TBD** |       **TBD** | **TBD** |

The central claim is supported only if CineDelta improves the Pareto trade-off, not merely cost. In particular, savings that reduce edit fidelity or create visible retained–generated seams are not counted as successful incremental revision.

### 7.6 Ablation studies

**Table 3. Planned ablations.** The final table should show process and output effects jointly.

| Variant                    | RRec | P-Viol. | Valid Plan | Preservation | Boundary | Cost |
| -------------------------- | ---: | ------: | ---------: | -----------: | -------: | ---: |
| Full CineDelta             |  TBD |     TBD |        TBD |          TBD |      TBD |  TBD |
| – typed propagation        |  TBD |     TBD |        TBD |          TBD |      TBD |  TBD |
| – semantic predictor       |  TBD |     TBD |        TBD |          TBD |      TBD |  TBD |
| – interval semantics       |  TBD |     TBD |        TBD |          TBD |      TBD |  TBD |
| – cost-aware selector      |  TBD |     TBD |        TBD |          TBD |      TBD |  TBD |
| – preservation constraints |  TBD |     TBD |        TBD |          TBD |      TBD |  TBD |
| – boundary packet          |  TBD |     TBD |        TBD |          TBD |      TBD |  TBD |
| – localized evaluator      |  TBD |     TBD |        TBD |          TBD |      TBD |  TBD |

Additional studies vary graph completeness, edit ambiguity, confidence threshold, affected-shot ratio, propagation distance, generation stochasticity, and retry budget. Calibration plots evaluate whether planner confidence predicts actual plan validity. Selective-risk curves measure whether abstention safely improves precision.

### 7.7 Qualitative analysis

The final paper should include three diagnostic case studies:

- **Long-range causal state:** moving a prop early affects a later interaction but not intervening shots in which it is absent;
- **Bounded appearance:** a costume change applies only to a flashback, preserving present-day shots and identity;
- **Local camera revision:** replacing one composition requires no world-state update but may require a neighboring bridge for continuity.

Each case should visualize the original graph, predicted node probabilities, selected plan, protected lane, old and revised frames, and the first failure of at least two baselines. Failure cases must include an under-propagated semantic edit, an over-conservative plan, and an evaluator-triggered expansion.

## 8. Discussion

### 8.1 Why this is not caching

Caching assumes that dependency validity can be decided by exact input identity or declared deterministic lineage. In generative production, two shots may share no file dependency yet express the same latent state; an edited fact can invalidate a shot semantically even when every prompt string is unchanged. Conversely, a graph descendant may remain perceptually valid because the changed entity is absent or occluded. PRIL therefore requires state semantics, visual evidence, uncertainty, and output verification in addition to provenance.

### 8.2 Why this is not selective regeneration

Selective regeneration usually begins with a failed output and chooses which shot to retry. CineDelta begins with a changed historical constraint and predicts invalidity before observing a new output. Its target includes state, prompts, references, media, and timeline artifacts; its negatives include protected content; and its evaluation asks whether the repair plan itself is sufficient and minimal. Verifier-driven retry remains an important baseline and a component of the execution loop, but it does not replace impact localization.

### 8.3 Practical use in an authoring system

In an interactive editor, the planner can expose affected shots before expensive work begins. A user may accept the proposed scope, lock additional artifacts, select a conservative or economical operating point, and inspect rationales. Because revisions create versions, the system supports comparison and rollback. The same abstraction can schedule distributed generation, estimate cost, and resume interrupted jobs without changing the task definition.

## 9. Limitations and Broader Impact

CineDelta depends on provenance quality. Missing references or incorrectly modeled state can cause silent under-propagation; conservative uncertainty handling may then erase efficiency gains. Required and Optional labels are partly policy-dependent because creative validity is not unique. Visual evaluators may overlook subtle narrative contradictions or penalize legitimate stylistic variation. The controlled tier cannot reproduce all stochastic failures of commercial generators, while the open tier is expensive and may become backend-dependent.

The system does not guarantee that a requested creative edit is safe, lawful, or ethically appropriate. Fine-grained revision tools can facilitate impersonation, misleading edits, or removal of evidence. A release should preserve provenance, record revision histories, expose model and asset licenses, support watermark or content-credential metadata where available, and exclude disallowed identity-manipulation episodes. Human annotators should receive clear content warnings and fair compensation. Cost reduction may broaden access to video production, but it may also accelerate low-quality or deceptive content; the paper should report both benefits and foreseeable misuse.

## 10. Conclusion

We introduced Production Revision Impact Localization, a task for deciding what must change—and what must not—after a retroactive edit to a completed multi-shot generative production. CineDelta combines structured edit deltas, typed provenance, semantic impact prediction, cost-aware selection, boundary-conditioned local re-execution, and localized validation. CineDelta-Eval extends output-only video evaluation with process-level labels and measured costs. The central hypothesis is that reliable revision requires reasoning over counterfactual production impact before generating new pixels. The completed paper will validate this hypothesis through controlled and open-production experiments without relaxing edit fidelity, preservation, or continuity.

## References

[1] [Hollywood Town](https://arxiv.org/abs/2510.22431). arXiv, 2025.  
[2] Zeng et al. [CoAgent: Collaborative Planning and Consistency Agent for Coherent Video Generation](https://arxiv.org/abs/2512.22536). arXiv, 2025.  
[3] Xu et al. [FilmAgent: A Multi-Agent Framework for End-to-End Film Automation in Virtual 3D Spaces](https://arxiv.org/abs/2501.12909). arXiv, 2025.  
[4] Wu et al. [Automated Movie Generation via Multi-Agent CoT Planning](https://arxiv.org/abs/2503.07314). arXiv, 2025.  
[5] Yan et al. [Crayotter: Traceable Multi-Agent Workflows for Long-Form Video Editing](https://arxiv.org/abs/2606.07636). arXiv, 2026.  
[6] Zhou et al. [VideoAgent: All-in-One Framework for Video Understanding and Editing](https://arxiv.org/abs/2606.23327). arXiv, 2026.  
[7] Long et al. [VISTA: A Test-Time Self-Improving Video Generation Agent](https://openaccess.thecvf.com/content/CVPR2026/html/Long_VISTA_A_Test-Time_Self-Improving_Video_Generation_Agent_CVPR_2026_paper.html). CVPR, 2026.  
[8] Liu et al. [AesopAgent: Agent-driven Evolutionary System on Story-to-Video Production](https://arxiv.org/abs/2403.07952). arXiv, 2024.  
[9] Guo et al. [ContextMaster: Interactive Multi-Shot Video Creation via Fixed-Budget Sparse Context Routing](https://arxiv.org/abs/2608.04956). arXiv, 2026.  
[10] Meng et al. [HoloCine: Holistic Generation of Cinematic Multi-Shot Long Video Narratives](https://openaccess.thecvf.com/content/CVPR2026/html/Meng_HoloCine_Holistic_Generation_of_Cinematic_Multi-Shot_Long_Video_Narratives_CVPR_2026_paper.html). CVPR, 2026.  
[11] Wang et al. [MultiShotMaster: A Controllable Multi-Shot Video Generation Framework](https://arxiv.org/abs/2512.03041). CVPR, 2026.  
[12] An et al. [OneStory: Coherent Multi-Shot Video Generation with Adaptive Memory](https://openaccess.thecvf.com/content/CVPR2026/html/An_OneStory_Coherent_Multi-Shot_Video_Generation_with_Adaptive_Memory_CVPR_2026_paper.html). CVPR, 2026.  
[13] Zhang et al. [STAGE: Storyboard-Anchored Generation for Cinematic Multi-Shot Narrative](https://openaccess.thecvf.com/content/CVPR2026/html/Zhang_STAGE_Storyboard-Anchored_Generation_for_Cinematic_Multi-shot_Narrative_CVPR_2026_paper.html). CVPR, 2026.  
[14] Wu et al. [ShotDirector: Directorially Controllable Multi-Shot Video Generation with Cinematographic Transitions](https://openaccess.thecvf.com/content/CVPR2026/html/Wu_ShotDirector_Directorially_Controllable_Multi-Shot_Video_Generation_with_Cinematographic_Transitions_CVPR_2026_paper.html). CVPR, 2026.  
[15] Yang et al. [PermaVid: Consistent Video Generation Across Edits via Disentangled Context Memory](https://arxiv.org/abs/2606.16449). arXiv, 2026.  
[16] Fu et al. [M3L: Language-Based Video Editing via Multi-Modal Multi-Level Transformers](https://openaccess.thecvf.com/content/CVPR2022/html/Fu_M3L_Language-Based_Video_Editing_via_Multi-Modal_Multi-Level_Transformers_CVPR_2022_paper.html). CVPR, 2022.  
[17] Li et al. [FiVE-Bench: A Fine-grained Video Editing Benchmark](https://openaccess.thecvf.com/content/ICCV2025/html/Li_FiVE-Bench_A_Fine-grained_Video_Editing_Benchmark_for_Evaluating_Emerging_Diffusion_ICCV_2025_paper.html). ICCV, 2025.  
[18] Liang et al. [CoT-Edit: Let CoT Guide Instruction Video Editing](https://openaccess.thecvf.com/content/CVPR2026/html/Liang_CoT-Edit_Let_CoT_Guide_Instruction_Video_Editing_CVPR_2026_paper.html). CVPR, 2026.  
[19] Jiang et al. [UniEditBench: A Unified and Cost-Effective Benchmark for Image and Video Editing](https://arxiv.org/abs/2604.15871). arXiv, 2026.  
[20] Noh et al. [Edit-As-Act: Goal-Regressive Planning for Open-Vocabulary 3D Indoor Scene Editing](https://arxiv.org/abs/2603.17583). CVPR, 2026.  
[21] Gupta et al. [Maintaining Views Incrementally](https://sigmodrecord.org/1993/06/03/maintaining-views-incrementally/). SIGMOD, 1993.  
[22] Acar et al. [A Consistent Semantics of Self-Adjusting Computation](https://arxiv.org/abs/1106.0478). Journal of Functional Programming, 2011.  
[23] Curtsinger and Barowy. [Riker: Always-Correct and Fast Incremental Builds from Simple Specifications](https://www.usenix.org/conference/atc22/presentation/curtsinger). USENIX ATC, 2022.  
[24] Luo et al. [ShotStream: Streaming Multi-Shot Video Generation for Interactive Storytelling](https://arxiv.org/abs/2603.25746). arXiv, 2026.  
[25] Meng et al. [CausalCine: Real-Time Autoregressive Generation for Multi-Shot Video Narratives](https://arxiv.org/abs/2605.12496). arXiv, 2026.  
[26] Fang et al. [V-RGBX: Video Editing with Accurate Controls over Intrinsic Properties](https://openaccess.thecvf.com/content/CVPR2026/html/Fang_V-RGBX_Video_Editing_with_Accurate_Controls_over_Intrinsic_Properties_CVPR_2026_paper.html). CVPR, 2026.  
[27] Yu et al. [Aurora: Unified Video Editing with a Tool-Using Agent](https://arxiv.org/abs/2605.18748). arXiv, 2026.  
[28] Li et al. [StoryBlender: Inter-Shot Consistent and Editable 3D Storyboard with Spatial-temporal Dynamics](https://arxiv.org/abs/2604.03315). arXiv, 2026.  
[29] Chi et al. [Vinedresser3D: Towards Agentic Text-guided 3D Editing](https://openaccess.thecvf.com/content/CVPR2026/html/Chi_Vinedresser3D_Towards_Agentic_Text-guided_3D_Editing_CVPR_2026_paper.html). CVPR, 2026.  
[30] Missier et al. [Provenance and Data Differencing for Workflow Reproducibility Analysis](https://arxiv.org/abs/1406.0905). 2014.  
[31] Huang et al. [VBench: Comprehensive Benchmark Suite for Video Generative Models](https://openaccess.thecvf.com/content/CVPR2024/html/Huang_VBench_Comprehensive_Benchmark_Suite_for_Video_Generative_Models_CVPR_2024_paper.html). CVPR, 2024.  
[32] Wei et al. [UniVBench: Towards Unified Evaluation for Video Foundation Models](https://openaccess.thecvf.com/content/CVPR2026/html/Wei_UniVBench_Towards_Unified_Evaluation_for_Video_Foundation_Models_CVPR_2026_paper.html). CVPR, 2026.  
[33] He et al. [EntityBench: Towards Entity-Consistent Long-Range Multi-Shot Video Generation](https://arxiv.org/abs/2605.15199). arXiv, 2026.  
[34] Chen et al. [DirectorBench: Diagnosing Long-Form Video Generation with Personalized Multi-Agent Evaluation](https://arxiv.org/abs/2605.30090). arXiv, 2026.

## Editorial checklist before submission

- Replace every **TBD** and bracketed result claim with measured values or remove it.
- Update the related-work search within two weeks of submission, with special attention to retroactive multi-shot editing and provenance-aware generation.
- Move implementation detail to the appendix after the page limit is known.
- Add a teaser figure with a concrete long-range revision case; retain Figure 2 as the method overview.
- Include graph-label annotation instructions, evaluator prompts, cost accounting rules, and all hyperparameters in the appendix.
- Release a reproducibility package containing typed schemas, episode manifests, planners, validators, cached controlled-tier assets, and evaluation scripts.
