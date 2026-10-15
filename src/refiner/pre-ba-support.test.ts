import { describe, expect, it } from 'vitest';

import type { RecorderDataset } from '../colmap/index.js';
import { evaluateBaselineGeometry } from './post-ba-safety.js';
import type { RefinerPreflight } from './preflight.js';
import {
  anchorScaleDistances,
  hasNonzeroAnchorScale,
} from './pre-ba-support.js';
import type { WorkingImage, WorkingPoint } from './triangulation.js';

describe('anchorScaleDistances', () => {
  it('exposes coincident anchors as a zero scale constraint', () => {
    const image = (name: string): WorkingImage => ({
      imageId: name.charCodeAt(0),
      cameraId: 1,
      name,
      qvec: [1, 0, 0, 0],
      tvec: [0, 0, 0],
      observations: [],
    });

    const distances = anchorScaleDistances(
      [image('a'), image('b'), image('c')],
      [
        'a',
        'b',
        'c',
      ]
    );

    expect(distances).toEqual([0, 0, 0]);
    expect(hasNonzeroAnchorScale(distances)).toBe(false);
  });
});

describe('pre-BA baseline geometry', () => {
  it('rejects a full match population with unobservable parallax', () => {
    const names = ['a.jpg', 'b.jpg', 'c.jpg'] as const;
    const images = names.map(
      (name, imageIndex): WorkingImage => ({
        imageId: imageIndex + 1,
        cameraId: 1,
        name,
        qvec: [1, 0, 0, 0],
        tvec: [-imageIndex * 0.2, 0, 0],
        observations:
          imageIndex < 2
            ? Array.from({ length: 15 }, (_, pointIndex) => ({
                x: 320,
                y: 240,
                point3DId: pointIndex + 1,
              }))
            : [],
      })
    );
    const points: WorkingPoint[] = Array.from(
      { length: 15 },
      (_, pointIndex) => ({
        point3DId: pointIndex + 1,
        xyz: [0, 0, 3],
        track: [
          { imageId: 1, point2DIndex: pointIndex },
          { imageId: 2, point2DIndex: pointIndex },
        ],
      })
    );
    const recorderImages = images.map((image) => ({
      imageId: image.imageId,
      cameraId: 1,
      name: image.name,
      pose: { qvec: image.qvec, tvec: image.tvec },
      observations: [],
    }));
    const preflight = {
      config: { anchors: names },
      dataset: {
        model: { images: recorderImages },
      } as unknown as RecorderDataset,
    } as RefinerPreflight;

    const result = evaluateBaselineGeometry(
      preflight,
      {
        camera: {
          cameraId: 1,
          width: 640,
          height: 480,
          params: [500, 500, 320, 240],
        },
        images,
        points,
      },
      [
        {
          images: [names[0], names[1]],
          roles: ['sequential'],
          matches: Array.from({ length: 15 }, (_, index) => ({
            keypointIndices: [index, index],
            xy: [
              [320, 240],
              [320, 240],
            ],
          })),
        },
      ]
    );

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('insufficient fixed-population geometry support'),
      ])
    );
  });
});
