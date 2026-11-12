const COLUMNS = [
  'compound_number', 'name', 'smiles', 'status', 'organism', 'taxon_id',
  'voucher_or_strain', 'part_or_condition', 'collection_place', 'collection_date',
  'observation', 'evidence', 'doi'
];
const REQUIRED = ['compound_number', 'name', 'smiles', 'organism'];
const STORAGE_KEY = 'lotus-si-composer-v1';
const recordsNode = document.querySelector('#records');
const notice = document.querySelector('#notice');
const lookupRequests = new WeakMap();
const placeRequests = new WeakMap();
const maps = new Map();
let leafletPromise;
const PINNABLE = COLUMNS.filter(column => !['compound_number', 'name', 'smiles'].includes(column));
let pinned = {};
let nextId = 1;
let records = [];
let storageAvailable = true;

function blankRecord() {
  return { id: nextId++, ...Object.fromEntries(COLUMNS.map(column => [column, ''])) };
}

function message(text, error = false) {
  notice.textContent = text;
  notice.classList.toggle('error', error);
}

function save() {
  if (!storageAvailable) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ records, pinned }));
  } catch {
    storageAvailable = false;
    message('Browser storage is unavailable. Download a TSV before leaving this page.', true);
  }
}

function load() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
      const savedDraft = JSON.parse(saved);
      const parsed = Array.isArray(savedDraft) ? savedDraft : savedDraft.records;
      if (!Array.isArray(parsed) || !parsed.every(row => row && typeof row === 'object')) throw new Error('Invalid draft');
      if (!Array.isArray(savedDraft) && savedDraft.pinned && typeof savedDraft.pinned === 'object') {
        for (const column of PINNABLE) {
          if (typeof savedDraft.pinned[column] === 'string') pinned[column] = savedDraft.pinned[column];
        }
      }
      records = parsed.map(row => {
        const record = blankRecord();
        for (const column of COLUMNS) record[column] = typeof row[column] === 'string' ? row[column] : '';
        return record;
      });
    }
  } catch {
    storageAvailable = false; // Do not overwrite a draft that cannot be read.
    message('Saved draft could not be read. It has not been overwritten; export this session before leaving.', true);
  }
  if (!records.length) records.push(blankRecord());
}

function lookupMarkup(kind) {
  const options = kind === 'part'
    ? '<option value="po">PO · plant</option><option value="fao">FAO · fungus</option><option value="uberon">UBERON · animal</option><option value="bto">BTO · tissue / culture</option><option value="envo">ENVO · environment</option><option value="ro">RO · relation</option>'
    : '<option value="chmo">CHMO · method</option><option value="eco">ECO · evidence</option>';
  return `<div class="lookup" data-lookup="${kind}"><label>Find ${kind === 'part' ? 'a part or condition' : 'an evidence term'}<span class="lookup-controls"><select aria-label="Ontology">${options}</select><input class="lookup-query" type="search" placeholder="Search term or CURIE" autocomplete="off" aria-label="Search ontology terms"></span></label><div class="lookup-results" role="group" aria-label="Ontology search results" aria-live="polite"></div></div>`;
}

const FORM = `
  <div class="card-head"><div><span class="card-kicker">COMPOUND <span class="ordinal"></span></span><h3>Occurrence details</h3></div><button type="button" class="remove text-button">Remove</button></div>
  <div class="field-grid">
    <label class="field field-small">Compound number <span class="required">*</span><input data-field="compound_number" placeholder="1" required></label>
    <label class="field field-wide">Compound name <span class="required">*</span><input data-field="name" placeholder="e.g. Subtortin A" required></label>
    <label class="field field-small">Status <select data-field="status"><option value="">Select…</option><option value="new">New</option><option value="known">Known</option></select></label>
    <label class="field field-full">Isomeric SMILES <span class="required">*</span><textarea data-field="smiles" rows="2" placeholder="Paste stereo-complete SMILES from the drawing tool" required></textarea><small>Structure and stereochemistry are not validated in this browser.</small></label>
    <label class="field field-wide">Source organism <span class="required">*</span><input data-field="organism" placeholder="Scientific name, e.g. Mitragyna speciosa" required></label>
    <label class="field field-small">Taxon ID <input data-field="taxon_id" placeholder="e.g. wd:Q139698"><small>Optional; plain-text organism is sufficient for current curation.</small></label>
    <label class="field field-full">Article DOI <span class="optional">(optional)</span><input data-field="doi" placeholder="10.1021/acs.jnatprod.…"><small>If known, include a DOI; a blank DOI is allowed.</small></label>
  </div>
  <div class="section-divider"><span>LINKED CONTEXT</span><span>Additional SI columns · optional</span></div>
  <div class="field-grid">
    <label class="field field-full">Voucher or strain <input data-field="voucher_or_strain" placeholder="dwc:PreservedSpecimen (BCO:0000046; ih:INST:ID)"><small>Record type and collection/strain ID, if known.</small></label>
    <div class="field field-wide"><label>Part or condition <input data-field="part_or_condition" placeholder="PO:0025034"></label><small>Selected term inserts a CURIE. For hosts, add a host taxon manually (e.g. RO:0002454 wd:Q…).</small>${lookupMarkup('part')}</div>
    <div class="field field-wide"><label>Evidence <input data-field="evidence" placeholder="CHMO:0000591; CHMO:0000470"></label><small>Choose multiple methods; identifiers are separated by semicolons.</small>${lookupMarkup('evidence')}</div>
    <div class="field field-full place-field"><label>Collection place <input data-field="collection_place" placeholder="wd:Q36378 or geo:46.805556,7.161267"></label><small>Search Wikidata for a named place, or mark precise coordinates on the map. Results are not restricted to places; check each description.</small>
      <form class="place-lookup"><label>Find a named place (Wikidata)<span class="lookup-controls"><input type="search" class="place-query" placeholder="e.g. Fribourg, Switzerland" aria-label="Search Wikidata places"><button type="submit" class="mini-button">Search</button></span></label><div class="lookup-results place-results" role="group" aria-label="Place search results" aria-live="polite"></div></form>
      <div class="coordinate-controls"><label>Latitude <input class="latitude" type="number" min="-90" max="90" step="any" placeholder="46.805556"></label><label>Longitude <input class="longitude" type="number" min="-180" max="180" step="any" placeholder="7.161267"></label><button type="button" class="use-coordinates mini-button">Use coordinates</button><button type="button" class="show-map mini-button">Pick on map…</button></div>
      <div class="map-panel" hidden><div class="map" aria-label="Interactive collection site map"></div><small>Click to place a pin. Coordinates are stored as an RFC 5870 <code>geo:lat,lon</code> URI. Map data © OpenStreetMap contributors.</small></div>
    </div>
    <label class="field field-small">Collection date <input data-field="collection_date" type="date"></label>
    <label class="field field-small">Observation <select data-field="observation"><option value="">Select…</option><option value="isolated">Isolated</option><option value="detected">Detected</option></select></label>
  </div>`;

function render() {
  for (const map of maps.values()) map.remove();
  maps.clear();
  recordsNode.replaceChildren();
  records.forEach((record, index) => {
    const card = document.createElement('article');
    card.className = 'record-card';
    card.dataset.id = String(record.id);
    card.innerHTML = FORM; // Static markup only; saved/user values are assigned as DOM properties.
    card.querySelector('.ordinal').textContent = String(index + 1).padStart(2, '0');
    for (const column of COLUMNS) card.querySelector(`[data-field="${column}"]`).value = record[column];
    for (const column of PINNABLE) {
      const field = card.querySelector(`[data-field="${column}"]`);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pin';
      button.dataset.pin = column;
      field.after(button);
    }
    const coordinates = parseGeo(record.collection_place);
    if (coordinates) {
      card.querySelector('.latitude').value = coordinates[0];
      card.querySelector('.longitude').value = coordinates[1];
    }
    recordsNode.append(card);
  });
  document.querySelector('#count').textContent = String(records.length).padStart(2, '0');
  updatePins();
  renderPreview();
}

function addRecord() {
  const record = blankRecord();
  for (const column of PINNABLE) if (Object.hasOwn(pinned, column)) record[column] = pinned[column];
  records.push(record);
  render();
  save();
  recordsNode.querySelector(`[data-id="${record.id}"] [data-field="compound_number"]`).focus();
}

function search(lookup) {
  const previous = lookupRequests.get(lookup);
  if (previous) { clearTimeout(previous.timer); previous.controller.abort(); }
  const query = lookup.querySelector('.lookup-query').value.trim();
  const ontology = lookup.querySelector('select').value;
  const results = lookup.querySelector('.lookup-results');
  results.replaceChildren();
  if (query.length < 2) {
    results.textContent = query ? 'Enter at least 2 characters.' : '';
    return;
  }
  results.textContent = 'Searching OLS…';
  const controller = new AbortController();
  const timer = setTimeout(async () => {
    const url = new URL('https://www.ebi.ac.uk/ols4/api/search');
    url.search = new URLSearchParams({ q: query, ontology, rows: '10', type: 'class' });
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`OLS returned HTTP ${response.status}`);
      const json = await response.json();
      if (lookupRequests.get(lookup)?.controller !== controller) return;
      const terms = json.response.docs.filter(doc => doc.ontology_name === ontology && doc.obo_id && doc.label);
      results.replaceChildren();
      if (!terms.length) { results.textContent = 'No terms found in this ontology. Try a different term or ontology.'; return; }
      for (const term of terms) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'term';
        button.dataset.curie = term.obo_id;
        const name = document.createElement('span');
        name.textContent = term.label;
        const id = document.createElement('code');
        id.textContent = term.obo_id;
        button.append(name, id);
        results.append(button);
      }
    } catch (error) {
      if (error.name !== 'AbortError' && lookupRequests.get(lookup)?.controller === controller) results.textContent = 'OLS is unavailable. Check your connection or enter a verified CURIE manually.';
    }
  }, 300);
  lookupRequests.set(lookup, { timer, controller });
}

function encodeCell(value) {
  const trimmed = value.trim();
  return /[\t\r\n"]/.test(trimmed) ? `"${trimmed.replaceAll('"', '""')}"` : trimmed;
}

function download() {
  for (const record of records) {
    for (const column of REQUIRED) {
      if (!record[column].trim()) {
        const field = recordsNode.querySelector(`[data-id="${record.id}"] [data-field="${column}"]`);
        field.focus();
        message(`Fill in ${column.replaceAll('_', ' ')} for compound ${records.indexOf(record) + 1} before downloading.`, true);
        return;
      }
    }
    if (record.doi.trim() && !/^10\.\d{4,9}\/\S+$/i.test(record.doi.trim())) {
      recordsNode.querySelector(`[data-id="${record.id}"] [data-field="doi"]`).focus();
      message(`Check the DOI for compound ${records.indexOf(record) + 1}.`, true);
      return;
    }
  }
  const numbers = records.map(row => row.compound_number.trim());
  if (new Set(numbers).size !== numbers.length) { message('Compound numbers must be unique.', true); return; }
  const tsv = buildTsv();
  const url = URL.createObjectURL(new Blob([tsv], { type: 'text/tab-separated-values;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'lotus-supporting-information.tsv';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  message(`Downloaded ${records.length} compound${records.length === 1 ? '' : 's'}. Review structures and identifiers before submission.`);
}

load();
render();
function buildTsv() {
  return [COLUMNS.join('\t'), ...records.map(record => COLUMNS.map(column => encodeCell(record[column])).join('\t'))].join('\r\n') + '\r\n';
}

function renderPreview() {
  document.querySelector('#tsv-preview').textContent = buildTsv();
}

function updatePins() {
  for (const button of recordsNode.querySelectorAll('[data-pin]')) {
    const record = records.find(row => row.id === Number(button.closest('.record-card').dataset.id));
    const active = Object.hasOwn(pinned, button.dataset.pin) && pinned[button.dataset.pin] === record[button.dataset.pin];
    button.textContent = active ? '▣ Pinned for next' : '□ Pin for next';
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('aria-label', `${active ? 'Unpin' : 'Pin'} ${button.dataset.pin.replaceAll('_', ' ')} for future compounds`);
    button.title = active ? 'Unpin this value' : 'Copy this value to future compounds';
  }
}

function parseGeo(value) {
  const match = /^geo:([+-]?\d+(?:\.\d+)?),([+-]?\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return null;
  const lat = Number(match[1]), lon = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}

function setCoordinates(card, lat, lon) {
  const field = card.querySelector('[data-field="collection_place"]');
  field.value = `geo:${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
  card.querySelector('.latitude').value = Number(lat).toFixed(6);
  card.querySelector('.longitude').value = Number(lon).toFixed(6);
  const map = maps.get(Number(card.dataset.id));
  if (map) {
    map.setView([lat, lon], Math.max(map.getZoom(), 12));
    if (map.siteMarker) map.siteMarker.setLatLng([lat, lon]);
    else map.siteMarker = window.L.marker([lat, lon]).addTo(map);
  }
  field.dispatchEvent(new Event('input', { bubbles: true }));
  message('Collection coordinates recorded in collection_place.');
}

async function searchPlaces(form) {
  const query = form.querySelector('.place-query').value.trim();
  const results = form.querySelector('.place-results');
  if (query.length < 2) { results.textContent = 'Enter a place name (at least 2 characters).'; return; }
  placeRequests.get(form)?.abort();
  const controller = new AbortController();
  placeRequests.set(form, controller);
  results.textContent = 'Searching Wikidata…';
  const url = new URL('https://www.wikidata.org/w/api.php');
  url.search = new URLSearchParams({
    action: 'wbsearchentities', search: query, language: 'en',
    type: 'item', limit: '10', format: 'json', origin: '*'
  });
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Wikidata returned HTTP ${response.status}`);
    const json = await response.json();
    if (placeRequests.get(form) !== controller) return;
    results.replaceChildren();
    if (!json.search?.length) { results.textContent = 'No matches. Try another name or enter a verified identifier manually.'; return; }
    for (const item of json.search) {
      if (!/^Q\d+$/.test(item.id)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'place-result term';
      button.dataset.place = item.id;
      const label = document.createElement('span');
      label.textContent = `${item.label} — ${item.description || 'No description; verify this is a place'}`;
      const id = document.createElement('code');
      id.textContent = item.id;
      button.append(label, id);
      results.append(button);
    }
  } catch (error) {
    if (error.name !== 'AbortError' && placeRequests.get(form) === controller) results.textContent = 'Wikidata is unavailable. Enter a verified wd:Q… or geo:lat,lon manually.';
  }
}

function loadLeaflet() {
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.append(css);
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.onload = () => resolve(window.L);
    script.onerror = () => reject(new Error('Map library could not be loaded'));
    document.head.append(script);
  }).catch(error => { leafletPromise = null; throw error; });
  return leafletPromise;
}

async function showMap(card) {
  const panel = card.querySelector('.map-panel');
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
  const existing = maps.get(Number(card.dataset.id));
  if (existing) { existing.invalidateSize(); return; }
  try {
    const L = await loadLeaflet();
    if (!card.isConnected || panel.hidden) return;
    const coordinates = parseGeo(card.querySelector('[data-field="collection_place"]').value);
    const map = L.map(panel.querySelector('.map')).setView(coordinates || [20, 0], coordinates ? 12 : 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }).addTo(map);
    maps.set(Number(card.dataset.id), map);
    if (coordinates) map.siteMarker = L.marker(coordinates).addTo(map);
    map.on('click', event => setCoordinates(card, event.latlng.lat, event.latlng.lng));
    map.invalidateSize();
  } catch {
    panel.hidden = true;
    message('Map unavailable. Enter latitude and longitude above instead.', true);
  }
}
document.querySelector('#add').addEventListener('click', addRecord);
document.querySelector('#add-bottom').addEventListener('click', addRecord);
document.querySelector('#download').addEventListener('click', download);
document.querySelector('#clear').addEventListener('click', () => {
  if (!confirm('Clear all compounds in this browser draft? Download a TSV first if you need a copy.')) return;
  records = [blankRecord()];
  pinned = {};
  render();
  save();
  message('Draft cleared.');
});
recordsNode.addEventListener('input', event => {
  const field = event.target.closest('[data-field]');
  if (field) {
    const record = records.find(row => row.id === Number(field.closest('.record-card').dataset.id));
    record[field.dataset.field] = field.value;
    if (Object.hasOwn(pinned, field.dataset.field)) pinned[field.dataset.field] = field.value;
    save();
    renderPreview();
    updatePins();
    if (!notice.classList.contains('error') || storageAvailable) message('');
  }
  if (event.target.matches('.lookup-query')) search(event.target.closest('.lookup'));
});
recordsNode.addEventListener('change', event => {
  if (event.target.matches('.lookup select')) search(event.target.closest('.lookup'));
  if (event.target.matches('[data-field]')) {
    const field = event.target;
    const record = records.find(row => row.id === Number(field.closest('.record-card').dataset.id));
    record[field.dataset.field] = field.value;
    if (Object.hasOwn(pinned, field.dataset.field)) pinned[field.dataset.field] = field.value;
    save();
    renderPreview();
    updatePins();
  }
});
recordsNode.addEventListener('submit', event => {
  if (!event.target.matches('.place-lookup')) return;
  event.preventDefault();
  searchPlaces(event.target);
});
recordsNode.addEventListener('click', event => {
  const card = event.target.closest('.record-card');
  const remove = event.target.closest('.remove');
  if (remove) {
    if (records.length === 1) { message('Keep at least one compound; use Clear draft to start over.', true); return; }
    records = records.filter(row => row.id !== Number(card.dataset.id));
    render(); save(); message('Compound removed.');
    return;
  }
  const pin = event.target.closest('[data-pin]');
  if (pin) {
    const column = pin.dataset.pin;
    const value = card.querySelector(`[data-field="${column}"]`).value;
    if (Object.hasOwn(pinned, column) && pinned[column] === value) delete pinned[column];
    else if (value.trim()) pinned[column] = value;
    else { message('Enter a value before pinning it.', true); return; }
    save(); updatePins();
    message(Object.hasOwn(pinned, column) ? `${column.replaceAll('_', ' ')} will be copied to new compounds.` : `${column.replaceAll('_', ' ')} unpinned.`);
    return;
  }
  const place = event.target.closest('.place-result');
  if (place) {
    const field = card.querySelector('[data-field="collection_place"]');
    field.value = `wd:${place.dataset.place}`;
    card.querySelector('.latitude').value = '';
    card.querySelector('.longitude').value = '';
    const map = maps.get(Number(card.dataset.id));
    if (map?.siteMarker) { map.removeLayer(map.siteMarker); map.siteMarker = null; }
    field.dispatchEvent(new Event('input', { bubbles: true }));
    place.closest('.place-lookup').querySelector('.place-results').replaceChildren();
    message(`Selected ${place.querySelector('span').textContent} (${place.dataset.place}).`);
    field.focus();
    return;
  }
  if (event.target.closest('.use-coordinates')) {
    const latitude = card.querySelector('.latitude');
    const longitude = card.querySelector('.longitude');
    if (!latitude.value || !longitude.value || !latitude.checkValidity() || !longitude.checkValidity()) {
      message('Enter valid latitude (−90 to 90) and longitude (−180 to 180).', true);
      return;
    }
    setCoordinates(card, Number(latitude.value), Number(longitude.value));
    return;
  }
  if (event.target.closest('.show-map')) { showMap(card); return; }
  const term = event.target.closest('.term');
  if (term) {
    const lookup = term.closest('.lookup');
    const field = lookup.parentElement.querySelector('[data-field]');
    const curie = term.dataset.curie;
    if (lookup.dataset.lookup === 'evidence') {
      const entries = field.value.split(';').map(value => value.trim()).filter(Boolean);
      if (!entries.includes(curie)) entries.push(curie);
      field.value = entries.join('; ');
    } else field.value = curie;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    lookup.querySelector('.lookup-query').value = '';
    lookup.querySelector('.lookup-results').replaceChildren();
    field.focus();
  }
});
