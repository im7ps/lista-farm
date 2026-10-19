/*
 * popup.js - impostazioni dell'estensione (salvate con chrome.storage.sync).
 * La popup non chiama il gioco: legge solo i dati salvati e rilevati.
 */
(async () => {
  const S = TGShared;
  const $ = id => document.getElementById(id);

  function setMsg(text, cls) {
    $('msg').className = `msg ${cls}`;
    $('msg').textContent = text;
  }

  function buildTroopInputs(troops) {
    const box = $('troops');
    box.innerHTML = '';
    S.TROOP_KEYS.forEach(k => {
      const label = document.createElement('label');
      label.textContent = k;
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.step = '1';
      input.id = `troop-${k}`;
      input.value = troops[k];
      label.appendChild(input);
      box.appendChild(label);
    });
  }

  // Menu dei villaggi rilevati sul gioco. "" = villaggio attivo al momento dell'import.
  async function fillTargets(current) {
    const detected = await S.getLocal(S.KEYS.detected);
    const select = $('target');
    select.innerHTML = '';
    select.add(new Option('Automatico: villaggio attivo', ''));

    if (detected && detected.villages.length) {
      detected.villages.forEach(v => {
        const label = `${v.name} (${v.id})${v.active ? ' - attivo' : ''}`;
        select.add(new Option(label, String(v.id)));
      });
    } else {
      $('target').disabled = true;
    }
    select.value = current || '';
    if (select.value !== (current || '')) select.value = '';
  }

  async function showInfo() {
    const saved = await S.getLocal(S.KEYS.saved);
    const detected = await S.getLocal(S.KEYS.detected);
    $('savedInfo').textContent = saved
      ? `Villaggi salvati da GetterTools: ${saved.villages.length} (${saved.server})`
      : 'Nessun villaggio salvato da GetterTools.';
    $('detectedInfo').textContent = detected
      ? `Villaggi rilevati sul gioco: ${detected.villages.length} (${detected.server})`
      : 'Nessun villaggio rilevato: apri una pagina del gioco.';
  }

  // Legge un intero dal campo, con controllo dell'intervallo.
  function readInt(id, min, max, label) {
    const n = Number($(id).value.trim());
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(`${label}: inserisci un intero tra ${min} e ${max}.`);
    }
    return n;
  }

  function readForm() {
    const prefix = $('prefix').value.trim();
    if (!prefix) throw new Error('Il prefisso dei nomi lista non può essere vuoto.');

    const minDelayMs = readInt('minDelayMs', 0, 60000, 'Pausa minima');
    const maxDelayMs = readInt('maxDelayMs', 0, 60000, 'Pausa massima');
    if (minDelayMs > maxDelayMs) throw new Error('La pausa minima non può superare la massima.');

    const troops = {};
    S.TROOP_KEYS.forEach(k => {
      troops[k] = readInt(`troop-${k}`, 0, 1000000, `Truppe ${k}`);
    });

    return {
      targetVillageId: $('target').value,
      prefix,
      capacity: readInt('capacity', 1, S.MAX_LIST_CAPACITY, 'Capacità per lista'),
      maxVillages: readInt('maxVillages', 0, S.HARD_MAX_VILLAGES, 'Max villaggi'),
      troops,
      onlyLosses: $('onlyLosses').checked,
      useShip: $('useShip').checked,
      minDelayMs,
      maxDelayMs,
      batchSize: readInt('batchSize', 1, 100, 'Obiettivi per richiesta'),
      dryRun: $('dryRun').checked
    };
  }

  async function save() {
    try {
      await S.saveSettings(readForm());
      setMsg('Impostazioni salvate.', 'ok');
    } catch (err) {
      setMsg(err.message, 'err');
    }
  }

  const settings = await S.getSettings();
  $('prefix').value = settings.prefix;
  $('capacity').value = settings.capacity;
  $('maxVillages').value = settings.maxVillages;
  $('onlyLosses').checked = settings.onlyLosses;
  $('useShip').checked = settings.useShip;
  $('minDelayMs').value = settings.minDelayMs;
  $('maxDelayMs').value = settings.maxDelayMs;
  $('batchSize').value = settings.batchSize;
  $('dryRun').checked = settings.dryRun;
  buildTroopInputs(settings.troops);
  await fillTargets(settings.targetVillageId);
  await showInfo();

  $('save').addEventListener('click', save);
})();
