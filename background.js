// Open the tool as a full tab (a popup closes itself as soon as another window takes focus).
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("popup.html");
  const [existing] = await chrome.tabs.query({ url });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url });
});
