# Recorder COLMAP Refiner

An experimental, offline pipeline for improving camera translations in a
recorder COLMAP ZIP without replacing the original archive or silently changing
its cameras, points, image identities, or other assets.

The tool runs this fixed workflow:

```text
recorder ZIP
  -> SIFT feature extraction and exhaustive matching
  -> fixed-pose triangulation
  -> pre-BA support checks
  -> inspected three-anchor, translation-only bundle adjustment
  -> post-BA geometry and identity gates
  -> separate, reopened, verified candidate ZIP
```

It is a local engineering tool, not a recorder UI. It has no runtime dependency
on LichtFeld. A controlled LichtFeld comparison can be performed later, after a
candidate passes the tool's deterministic checks.

## Requirements

- Node.js 24.14.0 and pnpm 11.11.0
- A pinned COLMAP executable whose help output identifies the configured version
  and build
- A pinned Python executable with the configured PyCOLMAP version
- A recorder ZIP containing `sparse/0/cameras.txt`, `images.txt`,
  `points3D.txt`, and its referenced images
- A GPU available to the configured COLMAP exhaustive matcher

After dependencies and tools are installed, the refinement run itself does not
need network access.

## Install and verify

```powershell
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` type-checks, builds, runs the unit tests, and smoke-tests the
packaged command and Python-driver layout.

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
directory.

Post-BA geometry has three possible verdicts:

- `Pass`: every applicable deterministic gate passed; transfer may proceed.
- `Rejected`: measured evidence violated at least one gate.
- `Inconclusive`: required evidence was absent, stale, non-finite, or otherwise
  insufficient.

Only `Pass` produces `output/candidate.zip`. The transfer stage reopens that ZIP
and verifies pose serialization, frame and scale safety, and preservation of the
original points, intrinsics, identities, and archive assets. It never overwrites
the input ZIP.

A passing ZIP is a provisionally accepted geometry candidate, not proof that a
Gaussian splat will look better. If visual confirmation is required, train the
original and candidate with the same LichtFeld version, settings, and viewpoints
and retain both outputs as separate evidence.

## Current limits

- The supported recorder contract is COLMAP text with a single `PINHOLE` camera.
- Refinement changes image translations only; rotations, intrinsics, points, and
  the three anchor poses are protected.
- Matching, thresholds, three-anchor policy, and safety gates are fixed rather
  than user-tunable.
- Anchor and loop-pair selection is not automated.
- The workflow has been exercised as a controlled local experiment, not as a
  general-purpose COLMAP repair tool.
- LichtFeld training and visual comparison are intentionally outside this CLI.

Future work should start with more varied recorder captures and independently
reviewed evidence before widening the COLMAP subset, automating selection, or
changing the optimization and acceptance policies.
