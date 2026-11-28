/** Fixed browser probes for local smoke fixtures. This module is excluded from the npm package. */
export async function execute({ operation, args }) {
  const task = await taskSpace(args.spaceId);
  const page = task.page(args.page);
  let value;
  if (operation === 'fixture-video-ready') {
    value = await page.evaluate(() => Boolean(window.fixtureReady && document.querySelector('video')?.readyState >= 2));
  } else if (operation === 'fixture-video-playback') {
    value = await page.evaluate(() => ({ paused: document.querySelector('video').paused, pauses: window.fixturePauses }));
  } else if (operation === 'fixture-panel') {
    value = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      return { ready: window.fixtureReady, title: document.querySelector('[role=status]')?.textContent,
        buttons: buttons.filter(button => button.offsetParent !== null).map(button => button.textContent),
        rawVisible: [...document.querySelectorAll('pre')].some(element => !element.closest('details:not([open])')),
        unstyled: buttons.some(button => !button.classList.contains('btn')),
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
  } else {
    throw new Error('Unknown smoke fixture probe.');
  }
  return { spaceId: task.spaceId, value };
}
