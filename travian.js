/*
 * travian.js - content script su *.travian.com.
 *
 * 1. Rileva i villaggi del giocatore (div.listEntry.village) e li salva.
 * 2. Se ci sono villaggi salvati da GetterTools per QUESTO server, mostra "Importa in liste farm".
 * 3. Crea le liste e aggiunge gli obiettivi con le API del gioco. Le chiamate partono
 *    da questa pagina (stesso origin, cookie di sessione).
 */
(() => {
  const S = TGShared;
  const HOST = location.hostname;

  class Cancelled extends Error {}

  let ui = null;
  let runs = {};
  let running = false;
  let cancelRequested = false;
  let logLines = [];

  /* ---------- Rilevamento villaggi ---------- */

  function detectVillages() {
    const villages = [];
    document.querySelectorAll('div.listEntry.village').forEach(el => {
      const id = Number(el.getAttribute('data-did'));
      if (!Number.isInteger(id) || id <= 0) return;
      villages.push({
        id,
        name: S.stripInvisible(el.querySelector('span.name')?.textContent),
        active: el.classList.contains('active')
      });
    });
    if (villages.length === 0) return null;
    const active = villages.find(v => v.active);
    return { server: HOST, villages, activeId: active ? active.id : null, savedAt: Date.now() };
  }

  async function refreshDetected() {
    const detected = detectVillages();
    if (detected) await S.setLocal(S.KEYS.detected, detected);
    return detected;
  }

  /* ---------- Pannello ---------- */

  function showPanel(bodyHtml, actions = []) {
    ui.box.innerHTML = `
      <div class="title">Liste farm per Travian</div>
      ${bodyHtml}
      <div class="log"></div>
      <div class="actions"></div>
    `;
    renderLog();
    const bar = ui.box.querySelector('.actions');
    actions.forEach(a => {
      const btn = document.createElement('button');
      btn.textContent = a.label;
      if (a.primary) btn.className = 'primary';
      if (a.danger) btn.className = 'danger';
      btn.addEventListener('click', a.onClick);
      bar.appendChild(btn);
    });
  }

  function setStatus(text, cls = 'msg') {
    const el = ui.box.querySelector('.msg');
    if (el) {
      el.className = cls;
      el.textContent = text;
    }
  }

  function log(text) {
    logLines.push(`${new Date().toLocaleTimeString()} ${text}`);
    renderLog();
  }

  function renderLog() {
    const el = ui.box.querySelector('.log');
    if (!el) return;
    el.hidden = logLines.length === 0;
    el.textContent = logLines.slice(-8).join('\n');
  }

  const closeAction = () => ({ label: 'Chiudi', onClick: renderHome });

  /* ---------- Schermate ---------- */

  async function renderHome() {
    if (running) return;
    const saved = await S.getLocal(S.KEYS.saved);
    if (!saved || saved.server !== HOST) {
      ui.host.style.display = 'none';
      return;
    }
    ui.host.style.display = '';
    showPanel(
      `<div class="msg">${S.esc(saved.villages.length)} villaggi salvati da GetterTools per questo server.</div>`,
      [{ label: 'Importa in liste farm', primary: true, onClick: onImportClick }]
    );
  }

  // Sceglie il villaggio di destinazione: quello dalle impostazioni, altrimenti quello attivo.
  function resolveTarget(settings, detected) {
    if (!detected) return null;
    const active = detected.villages.find(v => v.id === detected.activeId) || null;
    if (settings.targetVillageId) {
      const chosen = detected.villages.find(v => String(v.id) === String(settings.targetVillageId));
      if (chosen) return { village: chosen, warning: null };
      return active
        ? { village: active, warning: 'Il villaggio scelto nelle impostazioni non è su questo server: uso quello attivo.' }
        : null;
    }
    return active ? { village: active, warning: null } : null;
  }

  // Calcola cosa resta da fare, tenendo conto di un'esecuzione precedente.
  function computeRun(saved, settings, state) {
    const limit = settings.maxVillages > 0
      ? Math.min(settings.maxVillages, S.HARD_MAX_VILLAGES)
      : S.HARD_MAX_VILLAGES;
    const selected = saved.villages.slice(0, limit);
    const sent = state ? state.sent : {};
    const remaining = selected.filter(v => !sent[S.coordKey(v)]);
    const planItems = S.planLists({
      existing: state ? state.lists : [],
      remaining,
      capacity: settings.capacity,
      prefix: settings.prefix
    });
    return { remaining, planItems, capacity: settings.capacity };
  }

  async function onImportClick() {
    runs = (await S.getLocal(S.KEYS.runs, {})) || {};
    logLines = [];

    const saved = await S.getLocal(S.KEYS.saved);
    if (!saved || saved.server !== HOST) return renderHome();

    const settings = await S.getSettings();
    let detected = await refreshDetected();
    if (!detected) {
      const stored = await S.getLocal(S.KEYS.detected);
      detected = stored && stored.server === HOST ? stored : null;
    }

    const target = resolveTarget(settings, detected);
    if (!target) {
      return showPanel(
        '<div class="msg err">Nessun villaggio rilevato su questa pagina. Ricarica la pagina del gioco e riprova.</div>',
        [closeAction()]
      );
    }

    const key = S.runKey(HOST, target.village.id, settings.prefix);
    const state = runs[key] || null;
    const computed = computeRun(saved, settings, state);
    showSummary({ settings, target, key, state, computed });
  }

  function showSummary(ctx) {
    const { settings, target, key, state, computed } = ctx;
    const { planItems, remaining, capacity } = computed;
    const newLists = planItems.filter(p => p.isNew).length;
    const fillLists = planItems.length - newLists;
    const sentCount = state ? Object.keys(state.sent).length : 0;
    const troops = Object.entries(S.unitsFrom(settings.troops))
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ') || 'nessuna';

    const lines = [
      `Destinazione: ${target.village.name} (${target.village.id})`,
      `Da inviare: ${remaining.length} (già inviati: ${sentCount})`,
      `Liste da creare: ${newLists} · da completare: ${fillLists}`,
      `Capacità per lista: ${capacity}`,
      `Truppe: ${troops}`,
      `Solo perdite: ${settings.onlyLosses ? 'sì' : 'no'} · Nave: ${settings.useShip ? 'sì' : 'no'}`,
      `Pausa: ${settings.minDelayMs}-${settings.maxDelayMs} ms · batch: ${settings.batchSize}`
    ];
    if (target.warning) lines.push(`⚠ ${target.warning}`);
    if (settings.dryRun) lines.push('DRY RUN: nessuna chiamata API verrà fatta.');

    const body = `<div class="msg">${lines.map(S.esc).join('<br>')}</div>`;

    if (remaining.length === 0) {
      const actions = [closeAction()];
      if (state) actions.unshift(restartAction(key));
      return showPanel(body + '<div class="msg ok">Nulla da inviare: tutti i villaggi sono già stati aggiunti.</div>', actions);
    }

    const actions = [];
    if (settings.dryRun) {
      actions.push({ label: 'Simula', primary: true, onClick: () => simulate(ctx) });
    } else {
      const label = state && state.status !== 'done' ? 'Riprendi' : 'Avvia';
      actions.push({ label, primary: true, onClick: () => startRun(ctx) });
    }
    if (state) actions.push(restartAction(key));
    actions.push({ label: 'Annulla', onClick: renderHome });
    showPanel(body, actions);
  }

  function restartAction(key) {
    return {
      label: 'Ricomincia da zero',
      danger: true,
      onClick: async () => {
        // Dimentica lo stato di questa esecuzione: non cancella le liste già create nel gioco.
        runs = (await S.getLocal(S.KEYS.runs, {})) || {};
        delete runs[key];
        await S.setLocal(S.KEYS.runs, runs);
        onImportClick();
      }
    };
  }

  /* ---------- Simulazione (dry-run) ---------- */

  function simulate(ctx) {
    const { settings, computed } = ctx;
    logLines = [];
    computed.planItems.forEach(item => {
      const batch = Math.min(settings.batchSize, item.villages.length);
      log(`[DRY] ${item.isNew ? 'crea' : 'completa'} "${item.name}": ${item.villages.length} obiettivi, batch da ${batch}`);
    });
    showPanel('<div class="msg ok">Simulazione completata: nessuna chiamata API.</div>', [closeAction()]);
  }

  /* ---------- Esecuzione ---------- */

  function requestCancel() {
    cancelRequested = true;
    setStatus('Annullamento in corso…');
  }

  function checkCancel() {
    if (cancelRequested) throw new Cancelled('Annullato dall\'utente.');
  }

  // Pausa interrompibile: controlla l'annullamento ogni 100 ms.
  async function cancellableSleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      checkCancel();
      await S.sleep(Math.min(100, end - Date.now()));
    }
    checkCancel();
  }

  function describeError(err) {
    let text = err.message || String(err);
    if (err instanceof S.ApiError && err.status) text = `HTTP ${err.status}: ${text}`;
    if (err.requestId) text += ` (requestId: ${err.requestId})`;
    return text;
  }

  async function startRun(ctx) {
    const { settings, target, key, computed } = ctx;
    if (running) return;
    running = true;
    cancelRequested = false;

    const origin = location.origin;
    const units = S.unitsFrom(settings.troops);
    const plan = computed.planItems;

    // Stato persistito dopo ogni passo: serve a riprendere senza duplicare.
    const state = runs[key] || {
      server: HOST,
      targetVillageId: target.village.id,
      prefix: settings.prefix,
      lists: [],
      sent: {},
      batchSize: settings.batchSize,
      status: 'running',
      lastError: null,
      updatedAt: 0
    };
    state.status = 'running';
    state.lastError = null;
    // Il batch parte sempre dalle impostazioni: la riduzione dopo un rifiuto vale solo per questa esecuzione.
    state.batchSize = settings.batchSize;

    const persist = async () => {
      state.updatedAt = Date.now();
      runs[key] = state;
      await S.setLocal(S.KEYS.runs, runs);
    };

    // Pausa casuale tra due richieste (non prima della prima).
    let firstRequest = true;
    const gap = async () => {
      if (!firstRequest) {
        await cancellableSleep(S.randomBetween(settings.minDelayMs, settings.maxDelayMs));
      }
      firstRequest = false;
      checkCancel();
    };

    showPanel('<div class="msg">In esecuzione…</div>', [{ label: 'Annulla', danger: true, onClick: requestCancel }]);
    log(`Avvio: ${computed.remaining.length} villaggi, ${plan.length} liste da creare o completare.`);

    try {
      await persist();

      for (let i = 0; i < plan.length; i++) {
        const item = plan[i];
        let list;

        if (item.isNew) {
          await gap();
          const id = await S.createFarmList(origin, {
            villageId: Number(target.village.id),
            name: item.name,
            defaultUnits: units,
            useShip: settings.useShip,
            onlyLosses: settings.onlyLosses
          });
          list = { id, name: item.name, count: 0 };
          state.lists.push(list);
          await persist();
          log(`Creata lista "${item.name}" (id ${id}).`);
        } else {
          list = state.lists[item.listIndex];
        }

        let pending = item.villages;
        while (pending.length > 0) {
          const size = Math.min(state.batchSize, pending.length);
          const batch = pending.slice(0, size);

          const slots = batch.map(v => ({
            listId: list.id,
            x: v.x,
            y: v.y,
            units,
            active: true,
            abandoned: false
          }));

          await gap();
          try {
            await S.addFarmSlots(origin, slots);
          } catch (err) {
            // Errori 400 (o simili): dimezza il batch e riprova. Errori gravi: fermati.
            const retryable = err instanceof S.ApiError && !err.fatal;
            if (!retryable || size === 1) throw err;
            state.batchSize = Math.max(1, Math.floor(size / 2));
            await persist();
            log(`Batch di ${size} rifiutato (${describeError(err)}). Riprovo con ${state.batchSize}.`);
            console.warn('[Travian farm] batch rifiutato, slots inviati:', slots, describeError(err));
            continue;
          }

          batch.forEach(v => { state.sent[S.coordKey(v)] = true; });
          list.count += batch.length;
          pending = pending.slice(batch.length);
          await persist();

          log(`"${list.name}": +${batch.length} (${list.count}/${computed.capacity})`);
          setStatus(`Lista ${i + 1}/${plan.length} – ${list.count}/${computed.capacity}`);
        }
      }

      state.status = 'done';
      await persist();
      const sentCount = Object.keys(state.sent).length;
      showPanel(
        `<div class="msg ok">Completato: ${S.esc(sentCount)} villaggi in ${S.esc(state.lists.length)} liste.</div>`,
        [closeAction()]
      );
    } catch (err) {
      if (err instanceof Cancelled) {
        state.status = 'cancelled';
        state.lastError = null;
      } else {
        state.status = 'error';
        state.lastError = describeError(err);
        console.error('[Travian farm]', err);
      }
      await persist();

      const sentCount = Object.keys(state.sent).length;
      const summary = `Stato salvato: ${state.lists.length} liste, ${sentCount} villaggi inviati.`;
      const body = err instanceof Cancelled
        ? `<div class="msg">Annullato. ${S.esc(summary)}</div>`
        : `<div class="msg err">Errore: ${S.esc(state.lastError)}</div><div class="msg">${S.esc(summary)}</div>`;
      showPanel(body, [
        { label: 'Riprendi', primary: true, onClick: onImportClick },
        closeAction()
      ]);
    } finally {
      running = false;
    }
  }

  /* ---------- Avvio ---------- */

  async function init() {
    ui = S.createOverlay();
    runs = (await S.getLocal(S.KEYS.runs, {})) || {};

    // Il selettore villaggi potrebbe non essere ancora nel DOM: riprova una volta.
    if (!(await refreshDetected())) setTimeout(refreshDetected, 2000);

    await renderHome();
  }

  init();
})();
