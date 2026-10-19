# Liste farm da GetterTools (estensione Chrome)

Estensione Chrome (Manifest V3, JavaScript vanilla, nessun build step) che:

1. legge la lista dei villaggi inattivi dalla pagina di ricerca di GetterTools;
2. crea in automatico le liste farm su Travian;
3. aggiunge i villaggi alle liste, fino a 100 obiettivi per lista (limite del gioco).

Tutto è dinamico: dominio del server, ID dei villaggi, nomi, truppe e capacità arrivano dalla pagina o dalle impostazioni. Nel codice non c'è nulla legato a un server o a un villaggio specifico.

> **Attenzione:** automatizzare le azioni di gioco può violare i termini di servizio di Travian e portare alla sospensione dell'account. Usala a tuo rischio e preferibilmente con dry-run e pochi villaggi prima di un uso completo.

## Installazione

1. Apri `chrome://extensions`.
2. Attiva **Modalità sviluppatore** (in alto a destra).
3. Clicca **Carica estensione non pacchettizzata** e seleziona la cartella di questo progetto (quella che contiene `manifest.json`).
4. Dopo ogni modifica al codice, premi l'icona di ricarica dell'estensione in `chrome://extensions`.

## Uso

### 1. Salvare i villaggi da GetterTools

1. Apri `https://www.gettertools.com/<dominio-server>/42-Search-inactives`, ad esempio `https://www.gettertools.com/ts10.x1.america.travian.com/42-Search-inactives`.
2. In basso a destra compare il box **Liste farm per Travian**. Clicca **Salva villaggi per Travian**.
3. Il box mostra quanti villaggi sono stati salvati. Le righe duplicate o non valide vengono scartate e segnalate.

I dati restano in `chrome.storage.local` e vengono sovrascritti a ogni nuovo salvataggio.

### 2. Importare in Travian

1. Apri una pagina qualsiasi del gioco sul server indicato da GetterTools.
2. Se ci sono villaggi salvati per **quel** server, compare il box con **Importa in liste farm**.
3. Il riepilogo mostra destinazione, villaggi da inviare, liste da creare, truppe e impostazioni. Da qui puoi:
   - **Avvia** (o **Simula** se il dry-run è attivo);
   - **Riprendi**, se c'è un'esecuzione interrotta per la stessa configurazione;
   - **Ricomincia da zero**, che dimentica lo stato salvato (vedi sotto);
   - **Annulla**.
4. Durante l'esecuzione il box mostra il progresso, ad esempio `Lista 2/5 – 37/100`, e un log. **Annulla** si ferma dopo la richiesta in corso.

Non cambiare pagina nel gioco durante l'esecuzione: la pagina si ricarica e l'esecuzione si interrompe. Lo stato resta salvato e puoi riprendere in seguito.

### Impostazioni

Clicca l'icona dell'estensione nella barra di Chrome. Le impostazioni sono salvate con `chrome.storage.sync`.

| Impostazione | Default | Note |
|---|---|---|
| Villaggio di destinazione | Automatico (villaggio attivo) | Scelto tra i villaggi rilevati sul gioco |
| Prefisso nome liste | `inattivi` | Le liste si chiamano `<prefisso> 1`, `<prefisso> 2`, ... |
| Capacità per lista | 100 | Massimo 100 (limite del gioco) |
| Max villaggi | 0 (tutti) | Massimo 500 |
| Truppe di default | t1 = 2, resto 0 | Usate sia per la lista sia per ogni obiettivo |
| Solo perdite / Nave | sì / no | `onlyLosses` / `useShip` |
| Pausa minima / massima | 800 / 2000 ms | Pausa casuale tra due richieste |
| Obiettivi per richiesta | 20 | Si dimezza automaticamente se il gioco rifiuta una richiesta |
| Dry-run | no | Mostra cosa farebbe senza chiamare le API |

Il numero di liste è `ceil(villaggi / capacità)`.

## Come funziona

- **Liste:** per ogni blocco di villaggi viene creata una lista (`POST /api/v1/farm-list`), poi gli obiettivi vengono aggiunti con `POST /api/v1/farm-list/slot`.
- **Batch:** se il gioco rifiuta una richiesta con più obiettivi (errore 400 o simile), l'estensione dimezza il batch e riprova. Se fallisce anche con un solo obiettivo, si ferma.
- **Errori gravi:** 401, 403, 429, 5xx e errori di rete fermano subito l'esecuzione. Il box mostra il messaggio, il `requestId` quando presente e lo stato salvato.
- **Ripresa senza duplicati:** dopo ogni richiesta riuscita lo stato viene salvato. Gli obiettivi già inviati non vengono reinviati e le liste già create vengono riempite fino alla capacità.
- **Chiave dell'esecuzione:** server + villaggio di destinazione + prefisso. Cambiare capacità o truppe non fa ripartire da zero: le liste già create restano com'erano.
- **Ricomincia da zero:** dimentica lo stato locale, ma non cancella le liste già create nel gioco. Gli obiettivi già presenti in quelle liste potrebbero essere aggiunti di nuovo.

## Struttura dei file

```
manifest.json      Manifest V3, permessi minimi (storage) e host (gettertools.com, *.travian.com)
shared.js          Utility condivise: storage, parsing coordinate, piano delle liste, chiamate API
gettertools.js     Content script su GetterTools: estrazione e salvataggio dei villaggi
travian.js         Content script su Travian: rilevamento villaggi, riepilogo, esecuzione
popup.html         Pagina delle impostazioni
popup.js           Logica delle impostazioni
README.md          Questo file
```

## Limiti noti

- **Liste esistenti:** la modalità "riempi lista esistente" non è implementata, perché non è stato verificato l'endpoint GET delle liste. Le esecuzioni riprese riempiono solo le liste create dall'estensione.
- **Domini Travian:** il manifest copre `*.travian.com`. Se giochi su un altro dominio (es. `travian.it`), va aggiunto in `manifest.json` sia in `host_permissions` sia nei `matches` del content script di Travian.
- **Struttura delle pagine:** se GetterTools o Travian cambiano l'HTML, l'estensione mostra un errore chiaro invece di indovinare. In quel caso vanno aggiornati i selettori in `shared.js` (`extractVillages`) e `travian.js` (`detectVillages`).
- **API non documentate:** le chiamate sono quelle verificate dal browser e possono cambiare senza preavviso.

## Test consigliato

1. Salva i villaggi da GetterTools e controlla il conteggio.
2. Su Travian attiva **Dry-run**, apri il riepilogo e clicca **Simula**: non viene fatta nessuna chiamata.
3. Disattiva il dry-run e imposta **Max villaggi** a 1. Avvia: dovresti vedere una lista creata con un obiettivo.
4. Apri la console della pagina Travian: ogni risposta delle API è loggata con `status` e `body`.
5. Quando il test è andato bene, rimuovi il limite e avvia l'importazione completa.
