# tdarr-flow-sdk

Build Tdarr flows from typed primitives instead of dragging boxes around a canvas.

- 🧩 **A generated plugin catalog** — every community flow plugin, keyed by `name@version`, with typed inputs and real output counts
- 🔗 **A fluent graph builder** — handles checked at compile time *and* run time, deterministic ids, automatic layout
- 🍱 **Opinionated recipes** — declare what a flow is *for*; `compileSpec` works out how to wire it
- 🔎 **A browser-safe linter** — the same structural rules the command-line harness uses, running on every keystroke
- ♻️ **Import** — read an existing flow back into an editable spec, preserving whatever it could not interpret

Ships TypeScript source and runs on Node 24's native type stripping. No build step, no runtime
dependencies. The main entry is browser-safe and imports directly into Vite; everything that touches
the filesystem lives behind `tdarr-flow-sdk/node`.

## Install

```sh
pnpm add tdarr-flow-sdk
```

## Building a flow

```js
import { flow, plugins } from 'tdarr-flow-sdk';

flow('My Flow')
  .start(plugins.inputFile())
  .then(plugins.checkVideoCodec({ codec: 'hevc' }))
  .on(2, plugins.runClassicTranscodePlugin({ pluginSourceId: 'Community:Tdarr_Plugin_MC93_Migz1FFMPEG' }))
  .onError(plugins.resetFlowError())
  .then(plugins.replaceOriginalFile())
  .build();
//=> { _id, name, flowPlugins: [...], flowEdges: [...] }
```

Handles are checked both ways. `HandlesFor<R>` rejects `.on(3, …)` on a two-output plugin at compile
time; `assertHandle` catches the same thing at run time, for handles that came out of a form:

```js
flow('x').start(plugins.inputFile()).then(plugins.checkVideoCodec()).at(3)
//=> FlowBuildError: checkVideoCodec@1.0.0 ("Check Video Codec") has 2 outputs; handle 3 is not one of 1, 2.
```

`.onError()` is rejected outright on a plugin with no error handle, rather than producing an edge no
file can take.

### The ffmpeg command block

Nodes between `ffmpegCommandStart` and `ffmpegCommandExecute` do not each run ffmpeg — they mark up
one pending command that Execute then runs. `ffmpegCommand()` models the block as a single thing, so
you cannot accidentally transcode the file once per operation:

```js
import { ffmpegCommand } from 'tdarr-flow-sdk';

ffmpegCommand()
  .container({ container: 'mkv' })
  .videoEncoder({ outputCodec: 'hevc', hardwareEncoding: true, hardwareType: 'nvenc' })
  .ensureAudio({ audioEncoder: 'eac3', channels: 6, enableBitrate: true, bitrate: '384k' })
  .removeDataStreams()
```

`.branch(fn)` puts a decision *inside* the block — checking the source's channel layout before
choosing an audio target, for instance — with every path converging before Execute.

### Uncatalogued and Local plugins

```js
localNode({ pluginName: 'normaliseAudioTracks', outputs: 1, inputs: { targetCodec: 'eac3' } })
```

Declaring `outputs` is required: nothing else can know it, and without it the linter has to stay
quiet about the node.

## Recipes and the spec

`FlowSpec` describes what a flow is for. `compileSpec` turns it into a graph.

```js
import { compileSpec, newSpec } from 'tdarr-flow-sdk';

const spec = newSpec('HEVC Pipeline');
spec.container = { mode: 'remux', target: 'mkv', healStatistics: true,
  method: { kind: 'classic', pluginSourceId: 'Local:Tdarr_Plugin_bsh1_RemuxMKV' } };
spec.video.mode = 'transcode';

compileSpec(spec); //=> FlowJson
```

- __compileSpec(spec, options?)__ {FlowJson} — `options.embed` writes the spec into the flow's
  `description` so re-importing recovers it exactly _(default=`false`)_
- __newSpec(name?)__ {FlowSpec} — every step off
- __migrateSpec(value)__ {FlowSpec} — validates a spec from storage; throws `SpecVersionError`

Individual recipes (`sourceFile`, `remuxContainer`, `transcodeVideo`, `cleanTracks`,
`normalizeAudio`, `finalise`) are plain `Segment`s and compose anywhere a node does.

## The catalog

Generated from vendored upstream plugin source by `pnpm catalog:generate`, and keyed by
`name@version` — never by name alone. Seven plugins ship two versions and the version changes their
shape: `compareFileSizeRatio` has two outputs at 1.0.0 and three at 2.0.0, and real flows wire the
third.

```js
import { getPlugin, searchPlugins, visibleInputs } from 'tdarr-flow-sdk';

getPlugin('compareFileSizeRatio', '2.0.0').outputs.length; //=> 3
getPlugin('compareFileSizeRatio', '1.0.0').outputs.length; //=> 2

visibleInputs(getPlugin('ffmpegCommandEnsureAudioStream'), { enableBitrate: 'false' })
//=> bitrate is absent: its displayConditions are unmet
```

`visibleInputs` and `evaluateDisplayConditions` implement the same rules Tdarr's own editor uses, so
a form built on them behaves identically.

## Linting

```js
import { lint, catalogShapes, formatFindings } from 'tdarr-flow-sdk';

lint(flowJson);
lint(flowJson, {
  shapes: catalogShapes({ 'normaliseAudioTracks@1.0.0': { outputs: 1, error: false, terminal: false, confidence: 'declared' } }),
  ignore: ['missing-error-edge:audProped'],
});
```

Rules: `entry-node`, `dangling-edge`, `unreachable-node`, `nonexistent-handle`, `unwired-handle`,
`missing-error-edge`, `mixed-plugin-versions`, `overlapping-nodes`, `uncatalogued-plugin`.

`ignore` entries may be scoped to a node (`rule:nodeId`). Prefer the scoped form — a blanket disable
hides the next instance too.

## Importing

```js
import { importFlow } from 'tdarr-flow-sdk';

const { spec, source, recognised, unrecognised } = importFlow(json);
```

`source` is `embedded` when the flow carried a spec and recompiling it reproduced the flow exactly;
`recognised` when the matchers guessed structurally; `none` when nothing anchored.

Recognition is deliberately shallow — six matchers over a handful of idioms. It is safe to ship
anyway because nothing is discarded: unclaimed nodes become frozen `ExtraNode`s carrying their
original position and edges, and imported layouts are preserved rather than re-flowed.

## Development

```sh
pnpm check              # typecheck, lint, catalog freshness, tests
pnpm plugins:update     # re-vendor upstream plugin source
pnpm catalog:generate   # regenerate the catalog from it
```

## Notes

- **Tdarr stores every input as a string** and coerces on read. `''` is indistinguishable from a
  missing key — it substitutes the plugin's default — so `encodeInputs` rejects it rather than let a
  caller believe they cleared a field. Booleans are `value === 'true'`, so anything else is false.
  Unparseable numbers become `0`, so non-finite numbers are rejected too.
- **`err1` is not discoverable.** `details()` says nothing about error handles, so the catalog's are
  hand-curated in `src/catalog/overrides.ts`, each with a reason and a confidence. Findings derived
  from an `assumed` one are flagged, and nothing should auto-wire an error edge on the strength of a
  guess.
- **The classic-plugin runners forward undeclared inputs** to the plugin they wrap, so the usual
  unknown-key check is disabled for them.
- **`replaceOriginalFile` declares an output** but ending there is the normal way to finish a flow,
  so it does not raise `unwired-handle`. It is not terminal — chaining a notification after it is
  still legal.
- **Three upstream plugin names are misspelled** (`ffmpegCommandRorderStreams`,
  `ffmpegCommandSetVdeoResolution`, `ffmpegCommandSetVdeoFramerate`). The canonical exports keep the
  typos because they must match `pluginName`; correctly-spelled aliases exist alongside them.
- **`build()` is pure.** Ids are derived from content and ordinal, and layout is a single
  deterministic sweep, so recompiling a spec produces a byte-identical flow — which is what makes a
  diff against the copy on the server meaningful.
