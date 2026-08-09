/**
 * What each check plugin decides, given a file.
 *
 * Every entry here is a **transcription of the vendored plugin body** under
 * `vendor/FlowPlugins/CommunityFlowPlugins/<category>/<name>/<version>/index.js`,
 * not an interpretation of what the plugin is called or what its tooltip says.
 * That distinction is the whole reason this file can be trusted, and three cases
 * show why guessing from the name would have been wrong:
 *
 *  - `checkFileExtension` reads the extension off `inputFileObj._id`, the path -
 *    not the `container` field, which is the obvious one to reach for and which
 *    disagrees with the path after a remux.
 *  - `checkFileSize` computes `file_size * 1000 * 1000` - decimal MB off the
 *    denormalised field, never `statSync.size` - and both bounds are inclusive.
 *  - `checkVideoCodec` scans `ffProbeData.streams`, and never looks at the
 *    top-level `video_codec_name`.
 *
 * `scripts/check-simulators.ts` fails `pnpm check` if a ref here stops resolving
 * or if its output count moves, which is the failure that a version bump causes.
 *
 * # The three states, and why they must stay apart
 *
 * 1. **Modelled** - returns a handle.
 * 2. **Registered-unknowable** - present, but always returns `unknowable`. The
 *    answer depends on something that does not exist until the flow has already
 *    run: the size of a file that has not been encoded yet, whether an earlier
 *    step changed anything, which worker picked the job up. *We know that we
 *    cannot know.*
 * 3. **Unmodelled** - absent. *We do not know whether we could know.*
 *
 * Reporting (2) and (3) as one bucket would be the easy thing and would destroy
 * the report's value: (2) is a permanent property of the plugin and no amount of
 * work will improve it, while (3) is a gap in this file, and the count of files
 * stopped by one is precisely the signal for which gap to close next.
 */

import type { MediaRecord, MediaStream } from './record.ts';

export type InputValue = string | number | boolean;

export type Outcome =
  | { kind: 'handle'; handle: number }
  /** Not knowable before the flow runs. See state (2) above. */
  | { kind: 'unknowable'; reason: string }
  /** The vendored body throws on this record, and so would Tdarr. */
  | { kind: 'threw'; reason: string };

export interface SimulationEnv {
  /**
   * Flow variables the user has bound, e.g.
   * `{'args.configVars.config.nodeName': 'Nvidia'}`. Anything unbound stays
   * unknowable rather than being guessed.
   */
  variables: Readonly<Record<string, string>>;
}

export interface Simulator {
  /** `name@version`, matching the vendored directory this transcribes. */
  ref: string;
  /** What each handle means, from the vendored source. Used as report copy. */
  handles: Record<number, string>;
  evaluate(
    record: MediaRecord,
    inputs: Readonly<Record<string, InputValue>>,
    env: SimulationEnv,
  ): Outcome;
}

const handle = (n: number): Outcome => ({ kind: 'handle', handle: n });
const unknowable = (reason: string): Outcome => ({ kind: 'unknowable', reason });
const threw = (reason: string): Outcome => ({ kind: 'threw', reason });

const streamsOf = (record: MediaRecord): MediaStream[] | undefined =>
  Array.isArray(record.ffProbeData?.streams) ? record.ffProbeData.streams : undefined;

/** `getContainer` in the vendored `fileUtils`: everything after the last dot. */
const containerOf = (path: string): string => {
  const parts = path.split('.');
  return (parts[parts.length - 1] ?? '').toLowerCase();
};

const csv = (value: InputValue | undefined): string[] =>
  String(value ?? '').trim().split(',').map((item) => item.trim()).filter((item) => item.length > 0);

// --- modelled ---------------------------------------------------------------

const MODELLED: Simulator[] = [
  {
    ref: 'checkFileMedium@1.0.0',
    handles: { 1: 'File medium is a Video', 2: 'File medium is Audio', 3: 'File medium is Other' },
    evaluate(record) {
      switch (record.fileMedium) {
        case 'video':
          return handle(1);
        case 'audio':
          return handle(2);
        case 'other':
          return handle(3);
        default:
          // The vendored body throws rather than defaulting. A file Tdarr never
          // finished scanning would stop the flow here, so the scan says so.
          return threw('File has no fileMedium!');
      }
    },
  },

  {
    ref: 'checkFileExtension@1.0.0',
    handles: { 1: 'File is one of those specified', 2: 'File is not one of those specified' },
    evaluate(record, inputs) {
      const wanted = String(inputs['extensions'] ?? '').trim().split(',')
        .map((row) => row.toLowerCase());
      return handle(wanted.includes(containerOf(record._id)) ? 1 : 2);
    },
  },

  {
    ref: 'checkFileSize@1.0.0',
    handles: { 1: 'File size is within range specified', 2: 'File size is not within range' },
    evaluate(record, inputs) {
      const scale = { B: 1, KB: 1000, MB: 1_000_000, GB: 1_000_000_000 }[
        String(inputs['unit'] ?? 'MB')
      ] ?? 1;
      const bytes = record.file_size * 1000 * 1000;
      const lower = Number(inputs['greaterThan'] ?? 0) * scale;
      const upper = Number(inputs['lessThan'] ?? 0) * scale;
      // Both bounds inclusive, matching the vendored `>= && <=`.
      return handle(bytes >= lower && bytes <= upper ? 1 : 2);
    },
  },

  {
    ref: 'checkVideoCodec@1.0.0',
    handles: { 1: 'File has codec specified', 2: 'File does not have codec specified' },
    evaluate(record, inputs) {
      const streams = streamsOf(record) ?? [];
      const wanted = String(inputs['codec'] ?? '');
      const found = streams.some((s) => s.codec_type === 'video' && s.codec_name === wanted);
      return handle(found ? 1 : 2);
    },
  },

  {
    ref: 'checkAudioCodec@1.0.0',
    handles: { 1: 'File has audio codec specified', 2: 'File does not have audio codec' },
    evaluate(record, inputs) {
      const streams = streamsOf(record) ?? [];
      const wanted = String(inputs['codec'] ?? '');
      const checkBitrate = inputs['checkBitrate'] === true || inputs['checkBitrate'] === 'true';
      const lower = Number(inputs['greaterThan'] ?? 0);
      const upper = Number(inputs['lessThan'] ?? 0);

      const found = streams.some((stream, index) => {
        const matches = stream.codec_name === wanted
          || (wanted === 'wma' && stream.codec_name?.startsWith('wma') === true);
        if (stream.codec_type !== 'audio' || !matches) return false;
        if (!checkBitrate) return true;

        const ffprobe = Number(stream.bit_rate ?? 0);
        // The vendored body indexes mediaInfo.track at index + 1: track 0 is the
        // container's General track, so stream N is track N+1.
        const mediaInfo = Number(record.mediaInfo?.track?.[index + 1]?.BitRate ?? 0);
        return (ffprobe > lower && ffprobe < upper) || (mediaInfo > lower && mediaInfo < upper);
      });

      return handle(found ? 1 : 2);
    },
  },

  {
    ref: 'checkChannelCount@1.0.0',
    handles: { 1: 'File has specified channel count', 2: 'File does not have channel count' },
    evaluate(record, inputs) {
      const streams = streamsOf(record);
      if (!streams) return threw('File has no stream data');
      const wanted = Number(inputs['channelCount'] ?? 0);
      // No codec_type filter in the vendored body - any stream with a matching
      // `channels` counts, though in practice only audio streams have one.
      return handle(streams.some((s) => s.channels === wanted) ? 1 : 2);
    },
  },

  {
    ref: 'checkStreamProperty@1.0.0',
    handles: { 1: 'File has matching stream property', 2: 'File has no matching stream property' },
    evaluate(record, inputs) {
      const property = String(inputs['propertyToCheck'] ?? '').trim();
      const wanted = csv(inputs['valuesToMatch']).map((value) => value.toLowerCase());
      if (!property || wanted.length === 0) return handle(2);

      const streamType = String(inputs['streamType'] ?? 'all');
      const condition = String(inputs['condition'] ?? 'equals');

      let streams = streamsOf(record);
      if (!streams) return handle(2);
      if (streamType !== 'all') {
        streams = streams.filter((s) => s.codec_type === streamType);
        if (streams.length === 0) return handle(2);
      }

      const test = (stream: MediaStream): boolean => {
        const target = property.split('.').reduce<unknown>(
          (current, part) =>
            current && typeof current === 'object' && part in (current as object)
              ? (current as Record<string, unknown>)[part]
              : undefined,
          stream as unknown,
        );
        if (target === undefined || target === null) return false;
        const value = String(target).toLowerCase();

        switch (condition) {
          case 'includes':
            return wanted.some((item) => value.includes(item));
          case 'not_includes':
            return !wanted.some((item) => value.includes(item));
          case 'equals':
            return wanted.some((item) => value === item);
          case 'not_equals':
            return !wanted.some((item) => value === item);
          default:
            return false;
        }
      };

      // A negative condition asks whether *no* stream matches, so it folds with
      // `every`. Reading it as "some stream fails to match" inverts the plugin
      // on any file with more than one stream of the type.
      const negative = condition === 'not_includes' || condition === 'not_equals';
      const matched = negative ? streams.every(test) : streams.some(test);
      return handle(matched ? 1 : 2);
    },
  },

  {
    ref: 'checkHdr@1.0.0',
    handles: { 1: 'File is HDR', 2: 'File is not HDR' },
    evaluate(record) {
      const streams = streamsOf(record);
      if (!streams) return threw('File has not stream data');
      const isHdr = streams.some((s) =>
        s.codec_type === 'video'
        && ((s.color_transfer === 'smpte2084' && s.color_primaries === 'bt2020'
          && s.color_range === 'tv')
          || ['dvhe', 'dvav', 'dav1', 'dvh11'].some((tag) =>
            s.codec_tag_string?.includes(tag) === true
          ))
      );
      return handle(isHdr ? 1 : 2);
    },
  },

  {
    ref: 'check10Bit@1.0.0',
    handles: { 1: 'File is 10 bit', 2: 'File is not 10 bit' },
    evaluate(record) {
      const streams = streamsOf(record);
      if (!streams) return threw('File has not stream data');
      const is10Bit = streams.some((s) =>
        s.codec_type === 'video' && (s.bits_per_raw_sample === 10 || s.pix_fmt === 'yuv420p10le')
      );
      return handle(is10Bit ? 1 : 2);
    },
  },

  {
    ref: 'checkVideoResolution@1.0.0',
    handles: {
      1: '480p',
      2: '576p',
      3: '720p',
      4: '1080p',
      5: '1440p',
      6: '4KUHD',
      7: 'DCI4K',
      8: '8KUHD',
      9: 'Other',
    },
    evaluate(record) {
      const order = ['480p', '576p', '720p', '1080p', '1440p', '4KUHD', 'DCI4K', '8KUHD'];
      const index = order.indexOf(record.video_resolution ?? '');
      return handle(index === -1 ? 9 : index + 1);
    },
  },

  {
    ref: 'checkStreamsCount@1.0.0',
    handles: { 1: 'Less than target', 2: 'Equal to target', 3: 'Greater than target' },
    evaluate(record, inputs) {
      const streams = streamsOf(record);
      if (!streams) return threw('ffProbeData or ffProbeData.streams is not available.');
      const type = String(inputs['streamType'] ?? 'video');
      const target = Number(inputs['streamsTarget'] ?? 0);
      const count = streams.filter((s) => s.codec_type === type).length;
      if (count < target) return handle(1);
      return handle(count === target ? 2 : 3);
    },
  },

  {
    ref: 'checkFileNameIncludes@1.0.0',
    handles: { 1: 'File name includes one of the terms', 2: 'File name includes none of them' },
    evaluate(record, inputs) {
      // Name and extension only - the vendored body rebuilds them from the path
      // rather than matching the directory.
      const parts = record._id.split('/');
      const name = parts[parts.length - 1] ?? '';
      const terms = String(inputs['terms'] ?? '').trim().split(',');
      return handle(terms.some((term) => name.includes(term)) ? 1 : 2);
    },
  },

  {
    ref: 'checkFileNameIncludes@2.0.0',
    handles: { 1: 'File name includes one of the terms', 2: 'File name includes none of them' },
    evaluate(record, inputs) {
      const includeDirectory = inputs['includeFileDirectory'] === true
        || inputs['includeFileDirectory'] === 'true';
      // `fileToCheck: 'originalFile'` reads the original rather than the working
      // file. Before any action they are the same file, and the interpreter only
      // ever hands us the record as scanned, so the two agree here.
      const path = includeDirectory ? record._id : (record._id.split('/').pop() ?? '');

      const criteria = String(inputs['terms'] ?? '').trim().split(',')
        .map((term) => term.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&'));
      const pattern = String(inputs['pattern'] ?? '');
      if (pattern) criteria.push(pattern);

      try {
        return handle(criteria.some((source) => new RegExp(source).test(path)) ? 1 : 2);
      } catch {
        // A user-supplied `pattern` that is not a valid regex throws in Tdarr too.
        return threw(`invalid regular expression in pattern "${pattern}"`);
      }
    },
  },

  {
    ref: 'checkFlowVariable@1.0.0',
    handles: { 1: 'Variable matches', 2: 'Variable does not match' },
    evaluate(_record, inputs, env) {
      const variable = String(inputs['variable'] ?? '').trim();
      const bound = env.variables[variable];
      if (bound === undefined) {
        // Depends which worker picks the job up, and the user has not said. A
        // classic-encoder flow is a chain of these, so leaving them unbound
        // makes the whole report indeterminate - hence the binding control.
        return unknowable(`the value of ${variable || 'a flow variable'} is not known`);
      }

      const value = String(inputs['value'] ?? '');
      const condition = String(inputs['condition'] ?? '==');
      const matches = condition === '!=' ? bound !== value : bound === value;
      return handle(matches ? 1 : 2);
    },
  },
];

// --- registered-unknowable --------------------------------------------------

/**
 * Plugins whose answer does not exist until the flow has run. Registered on
 * purpose: an entry here is a *claim* that no improvement is possible, and it is
 * what keeps these out of the "not yet modelled" list that drives future work.
 */
const UNKNOWABLE: Array<{ ref: string; handles: Record<number, string>; reason: string }> = [
  {
    ref: 'checkFileChanged@1.0.0',
    handles: { 1: 'File has changed', 2: 'File has not changed' },
    reason: 'whether an earlier step changed the file is only known once it has run',
  },
  {
    ref: 'compareFileSizeRatio@1.0.0',
    handles: {
      1: 'Working file size % is within range',
      2: 'Working file size % is not within range',
    },
    reason: 'the encoded size is not known until the encode has happened',
  },
  {
    ref: 'compareFileSizeRatio@2.0.0',
    handles: { 1: 'Within range', 2: 'Smaller than lower bound', 3: 'Larger than upper bound' },
    reason: 'the encoded size is not known until the encode has happened',
  },
  {
    ref: 'compareFileSizeRatioLive@1.0.0',
    // One output: it reports as the encode runs and always continues.
    handles: { 1: 'Continue to next plugin' },
    reason: 'the encoded size is not known until the encode has happened',
  },
  {
    ref: 'compareFileSize@1.0.0',
    handles: {
      1: 'Working file is smaller than original file',
      2: 'Working file is same size as original file',
      3: 'Working file is larger than original file',
    },
    reason: 'compares the working file against the original, which needs the flow to have run',
  },
  {
    ref: 'compareFileDurationRatio@1.0.0',
    handles: {
      1: 'Working file duration % is within range',
      2: 'Working file duration % is smaller than lower bound',
      3: 'Working file duration % is larger than upper bound',
    },
    reason: 'compares the working file against the original, which needs the flow to have run',
  },
  {
    ref: 'checkFileExists@1.0.0',
    handles: { 1: 'File exists', 2: 'File does not exist' },
    reason: 'depends on the worker node\'s filesystem at the moment the flow runs',
  },
  {
    ref: 'checkFileVariationExists@1.0.0',
    handles: { 1: 'A variation exists', 2: 'No variation exists' },
    reason: 'depends on the worker node\'s filesystem at the moment the flow runs',
  },
  {
    ref: 'checkForHardlinks@1.0.0',
    handles: { 1: 'File has hardlinks', 2: 'File has no hardlinks' },
    reason: 'link counts are not part of the scanned record',
  },
  {
    ref: 'checkNodeHardwareEncoder@1.0.0',
    handles: { 1: 'Encoder available', 2: 'Encoder not available' },
    reason: 'depends which worker node picks the file up',
  },
  {
    // A gate, not an action: it wraps a classic *filter* plugin, whose condition
    // is arbitrary JavaScript in the plugin's own source and is not modelled.
    ref: 'runClassicFilterPlugin@1.0.0',
    handles: {
      1: 'File met conditions, would traditionally continue to next plugin in plugin stack',
      2: 'File did not meet conditions, would traditionally break out of plugin stack',
    },
    reason: 'the wrapped classic plugin decides, and its logic is not modelled here',
  },
];

export const SIMULATORS: Readonly<Record<string, Simulator>> = Object.freeze(
  Object.fromEntries([
    ...MODELLED.map((simulator) => [simulator.ref, simulator]),
    ...UNKNOWABLE.map(({ ref, handles: labels, reason }) => [ref, {
      ref,
      handles: labels,
      evaluate: () => unknowable(reason),
    } satisfies Simulator]),
  ]),
);

export function simulatorFor(ref: string): Simulator | undefined {
  return SIMULATORS[ref];
}
