// Google sends the browser here after "Continue with Google". Hand the result back to CelChat:
// the web app (same origin) gets it over BroadcastChannel/postMessage; the desktop and iPhone apps
// (state starts with "n.") get it through a celchat://oauth link. Nothing is stored here.
(function () {
  var hash = location.hash.slice(1) || location.search.slice(1);
  var p = new URLSearchParams(hash);
  var m = document.getElementById('m');
  history.replaceState(null, '', location.pathname); // keep the token out of the history
  if ((p.get('state') || '').indexOf('n.') === 0) {
    m.textContent = 'Going back to the CelChat app... You can close this tab.';
    location.replace('celchat://oauth#' + hash);
    return;
  }
  try {
    new BroadcastChannel('celchat-oauth').postMessage(hash);
  } catch (e) {}
  try {
    if (window.opener) window.opener.postMessage({ type: 'celchat-oauth', hash: hash }, location.origin);
  } catch (e) {}
  m.textContent = p.get('error') ? 'Sign-in was cancelled. You can close this window.' : 'Signed in! You can close this window.';
  setTimeout(function () {
    window.close();
  }, 400);
})();
