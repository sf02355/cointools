// 在扩展安装或更新时设置侧边栏行为
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('Failed to set side panel behavior:', error));
  console.log("Side panel behavior set to open on action click.");
});

// !! 注意：如果使用了 setPanelBehavior，您就不再需要下面的 onClicked 监听器来打开侧边栏了。
// !! 您可以移除它，或者保留它用于执行 *其他* 点击时需要做的事情 (如果_有_的话)。
/*
chrome.action.onClicked.addListener((tab) => {
  console.log("Action icon clicked (manual listener)...");
  if (chrome.sidePanel) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  } else {
    console.error("Side Panel API is not available.");
  }
});
*/

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) {
    sendResponse({ success: false, message: '无效的消息' });
    return true;
  }

  if (message.action === 'getCookies') {
    chrome.cookies.getAll({ url: 'https://www.bybit.com' }, (cookies) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, message: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ success: true, cookieHeader: cookies.map(c => `${c.name}=${c.value}`).join('; ') });
    });
  } else if (message.action === 'testCommunication') {
    sendResponse({ success: true, message: '通信测试成功' });
  } else if (message.action === 'toggleSidebar') {
    // 直接响应，无需额外发送消息
    sendResponse({ success: true, message: '侧边栏触发成功' });
  } else {
    sendResponse({ success: false, message: '未知的操作' });
  }
  return true; // 保持消息通道开放以支持异步响应
});