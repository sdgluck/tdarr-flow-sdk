/**
 * The projection of a Tdarr file record down to what deciding its fate needs.
 *
 * A real record is about 10.4 kB: scan history, health-check results, MediaInfo,
 * per-stream `disposition` maps, `statSync`. A library of 23,846 of them is a
 * quarter of a gigabyte, and the whole point of scanning is to fold them into
 * counters, so holding the raw rows would be holding 250 MB to produce a few
 * dozen numbers. Projected, the same 10,000 records are 2.1 MB.
 *
 * `project` is therefore not a convenience - it is the thing that lets a scan of
 * an arbitrarily large library run in constant memory. The scanner calls it on
 * every row as the response is walked, and drops the raw row immediately.
 *
 * What is kept is decided by what the simulators in `plugins.ts` actually read,
 * and those were transcribed from the vendored plugin bodies. Two fields look
 * redundant and are not:
 *
 *  - `_id` is the *path*, and `checkFileExtension` takes the extension from it
 *    rather than from `container`. The two disagree after a remux.
 *  - `file_size` is decimal MB, and `checkFileSize` computes bytes as
 *    `file_size * 1000 * 1000` rather than reading `statSync.size`.
 */

/** One ffprobe stream, narrowed to the properties a check plugin can read. */
export interface MediaStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  /** `checkHdr` looks for `dvhe`/`dvav`/`dav1`/`dvh11` in here. */
  codec_tag_string?: string;
  channels?: number;
  sample_rate?: string;
  bit_rate?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  bits_per_raw_sample?: number;
  color_transfer?: string;
  color_primaries?: string;
  color_range?: string;
  tags?: Record<string, string>;
}

export interface MediaRecord {
  /** The full path. `checkFileExtension` and `checkFileNameIncludes` read this. */
  _id: string;
  /** Library id, matching `LibrarySummary.id`. */
  DB: string;
  /** Decimal MB. `checkFileSize` multiplies by 1000 * 1000. */
  file_size: number;
  /** `video`, `audio`, `other` - or absent, which makes `checkFileMedium` throw. */
  fileMedium?: string;
  video_resolution?: string;
  video_codec_name?: string;
  audio_codec_name?: string;
  container?: string;
  duration?: number;
  bit_rate?: number;
  ffProbeData?: { streams?: MediaStream[] };
  /** `checkAudioCodec` falls back to this when the ffprobe bitrate is missing. */
  mediaInfo?: { track?: Array<{ BitRate?: string | number }> };
}

/** Exactly the keys `project` emits. Exported so a test can assert nothing leaks. */
export const PROJECTED_KEYS = [
  'DB',
  '_id',
  'audio_codec_name',
  'bit_rate',
  'container',
  'duration',
  'ffProbeData',
  'fileMedium',
  'file_size',
  'mediaInfo',
  'video_codec_name',
  'video_resolution',
] as const;

const STREAM_KEYS = [
  'bit_rate',
  'bits_per_raw_sample',
  'channels',
  'codec_name',
  'codec_tag_string',
  'codec_type',
  'color_primaries',
  'color_range',
  'color_transfer',
  'height',
  'index',
  'pix_fmt',
  'sample_rate',
  'tags',
  'width',
] as const;

function num(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function projectStream(raw: unknown): MediaStream {
  const source = raw as Record<string, unknown>;
  const stream: Record<string, unknown> = {};
  for (const key of STREAM_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== null) stream[key] = value;
  }
  return stream as MediaStream;
}

/**
 * Narrows one raw row, or returns null if it is not a usable file record.
 *
 * Null rather than throwing: a scan walks tens of thousands of rows written by
 * several Tdarr versions, and one malformed row should be counted and skipped,
 * not abort the whole thing. The caller reports how many were skipped.
 */
export function project(raw: unknown): MediaRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;

  const id = str(source['_id']);
  if (!id) return null;

  const streams = (source['ffProbeData'] as { streams?: unknown } | undefined)?.streams;
  const tracks = (source['mediaInfo'] as { track?: unknown } | undefined)?.track;

  const record: MediaRecord = {
    _id: id,
    DB: str(source['DB']) ?? '',
    // Absent size is 0, not undefined: `checkFileSize` would coerce it to 0
    // anyway, and a number keeps every consumer from re-testing for undefined.
    file_size: num(source['file_size']) ?? 0,
    ffProbeData: {
      streams: Array.isArray(streams) ? streams.map(projectStream) : undefined,
    },
  };

  // Assigned conditionally so an absent property stays absent. `checkFileMedium`
  // distinguishes "no fileMedium" (it throws) from any string value, so writing
  // `undefined` in and reading it back out must not become `'undefined'`.
  const medium = str(source['fileMedium']);
  if (medium !== undefined) record.fileMedium = medium;
  const resolution = str(source['video_resolution']);
  if (resolution !== undefined) record.video_resolution = resolution;
  const videoCodec = str(source['video_codec_name']);
  if (videoCodec !== undefined) record.video_codec_name = videoCodec;
  const audioCodec = str(source['audio_codec_name']);
  if (audioCodec !== undefined) record.audio_codec_name = audioCodec;
  const container = str(source['container']);
  if (container !== undefined) record.container = container;
  const duration = num(source['duration']);
  if (duration !== undefined) record.duration = duration;
  const bitRate = num(source['bit_rate']);
  if (bitRate !== undefined) record.bit_rate = bitRate;

  if (Array.isArray(tracks)) {
    record.mediaInfo = {
      track: tracks.map((track) => {
        const rate = (track as Record<string, unknown> | null)?.['BitRate'];
        return typeof rate === 'string' || typeof rate === 'number' ? { BitRate: rate } : {};
      }),
    };
  }

  return record;
}
