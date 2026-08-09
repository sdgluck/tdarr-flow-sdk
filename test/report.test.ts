/**
 * The scan report, over the real 35-node pipeline.
 *
 * The distributions in the fixture come from a real library of 23,846 files:
 * almost everything is already hevc in an mkv with a 6-channel track, which is
 * exactly the situation the feature exists to reveal.
 */

import { describe, expect, it } from 'vitest';
import { compileSpec } from '../src/recipes/index.ts';
import { prepareFlow, ScanAccumulator } from '../src/simulate/index.ts';
import type { MediaRecord } from '../src/simulate/index.ts';
import { pipelineSpec } from './pipelineSpec.ts';

function media(overrides: Partial<MediaRecord> & { _id: string }): MediaRecord {
  return {
    DB: 'lib1',
    file_size: 4000,
    fileMedium: 'video',
    container: 'mkv',
    video_resolution: '1080p',
    video_codec_name: 'hevc',
    audio_codec_name: 'eac3',
    ffProbeData: {
      streams: [
        { codec_type: 'video', codec_name: 'hevc' },
        { codec_type: 'audio', codec_name: 'eac3', channels: 6 },
      ],
    },
    ...overrides,
  };
}

/** Roughly the shape of the real library: mostly hevc, a little h264, one stray. */
const LIBRARY: MediaRecord[] = [
  ...Array.from({ length: 8 }, (_, i) => media({ _id: `/mnt/media/film/hevc-${i}.mkv` })),
  ...Array.from({ length: 2 }, (_, i) =>
    media({
      _id: `/mnt/media/film/h264-${i}.mkv`,
      video_codec_name: 'h264',
      ffProbeData: {
        streams: [
          { codec_type: 'video', codec_name: 'h264' },
          { codec_type: 'audio', codec_name: 'ac3', channels: 6 },
        ],
      },
    })),
  media({
    _id: '/mnt/media/film/music.flac',
    fileMedium: 'audio',
    container: 'flac',
    video_codec_name: '',
    audio_codec_name: 'flac',
  }),
];

const run = (records: MediaRecord[], variables: Record<string, string> = {}) => {
  const prepared = prepareFlow(compileSpec(pipelineSpec), { variables });
  const accumulator = new ScanAccumulator(prepared);
  for (const record of records) accumulator.add(record);
  return accumulator.report();
};

describe('the report over the reference pipeline', () => {
  it('accounts for every scanned file exactly once', () => {
    const report = run(LIBRARY);
    const total = report.modified.files + report.untouched.files
      + report.rejected.files + report.indeterminate.files;
    expect(report.scanned.files).toBe(LIBRARY.length);
    // The four verdicts partition the library. `retentionUncertain` is a subset
    // of `modified`, never a fifth bucket, so it must not appear in this sum.
    expect(total).toBe(LIBRARY.length);
    expect(report.scanned.megabytes).toBe(11 * 4000);
  });

  it('rejects the audio file at the source gate', () => {
    const report = run(LIBRARY);
    expect(report.rejected.files).toBe(1);
    const sample = report.samples.rejected[0]!;
    expect(sample.id).toBe('/mnt/media/film/music.flac');
    expect(sample.branches[0]).toMatchObject({ ref: 'checkFileMedium@1.0.0', handle: 2 });
  });

  it('counts every video file as processed', () => {
    const report = run(LIBRARY);
    expect(report.modified.files).toBe(10);
    expect(report.indeterminate.files).toBe(0);
  });

  it('marks the outcome uncertain, because a classic plugin may decline', () => {
    // This pipeline's first action wraps a classic remux plugin, whose own logic
    // is not modelled here. Counting the file as processed is the safe direction
    // - it overstates rather than hides work - but saying so is the difference
    // between a number and an honest number.
    const report = run(LIBRARY);
    expect(report.retentionUncertain.files).toBe(10);
    expect(report.retentionUncertain.files).toBeLessThanOrEqual(report.modified.files);
  });

  it('builds a funnel labelled with the catalog\'s own wording', () => {
    const report = run(LIBRARY);
    const medium = report.funnel.find((step) => step.ref === 'checkFileMedium@1.0.0')!;

    expect(medium.reached.files).toBe(11);
    expect(medium.outcomes.find((outcome) => outcome.handle === 1)).toMatchObject({
      label: 'File medium is a Video',
      wired: true,
      bucket: { files: 10 },
    });
    // The audio handle is deliberately dangling in the source recipe, and the
    // funnel shows it as a dead end rather than an unexplained disappearance.
    expect(medium.outcomes.find((outcome) => outcome.handle === 2)).toMatchObject({
      wired: false,
      bucket: { files: 1 },
    });
  });

  it('breaks values down as scanned versus modified', () => {
    const report = run(LIBRARY);
    const codecs = report.breakdowns.find((breakdown) => breakdown.key === 'video_codec_name')!;

    expect(codecs.values.find((value) => value.value === 'hevc'))
      .toMatchObject({ scanned: { files: 8 }, modified: { files: 8 } });
    // The stray file is counted but not modified, which is the whole comparison
    // the two columns exist to make.
    expect(codecs.values.find((value) => value.value === '(none)'))
      .toMatchObject({ scanned: { files: 1 }, modified: { files: 0 } });
  });

  it('keeps a bounded number of samples however large the library is', () => {
    const many = Array.from({ length: 500 }, (_, i) => media({ _id: `/mnt/media/film/f${i}.mkv` }));
    const report = run(many);
    expect(report.scanned.files).toBe(500);
    for (const samples of Object.values(report.samples)) {
      expect(samples.length).toBeLessThanOrEqual(5);
    }
  });

  it('counts rows it could not project rather than dropping them silently', () => {
    const prepared = prepareFlow(compileSpec(pipelineSpec));
    const accumulator = new ScanAccumulator(prepared);
    accumulator.skip();
    accumulator.skip();
    expect(accumulator.report().skipped).toBe(2);
  });
});
