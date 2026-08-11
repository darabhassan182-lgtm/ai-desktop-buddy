/* NEXUS — Memory panel wiring. Self-contained; uses window.nexus.memory.
   Secret VALUES never come back from the bridge — only names/notes are shown. */
(function () {
  'use strict';
  var mem = (window.nexus && window.nexus.memory) ? window.nexus.memory : null;
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var panel = $('memoryPanel'), backdrop = $('memBackdrop');
  function open() {
    if (panel) { panel.classList.add('show'); panel.setAttribute('aria-hidden', 'false'); }
    if (backdrop) backdrop.classList.add('show');
    refresh();
  }
  function close() {
    if (panel) { panel.classList.remove('show'); panel.setAttribute('aria-hidden', 'true'); }
    if (backdrop) backdrop.classList.remove('show');
  }
  var openBtn = $('memoryBtn'); if (openBtn) openBtn.addEventListener('click', open);
  var closeBtn = $('memClose'); if (closeBtn) closeBtn.addEventListener('click', close);
  if (backdrop) backdrop.addEventListener('click', close);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  // Tabs
  var tabs = document.querySelectorAll('.mem-tab');
  Array.prototype.forEach.call(tabs, function (t) {
    t.addEventListener('click', function () {
      Array.prototype.forEach.call(tabs, function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      var which = t.getAttribute('data-tab');
      Array.prototype.forEach.call(document.querySelectorAll('.mem-body'), function (b) {
        b.classList.toggle('hidden', b.getAttribute('data-panel') !== which);
      });
    });
  });

  function refresh() {
    var nl = $('noteList'), sl = $('secList');
    if (!mem) {
      if (nl) nl.innerHTML = '<li class="mem-empty">Memory needs the latest app — please reinstall Nexus (or run the newest build).</li>';
      return;
    }
    Promise.resolve(mem.list()).then(function (data) {
      data = data || { notes: [], secrets: [] };
      if (nl) {
        nl.innerHTML = '';
        if (!data.notes.length) nl.innerHTML = '<li class="mem-empty">Nothing yet. Tell Nova things to remember, or add them here.</li>';
        data.notes.forEach(function (n) {
          var li = document.createElement('li'); li.className = 'mem-item';
          li.innerHTML = '<span class="mem-kind">' + esc(n.kind) + '</span>' +
            '<span class="mem-text">' + esc(n.text) + '</span>' +
            '<button class="mem-del" title="Delete">✕</button>';
          li.querySelector('.mem-del').addEventListener('click', function () {
            Promise.resolve(mem.deleteNote(n.id)).then(refresh);
          });
          nl.appendChild(li);
        });
      }
      if (sl) {
        sl.innerHTML = '';
        if (!data.secrets.length) sl.innerHTML = '<li class="mem-empty">No keys stored yet.</li>';
        data.secrets.forEach(function (s) {
          var warn = s.insecure ? ' <span class="mem-warn" title="Keychain unavailable — obfuscated, not encrypted">⚠︎</span>' : '';
          var li = document.createElement('li'); li.className = 'mem-item';
          li.innerHTML = '<span class="mem-kind">key</span>' +
            '<span class="mem-text"><b>' + esc(s.name) + '</b>' + (s.note ? ' — ' + esc(s.note) : '') +
            ' <span class="mem-mask">•••• stored</span>' + warn + '</span>' +
            '<button class="mem-del" title="Delete">✕</button>';
          li.querySelector('.mem-del').addEventListener('click', function () {
            Promise.resolve(mem.deleteSecret(s.name)).then(refresh);
          });
          sl.appendChild(li);
        });
        var sn = $('secNote');
        if (sn && data.encAvailable === false) sn.textContent = '⚠︎ macOS Keychain unavailable — secrets are obfuscated, not encrypted. Avoid storing sensitive keys.';
      }
    }).catch(function () {});
  }

  var noteForm = $('noteForm');
  if (noteForm) noteForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var i = $('noteInput');
    if (!mem || !i || !i.value.trim()) return;
    Promise.resolve(mem.addNote('note', i.value.trim())).then(function () { i.value = ''; refresh(); });
  });

  var secForm = $('secForm');
  if (secForm) secForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!mem) return;
    var nm = $('secName'), v = $('secValue'), d = $('secDesc');
    if (!v || !v.value) return;
    Promise.resolve(mem.setSecret((nm && nm.value) || '', v.value, (d && d.value) || '')).then(function () {
      if (nm) nm.value = ''; if (v) v.value = ''; if (d) d.value = '';
      refresh();
    });
  });

  // Live sync + secret-captured notices
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast'); if (!t || !msg) return;
    t.textContent = msg; t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3400);
  }
  if (window.nexus && typeof window.nexus.on === 'function') {
    window.nexus.on('memory', function () { if (panel && panel.classList.contains('show')) refresh(); });
    window.nexus.on('notice', function (p) { toast(p && p.text); });
  }
})();
