// On a kid's Android phone (the Family Screen Warden app), the page talks to the app through window.ScreenWardenAndroid
// instead of WebView2's window.chrome.webview. This makes the phone look like WebView2, so launcher.js is the same
// everywhere. It does nothing on Windows.
(function () {
  if (!window.ScreenWardenAndroid || (window.chrome && window.chrome.webview)) return;
  var listeners = [];
  window.chrome = window.chrome || {};
  window.chrome.webview = {
    postMessage: function (m) { window.ScreenWardenAndroid.post(typeof m === 'string' ? m : JSON.stringify(m)); },
    addEventListener: function (type, f) { if (type === 'message') listeners.push(f); },
  };
  window.__swReceive = function (data) { listeners.forEach(function (f) { f({ data: data }); }); };
})();
