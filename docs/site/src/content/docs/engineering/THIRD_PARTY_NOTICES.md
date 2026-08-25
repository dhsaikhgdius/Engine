---
title: Third-party notices
description: Source, asset, and license notices for Director's third-party dependencies and reference projects.
---

The source and asset reuse decisions for the seven repositories in Director's
competitive-union study are maintained in
[reference reuse ledger](/engineering/reference_reuse_ledger/). Those repositories are
currently behavioral references; no source copy from them is registered. This does
not waive any license obligation if source is copied later, even in modified,
translated, or partially rewritten form.

## DeepSeek Harness

The Agent harness is the git submodule `vendor/deepseek-harness`
([deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness),
MIT, commit `47f943859bef60e4160492346772ded9b24f765a`). Director-specific Stage,
Canvas, Video Editor, and Blender tools are `@director/dsh-plugin-workbench`.
In-tree focused copies of DSH UI and workspace/web/subagent tools were removed
on 2026-08-17. Do not add new copies; use the submodule.

## Adobe Mixamo local character and animation package

Local development checkouts may populate `assets/library/mixamo-characters` and
`assets/library/mixamo-animations` with character and animation files supplied by the project
owner and converted into runtime GLB packages. Git tracks their generated catalogs,
not the GLB/FBX/thumbnail payloads. They are not original Director artwork and are not
licensed under the Director source-code license.

Adobe's [Mixamo FAQ](https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html)
states that Mixamo characters and animations may be used royalty free in personal,
commercial, and non-profit projects, including films and video games. That permission
must not be misrepresented as a general public-domain or open-asset license. Raw or
converted Mixamo library files must not be published as a standalone asset dump,
including through a public, gated, or shared private Hugging Face bundle. The asset
manifest represents them as `user-provided` without a remote repository or download
path. Every packaged item retains local-user-supplied provenance and source/output
hashes in its generated catalog.

## Lightricks LTX-2 source submodule

`vendor/ltx-2` is a Git submodule pinned to Lightricks' official
LTX-2 repository at revision
`9377758131b1ffde4b7f766804590a6617bf2ab9`. It is not licensed under Director's
root source-code license. Its source, model weights, derivatives, and use are governed
by the separate [LTX-2 Community License](https://github.com/Lightricks/LTX-2/blob/9377758131b1ffde4b7f766804590a6617bf2ab9/LICENSE),
including its acceptable-use restrictions and the separate commercial-license
requirement for entities at or above the revenue threshold stated in that agreement.

Director does not mirror LTX-2.3 checkpoints in the source repository. Users must
review and accept the upstream terms, obtain gated weights themselves, and set
`DIRECTOR_ACCEPT_LTX2_LICENSE=1` before `npm run setup:ltx2` will proceed. The pinned
source and model revisions are recorded in `vendor/ltx-2.lock.json`.

## Tencent Hunyuan3D-2 source submodule

`vendor/hunyuan3d` is a Git submodule pinned to
[Tencent-Hunyuan/Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2) at
`f8db63096c8282cb27354314d896feba5ba6ff8a`. It is governed by the
[Tencent Hunyuan 3D 2.0 Community License](https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/f8db63096c8282cb27354314d896feba5ba6ff8a/LICENSE),
including territory exclusions and the monthly-active-user commercial threshold stated
there. Director does not copy Hunyuan3D source or weights into another tree. Set
`DIRECTOR_ACCEPT_HUNYUAN3D_LICENSE=1` before `npm run setup:hunyuan3d`.

## Microsoft TRELLIS source submodule

`vendor/trellis` is a Git submodule pinned to
[microsoft/TRELLIS](https://github.com/microsoft/TRELLIS) at
`442aa1e1afb9014e80681d3bf604e8d728a86ee7`. The pinned TRELLIS source is MIT.
The nested FlexiCubes checkout and some mesh/render pip dependencies have separate
licenses; review those terms before a commercial deployment. Run `npm run setup:trellis`.
The pin is recorded in `vendor/trellis.lock.json`.

## NVIDIA ARDY source submodule

`vendor/ardy` is a Git submodule pinned to
[nv-tlabs/ardy](https://github.com/nv-tlabs/ardy) at
`693f74d13b3d04a0a22ce127ee79c929dd89756b` (Apache-2.0). Model checkpoints and
datasets are licensed separately on Hugging Face. Director's Gateway invokes
upstream `scripts/generate.py` and does not reimplement the model. Run `npm run setup:ardy`.
The pin is recorded in `vendor/ardy.lock.json`.