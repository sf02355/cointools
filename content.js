console.log('内容脚本已加载于:', window.location.href);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fillOrderValue') {
    console.log('收到填充订单价值请求，值:', message.value);
    setTimeout(() => {
      const value = message.value;
      let inputField = document.getElementById('orderLimitAmount');
      
      if (inputField) {
        console.log('找到订单价值输入框:', inputField);
        inputField.value = value;
        inputField.dispatchEvent(new Event('input', { bubbles: true }));
        inputField.dispatchEvent(new Event('change', { bubbles: true }));
        console.log(`订单价值框已填入: ${value}`);
        sendResponse({ success: true, message: `成功填入 ${value}` });
      } else {
        console.error('未找到订单价值输入框 (ID: orderLimitAmount)');
        sendResponse({ success: false, message: '未找到订单价值输入框 (ID: orderLimitAmount)' });
      }
    }, 3000); // 延迟 3 秒
    return true; // 保持消息通道开放
  }
});