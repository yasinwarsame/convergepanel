/**
 * background.js — Service worker for ConvergePanel Verify extension.
 *
 * Responsibilities:
 * - Creates a context menu item on extension install.
 * - Listens for context menu clicks on selected text.
 * - Saves the selected text to chrome.storage.local for popup access.
 * - Opens ConvergePanel verification page with the selected text prefilled.
 */

const CONVERGEPANEL_VERIFY_URL = 'https://convergepanel.com/verify';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'verify-with-convergepanel',
    title: 'Verify with ConvergePanel',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'verify-with-convergepanel') return;

  const selectedText = info.selectionText || '';
  if (!selectedText.trim()) return;

  await chrome.storage.local.set({
    selectedText,
    selectedAt: Date.now()
  });

  const url = `${CONVERGEPANEL_VERIFY_URL}?source=extension&text=${encodeURIComponent(selectedText)}`;
  chrome.tabs.create({ url });
});
