/*
 * gettertools.js - content script su gettertools.com.
 *
 * Aggiunge il pulsante "Salva villaggi per Travian": legge la tabella dei risultati
 * e salva in chrome.storage.local i villaggi insieme al dominio del server.
 */
(() => {
  const S = TGShared;

  // Dominio del server = secondo segmento del path, es. /ts10.x1.america.travian.com/42-Search-inactives
  function serverFromPath(pathname) {
    const segment = pathname.split('/')[1] || '';
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(segment) ? segment.toLowerCase() : null;
  }

  const ui = S.createOverlay();
  ui.box.innerHTML = `
    <div class="title">Liste farm per Travian</div>
    <div class="msg" id="msg">Clicca per salvare i villaggi di questa pagina.</div>
    <div class="actions"><button class="primary" id="save">Salva villaggi per Travian</button></div>
  `;
  const msg = ui.box.querySelector('#msg');
  ui.box.querySelector('#save').addEventListener('click', onSave);

  async function onSave() {
    try {
      const server = serverFromPath(location.pathname);
      if (!server) {
        throw new Error("Dominio del server non trovato nell'URL di GetterTools.");
      }

      const result = S.extractVillages(document);
      if (result.villages.length === 0) {
        throw new Error('Nessun villaggio valido trovato nella tabella.');
      }

      await S.setLocal(S.KEYS.saved, { server, villages: result.villages, savedAt: Date.now() });

      const lines = [`Salvati ${result.villages.length} villaggi per ${server}.`];
      if (result.duplicates) lines.push(`Duplicati scartati: ${result.duplicates}`);
      if (result.invalid.length) {
        lines.push(`Righe scartate: ${result.invalid.length}`, ...result.invalid.slice(0, 5));
      }
      msg.className = 'msg ok';
      msg.innerHTML = lines.map(S.esc).join('<br>');
    } catch (err) {
      msg.className = 'msg err';
      msg.textContent = err.message;
    }
  }
})();
