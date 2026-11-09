import type { ToolSpec } from 'cortico/core/types.ts';
const text = (description: string) => ({ type: 'string', description });
const page = text('Page label, e.g. p1.');
const element = text('Snapshot ref (e.g. @12) or Ego selector.');
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], read = false): ToolSpec {
  return { name: `ego_${name}`, description, tags: read ? ['read', 'snapshot'] : ['act', 'snapshot'],
    parameters: { type: 'object', additionalProperties: false, properties, required } };
}
export const EGO_TOOL_DECLS: readonly ToolSpec[] = [
  tool('open', 'Open a page. Returns its label and snapshot, or retains the label if navigation fails.', { url: text('HTTP(S) URL or Bilibili BV id.') }, ['url']),
  tool('navigate', 'Navigate a managed page and return a snapshot. Stops watching that page.', { page, url: text('HTTP(S) URL or Bilibili BV id.') }, ['page', 'url']),
  tool('tabs', 'List tabs in this Space. Only labeled tabs are managed.', {}, [], true),
  tool('read', 'Read a semantic snapshot with refs. Defaults to the viewport. Use fullPage for the whole page and offset/maxChars to paginate.', { page, fullPage: { type: 'boolean' }, offset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 100, maximum: 60000 } }, ['page'], true),
  tool('click', 'Click one element. Returns a snapshot and any popup page labels.', { page, selector: element }, ['page', 'selector']),
  tool('fill', 'Fill an editable element. Returns a snapshot.', { page, selector: element, text: text('Input value.') }, ['page', 'selector', 'text']),
  tool('press', 'Send a key to an element. Returns a snapshot.', { page, selector: element, key: text('Key or chord, e.g. Enter or ControlOrMeta+A.') }, ['page', 'selector', 'key']),
  tool('scroll', 'Scroll vertically at a viewport position in CSS pixels. Returns a snapshot.', { page, deltaY: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } }, ['page', 'deltaY']),
  tool('evaluate', 'Run JavaScript in the page and return JSON. Page-only APIs. Use ego_wait for delays; evaluation is limited to about 15 seconds.', { page, expression: text('JavaScript expression or function expression.') }, ['page', 'expression']),
  tool('wait', 'Wait in the host while video sampling continues.', { seconds: { type: 'number', minimum: 0, maximum: 60 } }, ['seconds'], true),
  tool('shot', 'Capture the viewport as an image attachment.', { page }, ['page'], true),
  tool('close', 'Close a bot-created page. Stops watching that page.', { page }, ['page']),
  tool('handoff', 'Give the operator control and stop commands and watching.', {}, []),
  tool('video', 'Inspect or control HTML5 video, including iframes. inspect reports playback, tracks and frameId. look captures immediately. watch starts playback and sampling; the first receipt has no image. Early end delivers collected frames. play alone does not start sampling; pause, seek and exit stop watching. video-frame is one image; video-mosaic tiles follow frameTimes in row order and share a boundary frame across batches. Viewport fallback may omit the video. Subtitles and Bilibili danmaku are separate text; no audio transcription.', {
    page, action: { type: 'string', enum: ['inspect', 'play', 'pause', 'seek', 'look', 'watch', 'tune', 'exit'] },
    windowSec: { type: 'number', minimum: 10, maximum: 120, description: 'Video seconds per mosaic. Pair with frameIntervalSec on watch/tune. Omit both on watch for operator defaults. tune applies at the next batch and preserves queued scenes.' },
    frameIntervalSec: { type: 'number', minimum: 1, maximum: 120, description: 'Video seconds between frames, at most windowSec. Both endpoints count: ceil(windowSec / frameIntervalSec) + 1 <= 9.' },
    frameId: text('From inspect; omit to scan page frames.'), selector: text('CSS video selector in the frame.'),
    index: { type: 'integer', minimum: 0, description: 'Zero-based video index in the frame.' },
    time: { type: 'number', minimum: 0, description: 'Required for seek, in video seconds.' },
    since: { type: 'number', minimum: 0, description: 'Subtitle/danmaku start in video seconds. Cannot retrieve past frames.' },
  }, ['page', 'action']),
  tool('bilibili', 'Search, list related videos or read comments using a Bilibili tab without navigating. Up to 10 results. Search/related return arrays. Comments return video, comments and status: available, empty (this list only), target-unavailable or error.', {
    page, action: { type: 'string', enum: ['search', 'related', 'comments'] }, query: text('Required for search.'),
    bvid: text('Target BV id for related or comments. Comments default to the tab video URL when both IDs are omitted.'),
    aid: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'Comments target. Must match bvid if both are given.' } }, ['page', 'action'], true),
];
