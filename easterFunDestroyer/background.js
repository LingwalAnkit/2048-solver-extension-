// MV3 background service worker
// Uses chrome.action (not chrome.browserAction which was MV2)
// Uses chrome.scripting.executeScript (not chrome.tabs.executeScript which was MV2)

console.log('[2048-Solver] Background service worker started.');

chrome.action.onClicked.addListener(function (tab) {
  console.log('[2048-Solver] Extension icon clicked, tab:', tab.id, tab.url);

  if (!tab.url || !tab.url.includes('play2048.co')) {
    console.warn('[2048-Solver] Not on play2048.co, ignoring click.');
    return;
  }

  chrome.scripting.executeScript(
    {
      target: { tabId: tab.id },
      files: ['content.js'],
      world: 'MAIN',
    },
    (results) => {
      if (chrome.runtime.lastError) {
        console.error('[2048-Solver] executeScript error:', chrome.runtime.lastError.message);
      } else {
        console.log('[2048-Solver] content.js injected successfully:', results);
      }
    }
  );
});