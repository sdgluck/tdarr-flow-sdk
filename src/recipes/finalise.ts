import * as plugins from '../catalog/factories.generated.ts';
import { Junction } from '../graph/builder.ts';
import type { Cursor, Exit } from '../graph/builder.ts';
import type { ContainerStep, Notification, OutputStep } from '../types/spec.ts';
import { recipe } from './types.ts';
import type { Recipe } from './types.ts';

/**
 * Commit the result and tell anyone who needs to know.
 *
 * The `checkFileChanged` gate is the important part: if nothing in the flow
 * actually modified the file, there is no working copy worth committing and no
 * statistics worth rebuilding. Skipping straight to the destination avoids
 * rewriting a file that is already exactly what it should be.
 */
export function finalise(step: OutputStep, container?: ContainerStep): Recipe {
  return recipe('finalise', step, (entry) => {
    const builder = entry.builder;
    const target = container?.mode === 'remux' ? container.target : 'mkv';

    const destination = () => {
      switch (step.destination.kind) {
        case 'moveToDirectory':
          return plugins.moveToDirectory({
            outputDirectory: step.destination.directory,
            keepRelativePath: step.destination.keepRelative,
          });
        case 'copyToDirectory':
          return plugins.copyToDirectory({
            outputDirectory: step.destination.directory,
            keepRelativePath: step.destination.keepRelative,
          });
        default:
          return plugins.replaceOriginalFile();
      }
    };

    const commit = builder.add(destination());

    if (step.restampStatistics) {
      const changed = entry.then(plugins.checkFileChanged({}, { name: 'File Changed?' }));
      // Handle 1: the file changed, so the statistics need rebuilding - but only
      // if it is Matroska, since mkvpropedit fails on anything else.
      const gate = changed.on(1, plugins.checkFileExtension(
        { extensions: target },
        { name: `Is ${target.toUpperCase()}?` },
      ));
      gate.on(1, plugins.runMkvPropEdit()).join(commit);
      gate.at(2).join(commit);
      // Handle 2: nothing changed, so commit as-is.
      changed.at(2).join(commit);
    } else {
      entry.join(commit);
    }

    let cursor: Cursor = commit;
    for (const notification of step.notifications) cursor = cursor.then(notify(notification));

    if (step.requeue?.kind === 'tags') {
      cursor = cursor.then(plugins.tagsRequeue({
        useBasicQueueTags: false,
        customQueueTags: step.requeue.customQueueTags,
      }));
    } else if (step.requeue?.kind === 'goToFlow') {
      cursor = cursor.then(plugins.goToFlow({ flowId: step.requeue.flowId }));
    }

    const exits: Exit[] = [{ id: cursor.id, handle: 1 }];
    return new Junction(builder, exits);
  });
}

function notify(notification: Notification) {
  switch (notification.kind) {
    case 'apprise':
      return plugins.apprise({
        command: notification.command,
        ...(notification.apprisePath ? { apprisePath: notification.apprisePath } : {}),
      });
    case 'webRequest':
      return plugins.webRequest({
        requestUrl: notification.url,
        method: notification.method,
        ...(notification.headers ? { requestHeaders: notification.headers } : {}),
        ...(notification.body ? { requestBody: notification.body } : {}),
      });
    default:
      return plugins.notifyRadarrOrSonarr({
        arr: notification.arr,
        arr_host: notification.url,
        arr_api_key: notification.apiKey,
      });
  }
}
