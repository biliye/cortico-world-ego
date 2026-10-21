/** Executed by the official ego-browser Node runtime, whose helpers are globals. */
import { videoOperation } from './video-page.mjs';
import { bilibiliDanmaku, decodeDanmakuSegment } from './bilibili-danmaku.mjs';
import { readFile } from 'node:fs/promises';

function errorCode(error) {
  for (let e = error, i = 0; e && i < 5; e = e.cause, i++) {
    if (e.error_code || e.code) return e.error_code || e.code;
  }
  return String(error).match(/EGO_[A-Z_]+/)?.[0];
}
export async function execute({ operation, args }) {
  let task;
  try {
    if (operation === 'resume') {
      // Only an authenticated operator panel can dispatch this operation.
      try { task = await takeOverTaskSpace(args.spaceId); }
      catch (error) {
        if (errorCode(error) !== 'EGO_TASK_SPACE_INACTIVE') throw error;
        task = await claimTaskSpace(args.spaceId);
      }
    } else {
      task = await taskSpace(args.spaceId ?? args.spaceName);
    }
    let value;
    if (operation === 'connect' || operation === 'resume') value = { name: task.name, pages: await inventory(task) };
    else if (operation === 'tabs') value = await inventory(task);
    else if (operation === 'handoff') { await task.handOff(); value = { handedOff: true }; }
    else if (operation === 'finish') { value = await task.finish({ keep: [] }); }
    else if (operation === 'open') {
      const blank = (await task.tabs()).find(t => t.label && t.openedBy === 'agent' && /^(about:blank|chrome:\/\/newtab\/?)$/.test(t.url));
      const page = blank ? task.page(blank.label) : await task.newPage();
      // The label survives failed navigation, allowing later inspection or closure.
      try {
        await page.goto(args.url, { timeout: 30000 });
        value = { page: page.label, url: await page.url(), snapshot: await page.snapshot() };
      } catch (error) {
        if (errorCode(error)?.startsWith('EGO_TASK_') || error.mayHaveLateEffects) throw error;
        return { spaceId: task.spaceId, error: `page=${page.label}: ${error.message}`, code: errorCode(error) };
      }
    } else {
      const tabs = await task.tabs();
      const entry = tabs.find(t => t.label === args.page);
      if (!entry) throw new Error(`Unknown managed page ${args.page}. Use ego_tabs for current page labels.`);
      const page = task.page(args.page);
      switch (operation) {
        case 'read': value = await page.snapshot({ scope: args.fullPage ? 'full_page' : 'only_within_viewport' }); break;
        case 'navigate': await page.goto(args.url, { timeout: 30000 }); value = await page.snapshot(); break;
        case 'click': {
          const receipt = await page.click(args.selector, { label: 'operate page element' });
          value = { receipt, snapshot: await page.snapshot(), pages: await inventory(task) }; break;
        }
        case 'fill': await page.fill(args.selector, args.text); value = await page.snapshot(); break;
        case 'press': await page.press(args.selector, args.key); value = await page.snapshot(); break;
        case 'scroll': await page.mouse.move(args.x ?? 500, args.y ?? 400); await page.mouse.wheel(0, args.deltaY, { label: 'scroll page content' }); value = await page.snapshot(); break;
        case 'evaluate': value = await page.evaluate(args.expression); break;
        case 'shot': {
          value = { ...(await capturePage(task, page, args)), url: await page.url() }; break;
        }
        case 'close':
          if (entry.openedBy !== 'agent') throw new Error('This page is user-owned; it cannot be closed by this World.');
          await page.close(); value = { closed: args.page }; break;
        case 'video': value = await runVideo(task, page, args); break;
        case 'bilibili': value = await page.evaluate(bilibiliQuery, args); break;
        default: throw new Error(`Unsupported operation ${operation}`);
      }
    }
    return { spaceId: task.spaceId, value: value ?? null };
  } catch (error) {
    return { spaceId: task?.spaceId, error: error.message ?? String(error), code: errorCode(error), uncertain: !!error.mayHaveLateEffects };
  }
}
async function inventory(task) {
  return (await task.tabs()).map(({ label, url, title, active, openedBy }) => ({ page: label, url, title, active, openedBy }));
}
async function capturePage(task, page, args) {
  let restoredWindow = false;
  if (args.restoreMinimized) {
    await page.info();
    const window = await task.cdp('Browser.getWindowForTarget', { targetId: page.targetId });
    if (window.bounds.windowState === 'minimized') {
      await task.cdp('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal' } });
      restoredWindow = true;
    }
  }
  await page.screenshot({ path: args.screenshotFile });
  return { image: { base64: (await readFile(args.screenshotFile)).toString('base64'), mime: 'image/png' }, restoredWindow };
}
async function runVideo(task, page, args) {
  const cdp = (method, params) => page.cdp(method, params);
  let state = await scanVideo(cdp, args);
  if (!state) {
    // OOPIFs are separate targets and absent from the parent Page.getFrameTree.
    await page.info();
    const { targetInfos } = await task.cdp('Target.getTargets', { filter: [{ type: 'iframe' }, { exclude: true }] });
    const owned = new Set([page.targetId]);
    const descendants = [];
    for (let pass = 0; pass <= targetInfos.length; pass++) {
      for (const target of targetInfos) if (owned.has(target.parentId) && !owned.has(target.targetId)) { owned.add(target.targetId); descendants.push(target); }
    }
    for (const target of descendants) {
      const { sessionId } = await page.cdp('Target.attachToTarget', { targetId: target.targetId, flatten: false });
      let canDetach = true;
      try { state = await scanVideo((method, params) => childCdp(page, sessionId, method, params), args); }
      catch (error) {
        if (errorCode(error)?.startsWith('EGO_TASK_') || error.mayHaveLateEffects) canDetach = false;
        throw error;
      } finally { if (canDetach) await page.cdp('Target.detachFromTarget', { sessionId }); }
      if (state) break;
    }
  }
  if (!state) {
    if (args.frameId) throw new Error('Video frame no longer exists or contains no matching video. Inspect again without frameId.');
    return { found: false, message: 'No HTML5 video found in accessible frames. The player may still be loading or use a different media surface.' };
  }
  if ((args.action === 'look' || state.batchComplete) && !state.samplePending && !state.image) {
    const shot = await capturePage(task, page, args);
    state.image = shot.image; state.restoredWindow = shot.restoredWindow;
    state.capture = 'viewport-fallback';
    state.captureNote = 'Video pixels could not be read (CORS/DRM/not ready). This image is the page viewport at capture time; it may not show the video.';
  }
  if ((args.action === 'look' || state.batchComplete) && !state.samplePending && /(^|\.)bilibili\.com$/.test(new URL(await page.url()).hostname)) {
    const range = { time: state.time, since: args.since <= state.time ? args.since : Math.max(0, state.time - 15) };
    try { state.bilibili = await page.evaluate(bilibiliSubtitles, range); }
    catch (error) { if (errorCode(error)?.startsWith('EGO_TASK_') || error.mayHaveLateEffects) throw error; state.subtitleError = error.message; }
    if (args.danmaku !== false) {
      try { state.danmaku = await page.evaluate(`(${bilibiliDanmaku.toString()})(${JSON.stringify(range)},${decodeDanmakuSegment.toString()})`); }
      catch (error) { if (errorCode(error)?.startsWith('EGO_TASK_') || error.mayHaveLateEffects) throw error; state.danmaku = { status: 'unavailable', error: error.message }; }
    }
  }
  return state;
}
let childMessageId = 1;
async function childCdp(page, sessionId, method, params) {
  const id = childMessageId++;
  await page.cdp('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    for (const event of await page.events()) {
      if (event.method !== 'Target.receivedMessageFromTarget' || event.params?.sessionId !== sessionId) continue;
      const message = JSON.parse(event.params.message);
      if (message.id !== id) continue;
      if (message.error) throw new Error(message.error.message);
      return message.result;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Object.assign(new Error(`Iframe CDP ${method} timed out; it may have late effects.`), { mayHaveLateEffects: true });
}
async function scanVideo(cdp, args) {
  const tree = await cdp('Page.getFrameTree');
  const frames = [];
  function visit(item) { frames.push(item.frame); for (const child of item.childFrames ?? []) visit(child); }
  visit(tree.frameTree);
  // Frame ids are returned to the caller and revalidated on each round.
  const candidates = args.frameId ? frames.filter(f => f.id === args.frameId) : frames;
  for (const frame of candidates) {
    const world = await cdp('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'cortico-ego-video' });
    const expression = `(${videoOperation.toString()})(${JSON.stringify(args)})`;
    const result = await cdp('Runtime.evaluate', { expression, contextId: world.executionContextId, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    const state = result.result?.value;
    if (!state?.found) continue;
    state.frameId = frame.id;
    return state;
  }
  return null;
}
async function bilibiliSubtitles({ time, since }) {
  if (!/(^|\.)bilibili\.com$/.test(location.hostname)) return null;
  const st = window.__INITIAL_STATE__;
  const info = st?.videoData ?? st?.epInfo;
  const bvid = info?.bvid ?? st?.bvid, aid = info?.aid ?? st?.aid;
  const part = Number(new URL(location.href).searchParams.get('p') ?? 1);
  const cid = info?.pages?.[part - 1]?.cid ?? info?.cid ?? st?.cid;
  if (!cid || (!aid && !bvid)) return { subtitleStatus: 'missing-video-identifiers' };
  const key = `${aid ?? bvid}:${cid}`;
  const cache = window.__corticoEgoBiliCache ??= {};
  const getJson = async (url, credentials = 'include') => {
    const r = await fetch(url, { credentials, signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`Subtitle HTTP ${r.status}`);
    return r.json();
  };
  if (cache.key !== key || Date.now() - cache.loadedAt > 60000) {
    const request = performance.getEntriesByType('resource').map(r => r.name).reverse().find(url => {
      try { const u = new URL(url); return u.hostname === 'api.bilibili.com' && /\/x\/player\/(wbi\/)?v2$/.test(u.pathname) && u.searchParams.get('cid') === String(cid); } catch { return false; }
    });
    const meta = await getJson(request ?? `https://api.bilibili.com/x/player/v2?cid=${cid}&${aid ? `aid=${aid}` : `bvid=${bvid}`}`);
    if (meta.code !== 0) return { subtitleStatus: `Bilibili API ${meta.code}: ${meta.message}` };
    const tracks = meta.data?.subtitle?.subtitles ?? [];
    const selected = tracks.find(t => /zh|cn/i.test(t.lan)) ?? tracks[0];
    let lines = [];
    if (selected?.subtitle_url) {
      const url = new URL(selected.subtitle_url, location.href);
      if (url.protocol !== 'https:') throw new Error('Invalid subtitle URL');
      lines = (await getJson(url.href, 'omit')).body ?? [];
    }
    Object.assign(cache, { key, lines, language: selected?.lan, loadedAt: Date.now(), available: tracks.map(t => t.lan) });
  }
  return { title: info?.title, bvid, cid, language: cache.language, available: cache.available,
    subtitleStatus: cache.lines.length ? 'available' : 'no-subtitles-returned',
    subtitles: cache.lines.filter(l => l.from <= time && l.to >= since).slice(-100).map(l => ({ from: l.from, to: l.to, text: String(l.content).slice(0, 2000) })) };
}
async function bilibiliQuery(args) {
  if (!/(^|\.)bilibili\.com$/.test(location.hostname)) throw new Error('Open a Bilibili page first.');
  const st = window.__INITIAL_STATE__;
  const info = st?.videoData;
  let url;
  if (args.action === 'search') url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(args.query)}&page=1`;
  else if (args.action === 'related') url = `https://api.bilibili.com/x/web-interface/archive/related?bvid=${encodeURIComponent(args.bvid ?? info?.bvid ?? '')}`;
  else url = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${Number(info?.aid)}&mode=3&next=0`;
  const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Bilibili HTTP ${response.status}`);
  const json = await response.json();
  if (json.code !== 0) throw new Error(`Bilibili API ${json.code}: ${json.message}`);
  const data = args.action === 'search' ? json.data?.result : args.action === 'related' ? json.data : json.data?.replies;
  return (data ?? []).slice(0, 10).map(i => args.action === 'comments' ? { user: i.member?.uname, text: i.content?.message, likes: i.like }
    : { bvid: i.bvid, title: String(i.title).replace(/<[^>]*>/g, ''), author: i.author ?? i.owner?.name, url: `https://www.bilibili.com/video/${i.bvid}` });
}
