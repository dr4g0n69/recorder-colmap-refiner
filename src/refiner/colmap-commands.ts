import type { PinholeCamera } from '../colmap/index.js';
import type { NativeCommand } from './native-command.js';

export function colmapIdentityCommand(
  executable: string,
  runDirectory: string
): NativeCommand {
  return {
    stage: 'colmap-identity',
    executable,
    args: ['-h'],
    cwd: runDirectory,
  };
}

export function featureExtractionCommand(
  executable: string,
  runDirectory: string,
  camera: PinholeCamera
): NativeCommand {
  const { fx, fy, cx, cy } = camera.intrinsics;
  return {
    stage: 'feature-extractor',
    executable,
    args: [
      'feature_extractor',
      '--database_path',
      'database/features.db',
      '--image_path',
      'images',
      '--ImageReader.single_camera',
      '1',
      '--ImageReader.camera_model',
      camera.model,
      '--ImageReader.camera_params',
      [fx, fy, cx, cy].join(','),
      '--FeatureExtraction.use_gpu',
      '0',
      '--FeatureExtraction.num_threads',
      '4',
    ],
    cwd: runDirectory,
  };
}

export function exhaustiveMatchingCommand(
  executable: string,
  runDirectory: string
): NativeCommand {
  return {
    stage: 'exhaustive-matcher',
    executable,
    args: [
      'exhaustive_matcher',
      '--database_path',
      'database/exhaustive.db',
      '--FeatureMatching.use_gpu',
      '1',
      '--FeatureMatching.gpu_index',
      '0',
    ],
    cwd: runDirectory,
    timeoutMs: 30 * 60 * 1000,
  };
}

export function selectedMatchingCommand(
  executable: string,
  runDirectory: string
): NativeCommand {
  return {
    stage: 'selected-matcher',
    executable,
    args: [
      'matches_importer',
      '--database_path',
      'database/selected.db',
      '--match_list_path',
      'evidence/selected-pairs.txt',
      '--match_type',
      'pairs',
      '--FeatureMatching.use_gpu',
      '1',
      '--FeatureMatching.gpu_index',
      '0',
    ],
    cwd: runDirectory,
    timeoutMs: 30 * 60 * 1000,
  };
}

export function triangulationCommand(
  executable: string,
  runDirectory: string,
  databasePath: string
): NativeCommand {
  return {
    stage: 'point-triangulator',
    executable,
    args: [
      'point_triangulator',
      '--database_path',
      databasePath,
      '--image_path',
      'images',
      '--input_path',
      'models/known',
      '--output_path',
      'models/triangulated',
      '--Mapper.ba_refine_focal_length',
      '0',
      '--Mapper.ba_refine_principal_point',
      '0',
      '--Mapper.ba_refine_extra_params',
      '0',
      '--Mapper.tri_ignore_two_view_tracks',
      '0',
      '--Mapper.filter_max_reproj_error',
      '15',
    ],
    cwd: runDirectory,
  };
}

export function modelConversionCommand(
  executable: string,
  runDirectory: string
): NativeCommand {
  return {
    stage: 'model-converter',
    executable,
    args: [
      'model_converter',
      '--input_path',
      'models/triangulated',
      '--output_path',
      'exports/triangulated',
      '--output_type',
      'TXT',
    ],
    cwd: runDirectory,
  };
}
