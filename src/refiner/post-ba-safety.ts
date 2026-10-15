import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { RefinerPreflight } from './preflight.js';
import type { PreparedRun } from './run-directory.js';
import { acceptancePolicy as policy } from './acceptance-policy.js';
import { verifyBundleAdjustmentEvidence } from './ba-solve.js';
import {
  readWorkingCamera,
  readWorkingImages,
  readWorkingPoints,
  type WorkingImage,
  type WorkingPoint,
} from './triangulation.js';

export type PostBaVerdict = 'Pass' | 'Rejected' | 'Inconclusive';

class CandidateViolationError extends Error {}

interface FrozenPair {
  readonly images: readonly [string, string];
  readonly roles: readonly string[];
  readonly matches: readonly FrozenMatch[];
}

interface FrozenMatch {
  readonly keypointIndices: readonly [number, number];
  readonly xy: readonly [readonly [number, number], readonly [number, number]];
}

export interface BaselineGeometryPair {
  readonly images: readonly [string, string];
  readonly roles: readonly string[];
  readonly matches: readonly FrozenMatch[];
}

interface WorkingModel {
  readonly camera: ReturnType<typeof readWorkingCamera>;
  readonly images: readonly WorkingImage[];
  readonly points: readonly WorkingPoint[];
}

export interface PoseSafetyModel {
  readonly images: readonly WorkingImage[];
}

interface PairEvaluation {
  readonly images: readonly [string, string];
  readonly roles: readonly string[];
  readonly status: 'scored' | 'inconclusive';
  readonly reason: string | null;
  readonly count: number;
  readonly metrics: {
    readonly errorsPx: readonly number[];
    readonly medianPx: number;
    readonly p90Px: number;
    readonly inlierCount: number;
    readonly inlierRatio: number;
    readonly coverage: readonly [number, number];
  } | null;
  readonly geometry: {
    readonly samples: readonly GeometrySample[];
    readonly failures: number;
    readonly positiveDepthRatio: number;
    readonly usableCount: number;
  };
  readonly support: {
    readonly trackIds: readonly number[];
    readonly trackCount: number;
    readonly observationCount: number;
    readonly usable: boolean;
  };
}

interface GeometrySample {
  readonly keypointIndices: readonly [number, number];
  readonly positiveDepth: boolean;
  readonly sufficientParallax: boolean;
  readonly parallaxDegrees: number | null;
  readonly failure: string | null;
}

export function evaluateBaselineGeometry(
  preflight: RefinerPreflight,
  model: WorkingModel,
  pairs: readonly BaselineGeometryPair[]
) {
  const evaluated = pairs.map((pair) => evaluatePair(model, pair));
  const violations = evaluated.flatMap((entry) => {
    const reasons: string[] = [];
    if (entry.status === 'inconclusive') {
      reasons.push(entry.reason ?? 'score unavailable');
    }
    if (
      entry.geometry.failures > 0 ||
      entry.geometry.usableCount < policy.minVerifiedMatches ||
      entry.geometry.positiveDepthRatio < policy.minPositiveDepthRatio ||
      !entry.support.usable
    ) {
      reasons.push('insufficient fixed-population geometry support');
    }
    return reasons.map(
      (reason) => `${entry.images.join(' / ')}: ${reason}.`
    );
  });
  const poseSafety = evaluatePoseSafety(preflight, model, model);
  violations.push(...poseSafety.violations);
  return {
    violations,
    pairs: evaluated.map((entry) => ({
      images: entry.images,
      status: entry.status,
      reason: entry.reason,
      count: entry.count,
      metrics: entry.metrics,
      geometry: entry.geometry,
      support: entry.support,
    })),
    poseSafety,
  };
}

export function decidePostBaVerdict(
  rejections: readonly string[],
  inconclusiveReasons: readonly string[]
): PostBaVerdict {
  if (rejections.length > 0) return 'Rejected';
  if (inconclusiveReasons.length > 0) return 'Inconclusive';
  return 'Pass';
}

export async function evaluatePostBaSafety(
  preflight: RefinerPreflight,
  run: PreparedRun
): Promise<PostBaVerdict> {
  const reportPath = join(run.runDirectory, 'metrics', 'post-ba-safety.json');
  let report: Record<string, unknown>;
  try {
    report = await evaluate(preflight, run);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const rejected = error instanceof CandidateViolationError;
    report = {
      schemaVersion: 1,
      policy,
      verdict: rejected ? 'Rejected' : 'Inconclusive',
      rejections: rejected ? [reason] : [],
      inconclusiveReasons: rejected ? [] : [reason],
    };
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
  });
  await writeFile(
    join(run.runDirectory, 'metrics', 'post-ba-safety.md'),
    postBaMarkdown(report),
    { flag: 'wx' }
  );
  return report.verdict as PostBaVerdict;
}

async function evaluate(
  preflight: RefinerPreflight,
  run: PreparedRun
): Promise<Record<string, unknown>> {
  const metricsDirectory = join(run.runDirectory, 'metrics');
  const evidenceDirectory = join(run.runDirectory, 'evidence');
  const baselineDirectory = join(run.runDirectory, 'exports', 'triangulated');
  const candidateDirectory = join(run.runDirectory, 'exports', 'adjusted');
  const [correspondenceBytes, preBaBytes, baBytes] = await Promise.all([
    readFile(join(metricsDirectory, 'correspondences.json')),
    readFile(join(metricsDirectory, 'pre-ba-support.json')),
    readFile(join(evidenceDirectory, 'ba-result.json')),
  ]);
  const preBa = parseRecord(preBaBytes, 'pre-BA support');
  const ba = await verifyBundleAdjustmentEvidence(preflight, run, false);
  if (preBa.status !== 'pass' || preBa.baParticipationEvaluated !== false) {
    throw new Error('Frozen pre-BA support is not a passing preparation gate.');
  }
  if (JSON.stringify(preBa.policy) !== JSON.stringify(policy)) {
    throw new Error('Frozen pre-BA policy differs from post-BA policy.');
  }
  if (
    ba.status !== 'pass' ||
    ba.solveCalled !== true ||
    ba.solutionUsable !== true ||
    !isRecord(ba.hardLocks) ||
    ba.hardLocks.passed !== true
  ) {
    throw new Error('BA result is not a usable hard-lock-passing solve.');
  }
  const frozenBindings = await verifyFrozenBindings(
    preflight,
    run,
    preBa,
    correspondenceBytes
  );
  if (
    JSON.stringify(ba.optimizationInputs) !== JSON.stringify(frozenBindings)
  ) {
    throw new Error('BA result is bound to different optimization inputs.');
  }
  const pairs = parseFrozenPairs(
    correspondenceBytes,
    requiredPairs(preflight),
    new Set(preflight.dataset.model.images.map((image) => image.name))
  );
  const [baseline, candidate] = await Promise.all([
    readModel(baselineDirectory),
    readModel(candidateDirectory),
  ]);
  requireSameModelIdentity(baseline, candidate);

  const before = pairs.map((pair) => evaluatePair(baseline, pair));
  const after = pairs.map((pair) => evaluatePair(candidate, pair));
  const rejections: string[] = [];
  const inconclusiveReasons: string[] = [];
  const performanceRejections: string[] = [];

  const baselineMedians = before.flatMap((entry) =>
    entry.status === 'scored' ? [entry.metrics!.medianPx] : []
  );
  const candidateMedians = after.flatMap((entry) =>
    entry.status === 'scored' ? [entry.metrics!.medianPx] : []
  );
  const aggregateImproved =
    baselineMedians.length === pairs.length &&
    candidateMedians.length === pairs.length
      ? median(baselineMedians) - median(candidateMedians) >
        policy.improvementTolerancePx
      : null;
  if (aggregateImproved === false) {
    performanceRejections.push('Aggregate epipolar error did not improve.');
  } else if (aggregateImproved === null) {
    inconclusiveReasons.push('Aggregate epipolar improvement is unavailable.');
  }

  const pairVetoes = before.map((baselinePair, index) => {
    const candidatePair = after[index]!;
    const vetoes: string[] = [];
    if (baselinePair.metrics && candidatePair.metrics) {
      if (
        candidatePair.metrics.medianPx - baselinePair.metrics.medianPx >
        policy.pairMedianRegressionPx
      ) {
        vetoes.push('median regression');
      }
      if (
        candidatePair.metrics.p90Px - baselinePair.metrics.p90Px >
        policy.pairP90RegressionPx
      ) {
        vetoes.push('p90 regression');
      }
      if (
        baselinePair.metrics.inlierRatio - candidatePair.metrics.inlierRatio >
        policy.maxInlierRatioDrop
      ) {
        vetoes.push('inlier-ratio drop');
      }
      for (let side = 0; side < 2; side++) {
        if (
          baselinePair.metrics.coverage[side]! -
            candidatePair.metrics.coverage[side]! >
          policy.maxCoverageDrop
        ) {
          vetoes.push(`${side === 0 ? 'first' : 'second'}-image coverage drop`);
        }
      }
    }
    if (vetoes.length > 0) {
      performanceRejections.push(
        `${baselinePair.images.join(' / ')}: ${vetoes.join(', ')}.`
      );
    }
    for (const entry of [baselinePair, candidatePair]) {
      if (entry.status === 'inconclusive') {
        inconclusiveReasons.push(
          `${entry.images.join(' / ')}: ${entry.reason ?? 'score unavailable'}.`
        );
      }
      if (
        entry.geometry.failures > 0 ||
        entry.geometry.usableCount < policy.minVerifiedMatches ||
        entry.geometry.positiveDepthRatio < policy.minPositiveDepthRatio ||
        !entry.support.usable
      ) {
        inconclusiveReasons.push(
          `${entry.images.join(' / ')}: insufficient fixed-population geometry support.`
        );
      }
    }
    return { images: baselinePair.images, vetoes };
  });

  const protectedPairs = before.map((baselinePair, pairIndex) => {
    const candidatePair = after[pairIndex]!;
    const protectedIdentities: (readonly [string, string, number, number])[] =
      [];
    const losses: string[] = [];
    const unavailable: string[] = [];
    baselinePair.geometry.samples.forEach((sample, matchIndex) => {
      if (
        sample.failure !== null ||
        !sample.positiveDepth ||
        !sample.sufficientParallax
      ) {
        return;
      }
      const identity = [
        baselinePair.images[0],
        baselinePair.images[1],
        sample.keypointIndices[0],
        sample.keypointIndices[1],
      ] as const;
      protectedIdentities.push(identity);
      const current = candidatePair.geometry.samples[matchIndex];
      if (current === undefined || !sameIndices(sample, current)) {
        losses.push(`${JSON.stringify(identity)}: identity changed`);
      } else if (current.failure !== null) {
        unavailable.push(`${JSON.stringify(identity)}: ${current.failure}`);
      } else if (!current.positiveDepth) {
        losses.push(`${JSON.stringify(identity)}: lost positive depth`);
      } else if (!current.sufficientParallax) {
        losses.push(`${JSON.stringify(identity)}: lost parallax`);
      }
    });
    rejections.push(...losses);
    inconclusiveReasons.push(...unavailable);
    return {
      images: baselinePair.images,
      protectedIdentities,
      losses,
      unavailable,
    };
  });

  const residualIdentities = residualObservationIdentities(ba, baseline);
  if (residualIdentities === null) {
    inconclusiveReasons.push('BA residual-selection evidence is malformed.');
  }
  const protectedTrackPairs = before.map((baselinePair, index) => {
    const candidateTracks = new Set(after[index]!.support.trackIds);
    const losses = baselinePair.support.trackIds.filter(
      (trackId) => !candidateTracks.has(trackId)
    );
    if (losses.length > 0) {
      rejections.push(
        `${baselinePair.images.join(' / ')}: protected BA tracks lost eligibility: ${losses.join(', ')}.`
      );
    }
    const participationLosses = baselinePair.support.trackIds.flatMap(
      (trackId) =>
        residualTrackParticipation(baseline, residualIdentities, trackId)
          ? []
          : [trackId]
    );
    if (participationLosses.length > 0) {
      inconclusiveReasons.push(
        `${baselinePair.images.join(' / ')}: BA participation is unverified for tracks ${participationLosses.join(', ')}.`
      );
    }
    return {
      images: baselinePair.images,
      protectedTrackIds: baselinePair.support.trackIds,
      losses,
      participationLosses,
    };
  });

  const baObservationLosses = protectedBaObservationLosses(baseline, candidate);
  if (baObservationLosses.length > 0) {
    rejections.push(
      `Previously valid BA observations lost positive depth: ${baObservationLosses.join(', ')}.`
    );
  }
  const connectivity = connectedComponents(
    candidate.images.map((image) => image.name),
    after
  );
  if (connectivity.length !== 1) {
    inconclusiveReasons.push(
      'Candidate required-pair support is disconnected.'
    );
  }
  const linkedObservationCount = baseline.points.reduce(
    (count, point) => count + point.track.length,
    0
  );
  const expectedResidualIdentities = new Set(
    baseline.points.flatMap((point) =>
      point.track.map(
        (entry) =>
          `${entry.imageId}:${entry.point2DIndex}:${point.point3DId}`
      )
    )
  );
  if (ba.scalarReprojectionResidualCount !== linkedObservationCount * 2) {
    inconclusiveReasons.push(
      'BA residual evidence does not cover every linked observation.'
    );
  }
  if (
    residualIdentities !== null &&
    (residualIdentities.size !== linkedObservationCount ||
      !sameSet(residualIdentities, expectedResidualIdentities))
  ) {
    inconclusiveReasons.push(
      'BA residual identity inventory does not exactly match linked observations.'
    );
  }

  const poseSafety = evaluatePoseSafety(preflight, baseline, candidate);
  rejections.push(...poseSafety.violations);
  if (inconclusiveReasons.length === 0) {
    rejections.push(...performanceRejections);
  }
  const verdict = decidePostBaVerdict(rejections, inconclusiveReasons);
  return {
    schemaVersion: 1,
    policy,
    bindings: {
      inputSha256: preflight.inputSha256,
      correspondencesSha256: sha256(correspondenceBytes),
      preBaSupportSha256: sha256(preBaBytes),
      baResultSha256: sha256(baBytes),
      optimizationInputs: frozenBindings,
    },
    verdict,
    finalAcceptance: false,
    nextRequiredGate:
      verdict === 'Pass' ? 'ZIP transfer and reopen verification' : null,
    rejections,
    inconclusiveReasons,
    comparison: {
      aggregateImproved,
      baselineMedianOfPairMediansPx:
        baselineMedians.length === pairs.length
          ? median(baselineMedians)
          : null,
      candidateMedianOfPairMediansPx:
        candidateMedians.length === pairs.length
          ? median(candidateMedians)
          : null,
      pairVetoes,
      deferredRejections:
        inconclusiveReasons.length > 0 ? performanceRejections : [],
    },
    baseline: before,
    candidate: after,
    protectedGeometry: {
      version: policy.protectedGeometryVersion,
      pairs: protectedPairs,
    },
    protectedBaSupport: {
      participationEvidence:
        'All reciprocal linked observations are included by the inspected all-image BA configuration.',
      scalarReprojectionResidualCount: ba.scalarReprojectionResidualCount,
      linkedObservationCount,
      pairs: protectedTrackPairs,
      observationLosses: baObservationLosses,
      connectedComponents: connectivity,
    },
    poseSafety,
  };
}

async function readModel(directory: string): Promise<WorkingModel> {
  const [camera, images, points] = await Promise.all([
    readFile(join(directory, 'cameras.txt'), 'utf8'),
    readFile(join(directory, 'images.txt'), 'utf8'),
    readFile(join(directory, 'points3D.txt'), 'utf8'),
  ]);
  return {
    camera: readWorkingCamera(camera),
    images: readWorkingImages(images),
    points: readWorkingPoints(points),
  };
}

async function verifyFrozenBindings(
  preflight: RefinerPreflight,
  run: PreparedRun,
  preBa: Record<string, unknown>,
  correspondenceBytes: Uint8Array
): Promise<Record<string, unknown>> {
  const bindings = requireRecord(preBa.bindings, 'Pre-BA bindings');
  const database = requireRecord(
    bindings.matchingDatabase,
    'Pre-BA matching database binding'
  );
  const model = requireRecord(
    bindings.triangulatedModel,
    'Pre-BA triangulated model binding'
  );
  const binaryModel = requireRecord(
    bindings.triangulatedBinaryModel,
    'Pre-BA triangulated binary model binding'
  );
  if (
    bindings.inputSha256 !== preflight.inputSha256 ||
    bindings.correspondencesSha256 !== sha256(correspondenceBytes) ||
    typeof database.path !== 'string' ||
    typeof database.sha256 !== 'string'
  ) {
    throw new Error('Pre-BA evidence bindings are stale or malformed.');
  }
  const databasePath = resolve(run.runDirectory, database.path);
  const databaseRelative = relative(run.runDirectory, databasePath);
  if (
    databaseRelative.startsWith('..') ||
    isAbsolute(databaseRelative) ||
    database.sha256 !== sha256(await readFile(databasePath))
  ) {
    throw new Error('Frozen matching database changed before scoring.');
  }
  for (const filename of ['cameras.txt', 'images.txt', 'points3D.txt']) {
    const path = join(run.runDirectory, 'exports', 'triangulated', filename);
    if (model[filename] !== sha256(await readFile(path))) {
      throw new Error(`Frozen triangulated ${filename} changed before scoring.`);
    }
  }
  for (const filename of [
    'cameras.bin',
    'frames.bin',
    'images.bin',
    'points3D.bin',
    'rigs.bin',
  ]) {
    const path = join(run.runDirectory, 'models', 'triangulated', filename);
    if (binaryModel[filename] !== sha256(await readFile(path))) {
      throw new Error(`Frozen triangulated ${filename} changed before scoring.`);
    }
  }
  return bindings;
}

function residualObservationIdentities(
  ba: Record<string, unknown>,
  baseline: WorkingModel
): ReadonlySet<string> | null {
  if (!isRecord(ba.residualSelection)) return null;
  const selection = ba.residualSelection;
  const linkedObservationCount = baseline.points.reduce(
    (count, point) => count + point.track.length,
    0
  );
  const imageIds = baseline.images
    .map((image) => image.imageId)
    .sort((left, right) => left - right);
  if (
    selection.method !== 'pycolmap-config-num-residuals-v2' ||
    selection.nativeApi !== 'BundleAdjustmentConfig.num_residuals' ||
    JSON.stringify(selection.configuredImageIds) !== JSON.stringify(imageIds) ||
    JSON.stringify(selection.reconstructionImageIds) !==
      JSON.stringify(imageIds) ||
    selection.linkedObservationCount !== linkedObservationCount ||
    selection.expectedScalarResidualCount !== linkedObservationCount * 2 ||
    selection.nativeScalarResidualCount !== linkedObservationCount * 2 ||
    ba.scalarReprojectionResidualCount !== linkedObservationCount * 2 ||
    !isRecord(selection.identityProof) ||
    selection.identityProof.status !== 'verified' ||
    selection.identityProof.method !==
      'native-residual-identity-inventory-v1' ||
    JSON.stringify(selection.identityProof.pycolmapBinaryHashes) !==
      JSON.stringify(ba.pycolmapBinaryHashes) ||
    !Array.isArray(selection.observationIdentities)
  ) {
    return null;
  }
  const identities = selection.observationIdentities.flatMap(
    (entry) =>
      isRecord(entry) &&
      Number.isSafeInteger(entry.imageId) &&
      Number.isSafeInteger(entry.point2DIndex) &&
      Number.isSafeInteger(entry.point3DId)
        ? [`${entry.imageId}:${entry.point2DIndex}:${entry.point3DId}`]
        : []
  );
  if (
    identities.length !== selection.observationIdentities.length ||
    new Set(identities).size !== identities.length
  ) {
    return null;
  }
  return new Set(identities);
}

function residualTrackParticipation(
  baseline: WorkingModel,
  identities: ReadonlySet<string> | null,
  trackId: number
): boolean {
  if (identities === null) return false;
  const point = baseline.points.find((entry) => entry.point3DId === trackId);
  return (
    point !== undefined &&
    point.track.every((entry) =>
      identities.has(`${entry.imageId}:${entry.point2DIndex}:${trackId}`)
    )
  );
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function evaluatePair(model: WorkingModel, pair: FrozenPair): PairEvaluation {
  const images = pair.images.map((name) =>
    requireImage(model.images, name)
  ) as [WorkingImage, WorkingImage];
  const rotations = images.map((image) => rotationMatrix(image.qvec)) as [
    readonly number[],
    readonly number[],
  ];
  const errors = epipolarErrors(model.camera, images, rotations, pair.matches);
  const cells: [Set<number>, Set<number>] = [new Set(), new Set()];
  errors.values.forEach((error, matchIndex) => {
    if (error > policy.inlierThresholdPx) return;
    pair.matches[matchIndex]!.xy.forEach(([x, y], side) => {
      const column = Math.min(
        policy.coverageGridColumns - 1,
        Math.floor((x * policy.coverageGridColumns) / model.camera.width)
      );
      const row = Math.min(
        policy.coverageGridRows - 1,
        Math.floor((y * policy.coverageGridRows) / model.camera.height)
      );
      cells[side]!.add(row * policy.coverageGridColumns + column);
    });
  });
  const coverage = cells.map(
    (set) => set.size / (policy.coverageGridRows * policy.coverageGridColumns)
  ) as [number, number];
  const metrics =
    errors.reason === null
      ? {
          errorsPx: errors.values,
          medianPx: median(errors.values),
          p90Px: [...errors.values].sort((a, b) => a - b)[
            Math.ceil(errors.values.length * 0.9) - 1
          ]!,
          inlierCount: errors.values.filter(
            (error) => error <= policy.inlierThresholdPx
          ).length,
          inlierRatio:
            errors.values.filter((error) => error <= policy.inlierThresholdPx)
              .length / errors.values.length,
          coverage,
        }
      : null;
  const reason =
    errors.reason ??
    (pair.matches.length < policy.minVerifiedMatches
      ? 'Insufficient verified matches'
      : coverage.some((value) => value < policy.minCoverageEachImage)
        ? 'Insufficient inlier coverage'
        : null);
  const geometrySamples = pair.matches.map((match) =>
    evaluateGeometry(model.camera, images, rotations, match)
  );
  const positiveDepthCount = geometrySamples.filter(
    (sample) => sample.positiveDepth
  ).length;
  const usableCount = geometrySamples.filter(
    (sample) => sample.positiveDepth && sample.sufficientParallax
  ).length;
  const supportTrackIds = new Set<number>();
  pair.matches.forEach((match, index) => {
    const observations = match.keypointIndices.map(
      (keypointIndex, side) => images[side]!.observations[keypointIndex]
    );
    const pointId = observations[0]?.point3DId;
    const point = model.points.find((entry) => entry.point3DId === pointId);
    if (
      pointId !== null &&
      pointId !== undefined &&
      pointId === observations[1]?.point3DId &&
      point !== undefined &&
      geometrySamples[index]!.positiveDepth &&
      geometrySamples[index]!.sufficientParallax &&
      metrics !== null &&
      metrics.errorsPx[index]! <= policy.inlierThresholdPx &&
      images.every(
        (image) => cameraDepth(image, point.xyz) > policy.depthEpsilon
      )
    ) {
      supportTrackIds.add(pointId);
    }
  });
  return {
    images: pair.images,
    roles: pair.roles,
    status: reason === null ? 'scored' : 'inconclusive',
    reason,
    count: pair.matches.length,
    metrics,
    geometry: {
      samples: geometrySamples,
      failures: geometrySamples.filter((sample) => sample.failure !== null)
        .length,
      positiveDepthRatio: pair.matches.length
        ? positiveDepthCount / pair.matches.length
        : 0,
      usableCount,
    },
    support: {
      trackIds: [...supportTrackIds].sort((a, b) => a - b),
      trackCount: supportTrackIds.size,
      observationCount: supportTrackIds.size * 2,
      usable:
        supportTrackIds.size >= policy.minUsableTracks &&
        supportTrackIds.size * 2 >= policy.minUsableObservations,
    },
  };
}

function epipolarErrors(
  camera: WorkingModel['camera'],
  images: readonly [WorkingImage, WorkingImage],
  rotations: readonly [readonly number[], readonly number[]],
  matches: readonly FrozenMatch[]
): { readonly values: readonly number[]; readonly reason: string | null } {
  const relativeRotation = multiply3(rotations[1], transpose3(rotations[0]));
  const rotatedTranslation = multiplyVector3(relativeRotation, images[0].tvec);
  const translation = images[1].tvec.map(
    (value, index) => value - rotatedTranslation[index]!
  );
  if (Math.hypot(...translation) <= policy.numericEpsilon) {
    return { values: [], reason: 'Zero or nonfinite baseline' };
  }
  const [fx, fy, cx, cy] = camera.params;
  if ([fx, fy, cx, cy].some((value) => value === undefined)) {
    return { values: [], reason: 'Incomplete PINHOLE calibration' };
  }
  const inverseK = [1 / fx!, 0, -cx! / fx!, 0, 1 / fy!, -cy! / fy!, 0, 0, 1];
  const skew = [
    0,
    -translation[2]!,
    translation[1]!,
    translation[2]!,
    0,
    -translation[0]!,
    -translation[1]!,
    translation[0]!,
    0,
  ];
  const raw = multiply3(
    multiply3(multiply3(transpose3(inverseK), skew), relativeRotation),
    inverseK
  );
  const norm = Math.hypot(...raw);
  if (!Number.isFinite(norm) || norm <= policy.numericEpsilon) {
    return { values: [], reason: 'Degenerate fundamental matrix' };
  }
  const f = raw.map((value) => value / norm);
  const ft = transpose3(f);
  const values: number[] = [];
  for (const match of matches) {
    if (
      match.xy.some(
        ([x, y]) =>
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          x < 0 ||
          x >= camera.width ||
          y < 0 ||
          y >= camera.height
      )
    ) {
      return { values: [], reason: 'Nonfinite or out-of-image correspondence' };
    }
    const first = [...match.xy[0], 1];
    const second = [...match.xy[1], 1];
    const secondLine = multiplyVector3(f, first);
    const firstLine = multiplyVector3(ft, second);
    const secondDenominator = Math.hypot(secondLine[0]!, secondLine[1]!);
    const firstDenominator = Math.hypot(firstLine[0]!, firstLine[1]!);
    if (
      secondDenominator <= policy.numericEpsilon ||
      firstDenominator <= policy.numericEpsilon
    ) {
      return { values: [], reason: 'Degenerate epipolar denominator' };
    }
    const residual = Math.abs(dot3(second, secondLine));
    values.push(
      (residual / secondDenominator + residual / firstDenominator) / 2
    );
  }
  return { values, reason: null };
}

function evaluateGeometry(
  camera: WorkingModel['camera'],
  images: readonly [WorkingImage, WorkingImage],
  rotations: readonly [readonly number[], readonly number[]],
  match: FrozenMatch
): GeometrySample {
  const failed = (failure: string, parallaxDegrees: number | null = null) => ({
    keypointIndices: match.keypointIndices,
    positiveDepth: false,
    sufficientParallax: false,
    parallaxDegrees,
    failure,
  });
  const frames = rotations.map((rotation, index) => ({
    rotation,
    centre: cameraCenter(images[index]!),
  }));
  const [fx, fy, cx, cy] = camera.params;
  const rays = match.xy.map(([x, y], side) =>
    multiplyVector3(transpose3(rotations[side]!), [
      (x - cx!) / fx!,
      (y - cy!) / fy!,
      1,
    ])
  );
  const parallaxDegrees = vectorAngle(rays[0]!, rays[1]!);
  if (
    parallaxDegrees === null ||
    distance3(frames[0]!.centre, frames[1]!.centre) <= policy.numericEpsilon
  ) {
    return failed('Zero/nonfinite baseline or ray', parallaxDegrees);
  }
  const rows = images.flatMap((image, side) => {
    const rotation = rotations[side]!;
    const p0 = [...rotation.slice(0, 3), image.tvec[0]!];
    const p1 = [...rotation.slice(3, 6), image.tvec[1]!];
    const p2 = [...rotation.slice(6, 9), image.tvec[2]!];
    const [x, y] = match.xy[side]!;
    return [
      p2.map((value, index) => (x - cx!) * value - fx! * p0[index]!),
      p2.map((value, index) => (y - cy!) * value - fy! * p1[index]!),
    ];
  });
  const point = triangulateDlt(rows);
  if (point === null)
    return failed('Failed or nonfinite DLT point', parallaxDegrees);
  const depths = images.map((image) => cameraDepth(image, point));
  if (depths.some((depth) => !Number.isFinite(depth))) {
    return failed('Nonfinite depth', parallaxDegrees);
  }
  return {
    keypointIndices: match.keypointIndices,
    positiveDepth: depths.every((depth) => depth > policy.depthEpsilon),
    sufficientParallax: parallaxDegrees >= policy.minParallaxDegrees,
    parallaxDegrees,
    failure: null,
  };
}

function protectedBaObservationLosses(
  baseline: WorkingModel,
  candidate: WorkingModel
): readonly string[] {
  const candidateImages = new Map(
    candidate.images.map((image) => [image.imageId, image])
  );
  const candidatePoints = new Map(
    candidate.points.map((point) => [point.point3DId, point])
  );
  const losses: string[] = [];
  for (const point of baseline.points) {
    const currentPoint = candidatePoints.get(point.point3DId)!;
    for (const member of point.track) {
      const beforeImage = baseline.images.find(
        (image) => image.imageId === member.imageId
      )!;
      if (cameraDepth(beforeImage, point.xyz) <= policy.depthEpsilon) continue;
      const afterImage = candidateImages.get(member.imageId)!;
      if (cameraDepth(afterImage, currentPoint.xyz) <= policy.depthEpsilon) {
        losses.push(
          `${beforeImage.name}:${member.point2DIndex}:${point.point3DId}`
        );
      }
    }
  }
  return losses;
}

export function evaluatePoseSafety(
  preflight: RefinerPreflight,
  baseline: PoseSafetyModel,
  candidate: PoseSafetyModel
) {
  const originals = new Map(
    preflight.dataset.model.images.map((image) => [image.name, image.pose])
  );
  const baselineByName = new Map(
    baseline.images.map((image) => [image.name, image])
  );
  const candidateByName = new Map(
    candidate.images.map((image) => [image.name, image])
  );
  const anchors = new Set(preflight.config.anchors);
  const frames = candidate.images.map((image) => {
    const original = originals.get(image.name)!;
    const before = baselineByName.get(image.name)!;
    const centreDelta = distance3(
      cameraCenterFromPose(original),
      cameraCenter(image)
    );
    const rotationQuaternionComponentDelta = quaternionDelta(
      original.qvec,
      image.qvec
    );
    const rotationDeltaDegrees = rotationDistance(
      rotationMatrix(original.qvec),
      rotationMatrix(image.qvec)
    );
    const anchorCentreDelta = anchors.has(image.name)
      ? distance3(cameraCenter(before), cameraCenter(image))
      : null;
    return {
      imageName: image.name,
      centreDelta,
      rotationQuaternionComponentDelta,
      rotationDeltaDegrees,
      anchorCentreDelta,
    };
  });
  const violations: string[] = [];
  for (const frame of frames) {
    if (frame.centreDelta > policy.maxCentreDelta) {
      violations.push(`${frame.imageName}: centre displacement exceeds limit.`);
    }
    if (frame.rotationQuaternionComponentDelta > policy.numericEpsilon) {
      violations.push(`${frame.imageName}: rotation changed.`);
    }
    if (
      frame.anchorCentreDelta !== null &&
      frame.anchorCentreDelta > policy.numericEpsilon
    ) {
      violations.push(`${frame.imageName}: anchor moved.`);
    }
  }
  const anchorDistances = preflight.config.anchors.slice(1).map((name) => {
    const firstOriginal = originals.get(preflight.config.anchors[0])!;
    const otherOriginal = originals.get(name)!;
    const before = distance3(
      cameraCenterFromPose(firstOriginal),
      cameraCenterFromPose(otherOriginal)
    );
    const after = distance3(
      cameraCenter(candidateByName.get(preflight.config.anchors[0])!),
      cameraCenter(candidateByName.get(name)!)
    );
    const ratio = before > policy.numericEpsilon ? after / before : null;
    if (ratio === null || Math.abs(ratio - 1) > policy.scaleTolerance) {
      violations.push(
        `${preflight.config.anchors[0]} / ${name}: scale changed.`
      );
    }
    return {
      images: [preflight.config.anchors[0], name],
      before,
      after,
      ratio,
    };
  });
  const trajectory = preflight.dataset.model.images
    .slice(1)
    .map((entry, index) => {
      const previous = candidateByName.get(
        preflight.dataset.model.images[index]!.name
      )!;
      const current = candidateByName.get(entry.name)!;
      const next = preflight.dataset.model.images[index + 2];
      const step = distance3(cameraCenter(previous), cameraCenter(current));
      const rotationDegrees = rotationDistance(
        rotationMatrix(previous.qvec),
        rotationMatrix(current.qvec)
      );
      const turnDegrees = next
        ? vectorAngle(
            subtract3(cameraCenter(current), cameraCenter(previous)),
            subtract3(
              cameraCenter(candidateByName.get(next.name)!),
              cameraCenter(current)
            )
          )
        : null;
      if (step > policy.maxSequentialStep) {
        violations.push(`${entry.name}: sequential step exceeds limit.`);
      }
      if (
        rotationDegrees > policy.maxSequentialTurnDegrees ||
        (turnDegrees !== null && turnDegrees > policy.maxSequentialTurnDegrees)
      ) {
        violations.push(`${entry.name}: sequential turn exceeds limit.`);
      }
      return {
        images: [previous.name, current.name],
        step,
        rotationDegrees,
        turnDegrees,
      };
    });
  return { violations, frames, anchorDistances, trajectory };
}

function requiredPairs(preflight: RefinerPreflight) {
  const result = new Map<
    string,
    { images: readonly [string, string]; roles: string[] }
  >();
  const add = (images: readonly [string, string], role: string) => {
    const key = pairKey(images);
    const previous = result.get(key);
    if (previous) previous.roles.push(role);
    else result.set(key, { images, roles: [role] });
  };
  preflight.sequentialPairs.forEach((pair) => add(pair, 'sequential'));
  preflight.config.loopPairs.forEach((pair) => add(pair, 'loop'));
  return [...result.values()];
}

function parseFrozenPairs(
  bytes: Uint8Array,
  required: readonly {
    readonly images: readonly [string, string];
    readonly roles: readonly string[];
  }[],
  imageNames: ReadonlySet<string>
): readonly FrozenPair[] {
  const value = parseRecord(bytes, 'correspondences');
  if (!Array.isArray(value.pairs))
    throw new Error('Correspondences lack pairs.');
  const parsed = new Map<string, FrozenPair>();
  for (const pairValue of value.pairs) {
    if (
      !isRecord(pairValue) ||
      !isStringPair(pairValue.images) ||
      !Array.isArray(pairValue.matches)
    ) {
      throw new Error('Correspondence pair is malformed.');
    }
    if (!pairValue.images.every((name) => imageNames.has(name))) {
      throw new Error('Correspondence pair references an unknown image.');
    }
    const roles =
      Array.isArray(pairValue.roles) &&
      pairValue.roles.every((role) => typeof role === 'string')
        ? pairValue.roles
        : [];
    const seen = [new Set<number>(), new Set<number>()];
    const matches = pairValue.matches.map((match): FrozenMatch => {
      if (
        !isRecord(match) ||
        !isNumberPair(match.keypointIndices, true) ||
        !Array.isArray(match.xy) ||
        match.xy.length !== 2 ||
        !match.xy.every((xy) => isNumberPair(xy, false))
      ) {
        throw new Error('Correspondence match is malformed.');
      }
      match.keypointIndices.forEach((index, side) => {
        if (seen[side]!.has(index))
          throw new Error('Correspondence identity is duplicated.');
        seen[side]!.add(index);
      });
      return {
        keypointIndices: match.keypointIndices,
        xy: [match.xy[0] as [number, number], match.xy[1] as [number, number]],
      };
    });
    parsed.set(pairKey(pairValue.images), {
      images: pairValue.images,
      roles,
      matches,
    });
  }
  if (parsed.size !== required.length)
    throw new Error('Correspondence pair population changed.');
  return required.map((entry) => {
    const pair = parsed.get(pairKey(entry.images));
    if (pair === undefined)
      throw new Error(`Missing required pair ${entry.images.join(' / ')}.`);
    return { ...pair, images: entry.images, roles: entry.roles };
  });
}

function requireSameModelIdentity(
  baseline: WorkingModel,
  candidate: WorkingModel
): void {
  if (JSON.stringify(baseline.camera) !== JSON.stringify(candidate.camera)) {
    throw new CandidateViolationError(
      'Candidate camera calibration differs from the baseline.'
    );
  }
  const candidateImages = new Map(
    candidate.images.map((image) => [image.name, image])
  );
  const candidatePoints = new Map(
    candidate.points.map((point) => [point.point3DId, point])
  );
  if (
    candidateImages.size !== baseline.images.length ||
    candidatePoints.size !== baseline.points.length
  ) {
    throw new CandidateViolationError(
      'Candidate image or point population differs from the baseline.'
    );
  }
  for (const image of baseline.images) {
    const current = candidateImages.get(image.name);
    if (
      current === undefined ||
      current.imageId !== image.imageId ||
      current.cameraId !== image.cameraId ||
      JSON.stringify(current.observations.map((entry) => entry.point3DId)) !==
        JSON.stringify(image.observations.map((entry) => entry.point3DId))
    ) {
      throw new CandidateViolationError(
        `Candidate image identity changed for ${image.name}.`
      );
    }
  }
  for (const point of baseline.points) {
    if (
      JSON.stringify(candidatePoints.get(point.point3DId)?.track) !==
      JSON.stringify(point.track)
    ) {
      throw new CandidateViolationError(
        `Candidate track identity changed for ${point.point3DId}.`
      );
    }
  }
}

function connectedComponents(
  names: readonly string[],
  pairs: readonly PairEvaluation[]
) {
  const edges = new Map(names.map((name) => [name, new Set<string>()]));
  pairs
    .filter((pair) => pair.support.usable)
    .forEach((pair) => {
      edges.get(pair.images[0])!.add(pair.images[1]);
      edges.get(pair.images[1])!.add(pair.images[0]);
    });
  const unseen = new Set(names);
  const result: string[][] = [];
  for (const name of names) {
    if (!unseen.delete(name)) continue;
    const component = [name];
    for (const current of component) {
      for (const neighbour of edges.get(current)!) {
        if (unseen.delete(neighbour)) component.push(neighbour);
      }
    }
    result.push(component);
  }
  return result;
}

function triangulateDlt(
  rows: readonly (readonly number[])[]
): readonly number[] | null {
  const scale = Math.max(...rows.flat().map(Math.abs));
  if (!Number.isFinite(scale) || scale === 0) return null;
  const columns = [0, 1, 2, 3].map((column) =>
    rows.map((row) => row[column]! / scale)
  );
  const vectors = [0, 1, 2, 3].map((column) =>
    [0, 1, 2, 3].map((row) => Number(column === row))
  );
  let converged = false;
  for (let sweep = 0; sweep < 64; sweep++) {
    converged = true;
    for (let first = 0; first < 3; first++) {
      for (let second = first + 1; second < 4; second++) {
        const left = columns[first]!;
        const right = columns[second]!;
        const aa = dot(left, left);
        const bb = dot(right, right);
        const ab = dot(left, right);
        if (
          Math.sqrt(aa) <= Number.EPSILON * 8 ||
          Math.sqrt(bb) <= Number.EPSILON * 8 ||
          Math.abs(ab) <= Number.EPSILON * 8 * Math.sqrt(aa * bb)
        )
          continue;
        converged = false;
        const tau = (bb - aa) / (2 * ab);
        const tangent =
          (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.hypot(1, tau));
        const cosine = 1 / Math.hypot(1, tangent);
        const sine = cosine * tangent;
        for (const matrix of [columns, vectors]) {
          const x = matrix[first]!;
          const y = matrix[second]!;
          matrix[first] = x.map(
            (value, index) => cosine * value - sine * y[index]!
          );
          matrix[second] = x.map(
            (value, index) => sine * value + cosine * y[index]!
          );
        }
      }
    }
    if (converged) break;
  }
  if (!converged) return null;
  const order = columns
    .map((column, index) => ({ index, norm: Math.hypot(...column) }))
    .sort((left, right) => left.norm - right.norm);
  if (order[1]!.norm - order[0]!.norm <= policy.numericEpsilon * order[3]!.norm)
    return null;
  const homogeneous = vectors[order[0]!.index]!;
  if (Math.abs(homogeneous[3]!) <= policy.numericEpsilon) return null;
  const point = homogeneous.slice(0, 3).map((value) => value / homogeneous[3]!);
  return point.every(Number.isFinite) ? point : null;
}

function rotationMatrix(qvec: readonly number[]): readonly number[] {
  const [w, x, y, z] = qvec;
  if (
    w === undefined ||
    x === undefined ||
    y === undefined ||
    z === undefined ||
    Math.abs(Math.hypot(w, x, y, z) - 1) > policy.quaternionTolerance
  )
    throw new Error('Pose has an invalid quaternion.');
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - w * z),
    2 * (x * z + w * y),
    2 * (x * y + w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z - w * x),
    2 * (x * z - w * y),
    2 * (y * z + w * x),
    1 - 2 * (x * x + y * y),
  ];
}

function cameraCenter(image: WorkingImage): readonly number[] {
  return cameraCenterFromPose({ qvec: image.qvec, tvec: image.tvec });
}

function cameraCenterFromPose(pose: {
  readonly qvec: readonly number[];
  readonly tvec: readonly number[];
}) {
  return multiplyVector3(transpose3(rotationMatrix(pose.qvec)), pose.tvec).map(
    (value) => -value || 0
  );
}

function cameraDepth(image: WorkingImage, point: readonly number[]): number {
  return dot3(rotationMatrix(image.qvec).slice(6, 9), point) + image.tvec[2]!;
}

function rotationDistance(
  first: readonly number[],
  second: readonly number[]
): number {
  const relative = multiply3(first, transpose3(second));
  return (
    (Math.atan2(
      Math.hypot(
        relative[7]! - relative[5]!,
        relative[2]! - relative[6]!,
        relative[3]! - relative[1]!
      ) / 2,
      (relative[0]! + relative[4]! + relative[8]! - 1) / 2
    ) *
      180) /
    Math.PI
  );
}

function quaternionDelta(
  first: readonly number[],
  second: readonly number[]
): number {
  const direct = Math.max(
    ...first.map((value, index) => Math.abs(value - second[index]!))
  );
  const negated = Math.max(
    ...first.map((value, index) => Math.abs(value + second[index]!))
  );
  return Math.min(direct, negated);
}

function vectorAngle(
  first: readonly number[],
  second: readonly number[]
): number | null {
  const firstNorm = Math.hypot(...first);
  const secondNorm = Math.hypot(...second);
  if (firstNorm <= policy.numericEpsilon || secondNorm <= policy.numericEpsilon)
    return null;
  const cosine = dot(first, second) / (firstNorm * secondNorm);
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
}

function multiply3(
  first: readonly number[],
  second: readonly number[]
): number[] {
  return first.map((_, index) =>
    [0, 1, 2].reduce(
      (sum, inner) =>
        sum +
        first[Math.floor(index / 3) * 3 + inner]! *
          second[inner * 3 + (index % 3)]!,
      0
    )
  );
}

function multiplyVector3(
  matrix: readonly number[],
  vector: readonly number[]
): number[] {
  return [0, 1, 2].map(
    (row) =>
      matrix[row * 3]! * vector[0]! +
      matrix[row * 3 + 1]! * vector[1]! +
      matrix[row * 3 + 2]! * vector[2]!
  );
}

function transpose3(matrix: readonly number[]): number[] {
  return [
    matrix[0]!,
    matrix[3]!,
    matrix[6]!,
    matrix[1]!,
    matrix[4]!,
    matrix[7]!,
    matrix[2]!,
    matrix[5]!,
    matrix[8]!,
  ];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function subtract3(first: readonly number[], second: readonly number[]) {
  return first.map((value, index) => value - second[index]!);
}

function distance3(first: readonly number[], second: readonly number[]) {
  return Math.hypot(...subtract3(first, second));
}

function dot(first: readonly number[], second: readonly number[]) {
  return first.reduce((sum, value, index) => sum + value * second[index]!, 0);
}

function dot3(first: readonly number[], second: readonly number[]) {
  return (
    first[0]! * second[0]! + first[1]! * second[1]! + first[2]! * second[2]!
  );
}

function requireImage(
  images: readonly WorkingImage[],
  name: string
): WorkingImage {
  const image = images.find((entry) => entry.name === name);
  if (image === undefined)
    throw new Error(`Working model lacks image ${name}.`);
  return image;
}

function sameIndices(first: GeometrySample, second: GeometrySample): boolean {
  return (
    first.keypointIndices[0] === second.keypointIndices[0] &&
    first.keypointIndices[1] === second.keypointIndices[1]
  );
}

function pairKey(pair: readonly [string, string]) {
  return [...pair].sort().join('\0');
}

function parseRecord(
  bytes: Uint8Array,
  field: string
): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (!isRecord(value)) throw new Error(`${field} must be a JSON object.`);
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be a JSON object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringPair(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((entry) => typeof entry === 'string')
  );
}

function isNumberPair(
  value: unknown,
  integer: boolean
): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(
      (entry) =>
        typeof entry === 'number' &&
        Number.isFinite(entry) &&
        (!integer || (Number.isSafeInteger(entry) && entry >= 0))
    )
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function postBaMarkdown(report: Record<string, unknown>): string {
  const rejections = Array.isArray(report.rejections) ? report.rejections : [];
  const inconclusive = Array.isArray(report.inconclusiveReasons)
    ? report.inconclusiveReasons
    : [];
  return `${[
    '# Post-BA geometry safety',
    '',
    `Verdict: ${String(report.verdict)}`,
    '',
    'This is a geometry verdict only. It is not final ZIP acceptance.',
    '',
    '## Rejections',
    '',
    ...(rejections.length
      ? rejections.map((entry) => `- ${String(entry)}`)
      : ['- None']),
    '',
    '## Inconclusive evidence',
    '',
    ...(inconclusive.length
      ? inconclusive.map((entry) => `- ${String(entry)}`)
      : ['- None']),
    '',
  ].join('\n')}\n`;
}
