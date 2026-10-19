/*
 * shared.js - utilità condivise da popup, content script di GetterTools e di Travian.
 *
 * Nessun valore è legato a un server, a un villaggio o a una lista specifici:
 * tutto arriva dalle impostazioni (chrome.storage.sync), dai dati salvati
 * (chrome.storage.local) o dalla pagina stessa (location.origin, DOM).
 */
const TGShared = (() => {
  // Massimo di villaggi importabili in una esecuzione (vincolo della pagina GetterTools).
  const HARD_MAX_VILLAGES = 500;
  // Obiettivi massimi per lista imposti dal gioco.
  const MAX_LIST_CAPACITY = 100;

  const TROOP_KEYS = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'];

  const KEYS = {
    settings: 'settings',          // chrome.storage.sync: impostazioni
    saved: 'savedVillages',        // chrome.storage.local: villaggi salvati da GetterTools
    detected: 'detectedVillages',  // chrome.storage.local: villaggi rilevati sul gioco
    runs: 'runs'                   // chrome.storage.local: stato delle esecuzioni (per riprendere)
  };

  function defaultTroops() {
    const troops = {};
    TROOP_KEYS.forEach(k => { troops[k] = 0; });
    troops.t1 = 2;
    return troops;
  }

  const DEFAULT_SETTINGS = {
    targetVillageId: '',   // '' = villaggio attivo al momento dell'importazione
    prefix: 'inattivi',
    capacity: MAX_LIST_CAPACITY,
    maxVillages: 0,        // 0 = tutti (fino a HARD_MAX_VILLAGES)
    troops: defaultTroops(),
    onlyLosses: true,
    useShip: false,
    minDelayMs: 800,
    maxDelayMs: 2000,
    batchSize: 20,         // slot per richiesta; si dimezza automaticamente se il gioco rifiuta
    dryRun: false
  };

  /* ---------- Storage ---------- */

  async function getLocal(key, fallback = null) {
    const data = await chrome.storage.local.get(key);
    return data[key] !== undefined ? data[key] : fallback;
  }

  async function setLocal(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }

  function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isInteger(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  // Unisce le impostazioni salvate con i default e corregge i valori fuori range.
  function mergeSettings(saved) {
    const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
    s.troops = { ...defaultTroops(), ...((saved && saved.troops) || {}) };
    s.capacity = clampInt(s.capacity, 1, MAX_LIST_CAPACITY, DEFAULT_SETTINGS.capacity);
    s.maxVillages = clampInt(s.maxVillages, 0, HARD_MAX_VILLAGES, 0);
    s.batchSize = clampInt(s.batchSize, 1, 100, DEFAULT_SETTINGS.batchSize);
    s.minDelayMs = clampInt(s.minDelayMs, 0, 60000, DEFAULT_SETTINGS.minDelayMs);
    s.maxDelayMs = clampInt(s.maxDelayMs, 0, 60000, DEFAULT_SETTINGS.maxDelayMs);
    if (s.minDelayMs > s.maxDelayMs) {
      [s.minDelayMs, s.maxDelayMs] = [s.maxDelayMs, s.minDelayMs];
    }
    s.prefix = String(s.prefix || '').trim() || DEFAULT_SETTINGS.prefix;
    return s;
  }

  async function getSettings() {
    const data = await chrome.storage.sync.get(KEYS.settings);
    return mergeSettings(data[KEYS.settings]);
  }

  async function saveSettings(settings) {
    await chrome.storage.sync.set({ [KEYS.settings]: settings });
  }

  /* ---------- Testo e coordinate ---------- */

  // Rimuove caratteri invisibili (zero-width, BOM, soft hyphen) e normalizza gli spazi.
  function stripInvisible(text) {
    return String(text || '')
      .replace(/[​-‍⁠﻿­]/g, '')
      .replace(/ /g, ' ')
      .trim();
  }

  // Per i numeri normalizza anche i vari segni meno (U+2212 "−", trattini Unicode).
  function normalizeNumberText(text) {
    return stripInvisible(text).replace(/[‒–—−﹣－]/g, '-');
  }

  // Ritorna un intero oppure null se il testo non è un intero valido.
  function parseCoordinate(raw) {
    const cleaned = normalizeNumberText(raw).replace(/\s+/g, '');
    if (!/^[+-]?\d+$/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isSafeInteger(n) ? n : null;
  }

  function coordKey(village) {
    return `${village.x}|${village.y}`;
  }

  // Estrae i villaggi dalla tabella dei risultati di GetterTools.
  // Lancia un errore chiaro se la struttura non corrisponde (non tenta di indovinare).
  function extractVillages(doc) {
    const rows = Array.from(doc.querySelectorAll('tr')).filter(tr =>
      tr.querySelector('span.koordk1 > span') &&
      tr.querySelector('span.koordk2 > span') &&
      tr.querySelector('td.tscity')
    );
    if (rows.length === 0) {
      throw new Error(
        'Nessuna riga di risultati riconosciuta. La pagina non è ancora caricata oppure ' +
        'la struttura di GetterTools è cambiata.'
      );
    }

    // Se ci sono più tabelle con righe simili, usa quella con più righe (la tabella dei risultati).
    const groups = new Map();
    for (const tr of rows) {
      const table = tr.closest('table');
      if (!groups.has(table)) groups.set(table, []);
      groups.get(table).push(tr);
    }
    let best = [];
    groups.forEach(list => { if (list.length > best.length) best = list; });

    const villages = [];
    const invalid = [];
    const seen = new Set();
    let duplicates = 0;

    best.forEach((tr, i) => {
      const rowNo = i + 1;
      const x = parseCoordinate(tr.querySelector('span.koordk1 > span').textContent);
      const y = parseCoordinate(tr.querySelector('span.koordk2 > span').textContent);
      if (x === null || y === null) {
        invalid.push(`Riga ${rowNo}: coordinate non valide`);
        return;
      }
      const key = `${x}|${y}`;
      if (seen.has(key)) {
        duplicates++;
        return;
      }
      seen.add(key);
      villages.push({ x, y, name: stripInvisible(tr.querySelector('td.tscity').textContent) });
    });

    return { villages, invalid, duplicates, totalRows: best.length };
  }

  /* ---------- Pianificazione liste ---------- */

  // Chiave dell'esecuzione: un'esecuzione riprende solo con stesso server, villaggio e prefisso.
  function runKey(server, targetVillageId, prefix) {
    return `${server}|${targetVillageId}|${prefix}`;
  }

  // Divide i villaggi ancora da inviare tra le liste esistenti (riempiendo quelle incomplete)
  // e nuove liste da creare. Non scrive numeri fissi: tutto dipende da capacità e numero di villaggi.
  //   existing:  [{ id, name, count }]  liste già create in una esecuzione precedente
  //   remaining: [{ x, y, name }]       villaggi non ancora inviati, nell'ordine di GetterTools
  function planLists({ existing, remaining, capacity, prefix }) {
    const plan = [];
    let idx = 0;

    existing.forEach((list, listIndex) => {
      const free = Math.max(0, capacity - list.count);
      if (free === 0 || idx >= remaining.length) return;
      const villages = remaining.slice(idx, idx + free);
      idx += villages.length;
      plan.push({ isNew: false, listIndex, name: list.name, villages });
    });

    let number = existing.length;
    while (idx < remaining.length) {
      number++;
      const villages = remaining.slice(idx, idx + capacity);
      idx += villages.length;
      plan.push({ isNew: true, listIndex: null, name: `${prefix} ${number}`, villages });
    }
    return plan;
  }

  // Converte i valori delle truppe in interi >= 0, nel formato t1..t10 richiesto dal gioco.
  function unitsFrom(troops) {
    const units = {};
    TROOP_KEYS.forEach(k => { units[k] = Math.max(0, Math.floor(Number(troops[k]) || 0)); });
    return units;
  }

  /* ---------- Utilità ---------- */

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function randomBetween(min, max) {
    return Math.round(min + Math.random() * (max - min));
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Box flottante in uno shadow DOM, così gli stili non si mescolano con quelli della pagina.
  const OVERLAY_CSS = `
    .box { font: 13px/1.4 system-ui, sans-serif; background: #1f2933; color: #f5f7fa;
           border-radius: 8px; padding: 12px; width: 300px;
           box-shadow: 0 4px 16px rgba(0, 0, 0, .35); }
    .title { font-weight: 600; margin-bottom: 6px; }
    .msg { margin: 6px 0; white-space: pre-line; }
    .ok { color: #b9f6ca; }
    .err { color: #ff8a80; }
    .log { max-height: 140px; overflow: auto; font: 11px/1.3 monospace; background: #111820;
           padding: 6px; border-radius: 4px; margin-top: 6px; white-space: pre; }
    .log[hidden] { display: none; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
    button { cursor: pointer; border: 0; border-radius: 4px; padding: 6px 10px;
             background: #3e4c59; color: #fff; font: inherit; }
    button.primary { background: #2f855a; }
    button.danger { background: #c53030; }
  `;

  function createOverlay() {
    const host = document.createElement('div');
    host.style.cssText = 'position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${OVERLAY_CSS}</style><div class="box"></div>`;
    document.documentElement.appendChild(host);
    return { host, box: root.querySelector('.box') };
  }

  /* ---------- API di Travian ----------
   * Chiamate POST dalla pagina del gioco (stesso origin, cookie di sessione).
   * Il successo di /farm-list/slot ha corpo vuoto: non viene fatto parse JSON.
   */

  class ApiError extends Error {
    constructor(status, message, requestId = null, code = null) {
      super(message);
      this.name = 'ApiError';
      this.status = status;       // 0 = errore di rete
      this.requestId = requestId;
      this.code = code;           // chiave errore del gioco, es. "raidList.error_listNotFound"
    }

    // Errori per cui è inutile riprovare con batch più piccoli: fermare l'esecuzione.
    // Include la lista non trovata: dimezzare il batch non la farebbe ricomparire.
    get fatal() {
      return this.status === 0 || this.status === 401 || this.status === 403 ||
             this.status === 404 || this.status === 429 || this.status >= 500 ||
             /NotFound/i.test(`${this.code || ''} ${this.message}`);
    }
  }

  async function apiPost(origin, path, body) {
    let res;
    try {
      res = await fetch(origin + path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json; charset=UTF-8', accept: '*/*' },
        body: JSON.stringify(body)
      });
    } catch (err) {
      throw new ApiError(0, `Errore di rete: ${err.message}`);
    }

    const text = await res.text();
    console.info('[Travian farm]', 'POST', path, 'status', res.status, 'body', text);

    if (res.ok) return { status: res.status, text };

    let message = res.statusText || 'Errore HTTP';
    let requestId = null;
    let code = null;
    try {
      const data = JSON.parse(text);
      message = data.message || data.error || message;
      requestId = data.requestId || null;
      code = data.error || null;
    } catch (_) {
      if (text) message = text.slice(0, 200);
    }
    throw new ApiError(res.status, message, requestId, code);
  }

  // Crea una lista farm e ritorna il suo id.
  async function createFarmList(origin, body) {
    const { status, text } = await apiPost(origin, '/api/v1/farm-list', body);
    let data = null;
    try { data = JSON.parse(text); } catch (_) { /* gestito sotto */ }
    if (!data || !Number.isInteger(data.id)) {
      throw new ApiError(status, 'Risposta inattesa alla creazione della lista: id mancante.');
    }
    return data.id;
  }

  // Aggiunge uno o più obiettivi (slots) a una lista.
  async function addFarmSlots(origin, slots) {
    console.info('[Travian farm] invio', slots.length, 'obiettivi in una richiesta');
    await apiPost(origin, '/api/v1/farm-list/slot', { slots });
  }

  return {
    HARD_MAX_VILLAGES,
    MAX_LIST_CAPACITY,
    TROOP_KEYS,
    KEYS,
    DEFAULT_SETTINGS,
    ApiError,
    getLocal,
    setLocal,
    getSettings,
    saveSettings,
    mergeSettings,
    stripInvisible,
    normalizeNumberText,
    parseCoordinate,
    coordKey,
    extractVillages,
    runKey,
    planLists,
    unitsFrom,
    sleep,
    randomBetween,
    esc,
    createOverlay,
    createFarmList,
    addFarmSlots
  };
})();
