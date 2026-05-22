/**
 * popup.js — Popup UI logic for ConvergePanel Verify extension.
 *
 * Responsibilities:
 * - Reads the last selected text from chrome.storage.local.
 * - Displays a truncated preview of the selected text.
 * - Provides buttons to open ConvergePanel or verify the last selection.
 */

const CONVERGEPANEL_URL = 'https://convergepanel.com';
const CONVERGEPANEL_VERIFY_URL = 'https://convergepanel.com/verify';
const MAX_PREVIEW_LENGTH = 140;

document.addEventListener('DOMContentLoaded', async () => {
  const previewEl = document.getElementById('preview-text');
  const btnVerify = document.getElementById('btn-verify');
  const btnOpen = document.getElementById('btn-open');

  const { selectedText } = await chrome.storage.local.get('selectedText');

  if (selectedText && selectedText.trim()) {
    const display = selectedText.length > MAX_PREVIEW_LENGTH
      ? selectedText.slice(0, MAX_PREVIEW_LENGTH) + '…'
      : selectedText;

    previewEl.textContent = `"${display}"`;
    previewEl.classList.remove('empty');
    btnVerify.disabled = false;
  }

  btnVerify.addEventListener('click', async () => {
    const { selectedText: text } = await chrome.storage.local.get('selectedText');
    if (!text || !text.trim()) return;

    const url = `${CONVERGEPANEL_VERIFY_URL}?source=extension&text=${encodeURIComponent(text)}`;
    chrome.tabs.create({ url });
  });

  btnOpen.addEventListener('click', () => {
    chrome.tabs.create({ url: CONVERGEPANEL_URL });
  });
});
