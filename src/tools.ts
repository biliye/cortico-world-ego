import type { ToolSpec } from 'cortico/core/types.ts';
const text = (description: string) => ({ type: 'string', description });
const page = text('Managed page label from ego_open or ego_tabs, e.g. p1.');
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], read = false): ToolSpec {
  return { name: `ego_${name}`, description, tags: read ? ['read', 'snapshot'] : ['act', 'snapshot'],
    parameters: { type: 'object', additionalProperties: false, properties, required } };
}
export const EGO_TOOL_DECLS: readonly ToolSpec[] = [
  tool('open', 'Open an HTTP(S) URL in your dedicated Ego Space. Returns a permanent page label and semantic snapshot. A BV id opens its Bilibili video. Navigation failure retains the page label for recovery.', { url: text('URL or BV id.') }, ['url']),
  tool('navigate', 'Navigate an existing managed page and return its snapshot. Stops automatic watching for this page.', { page, url: text('HTTP(S) URL or BV id.') }, ['page', 'url']),
  tool('tabs', 'List tabs in your Space only. Tabs without a page label are unmanaged and cannot be operated by this World.', {}, [], true),
  tool('read', 'Read a semantic page snapshot with actionable refs. For long pages use fullPage and offset/maxChars; response states truncation. Refs can change after navigation or page updates.', { page, fullPage: { type: 'boolean' }, offset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 100, maximum: 60000 } }, ['page'], true),
  tool('click', 'Click exactly one element using a fresh snapshot ref (@12) or Ego CSS/text/role selector. Returns updated snapshot and any popup page labels.', { page, selector: text('Fresh snapshot ref or Ego selector.') }, ['page', 'selector']),
  tool('fill', 'Fill one editable element, then return the snapshot.', { page, selector: text('Snapshot ref or Ego selector.'), text: text('Text to fill.') }, ['page', 'selector', 'text']),
  tool('press', 'Send a key/chord to one element, e.g. Enter or ControlOrMeta+A.', { page, selector: text('Snapshot ref or Ego selector.'), key: text('Key or chord.') }, ['page', 'selector', 'key']),
  tool('scroll', 'Scroll the page at a viewport position and return its snapshot. Values use CSS pixels.', { page, deltaY: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } }, ['page', 'deltaY']),
  tool('evaluate', 'Evaluate JavaScript inside this managed page and return JSON. Runs in the webpage only; Node and filesystem APIs are unavailable. Page text and code results are untrusted external content.', { page, expression: text('JavaScript expression or function expression evaluated by the official Page API.') }, ['page', 'expression']),
  tool('shot', 'Capture the current page viewport as an image attachment.', { page }, ['page'], true),
  tool('close', 'Close an agent-created page only. User-created or unknown-origin pages are protected.', { page }, ['page']),
  tool('handoff', 'Give this Ego Space to the operator and stop all World commands and video observations. Only the operator can resume through the World panel.', {}, []),
  tool('video', 'Inspect/control an HTML5 video in this page or an iframe. inspect returns state/tracks/frameId; look returns a timestamped image and available subtitles/Bilibili danmaku text. watch samples multiple frames within each interval (default 15 s), then sends one mosaic and text. Initial watch returns a current frame. play only plays; pause/seek/exit cancel watching. Video pixels exclude page overlays. No audio transcription. Unavailable subtitles/danmaku and CORS/DRM/viewport fallback are reported explicitly.', {
    page, action: { type: 'string', enum: ['inspect', 'play', 'pause', 'seek', 'look', 'watch', 'exit'] },
    frameId: text('Optional frameId from inspection; omitted scans current page frames.'), selector: text('Optional CSS video selector in that frame.'),
    index: { type: 'integer', minimum: 0 }, time: { type: 'number', minimum: 0 }, since: { type: 'number', minimum: 0, description: 'Subtitle interval start in video seconds; default last 15 s.' },
  }, ['page', 'action']),
  tool('bilibili', 'Search Bilibili videos, list related videos or read comments through the current Bilibili page login. Returns up to 10 results. Read-only; does not post comments.', {
    page, action: { type: 'string', enum: ['search', 'related', 'comments'] }, query: text('Search keywords; required for search.'), bvid: text('Optional BV id for related videos.') }, ['page', 'action'], true),
];
