(function () {
  "use strict";

  const TYPE_LABELS = {
    rosso: "Rosso",
    bianco: "Bianco",
    champagne: "Champagne / Bollicine",
    rosato: "Rosato",
    orange: "Orange",
    dolce: "Dolce",
    altro: "Altro",
  };

  // Ordine fisso delle tipologie sempre selezionabili come filtro,
  // indipendentemente da quali siano effettivamente presenti nella carta caricata.
  const FIXED_TYPES = ["rosso", "bianco", "rosato", "orange", "champagne", "dolce"];

  const SETTINGS_KEY = "sommelier_settings_v1";

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { apiKey: "", model: "claude-sonnet-5" };
      const parsed = JSON.parse(raw);
      return { apiKey: parsed.apiKey || "", model: parsed.model || "claude-sonnet-5" };
    } catch (e) {
      return { apiKey: "", model: "claude-sonnet-5" };
    }
  }

  function saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  const state = {
    settings: loadSettings(),
    showSettings: false,
    testingConnection: false,
    testResult: null,
    rawText: "",
    files: [], // {id, name, kind, mediaType, base64, sizeMB}
    filesProcessing: false,
    filesProcessingProgress: "",
    parsing: false,
    parsingProgress: "",
    parseError: "",
    parsedWines: null,
    budget: 1000,
    colorPref: "tutti",
    stylePref: "tutti",
    countryPref: "tutte",
    recommending: false,
    recError: "",
    recommendations: null,
  };

  const MAX_CHUNK_MB = 6; // peso massimo (approssimativo) di immagini per singola richiesta
  const MAX_FILES_PER_CHUNK = 10; // tetto comunque presente per non fare pagine di testo enormi in un colpo solo
  const MAX_RETRIES_PER_CHUNK = 2;

  // Raggruppa i file per peso reale invece che per numero fisso: una carta leggera
  // (poche pagine, scansioni ben compresse) finisce in un'unica richiesta invece di
  // essere spezzata inutilmente in più round-trip, che su reti instabili aumentano
  // solo le occasioni di fallimento.
  function buildDynamicChunks(files) {
    const chunks = [];
    let current = [];
    let currentMB = 0;
    files.forEach((f) => {
      const fMB = f.sizeMB || 0.3;
      const wouldExceed = current.length > 0 && (currentMB + fMB > MAX_CHUNK_MB || current.length >= MAX_FILES_PER_CHUNK);
      if (wouldExceed) {
        chunks.push(current);
        current = [];
        currentMB = 0;
      }
      current.push(f);
      currentMB += fMB;
    });
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
  }

  function mostCommonCurrency(wines) {
    const counts = {};
    wines.forEach((w) => {
      if (w.currency) counts[w.currency] = (counts[w.currency] || 0) + 1;
    });
    let best = "", bestCount = 0;
    Object.entries(counts).forEach(([c, n]) => {
      if (n > bestCount) { best = c; bestCount = n; }
    });
    return best;
  }

  function parseJsonSafe(text) {
    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      const match = cleaned.match(/(\[[\s\S]*\])/);
      if (match) {
        try { return JSON.parse(match[1]); } catch (e2) { throw new Error("Non sono riuscito a leggere la risposta del modello."); }
      }
      throw new Error("Non sono riuscito a leggere la risposta del modello.");
    }
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(",")[1]);
      r.onerror = () => reject(new Error("Lettura file fallita"));
      r.readAsDataURL(file);
    });
  }

  function downscaleImageFile(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL("image/jpeg", quality);
          resolve(dataUrl.split(",")[1]);
        };
        img.onerror = () => reject(new Error("Immagine non leggibile"));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error("Lettura file fallita"));
      reader.readAsDataURL(file);
    });
  }

  async function pdfFileToImageEntries(file, maxDim, quality, onProgress) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const entries = [];
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      if (onProgress) onProgress(pageNum, pdf.numPages);
      const page = await pdf.getPage(pageNum);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = Math.max(0.25, Math.min(maxDim / baseViewport.width, maxDim / baseViewport.height));
      const viewport = page.getViewport({ scale });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const base64 = dataUrl.split(",")[1];
      entries.push({
        id: Date.now() + "-" + pageNum + "-" + Math.random().toString(36).slice(2),
        name: file.name + " · pag. " + pageNum + "/" + pdf.numPages,
        kind: "image",
        mediaType: "image/jpeg",
        base64,
        sizeMB: (base64.length * 0.75) / (1024 * 1024),
      });
      // Libera la memoria della pagina renderizzata prima di passare alla successiva:
      // essenziale su telefono con PDF lunghi, altrimenti il browser può saturare la RAM.
      page.cleanup();
    }
    // Riusa un solo canvas per tutte le pagine invece di crearne uno nuovo ogni volta.
    canvas.width = 0;
    canvas.height = 0;
    return entries;
  }

  async function callClaude(content, maxTokens) {
    if (!state.settings.apiKey) {
      throw new Error("Aggiungi la tua chiave API Anthropic nelle impostazioni (icona ingranaggio) prima di continuare.");
    }
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": state.settings.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: state.settings.model || "claude-sonnet-5",
          max_tokens: maxTokens,
          stream: true,
          messages: [{ role: "user", content }],
        }),
      });
    } catch (networkErr) {
      throw new Error(
        "La richiesta non è arrivata a destinazione (connessione instabile). Prova a: 1) passare al Wi-Fi se sei sui dati mobili (o viceversa), 2) riprovare. [dettaglio tecnico: " +
        (networkErr && networkErr.name ? networkErr.name + ": " : "") +
        (networkErr && networkErr.message ? networkErr.message : String(networkErr)) +
        "]"
      );
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error("Errore API (" + res.status + "): " + errText.slice(0, 200));
    }

    // Streaming: i dati arrivano a pezzi via Server-Sent Events invece che tutti insieme
    // alla fine. Questo evita che una rete mobile "chiuda per inattività" una connessione
    // che resta aperta a lungo mentre il modello genera risposte lunghe (liste dense di vini).
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullText = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;
          try {
            const evt = JSON.parse(jsonStr);
            if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
              fullText += evt.delta.text;
            } else if (evt.type === "error") {
              throw new Error(evt.error && evt.error.message ? evt.error.message : "Errore dal modello durante lo streaming.");
            }
          } catch (parseErr) {
            // riga SSE incompleta/malformata: la ignoriamo e proseguiamo
          }
        }
      }
    } catch (streamErr) {
      if (fullText) {
        // Avevamo già ricevuto parte della risposta: proviamo comunque a usarla
        // invece di buttare via tutto quello che era arrivato.
        return fullText;
      }
      throw new Error(
        "La connessione si è interrotta durante la ricezione della risposta. Riprova. [dettaglio tecnico: " +
        (streamErr && streamErr.message ? streamErr.message : String(streamErr)) +
        "]"
      );
    }
    return fullText;
  }

  const PARSE_INSTRUCTIONS = `Analizza il contenuto sopra (testo incollato e/o immagini/PDF di una carta dei vini di ristorante). La carta puo' essere disordinata, scritta a mano, scansionata o organizzata per regioni.

Estrai OGNI vino/bottiglia che riesci a identificare come un oggetto con questi campi:
- name: nome della cuvee/etichetta (senza produttore, senza annata)
- producer: nome del produttore/cantina
- region: regione o denominazione (se nota, altrimenti stringa vuota)
- country: nazione di origine, dedotta dalla regione/denominazione/produttore (es. "Italia", "Francia", "Spagna", "Germania", "Portogallo", "Stati Uniti", "Cile", "Argentina", "Sudafrica", "Australia", "Nuova Zelanda", "Austria", "Ungheria", "Slovenia", ecc.), stringa vuota se non deducibile con ragionevole certezza
- vintage: annata come numero, o null se non millesimato
- type: uno tra "rosso", "bianco", "champagne", "rosato", "orange", "dolce", "altro" (usa "orange" per i vini macerati/orange wine, ottenuti da uve bianche vinificate con le bucce)
- price: prezzo come numero (solo cifre), o null se assente
- currency: valuta stimata come sigla (es. "DKK", "EUR", "CHF"), stringa vuota se ignota
- style: se deducibile, uno tra "naturale", "biodinamico", "classico" o null
- raw: la riga originale

Rispondi SOLO con un array JSON valido di questi oggetti, senza testo introduttivo, senza commenti, senza blocchi markdown.`;

  function buildRecommendInstructions({ budget, currency, colorPref, stylePref, countryPref, fallbackUsed }) {
    return `Sei un sommelier. Ti fornisco un elenco di vini candidati (in JSON) gia' pre-filtrato da un budget massimo di ${budget}${currency ? " " + currency : ""} per bottiglia.

Preferenza di colore/tipologia richiesta: ${colorPref === "tutti" ? "nessuna, va bene qualsiasi tipologia" : (TYPE_LABELS[colorPref] || colorPref)}.
Preferenza di stile richiesta: ${stylePref === "tutti" ? "nessuna preferenza particolare" : stylePref}.
Preferenza di nazione richiesta: ${!countryPref || countryPref === "tutte" ? "nessuna preferenza particolare" : countryPref}.
${fallbackUsed ? "Nota: nessun vino rispettava esattamente colore/stile/nazione richiesti entro budget, quindi ti sto passando i migliori candidati solo filtrati per budget: rilassa i criteri secondari ma spiegalo brevemente nella motivazione." : ""}

Scegli le 3 proposte migliori (o meno di 3 se i candidati sono meno di 3), privilegiando a parita' di merito i produttori piccoli/indipendenti e le etichette meno scontate rispetto ai nomi piu' commerciali, e cercando di variare regione/stile tra le proposte quando possibile.

Rispondi SOLO con un array JSON di massimo 3 oggetti con questi campi, in italiano:
- name, producer, region, country, vintage, price, currency
- reason: motivazione breve (massimo 2 frasi), in italiano, colloquiale ma competente

Nessun testo fuori dal JSON, niente blocchi markdown.`;
  }

  // ---------- rendering ----------

  function iconSvg(name) {
    const icons = {
      wine: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 22h8"/><path d="M7 10h10"/><path d="M12 15v7"/><path d="M12 15a5 5 0 0 0 5-5c0-2-1.5-2-1.5-3S17 5.5 17 3.5c0-.5-.5-1.5-1.5-1.5h-7C7.5 2 7 3 7 3.5 7 5.5 8.5 5.5 8.5 7c0 1-1.5 1-1.5 3a5 5 0 0 0 5 5Z"/></svg>',
      upload: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m16 16-4-4-4 4"/></svg>',
      sliders: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/></svg>',
      sparkles: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>',
      loader: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
      x: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
      file: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>',
      image: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>',
      reset: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
      settings: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
    };
    return icons[name] || "";
  }

  function render() {
    const root = document.getElementById("wsl-root");
    const s = state;
    const detectedCurrency = s.parsedWines ? mostCommonCurrency(s.parsedWines) : "";
    const availableTypes = s.parsedWines
      ? Array.from(new Set(s.parsedWines.map((w) => w.type).filter(Boolean)))
      : [];
    const availableCountries = s.parsedWines
      ? Array.from(new Set(s.parsedWines.map((w) => w.country).filter(Boolean))).sort()
      : [];

    root.innerHTML = `
      <div class="wsl-header">
        ${iconSvg("wine")}
        <div>
          <h1>Sommelier di carta</h1>
          <div class="wsl-sub">analisi lista vini &middot; consigli su misura</div>
        </div>
        <div class="wsl-header-actions">
          ${(s.parsedWines || s.rawText || s.files.length > 0)
            ? `<button class="wsl-icon-btn" id="btn-reset">${iconSvg("reset")} Ricomincia</button>`
            : ""}
          <button class="wsl-icon-btn" id="btn-settings">${iconSvg("settings")} Chiave API</button>
        </div>
      </div>

      <div class="wsl-body">
        <div class="wsl-input-panel">
          <div class="wsl-label">${iconSvg("file")} Testo della carta</div>
          <textarea class="wsl-textarea" id="raw-text" placeholder="Incolla qui il testo della carta vini...">${escapeHtml(s.rawText)}</textarea>

          <div class="wsl-upload-zone" id="upload-zone">
            ${s.filesProcessing
              ? `<span class="wsl-spin">${iconSvg("loader")}</span><div>${s.filesProcessingProgress || "Elaborazione pagine..."}</div>`
              : `${iconSvg("upload")}<div>Carica foto o PDF della carta</div>`}
            <input type="file" id="file-input" accept="image/*,application/pdf" multiple style="display:none" ${s.filesProcessing ? "disabled" : ""} />
          </div>

          ${s.files.length > 0 ? `
            <div class="wsl-file-list">
              ${s.files.map((f) => `
                <div class="wsl-file-chip" data-id="${f.id}">
                  ${f.kind === "pdf" ? iconSvg("file") : iconSvg("image")}
                  <span>${escapeHtml(f.name)}${f.sizeMB ? " · " + f.sizeMB.toFixed(1) + " MB" : ""}</span>
                  <button class="btn-remove-file" data-id="${f.id}">${iconSvg("x")}</button>
                </div>
              `).join("")}
            </div>
          ` : ""}

          <button class="wsl-btn primary" id="btn-analyze" ${s.parsing || s.filesProcessing ? "disabled" : ""}>
            ${s.parsing
              ? `<span class="wsl-spin">${iconSvg("loader")}</span> ${s.parsingProgress || "Sto leggendo la carta..."}`
              : `${iconSvg("sparkles")} Analizza carta`}
          </button>

          ${s.parseError ? `<div class="wsl-error">${escapeHtml(s.parseError)}</div>` : ""}

          ${s.parsedWines ? `
            <div class="wsl-summary">
              Trovati <strong>${s.parsedWines.length}</strong> vini
              ${detectedCurrency ? ` &middot; valuta rilevata <strong>${detectedCurrency}</strong>` : ""}
              <div class="wsl-chips">
                ${availableTypes.map((t) => `<span class="wsl-chip">${TYPE_LABELS[t] || t} &middot; ${s.parsedWines.filter((w) => w.type === t).length}</span>`).join("")}
              </div>
            </div>

            <div class="wsl-filters">
              <div class="wsl-label">${iconSvg("sliders")} Cosa cerchi</div>

              <div class="wsl-field">
                <label>Budget massimo per bottiglia ${detectedCurrency ? `(${detectedCurrency})` : ""}</label>
                <input type="number" class="wsl-number-input" id="budget-input" value="${s.budget}" min="0" />
              </div>

              <div class="wsl-field">
                <label>Tipologia</label>
                <div class="wsl-pill-row" id="color-pills">
                  <button class="wsl-pill ${s.colorPref === "tutti" ? "active" : ""}" data-color="tutti">Tutti</button>
                  ${FIXED_TYPES.map((t) => `<button class="wsl-pill ${s.colorPref === t ? "active" : ""}" data-color="${t}">${TYPE_LABELS[t] || t}</button>`).join("")}
                </div>
              </div>

              <div class="wsl-field">
                <label>Stile</label>
                <div class="wsl-pill-row" id="style-pills">
                  ${["tutti", "naturale", "classico"].map((st) => `<button class="wsl-pill ${s.stylePref === st ? "active" : ""}" data-style="${st}">${st === "tutti" ? "Nessuna preferenza" : st.charAt(0).toUpperCase() + st.slice(1)}</button>`).join("")}
                </div>
              </div>

              <div class="wsl-field">
                <label>Nazione</label>
                ${availableCountries.length > 0 ? `
                  <select class="wsl-number-input" id="country-select">
                    <option value="tutte" ${s.countryPref === "tutte" ? "selected" : ""}>Tutte</option>
                    ${availableCountries.map((c) => `<option value="${escapeHtml(c)}" ${s.countryPref === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}
                  </select>
                ` : `<div style="font-size:11.5px;color:var(--muted);">Nazione non rilevabile da questa carta.</div>`}
              </div>

              <button class="wsl-btn gold" id="btn-recommend" ${s.recommending ? "disabled" : ""}>
                ${s.recommending
                  ? `<span class="wsl-spin">${iconSvg("loader")}</span> Scelgo le proposte...`
                  : `${iconSvg("wine")} Consigliami 3 vini`}
              </button>
              ${s.recError ? `<div class="wsl-error">${escapeHtml(s.recError)}</div>` : ""}
            </div>
          ` : ""}
        </div>

        <div class="wsl-results-panel">
          ${!s.recommendations ? `
            <div class="wsl-empty-state">
              <div class="wsl-icon-wrap">${iconSvg("wine")}</div>
              ${s.parsedWines
                ? "Imposta budget, tipologia e stile, poi chiedi le 3 proposte."
                : "Incolla o carica una carta vini per iniziare."}
            </div>
          ` : (s.recommendations.length > 0 ? `
            <div class="wsl-cards">
              ${s.recommendations.map((r, i) => `
                <div class="wsl-card">
                  <div class="wsl-card-index">${String(i + 1).padStart(2, "0")}</div>
                  <div class="wsl-card-name">${escapeHtml(r.name || "")}</div>
                  <div class="wsl-card-producer">${escapeHtml(r.producer || "")}</div>
                  <div class="wsl-card-meta">
                    ${r.region ? `<span>regione <b>${escapeHtml(r.region)}</b></span>` : ""}
                    ${r.country ? `<span>nazione <b>${escapeHtml(r.country)}</b></span>` : ""}
                    ${r.vintage ? `<span>annata <b>${escapeHtml(String(r.vintage))}</b></span>` : ""}
                    ${r.price != null ? `<span>prezzo <b>${escapeHtml(String(r.price))}${r.currency ? " " + escapeHtml(r.currency) : ""}</b></span>` : ""}
                  </div>
                  <div class="wsl-card-reason">${escapeHtml(r.reason || "")}</div>
                </div>
              `).join("")}
            </div>
          ` : `<div class="wsl-empty-state">Nessuna proposta trovata con questi criteri.</div>`)}
        </div>
      </div>

      ${s.showSettings ? `
        <div class="wsl-modal-backdrop" id="settings-backdrop">
          <div class="wsl-modal">
            <h2>Chiave API Anthropic</h2>
            <p>L'app gira come sito/app standalone e chiama direttamente l'API di Anthropic dal tuo dispositivo: serve una tua chiave API personale (creata su console.anthropic.com). Viene salvata solo in locale sul telefono.</p>
            <input type="password" id="api-key-input" placeholder="sk-ant-..." value="${escapeHtml(s.settings.apiKey)}" />
            <p style="margin-top:-6px;">Modello (facoltativo, default claude-sonnet-5):</p>
            <input type="text" id="model-input" placeholder="claude-sonnet-5" value="${escapeHtml(s.settings.model)}" />
            <div class="wsl-modal-actions" style="justify-content: space-between; margin-bottom: 10px;">
              <button class="cancel" id="test-connection" ${s.testingConnection ? "disabled" : ""}>
                ${s.testingConnection ? "Test in corso..." : "Testa connessione"}
              </button>
            </div>
            ${s.testResult ? `<p style="color:${s.testResult.ok ? "#9fd6a8" : "#e7a2a2"}; font-size:12px;">${escapeHtml(s.testResult.message)}</p>` : ""}
            <div class="wsl-modal-actions">
              <button class="cancel" id="settings-cancel">Annulla</button>
              <button class="save" id="settings-save">Salva</button>
            </div>
          </div>
        </div>
      ` : ""}
    `;

    attachListeners();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function attachListeners() {
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));

    const rawTextEl = $("#raw-text");
    if (rawTextEl) rawTextEl.addEventListener("input", (e) => { state.rawText = e.target.value; });

    const uploadZone = $("#upload-zone");
    const fileInput = $("#file-input");
    if (uploadZone && fileInput) {
      uploadZone.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", handleFilesSelected);
    }

    $$(".btn-remove-file").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const id = e.currentTarget.getAttribute("data-id");
        state.files = state.files.filter((f) => f.id !== id);
        render();
      });
    });

    const analyzeBtn = $("#btn-analyze");
    if (analyzeBtn) analyzeBtn.addEventListener("click", handleAnalyze);

    const recommendBtn = $("#btn-recommend");
    if (recommendBtn) recommendBtn.addEventListener("click", handleRecommend);

    const resetBtn = $("#btn-reset");
    if (resetBtn) resetBtn.addEventListener("click", resetAll);

    const settingsBtn = $("#btn-settings");
    if (settingsBtn) settingsBtn.addEventListener("click", () => { state.showSettings = true; render(); });

    const budgetInput = $("#budget-input");
    if (budgetInput) budgetInput.addEventListener("input", (e) => { state.budget = e.target.value; });

    $$("#color-pills .wsl-pill").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        state.colorPref = e.currentTarget.getAttribute("data-color");
        render();
      });
    });
    $$("#style-pills .wsl-pill").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        state.stylePref = e.currentTarget.getAttribute("data-style");
        render();
      });
    });

    const countrySelect = $("#country-select");
    if (countrySelect) countrySelect.addEventListener("change", (e) => { state.countryPref = e.target.value; });

    const settingsCancel = $("#settings-cancel");
    if (settingsCancel) settingsCancel.addEventListener("click", () => { state.showSettings = false; render(); });

    const testBtn = $("#test-connection");
    if (testBtn) testBtn.addEventListener("click", async () => {
      const apiKeyToTest = $("#api-key-input").value.trim();
      state.testingConnection = true;
      state.testResult = null;
      render();
      try {
        if (!apiKeyToTest) throw new Error("Inserisci prima la chiave API qui sopra.");
        const t0 = Date.now();
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKeyToTest,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: $("#model-input").value.trim() || "claude-sonnet-5",
            max_tokens: 10,
            messages: [{ role: "user", content: "rispondi solo con: ok" }],
          }),
        });
        const ms = Date.now() - t0;
        if (res.ok) {
          state.testResult = { ok: true, message: "Connessione riuscita in " + ms + " ms: il dispositivo raggiunge l'API senza problemi. Se foto/PDF continuano a fallire, il problema è nel payload/nella logica dell'app, non nella rete." };
        } else {
          const errText = await res.text().catch(() => "");
          state.testResult = { ok: false, message: "Il dispositivo raggiunge l'API (risposta ricevuta) ma con un errore (" + res.status + "): " + errText.slice(0, 150) };
        }
      } catch (err) {
        state.testResult = { ok: false, message: "Richiesta non arrivata a destinazione: " + (err.message || "errore di rete") + ". Questo indica un blocco di rete (operatore, VPN, firewall) verso api.anthropic.com, non un problema di peso dei file." };
      } finally {
        state.testingConnection = false;
        render();
      }
    });

    const settingsSave = $("#settings-save");
    if (settingsSave) settingsSave.addEventListener("click", () => {
      const apiKey = $("#api-key-input").value.trim();
      const model = $("#model-input").value.trim() || "claude-sonnet-5";
      state.settings = { apiKey, model };
      saveSettings(state.settings);
      state.showSettings = false;
      render();
    });
    const backdrop = $("#settings-backdrop");
    if (backdrop) backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) { state.showSettings = false; render(); }
    });
  }

  async function handleFilesSelected(e) {
    const selected = Array.from(e.target.files || []);
    if (selected.length === 0) return;
    state.parseError = "";
    state.filesProcessing = true;
    render();
    for (const file of selected) {
      const isPdf = file.type === "application/pdf";
      const isImage = file.type.startsWith("image/");
      if (!isPdf && !isImage) continue;
      try {
        if (isPdf && window.pdfjsLib) {
          const entries = await pdfFileToImageEntries(file, 1300, 0.62, (pageNum, total) => {
            state.filesProcessingProgress = "Pagina " + pageNum + "/" + total + " di " + file.name;
            render();
          });
          state.files.push(...entries);
          state.filesProcessingProgress = "";
        } else if (isPdf) {
          // fallback se pdf.js non si carica (es. offline): invia il PDF grezzo, meno affidabile su reti deboli
          const base64 = await readFileAsBase64(file);
          state.files.push({
            id: Date.now() + "-" + Math.random().toString(36).slice(2),
            name: file.name,
            kind: "pdf",
            mediaType: file.type,
            base64,
            sizeMB: file.size / (1024 * 1024),
          });
        } else {
          const base64 = await downscaleImageFile(file, 1800, 0.78);
          state.files.push({
            id: Date.now() + "-" + Math.random().toString(36).slice(2),
            name: file.name,
            kind: "image",
            mediaType: "image/jpeg",
            base64,
            sizeMB: (base64.length * 0.75) / (1024 * 1024),
          });
        }
      } catch (err) {
        state.parseError = (err.message || "Errore leggendo " + file.name) + " (" + file.name + ")";
      }
    }
    state.filesProcessing = false;
    state.filesProcessingProgress = "";
    render();
  }

  function resetAll() {
    state.rawText = "";
    state.files = [];
    state.parsedWines = null;
    state.parseError = "";
    state.recommendations = null;
    state.recError = "";
    state.colorPref = "tutti";
    state.stylePref = "tutti";
    state.countryPref = "tutte";
    render();
  }

  async function handleAnalyze() {
    state.parseError = "";
    state.recommendations = null;
    if (!state.rawText.trim() && state.files.length === 0) {
      state.parseError = "Incolla del testo o carica almeno un'immagine/PDF della carta.";
      render();
      return;
    }
    state.parsing = true;
    state.parsingProgress = "";
    render();
    try {
      const allWines = [];

      if (state.files.length === 0) {
        const content = [
          { type: "text", text: "Testo della carta vini incollato dall'utente:\n" + state.rawText },
          { type: "text", text: PARSE_INSTRUCTIONS },
        ];
        const result = await callClaude(content, 8000);
        const parsed = parseJsonSafe(result);
        if (Array.isArray(parsed)) allWines.push(...parsed);
      } else {
        const chunks = buildDynamicChunks(state.files);
        const totalChunks = chunks.length;
        const failedChunks = [];
        let pagesDone = 0;
        for (let chunkNum = 1; chunkNum <= chunks.length; chunkNum++) {
          const chunkFiles = chunks[chunkNum - 1];
          const rangeLabel = "pagine " + (pagesDone + 1) + "-" + (pagesDone + chunkFiles.length) + " di " + state.files.length;
          pagesDone += chunkFiles.length;

          const content = [];
          if (chunkNum === 1 && state.rawText.trim()) {
            content.push({ type: "text", text: "Testo della carta vini incollato dall'utente:\n" + state.rawText });
          }
          chunkFiles.forEach((f) => {
            if (f.kind === "pdf") {
              content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.base64 } });
            } else {
              content.push({ type: "image", source: { type: "base64", media_type: f.mediaType, data: f.base64 } });
            }
          });
          content.push({ type: "text", text: PARSE_INSTRUCTIONS });

          // Riprova automaticamente un lotto che fallisce (tipico su reti mobili instabili)
          // invece di far fallire l'intera analisi per un singolo lotto sfortunato.
          let lastErr = null;
          let succeeded = false;
          for (let attempt = 1; attempt <= MAX_RETRIES_PER_CHUNK + 1; attempt++) {
            state.parsingProgress = totalChunks > 1
              ? "Lotto " + chunkNum + "/" + totalChunks + " (" + rangeLabel + ")" + (attempt > 1 ? " · tentativo " + attempt : "")
              : (attempt > 1 ? "Nuovo tentativo..." : "");
            render();
            try {
              const result = await callClaude(content, 8000);
              const parsed = parseJsonSafe(result);
              if (Array.isArray(parsed)) allWines.push(...parsed);
              succeeded = true;
              break;
            } catch (err) {
              lastErr = err;
              if (attempt <= MAX_RETRIES_PER_CHUNK) {
                await new Promise((r) => setTimeout(r, 1200 * attempt));
              }
            }
          }
          if (!succeeded) {
            failedChunks.push({ rangeLabel, error: lastErr });
          }
        }

        if (failedChunks.length > 0 && allWines.length > 0) {
          // Risultato parziale: meglio mostrare quello che si è riusciti a leggere
          // che perdere tutto per un lotto che continua a fallire.
          state.parseError =
            "Alcune pagine non sono state lette dopo vari tentativi (" +
            failedChunks.map((f) => f.rangeLabel).join("; ") +
            "): l'analisi qui sotto è basata solo sulle pagine lette con successo. Puoi riprovare, magari con una connessione più stabile.";
        } else if (failedChunks.length > 0 && allWines.length === 0) {
          throw failedChunks[0].error || new Error("Errore durante l'analisi.");
        }
      }

      if (allWines.length === 0) {
        throw new Error("Non ho trovato vini leggibili in questa carta.");
      }

      // Deduplica in caso di vini ripetuti tra pagine/lotti sovrapposti
      const seen = new Set();
      const deduped = allWines.filter((w) => {
        const key = [String(w.name || "").toLowerCase().trim(), String(w.producer || "").toLowerCase().trim(), w.vintage || ""].join("|");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      state.parsedWines = deduped;
    } catch (err) {
      state.parseError = err.message || "Errore durante l'analisi.";
    } finally {
      state.parsing = false;
      state.parsingProgress = "";
      render();
    }
  }

  async function handleRecommend() {
    if (!state.parsedWines) return;
    state.recError = "";
    state.recommending = true;
    render();
    try {
      const currency = mostCommonCurrency(state.parsedWines);
      let candidates = state.parsedWines.filter((w) => {
        const withinBudget = w.price == null || Number(w.price) <= Number(state.budget);
        const colorOk = state.colorPref === "tutti" || w.type === state.colorPref;
        const styleOk = state.stylePref === "tutti" || (w.style && String(w.style).toLowerCase().includes(state.stylePref));
        const countryOk = !state.countryPref || state.countryPref === "tutte" || w.country === state.countryPref;
        return withinBudget && colorOk && styleOk && countryOk;
      });

      let fallbackUsed = false;
      if (candidates.length === 0) {
        fallbackUsed = true;
        candidates = state.parsedWines.filter((w) => w.price == null || Number(w.price) <= Number(state.budget));
      }
      if (candidates.length === 0) {
        candidates = state.parsedWines;
        fallbackUsed = true;
      }

      const trimmed = candidates.slice(0, 200);
      const instructions = buildRecommendInstructions({
        budget: state.budget, currency, colorPref: state.colorPref, stylePref: state.stylePref, countryPref: state.countryPref, fallbackUsed,
      });

      const content = [{ type: "text", text: "Elenco vini candidati (JSON):\n" + JSON.stringify(trimmed) + "\n\n" + instructions }];
      const result = await callClaude(content, 2000);
      const parsed = parseJsonSafe(result);
      state.recommendations = Array.isArray(parsed) ? parsed.slice(0, 3) : [];
    } catch (err) {
      state.recError = err.message || "Errore durante la generazione dei consigli.";
    } finally {
      state.recommending = false;
      render();
    }
  }

  render();
})();
