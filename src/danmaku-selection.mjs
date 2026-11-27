/** Serialized into the browser along with each site's reader. */
export function selectDanmaku(lines) {
  const unique = [...new Map(lines.map(line => [line.id, line])).values()].sort((a, b) => a.time - b.time);
  const likesKnown = unique.filter(line => Number.isSafeInteger(line.likes) && line.likes >= 0).length;
  const rank = (a, b) => (b.likes ?? -1) - (a.likes ?? -1) || a.time - b.time;
  const seconds = new Map();

  for (const line of unique) {
    const second = Math.floor(line.time);
    let texts = seconds.get(second);
    if (!texts) seconds.set(second, texts = new Map());
    const key = line.text.normalize('NFC').trim().replace(/\s+/g, ' ');
    const previous = texts.get(key);
    if (!previous || rank(line, previous) < 0) texts.set(key, line);
  }

  const buckets = [...seconds.values()].map(texts => [...texts.values()].sort(rank));
  const uniqueTextInRange = buckets.reduce((total, rows) => total + rows.length, 0);
  const limit = 12;
  const spread = rows => rows.length <= limit ? rows
    : Array.from({ length: limit }, (_, index) => rows[Math.round(index * (rows.length - 1) / (limit - 1))]);
  let comments;
  if (!likesKnown) {
    comments = spread(buckets.flat().sort((a, b) => a.time - b.time));
  } else if (buckets.length >= limit) {
    comments = spread(buckets).map(rows => rows[0]);
  } else {
    comments = [];
    for (let offset = 0; comments.length < limit; offset++) {
      const next = buckets.flatMap(rows => rows[offset] ? [rows[offset]] : []);
      if (!next.length) break;
      comments.push(...next.slice(0, limit - comments.length));
    }
  }

  return {
    totalInRange: unique.length,
    uniqueTextInRange,
    comments: comments.sort((a, b) => a.time - b.time),
    truncated: uniqueTextInRange > comments.length,
    ...(unique.length > 0 && { likesStatus: !likesKnown ? 'unavailable' : likesKnown === unique.length ? 'available' : 'partial' }),
  };
}
