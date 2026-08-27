<!-- 北极星：Director 是一座经过验证的镜头工厂。宪法见
docs/site/src/content/docs/concepts/product-constitution.md，采纳记录见
docs/site/src/content/docs/engineering/adr/0005-verified-shot-north-star.md -->

## 理念三问（必填 / required）

1. **它强化黄金旅程的哪一步（J1–J6）？** (Which golden-journey step does it strengthen?)

   答：

2. **Agent 能端到端驱动它吗？** (Can an agent drive it end to end — discoverable, addressable, guarded, idempotent, observable?)

   答：

3. **它产生什么证据？** (What revision-bound evidence proves it — receipt, audit, diff, or clean capture?)

   答：

## 层级 / Layer（选一 / pick one）

- [ ] `core` — 唯一的「意图 → 已验证镜头」生产线
- [ ] `adapter` — 把外部工具、格式或模型映射到 core 契约
- [ ] `experiment` — 隔离且诚实标注，不是第二条管线

## 证据链接 / Evidence links

<!-- revision 绑定的回执、audit、diff、干净捕获、测试或 eval 输出的链接或粘贴 -->

-

## 宪法自查 / Constitution checklist

- [ ] 理念三问已在上方作答，Layer 标注准确
- [ ] 一个项目、每个界面：无 shadow state，功能不是 UI-only 也不是 Agent-only
- [ ] 一次意图、一个原子批次：mutation 带 revision 守卫与幂等键
- [ ] 真实几何：catalog、Blender 或提升后的 generated-3D；白模是黏土观感，不是 Stage 盒子堆
- [ ] 回执而非乐观：成功可对照 revision 检验；`audit.ready` 不等于视觉验收（35–65 mm 干净捕获）
- [ ] 复用生态：无 in-tree fork、无第二条工具环、无第五个教学渠道（`director_game` 是 experiment，不是第二条影片管线）

## 状态同步 / Status sync

- [ ] feature-status：成熟度或范围变化已同步 `docs/site/src/content/docs/reference/feature-status.md`（或不适用）
- [ ] i18n：UI 文案以简体中文为源语言，英文翻译已加入 `frontend/director/src/comprehensive/i18n/en-US.json`（或不适用）
- [ ] eval：Agent 行为变化已新增或更新 `tools/evals/` golden task（或不适用）
