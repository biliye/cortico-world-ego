import { copyFile, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';

export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function safeFilename(hint) {
  const name = String(hint ?? '').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').trim().replace(/^[. ]+|[. ]+$/g, '');
  const extension = name.match(/\.[a-z0-9]{1,12}$/i)?.[0] ?? '';
  const stem = (extension ? name.slice(0, -extension.length) : name).slice(0, 96).trimEnd() || 'download';
  const reserved = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(stem);
  return `${reserved ? '_' : ''}${stem}${extension}`;
}

export async function uploadFile(page, args) {
  const file = args.transferFile;
  if (args.chooser !== true) return page.setInputFiles(args.selector, [file]);
  const [chooser] = await Promise.all([
    page.waitForFileChooser({ timeout: Math.min(10000, args.transferTimeoutMs) }),
    page.click(args.selector, { label: 'open file chooser' }),
  ]);
  return chooser.setFiles(file);
}

export async function downloadFile(task, page, args) {
  if (args.url !== undefined) {
    const result = await page.evaluate(fetchFile, {
      url: args.url, maxBytes: MAX_FILE_BYTES, timeoutMs: Math.min(12000, args.transferTimeoutMs),
    });
    if (result.error) throw new Error(result.error);
    const bytes = Buffer.from(result.base64, 'base64');
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('File exceeds the 8 MiB transfer limit.');
    await writeFile(args.transferFile, bytes, { flag: 'wx', mode: 0o600 });
    return { name: safeFilename(result.name), mime: result.mime };
  }

  const timeoutMs = args.transferTimeoutMs;
  const started = Date.now();
  const startTimeoutMs = Math.min(25000, timeoutMs);
  let clickCompleted = false;
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: startTimeoutMs }),
    page.click(args.selector, { label: 'start file download' }).then(receipt => {
      clickCompleted = !receipt?.dialog;
    }),
  ]).catch(async error => {
    if (/^page\.waitForEvent\("download"\) timed out after \d+ms$/.test(error.message)) {
      const canContinue = clickCompleted && await canReadDownloadPage(task, page);
      const hint = canContinue
        ? 'The page is still readable. Check ego_read or ego_tabs; if you find the intended file URL, use ego_download with url.'
        : 'Check the browser and resume from the World panel.';
      throw Object.assign(new Error(`No download event observed within ${startTimeoutMs}ms. The download outcome is unknown. ${hint} Do not repeat the click blindly.`), {
        code: 'EGO_DOWNLOAD_START_TIMEOUT', mayHaveLateEffects: !canContinue,
      });
    }
    if (/timed out/i.test(error.message)) error.mayHaveLateEffects = true;
    throw error;
  });
  let timer;
  try {
    const source = await Promise.race([
      download.path(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Browser download did not finish in time. Check the page before retrying.'), {
          code: 'EGO_COMMAND_TIMEOUT', mayHaveLateEffects: true,
        })), Math.max(1, timeoutMs - (Date.now() - started)));
      }),
    ]);
    if ((await stat(source)).size > MAX_FILE_BYTES) throw new Error('File exceeds the 8 MiB transfer limit.');
    await copyFile(source, args.transferFile, constants.COPYFILE_EXCL);
    return { name: safeFilename(download.suggestedFilename()) };
  } catch (error) {
    if (error.code === 'EGO_COMMAND_TIMEOUT') void download.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function canReadDownloadPage(task, page) {
  try {
    await task.waitForControl({ interval: 1, timeout: 1 });
    if (typeof await page.snapshot() !== 'string') return false;
    await task.waitForControl({ interval: 1, timeout: 1 });
    return true;
  } catch {
    return false;
  }
}

// This callback is serialized by Ego and runs inside the managed page.
async function fetchFile({ url, maxBytes, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const target = new URL(url, document.baseURI);
    if (!['http:', 'https:', 'blob:'].includes(target.protocol) || target.username || target.password) {
      throw new Error('Use a page-relative URL, HTTP(S) URL without credentials, or a blob URL from this page.');
    }
    const response = await fetch(target, { credentials: 'same-origin', signal: controller.signal });
    if (!response.ok) throw new Error(`File request failed: HTTP ${response.status}.`);
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('File exceeds the 8 MiB transfer limit.');
    const reader = response.body?.getReader();
    let length = 0;
    let binary = '';
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('File exceeds the 8 MiB transfer limit.');
      for (let i = 0; i < value.byteLength; i += 0x4000) binary += String.fromCharCode(...value.subarray(i, i + 0x4000));
    }
    const encodedName = new URL(response.url || target).pathname.split('/').pop();
    let name = encodedName;
    try { name = decodeURIComponent(encodedName); } catch { /* Keep a malformed percent escape literal. */ }
    return { name, mime: response.headers.get('content-type'), base64: btoa(binary) };
  } catch (error) {
    controller.abort();
    return { error: error.message };
  } finally {
    clearTimeout(timer);
  }
}
