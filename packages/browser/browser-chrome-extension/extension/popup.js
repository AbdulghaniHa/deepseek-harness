const status = document.getElementById('status')
chrome.runtime.sendMessage({ type: 'status' }, (response) => {
  if (chrome.runtime.lastError || response?.connected !== true) return
  status.textContent = 'Connected'
  status.className = 'ok'
})
