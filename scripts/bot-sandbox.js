// Runs inside the sandboxed bot iframe. Starts the bot's Worker from the source CelChat sends and
// relays messages both ways. Nothing here can reach CelChat's origin, storage or keys.
(function () {
  'use strict';
  var worker = null;
  function up(m) {
    parent.postMessage(m, '*');
  }
  addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.t === 'init') {
      if (worker) return;
      var url = URL.createObjectURL(new Blob([String(m.source)], { type: 'text/javascript' }));
      try {
        worker = new Worker(url, { name: 'celchat-bot' });
      } catch (err) {
        up({ t: 'fatal', message: String((err && err.message) || err) });
        return;
      }
      worker.onmessage = function (ev) {
        up(ev.data);
      };
      worker.onerror = function (ev) {
        ev.preventDefault();
        up({ t: 'fatal', message: ev.message || 'The bot crashed while loading', line: ev.lineno || 0, col: ev.colno || 0 });
      };
      worker.onmessageerror = function () {
        up({ t: 'log', level: 'error', args: ['A message could not be delivered to CelChat (it contained something that cannot be copied).'] });
      };
      return;
    }
    if (worker) {
      try {
        worker.postMessage(m);
      } catch (err) {
        up({ t: 'log', level: 'error', args: [String(err)] });
      }
    }
  });
  up({ t: 'sandbox' });
})();
