/** Serialized into the managed page by Ego; keep this function self-contained. */
export async function bilibiliComments(args) {
  const pageUrl = location.href;
  const explicit = args.aid !== undefined || args.bvid !== undefined;
  const receipt = { action: 'comments', page: args.page, pageUrl, targetSource: explicit ? 'explicit' : 'page',
    requestedTarget: null, video: null, status: 'target-unavailable', comments: [] };
  const validAid = value => Number.isSafeInteger(value) && value > 0;
  const validBvid = value => typeof value === 'string' && /^BV[0-9A-Za-z]{10}$/.test(value);
  if (!/(^|\.)bilibili\.com$/.test(location.hostname)) return { ...receipt, reason: 'Open a Bilibili page first to provide the login context.' };
  let aid = args.aid, bvid = args.bvid;
  if (explicit) {
    if ((aid !== undefined && !validAid(aid)) || (bvid !== undefined && !validBvid(bvid))) {
      return { ...receipt, reason: 'Invalid target: aid must be a positive safe integer; bvid must be a BV id.' };
    }
  } else {
    // Prefer the live URL over potentially stale __INITIAL_STATE__ after SPA navigation.
    const id = new URL(pageUrl).pathname.match(/^\/video\/(BV[0-9A-Za-z]{10}|av[1-9][0-9]*)(?:\/|$)/)?.[1];
    if (!id) return { ...receipt, reason: 'This page has no supported video URL. Pass an explicit aid or bvid.' };
    if (id.startsWith('BV')) bvid = id;
    else aid = Number(id.slice(2));
    if (aid !== undefined && !validAid(aid)) return { ...receipt, reason: 'The page video aid is invalid.' };
  }
  receipt.requestedTarget = { ...(aid !== undefined ? { aid } : {}), ...(bvid !== undefined ? { bvid } : {}) };
  try {
    // Both requests share a deadline below Ego's page-evaluation limit.
    const signal = AbortSignal.timeout(10000);
    const getJson = async url => {
      const response = await fetch(url, { credentials: 'include', signal });
      if (!response.ok) throw new Error(`Bilibili HTTP ${response.status}`);
      const json = await response.json();
      if (json?.code !== 0) throw new Error(`Bilibili API ${json?.code}: ${json?.message}`);
      return json.data;
    };
    const info = await getJson(`https://api.bilibili.com/x/web-interface/view?${bvid ? `bvid=${encodeURIComponent(bvid)}` : `aid=${aid}`}`);
    if (!validAid(info?.aid) || !validBvid(info?.bvid)) throw new Error('Bilibili video metadata is missing valid aid/bvid.');
    if ((aid !== undefined && info.aid !== aid) || (bvid !== undefined && info.bvid !== bvid)) {
      return { ...receipt, reason: 'Video metadata does not match the requested aid/bvid; no comments were requested.' };
    }
    receipt.video = { aid: info.aid, bvid: info.bvid, title: typeof info.title === 'string' ? info.title.slice(0, 300) : null };
    const data = await getJson(`https://api.bilibili.com/x/v2/reply/main?type=1&oid=${info.aid}&mode=3&next=0`);
    if (!data || !Object.prototype.hasOwnProperty.call(data, 'replies') || (data.replies !== null && !Array.isArray(data.replies))) {
      throw new Error('Bilibili comments response is missing a valid replies field.');
    }
    const comments = (data.replies ?? []).slice(0, 10).map(i => ({ user: i.member?.uname, text: i.content?.message, likes: i.like }));
    return { ...receipt, status: comments.length ? 'available' : 'empty', comments,
      ...(comments.length ? {} : { reason: 'The API returned an empty list for this request; this does not prove the video has no comments.' }) };
  } catch (error) {
    return { ...receipt, status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}
