# Recorder COLMAP Refiner

An experimental offline tool for refining camera positions in recorded 3D
captures while preserving the recorder's original data. Small position errors
can misalign views and produce duplicated or blurred reconstruction geometry.
Built for a university SoftwareLab Gaussian-splatting project, the tool combines
COLMAP processing with strict validation, reproducible evidence, and safe ZIP
export. It is intended to test whether constrained refinement can help; it does
not claim demonstrated visual improvement.

> [!IMPORTANT]
> This is a fail-closed research prototype. PyCOLMAP 4.2 reports the selected
> residual count but not the selected residual identities, so a real run
> currently stops before bundle adjustment rather than publishing an
> unverifiable result. The ZIP reader/writer and safety boundaries are complete
> and tested.

## Intended complete pipeline

```text
recorder ZIP
  -> SIFT feature extraction and exhaustive matching
     (clean selected-pair fallback on failure)
  -> fixed-pose triangulation
  -> pre-BA support checks
  -> CURRENT STOP: native residual-identity evidence is unavailable
  -> inspected three-anchor, translation-only bundle adjustment
  -> post-BA geometry and identity gates
  -> separate, reopened, verified candidate ZIP
```

SIFT finds repeatable image features, and matching links the same visual points
between images. Triangulation estimates temporary 3D working points from those
links. Constrained bundle adjustment then attempts to reduce reprojection error
by changing camera translations while keeping rotations, camera intrinsics
(focal length and principal point), and three anchor poses fixed.

It is a local engineering tool, not a recorder UI. It has no runtime dependency
on LichtFeld, a desktop application used to train and inspect Gaussian splats. A
controlled LichtFeld comparison can be performed later, after a candidate passes
the tool's deterministic checks.

## Safety properties

- Never overwrites the input ZIP.
- Preserves rotations, intrinsics, image identities, anchor poses, the recorder
  points exported to the candidate ZIP, and unrelated archive entries. Temporary
  working points may be optimized internally during bundle adjustment.
- Hash-binds the inputs, native tools, configuration, and evidence used by a
  run.
- Allows one bundle-adjustment attempt per run directory.
- Publishes a candidate only after reopening and verifying the generated ZIP.
- Reports missing or stale evidence as `Inconclusive`, not as success.

## Requirements

- Node.js 24.14.0 and pnpm 11.11.0
- `uv` for the frozen Python environment
- The verified native baseline is COLMAP 4.2.0, commit `be5e291`, CUDA build.
  Other builds require a separate controlled verification.
- Python 3.12.14, NumPy 2.5.3, and PyCOLMAP 4.2.0, installed from
  `pyproject.toml` and `uv.lock`
- A recorder ZIP containing `sparse/0/cameras.txt`, `images.txt`,
  `points3D.txt`, and its referenced images
- A GPU available to the configured COLMAP exhaustive matcher

After dependencies and tools are installed, the refinement run itself does not
need network access. Development and automated verification were performed on
Windows using PowerShell.

## Quick start

```powershell
pnpm install --frozen-lockfile
uv sync
pnpm check
```

`pnpm check` type-checks, builds, runs the unit tests, and smoke-tests the
packaged command and Python-driver layout. It also runs the Python driver tests
through the frozen `uv` environment.

## Configure a run

Copy `examples/run.example.json` to a working directory and replace every
placeholder. Paths are resolved relative to that copied config file.

Record the executable hashes on Windows with:

```powershell
(Get-FileHash C:\path\to\colmap.exe -Algorithm SHA256).Hash.ToLowerInvariant()
(Get-FileHash C:\path\to\python.exe -Algorithm SHA256).Hash.ToLowerInvariant()
```

The configuration contains:

- `inputZip`: the untouched recorder ZIP;
- `outputDirectory`: where a new isolated run directory will be created;
- `colmap`: executable path, exact help-output version/build text, and SHA-256;
- `python`: executable path, SHA-256, and exact PyCOLMAP version;
- `anchors`: exactly three distinct recorder image names whose full poses remain
  fixed during bundle adjustment;
- `loopPairs`: one or more distinct image pairs used as required closure
  evidence.

Anchor and loop-pair names must already exist in the recorder COLMAP model.
Selection is currently manual and should be reviewed for the capture before a
run.

## Run

Build once, then execute one configuration:

```powershell
pnpm build
pnpm refine --config C:\path\to\run.json
```

The executable form after installation is equivalent:

```powershell
recorder-colmap-refiner refine --config C:\path\to\run.json
```

Each invocation creates a new `run-*` directory. The bundle-adjustment attempt
is deliberately one-shot for that directory: do not edit evidence or retry a
failed attempt in place. Correct the input or configuration and create a new
run instead.

## Result and evidence

A run records its resolved inputs, hashes, native-tool logs, frozen
correspondences, model exports, and metric reports beneath its isolated run
directory. Failed or stopped runs retain `run-result.json` at the run root.
Delivered runs publish `output/run-result.json` in the same atomic directory as
`candidate.zip` and `transfer.json`.

Post-BA geometry has three possible verdicts:

- `Pass`: every applicable deterministic gate passed; transfer may proceed.
- `Rejected`: measured evidence violated at least one gate.
- `Inconclusive`: required evidence was absent, stale, non-finite, or otherwise
  insufficient.

Only `Pass` produces `output/candidate.zip`. The transfer stage reopens that ZIP
and verifies pose serialization, frame and scale safety, and preservation of the
original points, intrinsics, identities, and archive assets. It never overwrites
the input ZIP. Publication first reserves a permanent attempt record and then
atomically renames a staging directory containing the verified ZIP and its
completion evidence into place.

A passing ZIP is a provisionally accepted geometry candidate, not proof that a
Gaussian splat will look better. If visual confirmation is required, train the
original and candidate with the same LichtFeld version, settings, and viewpoints
and retain both outputs as separate evidence.

## Validation and results

Automated TypeScript and Python tests cover COLMAP text parsing and writing,
archive preservation, input and evidence hashes, one-shot optimization guards,
geometry verdicts, pose-only transfer, reopened-ZIP checks, and atomic
publication. The package check also type-checks, builds, and smoke-tests the
installed command layout.

The earlier SoftwareLab experiment workflow—not this standalone command—was run
on a real recorder capture through constrained bundle adjustment, verified ZIP
transfer, and a controlled LichtFeld comparison. That single experiment informed
the standalone safety design but does not establish general visual improvement.

The standalone command currently stops after native inspection with an
`Inconclusive` result because PyCOLMAP does not expose the selected residual
identities required by its evidence policy. It therefore performs no bundle
adjustment and publishes no `candidate.zip`. Real standalone optimization,
multi-capture validation, and demonstrated visual improvement remain unverified.

## Current limits

- The supported recorder contract is COLMAP text with a single `PINHOLE` camera.
- Refinement changes image translations only; rotations, intrinsics, points, and
  the three anchor poses are protected.
- Matching, thresholds, three-anchor policy, and safety gates are fixed rather
  than user-tunable.
- Anchor and loop-pair selection is not automated.
- The earlier experimental workflow was exercised locally; the standalone
  command remains a fail-closed prototype, not a general-purpose COLMAP repair
  tool.
- LichtFeld training and visual comparison are intentionally outside this CLI.

Future work should start with more varied recorder captures and independently
reviewed evidence before widening the COLMAP subset, automating selection, or
changing the optimization and acceptance policies.

The reusable recorder ZIP reader/writer is also proposed for the main project
in [cs-util-com/location-based-webxr#635](https://github.com/cs-util-com/location-based-webxr/pull/635).

## Contributions and maintenance

This repository is a SoftwareLab project snapshot, not a maintained production
service. Issues and focused pull requests are welcome, but ongoing support and
response times are not guaranteed. Changes to optimization or acceptance rules
must include evidence and counterexample tests.

## Contributors

- [Filip](https://github.com/dr4g0n69) — standalone TypeScript CLI, COLMAP ZIP
  handling, safety checks, Python-driver integration, and automated tests
- [Mingna](https://github.com/Zhi-Yu941) — refinement-workflow design,
  experimental pipeline construction and review, LichtFeld training, and visual
  evaluation

## Acknowledgements

Simon served as Product Owner for the university SoftwareLab project and
contributed the requirements and research direction.

## AI assistance

AI tools assisted with planning, implementation, debugging, documentation, and
code review. Filip and Mingna reviewed and tested the resulting work and remain
responsible for the accepted design decisions and code. AI review does not
replace experimental validation.

## Licence

The project is licensed under Apache-2.0. Runtime and package attribution is
recorded in `NOTICE`.
