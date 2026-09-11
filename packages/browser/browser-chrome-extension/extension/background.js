const NATIVE_HOST = 'com.deepseek.dsh.browser'
const attached = new Set()
let port
let connected = false

function connect() {
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST)
  } catch {
    connected = false
    return
  }
  connected = true
  chrome.action.setBadgeText({ text: '●' })
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a' })
  port.onMessage.addListener((message) => { void handleHostMessage(message) })
  port.onDisconnect.addListener(() => {
    connected = false
    chrome.action.setBadgeText({ text: '' })
    port = undefined
    setTimeout(connect, 1000)
  })
}

function post(message) {
  if (port === undefined) return
  port.postMessage(message)
}

async function handleHostMessage(message) {
  if (message == null || typeof message !== 'object' || typeof message.id !== 'number') return
  try {
    const result = await dispatch(message.method, message.params ?? {})
    post({ jsonrpc: '2.0', id: message.id, result })
  } catch (error) {
    post({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    })
  }
}

async function dispatch(method, params) {
  switch (method) {
    case 'tabs.list':
      return (await chrome.tabs.query({})).map(projectTab)
    case 'tabs.create': {
      let sibling
      if (params.groupWithTabId !== undefined) {
        const tabs = await chrome.tabs.query({})
        sibling = tabs.find(tab => String(tab.id) === params.groupWithTabId)
      }
      const tab = await chrome.tabs.create({ url: params.url, active: false,
        ...(sibling === undefined ? {} : { windowId: sibling.windowId }),
      })
      if (params.group !== true || tab.id === undefined) return projectTab(tab)
      const groupId = await chrome.tabs.group({ tabIds: [tab.id],
        ...(sibling !== undefined && sibling.groupId !== -1 ? { groupId: sibling.groupId } : {}),
      })
      await chrome.tabGroups.update(groupId, { title: params.groupTitle ?? 'DeepSeek', color: 'blue' })
      return projectTab(await chrome.tabs.get(tab.id))
    }
    case 'tabs.close':
      await chrome.tabs.remove(Number(params.tabId))
      return { ok: true }
    case 'tabs.activate': {
      const tab = await chrome.tabs.update(Number(params.tabId), { active: true })
      await chrome.windows.update(tab.windowId, { focused: true })
      return { ok: true }
    }
    case 'debugger.attach': {
      const tabId = Number(params.tabId)
      if (!attached.has(tabId)) {
        await chrome.debugger.attach({ tabId }, '1.3')
        attached.add(tabId)
        try {
          await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', {
            autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
          })
        } catch {
          // Older Chrome builds omit flattened child sessions; frame tools then
          // attach to iframe targets explicitly.
        }
      }
      return { ok: true }
    }
    case 'debugger.detach': {
      const tabId = Number(params.tabId)
      if (attached.has(tabId)) {
        await chrome.debugger.detach({ tabId })
        attached.delete(tabId)
      }
      return { ok: true }
    }
    case 'debugger.sendCommand': {
      const debuggee = params.targetId !== undefined && params.targetId !== ''
        ? { targetId: String(params.targetId) }
        : { tabId: Number(params.tabId) }
      if (typeof params.sessionId === 'string' && params.sessionId.length > 0) {
        return chrome.debugger.sendCommand(debuggee, params.method, params.params ?? {}, params.sessionId)
      }
      return chrome.debugger.sendCommand(debuggee, params.method, params.params ?? {})
    }
    case 'debugger.getTargets':
      return chrome.debugger.getTargets()
    case 'history.search':
      return chrome.history.search({ text: params.query, maxResults: 50 })
    case 'bookmarks.list':
      return flattenBookmarks(await chrome.bookmarks.getTree())
    case 'bookmarks.create':
      return chrome.bookmarks.create({ title: params.title, url: params.url })
    case 'readingList.list':
      return chrome.readingList.query({})
    case 'readingList.add':
      return chrome.readingList.addEntry({ title: params.title, url: params.url, hasBeenRead: false })
    case 'downloads.list':
      return (await chrome.downloads.search({ limit: 50, orderBy: ['-startTime'] })).map(projectDownload)
    case 'downloads.get': {
      const rows = await chrome.downloads.search({ id: Number(params.id) })
      return rows[0] === undefined ? null : projectDownload(rows[0])
    }
    case 'notifications.create':
      return chrome.notifications.create({
        type: 'basic',
        title: params.title ?? 'DeepSeek Harness',
        message: params.message ?? '',
        iconUrl: 'popup.html',
      })
    default:
      throw new Error(`unknown browser host method "${method}"`)
  }
}

function projectTab(tab) {
  return {
    id: String(tab.id ?? ''),
    url: tab.url ?? '',
    title: tab.title ?? '',
    active: tab.active === true,
    windowId: tab.windowId ?? 0,
    grouped: tab.groupId !== undefined && tab.groupId !== -1,
  }
}

function flattenBookmarks(nodes, out = []) {
  for (const node of nodes) {
    out.push({ id: node.id, title: node.title ?? '', url: node.url })
    if (node.children) flattenBookmarks(node.children, out)
  }
  return out
}

function projectDownload(item) {
  const state = item.state === 'interrupted' || item.state === 'complete' ? item.state : 'in_progress'
  return {
    id: String(item.id ?? ''),
    url: item.url ?? '',
    filename: item.filename ?? '',
    state,
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
    exists: item.exists,
    error: item.error,
    filePath: state === 'complete' ? item.filename : undefined,
  }
}

chrome.debugger.onEvent.addListener((source, method, params, sessionId) => {
  post({
    jsonrpc: '2.0',
    method: 'debugger.event',
    params: {
      tabId: String(source.tabId ?? ''),
      method,
      params,
      ...typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {},
      ...source.targetId !== undefined ? { targetId: source.targetId } : {},
    },
  })
})

chrome.debugger.onDetach.addListener((source) => {
  attached.delete(source.tabId)
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'status') sendResponse({ connected })
})

connect()
