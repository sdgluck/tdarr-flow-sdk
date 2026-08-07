/**
 * Structural recognition: reading a hand-built flow back into a `FlowSpec`.
 *
 * Each matcher anchors on a signature plugin - the one node that only appears
 * because that stage exists - and reads its parameters out of the nodes around
 * it. It claims what it understood; whatever is left over becomes a frozen
 * `ExtraNode` and is reproduced verbatim.
 *
 * These are deliberately shallow. They recognise the idioms of the flows this
 * SDK generates, plus the hand-built pipeline they were derived from, and they
 * will not understand a flow written in some other style. That is an acceptable
 * ceiling *because* the unclaimed remainder is preserved rather than dropped: a
 * bad match costs the user a repopulated wizard step, not their flow. Anything
 * more ambitious would be guessing about intent, and guessing wrong about intent
 * is worse than admitting ignorance.
 */

import { newSpec } from '../recipes/compileSpec.ts';
import type {
  AudioStep,
  ContainerStep,
  FlowSpec,
  OutputStep,
  SourceStep,
  TracksStep,
  VideoStep,
} from '../types/spec.ts';
import type { Walk } from './walk.ts';

export interface Match {
  recipe: string;
  /** `exact` when every part of the template matched. */
  confidence: 'exact' | 'partial';
  nodeIds: string[];
}

export interface MatchResult {
  spec: FlowSpec;
  matches: Match[];
}

const REMUX = /remux/i;
const CLEAN = /clean|track|language/i;

const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const num = (value: unknown, fallback = 0) => (typeof value === 'number' ? value : fallback);

// --- source -----------------------------------------------------------------

function matchSource(walk: Walk, spec: FlowSpec): Match | null {
  const medium = walk.first('checkFileMedium');
  const extension = walk.nodes.find((n) =>
    n.pluginName === 'checkFileExtension' && !walk.isClaimed(n)
    // The container recipe uses this plugin too, but always in front of an
    // mkvpropedit. A gate that is not guarding one is a source filter.
    && !walk.targets(n.id).some((t) => t.pluginName === 'runMkvPropEdit')
    && walk.sources(n.id).some((s) => s.pluginName === 'inputFile' || s.pluginName === 'checkFileMedium')
  );
  const size = walk.first('checkFileSize');

  if (!medium && !extension && !size) return null;

  const source: SourceStep = { ...spec.source };
  const ids: string[] = [];

  if (medium) {
    const wired = walk.handles(medium.id);
    source.requireMedium = wired.includes('1') ? 'video' : wired.includes('2') ? 'audio' : 'any';
    ids.push(medium.id);
  }
  if (extension) {
    const list = str(walk.inputs(extension)['extensions']).split(',').map((s) => s.trim())
      .filter(Boolean);
    source.extensions = {
      mode: walk.handles(extension.id).includes('1') ? 'include' : 'exclude',
      list,
    };
    ids.push(extension.id);
  }
  if (size) {
    source.minSizeMb = num(walk.inputs(size)['greaterThan']);
    ids.push(size.id);
  }

  walk.claim(medium, extension, size);
  spec.source = source;
  return { recipe: 'sourceFile', confidence: 'exact', nodeIds: ids };
}

// --- container --------------------------------------------------------------

function matchContainer(walk: Walk, spec: FlowSpec): Match | null {
  const primary = walk.find('runClassicTranscodePlugin')
    .find((n) => REMUX.test(str(walk.raw(n)['pluginSourceId'])));

  if (!primary) {
    const setContainer = walk.nodes.find((n) =>
      n.pluginName === 'ffmpegCommandSetContainer' && !walk.isClaimed(n)
      // Inside an audio block this belongs to normalizeAudio, not here.
      && !walk.sources(n.id).some((s) => s.pluginName === 'ffmpegCommandStart')
    );
    if (!setContainer) return null;

    const inputs = walk.inputs(setContainer);
    spec.container = {
      mode: 'remux',
      target: str(inputs['container'], 'mkv') === 'mp4' ? 'mp4' : 'mkv',
      method: { kind: 'ffmpeg', forceConform: inputs['forceConform'] === true },
      healStatistics: false,
    };
    walk.claim(setContainer);
    return { recipe: 'remuxContainer', confidence: 'exact', nodeIds: [setContainer.id] };
  }

  const ids = [primary.id];
  const fallbackNode = walk.throughReset(primary);
  const isFallback = fallbackNode?.pluginName === 'runClassicTranscodePlugin'
    && REMUX.test(str(walk.raw(fallbackNode)['pluginSourceId']));

  const gates = walk.nodes.filter((n) =>
    n.pluginName === 'checkFileExtension'
    && walk.targets(n.id).some((t) => t.pluginName === 'runMkvPropEdit')
  );
  const propEdits = gates.flatMap((g) => walk.targets(g.id, 1))
    .filter((n) => n.pluginName === 'runMkvPropEdit');

  const container: ContainerStep = {
    mode: 'remux',
    target: str(walk.inputs(gates[0] ?? primary)['extensions'], 'mkv') === 'mp4' ? 'mp4' : 'mkv',
    method: {
      kind: 'classic',
      pluginSourceId: str(walk.raw(primary)['pluginSourceId']),
      ...(isFallback
        ? { fallbackPluginSourceId: str(walk.raw(fallbackNode!)['pluginSourceId']) }
        : {}),
    },
    healStatistics: gates.length > 0,
  };

  // The reset nodes on the escalation path belong to this stage too.
  const resets = walk.nodes.filter((n) =>
    n.pluginName === 'resetFlowError'
    && walk.sources(n.id).every((s) =>
      s.id === primary.id || s.id === fallbackNode?.id || propEdits.some((p) => p.id === s.id)
    )
    && walk.sources(n.id).length > 0
  );

  if (isFallback) ids.push(fallbackNode!.id);
  ids.push(...gates.map((g) => g.id), ...propEdits.map((p) => p.id), ...resets.map((r) => r.id));

  walk.claim(primary, isFallback ? fallbackNode : undefined, ...gates, ...propEdits, ...resets);
  spec.container = container;

  return {
    recipe: 'remuxContainer',
    confidence: isFallback || !container.healStatistics ? 'exact' : 'partial',
    nodeIds: ids,
  };
}

// --- video ------------------------------------------------------------------

function matchVideo(walk: Walk, spec: FlowSpec): Match | null {
  const gate = walk.first('checkVideoCodec');
  const selectors = walk.find('checkFlowVariable');
  const encoders = walk.find('runClassicTranscodePlugin')
    .filter((n) => !CLEAN.test(str(walk.raw(n)['pluginSourceId'])));
  const compare = walk.first('compareFileSizeRatio');
  const ffmpegEncoder = walk.first('ffmpegCommandSetVideoEncoder');

  if (!gate && !encoders.length && !ffmpegEncoder) return null;

  const video: VideoStep = { ...spec.video, mode: 'transcode' };
  const ids: string[] = [];

  if (gate) {
    const codec = str(walk.inputs(gate)['codec'], 'hevc');
    video.targetCodec = codec === 'h264' || codec === 'av1' ? codec : 'hevc';
    video.skipIfAlreadyTarget = true;
    ids.push(gate.id);
  }

  if (encoders.length) {
    // A selector's handle 1 leads to the encoder it selects; whatever no
    // selector points at is the fallback.
    const selected = new Map<string, string>();
    for (const selector of selectors) {
      const picked = walk.target(selector.id, 1);
      if (picked) selected.set(picked.id, selector.id);
    }

    const branches = selectors.flatMap((selector) => {
      const picked = walk.target(selector.id, 1);
      if (!picked) return [];
      const inputs = walk.inputs(selector);
      return [{
        label: picked.name.replace(/^Transcode\s+\S+\s*/, '').replace(/[()]/g, '').trim()
          || str(inputs['value']),
        flowVariable: str(inputs['variable']),
        equals: str(inputs['value']),
        pluginSourceId: str(walk.raw(picked)['pluginSourceId']),
      }];
    });

    const fallback = encoders.find((n) => !selected.has(n.id));
    video.encoder = {
      kind: 'classic',
      branches,
      fallbackPluginSourceId: str(walk.raw(fallback ?? encoders[0]!)['pluginSourceId']),
      errorFallsBackToCpu: Boolean(
        fallback && encoders.some((n) => walk.target(n.id, 'err1')?.id === fallback.id),
      ),
    };
    ids.push(...selectors.map((s) => s.id), ...encoders.map((e) => e.id));
    walk.claim(...selectors, ...encoders);
  } else if (ffmpegEncoder) {
    const inputs = walk.inputs(ffmpegEncoder);
    const hardware = inputs['hardwareEncoding'] === false
      ? 'cpu'
      : (str(inputs['hardwareType'], 'auto') as 'auto');
    video.encoder = { kind: 'ffmpeg', hardware };
    ids.push(ffmpegEncoder.id);
    walk.claim(ffmpegEncoder);
  }

  if (compare) {
    const inputs = walk.inputs(compare);
    const outOfRange = walk.target(compare.id, 3) ?? walk.target(compare.id, 2);
    video.sizeGuard = {
      enabled: true,
      greaterThan: num(inputs['greaterThan']),
      lessThan: num(inputs['lessThan'], 100),
      onFail: outOfRange?.pluginName === 'setOriginalFile' ? 'keepOriginal' : 'continue',
    };
    ids.push(compare.id);
    walk.claim(compare);
  }

  const restore = walk.first('setOriginalFile');
  if (restore) {
    ids.push(restore.id);
    const resets = walk.find('resetFlowError')
      .filter((n) => walk.target(n.id, 1)?.id === restore.id);
    ids.push(...resets.map((r) => r.id));
    walk.claim(restore, ...resets);
  }

  walk.claim(gate);
  spec.video = video;

  return {
    recipe: 'transcodeVideo',
    confidence: gate && (encoders.length || ffmpegEncoder) ? 'exact' : 'partial',
    nodeIds: ids,
  };
}

// --- tracks -----------------------------------------------------------------

function matchTracks(walk: Walk, spec: FlowSpec): Match | null {
  const clean = walk.find('runClassicTranscodePlugin')
    .find((n) => CLEAN.test(str(walk.raw(n)['pluginSourceId'])));

  if (!clean) {
    const removals = [
      ...walk.find('ffmpegCommandRemoveSubtitles'),
      ...walk.find('ffmpegCommandRemoveDataStreams'),
      ...walk.find('ffmpegCommandRemoveStreamByProperty'),
    ];
    if (!removals.length) return null;

    const tracks: TracksStep = {
      mode: 'clean',
      implementation: {
        kind: 'ffmpeg',
        removeSubtitles: removals.some((n) => n.pluginName === 'ffmpegCommandRemoveSubtitles'),
        removeDataStreams: removals.some((n) => n.pluginName === 'ffmpegCommandRemoveDataStreams'),
      },
    };
    walk.claim(...removals);
    spec.tracks = tracks;
    return {
      recipe: 'cleanTracks',
      confidence: 'exact',
      nodeIds: removals.map((n) => n.id),
    };
  }

  const { pluginSourceId, ...inputs } = walk.raw(clean);
  spec.tracks = {
    mode: 'clean',
    implementation: { kind: 'classic', pluginSourceId: str(pluginSourceId), inputs },
  };

  const resets = walk.find('resetFlowError')
    .filter((n) => walk.sources(n.id).some((s) => s.id === clean.id));

  walk.claim(clean, ...resets);
  return {
    recipe: 'cleanTracks',
    confidence: 'exact',
    nodeIds: [clean.id, ...resets.map((r) => r.id)],
  };
}

// --- audio ------------------------------------------------------------------

function matchAudio(walk: Walk, spec: FlowSpec): Match | null {
  const ensures = walk.find('ffmpegCommandEnsureAudioStream');
  if (!ensures.length) return null;

  const ids = ensures.map((n) => n.id);
  const first = walk.inputs(ensures[0]!);

  const audio: AudioStep = {
    mode: 'ensure',
    encoder: str(first['audioEncoder'], 'eac3'),
    language: str(first['language'], 'eng'),
    stereoMate: false,
  };

  const gates = walk.find('checkStreamProperty')
    .filter((n) => str(walk.inputs(n)['propertyToCheck']) === 'channels');

  /** The channel counts the gate in front of an ensure node tests for. */
  const matchChannelsFor = (nodeId: string): number[] | undefined => {
    const gate = gates.find((g) => walk.targets(g.id, 1).some((t) => t.id === nodeId));
    if (!gate) return undefined;
    return str(walk.inputs(gate)['valuesToMatch']).split(',').map(Number).filter(Number.isFinite);
  };

  for (const node of ensures) {
    const inputs = walk.inputs(node);
    const channels = num(inputs['channels'], 2);
    const target = {
      channels,
      ...(inputs['enableBitrate'] === true && inputs['bitrate']
        ? { bitrate: str(inputs['bitrate']) }
        : {}),
      ...(inputs['enableSamplerate'] === true && inputs['samplerate']
        ? { samplerate: str(inputs['samplerate']) }
        : {}),
      ...(matchChannelsFor(node.id) ? { matchChannels: matchChannelsFor(node.id) } : {}),
    };

    if (channels >= 3) audio.surround = target;
    else if (channels === 2) audio.stereo = target;
    else audio.mono = target;
  }

  // A surround node that leads into the stereo node is the stereo-mate idiom.
  const surroundNode = ensures.find((n) => num(walk.inputs(n)['channels'], 2) >= 3);
  const stereoNode = ensures.find((n) => num(walk.inputs(n)['channels'], 2) === 2);
  if (surroundNode && stereoNode) {
    audio.stereoMate = walk.targets(surroundNode.id).some((t) => t.id === stereoNode.id);
  }

  const reorder = walk.first('ffmpegCommandRorderStreams');
  if (reorder) {
    const inputs = walk.inputs(reorder);
    audio.reorder = {
      processOrder: 'streamTypes',
      streamTypes: str(inputs['streamTypes'], 'video,audio,subtitle'),
    };
    ids.push(reorder.id);
  }

  // A node the catalog does not know, sitting between the ensures and the
  // reorder, is a local audio post-processor.
  const local = walk.unclaimed().find((n) =>
    n.sourceRepo === 'Local'
    && walk.sources(n.id).some((s) => s.pluginName === 'ffmpegCommandEnsureAudioStream')
  );
  if (local) {
    audio.normalise = {
      pluginName: local.pluginName,
      version: local.version,
      outputs: Math.max(1, walk.handles(local.id).filter((h) => h !== 'err1').length),
      inputs: walk.raw(local),
    };
    ids.push(local.id);
  }

  const block = [
    ...walk.find('ffmpegCommandStart'),
    ...walk.find('ffmpegCommandExecute'),
    ...walk.find('ffmpegCommandSetContainer'),
  ];
  ids.push(...gates.map((g) => g.id), ...block.map((n) => n.id));

  walk.claim(...ensures, reorder, local, ...gates, ...block);
  spec.audio = audio;

  return { recipe: 'normalizeAudio', confidence: 'exact', nodeIds: ids };
}

// --- output -----------------------------------------------------------------

function matchOutput(walk: Walk, spec: FlowSpec): Match | null {
  const replace = walk.first('replaceOriginalFile');
  const move = walk.first('moveToDirectory');
  const copy = walk.first('copyToDirectory');
  const destinationNode = replace ?? move ?? copy;
  if (!destinationNode) return null;

  const output: OutputStep = { ...spec.output, notifications: [] };
  const ids = [destinationNode.id];

  if (move) {
    const inputs = walk.inputs(move);
    output.destination = {
      kind: 'moveToDirectory',
      directory: str(inputs['outputDirectory']),
      keepRelative: inputs['keepRelativePath'] === true,
    };
  } else if (copy) {
    const inputs = walk.inputs(copy);
    output.destination = {
      kind: 'copyToDirectory',
      directory: str(inputs['outputDirectory']),
      keepRelative: inputs['keepRelativePath'] === true,
    };
  } else {
    output.destination = { kind: 'replaceOriginal' };
  }

  const changed = walk.first('checkFileChanged');
  if (changed) {
    output.restampStatistics = true;
    ids.push(changed.id);
    const gate = walk.target(changed.id, 1);
    if (gate?.pluginName === 'checkFileExtension') {
      ids.push(gate.id);
      const propEdit = walk.target(gate.id, 1);
      if (propEdit?.pluginName === 'runMkvPropEdit') ids.push(propEdit.id);
      walk.claim(gate, propEdit);
    }
    walk.claim(changed);
  }

  walk.claim(destinationNode);
  spec.output = output;

  return { recipe: 'finalise', confidence: 'exact', nodeIds: ids };
}

// --- driver -----------------------------------------------------------------

const MATCHERS = [
  matchSource,
  matchContainer,
  matchVideo,
  matchTracks,
  matchAudio,
  matchOutput,
] as const;

export function runMatchers(walk: Walk, name: string): MatchResult {
  const spec = newSpec(name);

  // The entry node is structural, not a recipe of its own.
  walk.claim(walk.first('inputFile'));

  const matches: Match[] = [];
  for (const matcher of MATCHERS) {
    const match = matcher(walk, spec);
    if (match) matches.push(match);
  }
  return { spec, matches };
}
