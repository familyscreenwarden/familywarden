import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Link } from 'react-router-dom';
import { useApp, useLoad } from '../app';
import type { FamilyMap, KeepDays, MapCheckIn, MapKid } from '../api/types';
import { Avatar, Card, Confirm, ErrorBox, Loading, PageHead, StaleNote, Switch } from '../components/ui';
import { safeColor, textOn } from '../lib/color';
import { plural, possessive } from '../lib/format';
import {
  CHECKIN_TEXT, KEEP_LABEL, accuracyText, attributionHtml, batteryText, boundsOf, clockTime, escapeHtml, openCheckIns, recentOk, tileRetryUrl, whenText, whereText,
} from '../lib/map';

const RADII = [50, 100, 150, 250, 500, 1000];

function kidIcon(k: MapKid, selected: boolean): L.DivIcon {
  const bg = safeColor(k.color);
  const letter = escapeHtml((k.name.trim()[0] ?? '?').toUpperCase());
  return L.divIcon({
    className: 'map-pin',
    html: `<span class="${selected ? 'on' : ''}" style="background:${bg};color:${textOn(bg)}">${letter}</span>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });
}

/**
 * /map: where the kids' phones are. While this page is open the phones report every few seconds; otherwise every
 * five minutes. Check-ins from the kids show at the top. Places, sharing and how long a trail is kept are below.
 */
export function MapPage() {
  const { api, run } = useApp();
  const data = useLoad(() => api.familyMap(true), [], 5000);
  const d = data.data;
  const [selected, setSelected] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [newPlace, setNewPlace] = useState<{ lat: number; lng: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [clearing, setClearing] = useState<MapKid | null>(null);
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<L.LayerGroup | null>(null);
  const tileLayer = useRef<L.TileLayer | null>(null);
  const fitted = useRef(false);
  const addModeRef = useRef(false);
  addModeRef.current = addMode;

  const ready = d !== null;
  const tilesOn = d?.tiles.enabled ?? false;
  const attribution = d ? attributionHtml(d.tiles.attribution, d.tiles.attributionUrl) : '';
  const maxZoom = d?.tiles.maxZoom ?? 19;

  // The map itself, made once the first answer is here (it says where tiles come from and whose credit to show).
  useEffect(() => {
    if (!ready || !mapEl.current || map.current) return undefined;
    const m = L.map(mapEl.current, { zoomControl: true, attributionControl: true, maxZoom }).setView([39.5, -98.35], 4);
    m.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noreferrer noopener">Leaflet</a>');
    if (tilesOn) {
      // Tiles come through this server (signed-in parents only); the browser never asks the tile source itself.
      const tiles = L.tileLayer('/api/map-tiles/{z}/{x}/{y}.png', { maxZoom, keepBuffer: 4, updateWhenZooming: false, attribution }).addTo(m);
      // A tile the server could not get yet: ask again a few times instead of leaving a hole.
      tiles.on('tileerror', (e: L.TileErrorEvent) => {
        const img = e.tile as HTMLImageElement & { tries?: number };
        const tries = (img.tries ?? 0) + 1;
        if (tries > 4) return;
        img.tries = tries;
        const src = img.src;
        window.setTimeout(() => { img.src = tileRetryUrl(src, tries); }, 1500 * tries);
      });
      tileLayer.current = tiles;
    }
    layers.current = L.layerGroup().addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => {
      if (addModeRef.current) setNewPlace({ lat: e.latlng.lat, lng: e.latlng.lng });
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      layers.current = null;
      tileLayer.current = null;
      fitted.current = false;
    };
  }, [ready, tilesOn, attribution, maxZoom]);

  // Places, the kids, and the selected kid's trail of today.
  useEffect(() => {
    const m = map.current;
    const g = layers.current;
    if (!m || !g || !d) return;
    g.clearLayers();
    for (const p of d.places) {
      L.circle([p.lat, p.lng], { radius: p.radius, color: '#6f82de', weight: 2, fillOpacity: 0.12 }).addTo(g).bindTooltip(p.name);
    }
    if (newPlace) L.circleMarker([newPlace.lat, newPlace.lng], { radius: 8, color: '#34d399', weight: 3, fillOpacity: 0.4 }).addTo(g);
    const points: Array<[number, number]> = [];
    for (const k of d.kids) {
      if (!k.last) continue;
      const at: [number, number] = [k.last.lat, k.last.lng];
      const color = safeColor(k.color);
      points.push(at);
      if (k.last.accuracy !== null && k.last.accuracy > 20) L.circle(at, { radius: k.last.accuracy, color, weight: 1, fillOpacity: 0.08, interactive: false }).addTo(g);
      if (selected === k.id && k.trail.length > 1) {
        L.polyline(k.trail.map((t) => [t[0], t[1]] as [number, number]), { color, weight: 4, opacity: 0.8, dashArray: '1 8', lineCap: 'round', interactive: false }).addTo(g);
      }
      L.marker(at, { icon: kidIcon(k, selected === k.id), zIndexOffset: selected === k.id ? 1000 : 0, title: k.name, alt: `${k.name}: ${whereText(k)}`, keyboard: true })
        .addTo(g)
        .on('click', () => setSelected(k.id));
    }
    if (!fitted.current && points.length > 0) {
      fitted.current = true;
      const box = boundsOf(points);
      if (points.length === 1 && points[0]) m.setView(points[0], 15);
      else if (box) m.fitBounds(box, { padding: [60, 60], maxZoom: 16 });
    }
  }, [d, selected, newPlace]);

  // Picking a kid moves the map to them (only when the pick changes, not with every refresh).
  useEffect(() => {
    const k = d?.kids.find((x) => x.id === selected);
    if (k?.last && map.current) map.current.setView([k.last.lat, k.last.lng], Math.max(map.current.getZoom(), 15));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  async function act(action: () => Promise<unknown>, okText?: string): Promise<boolean> {
    setBusy(true);
    const ok = await run(action, okText);
    await data.reload();
    setBusy(false);
    return ok;
  }

  if (!d) {
    return (
      <>
        <PageHead title="Map" />
        {data.error ? <ErrorBox message={data.error} onRetry={() => void data.reload()} /> : <Loading label="Loading the map" />}
      </>
    );
  }

  const waiting = openCheckIns(d.checkins);
  const anyLive = d.kids.some((k) => k.live);
  const kidName = (kidId: string): string => d.kids.find((k) => k.id === kidId)?.name ?? 'A kid';

  return (
    <>
      <PageHead title="Map" sub="Where the kids' phones are. Only you can see this, and each kid's phone says that sharing is on.">
        {anyLive && <span className="pill pill-green">Live</span>}
      </PageHead>
      {data.error && <StaleNote message={data.error} />}

      {waiting.map((c) => (
        <CheckInAlert key={c.id} c={c} name={kidName(c.kidId)} busy={busy}
          onAnswer={() => void act(() => api.answerCheckIn(c.id, 'On my way'), `${kidName(c.kidId)} was answered: on my way.`)}
          onShow={() => setSelected(c.kidId)} />
      ))}

      {d.kids.length === 0 && (
        <Card className="first-run">
          <p>No kid has a phone yet. Set one up and it shows here.</p>
          <div><Link to="/devices" className="btn btn-primary">Set up a phone</Link></div>
        </Card>
      )}

      <div className="map-body">
        <div className="map-frame">
          <div className={`map-canvas${addMode ? ' adding' : ''}`} ref={mapEl} role="application" aria-label="Map of the kids' phones" />
          {!d.tiles.enabled && <p className="tiny muted map-note">No map pictures are set up on this server, so the kids are shown on a plain background.</p>}
          {addMode && !newPlace && <p className="banner banner-info small" role="status">Tap the map where the place is.</p>}
        </div>
        <div className="map-side">
          {d.kids.map((k) => (
            <KidCard key={k.id} k={k} selected={selected === k.id} ok={recentOk(d.checkins, k.id)} busy={busy}
              onSelect={() => setSelected(selected === k.id ? null : k.id)}
              onRing={() => void act(() => api.ringPhone(k.id).then((r) => r.message), `${possessive(k.name)} phone rings within about 20 seconds, loudly, even on mute.`)} />
          ))}
        </div>
      </div>

      <div className="grid-300">
        <PlacesCard d={d} busy={busy} addMode={addMode} newPlace={newPlace}
          onStart={() => { setAddMode(true); setNewPlace(null); mapEl.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }}
          onCancel={() => { setAddMode(false); setNewPlace(null); }}
          onSave={async (name, radius) => {
            if (!newPlace) return;
            if (await act(() => api.createPlace({ name, radius, lat: newPlace.lat, lng: newPlace.lng }), `${name} is a place now.`)) { setAddMode(false); setNewPlace(null); }
          }}
          onRemove={(id, name) => void act(() => api.deletePlace(id), `${name} was removed.`)} />

        <Card title="Sharing, for each kid">
          {d.kids.length === 0 && <p className="empty">Kids with a phone show here.</p>}
          {d.kids.map((k) => (
            <KidSettings key={k.id} k={k} busy={busy} options={d.keepDaysOptions}
              onSave={(patch, text) => void act(() => api.saveLocationSettings(k.id, patch), text)}
              onClear={() => setClearing(k)} />
          ))}
          <ul className="notes">
            <li>The kid's phone always shows when sharing is on, and says when you are looking at the map.</li>
            <li>While this page is open, phones report every few seconds; otherwise every 5 minutes.</li>
            <li>Positions older than the time you pick are deleted. Check-ins are deleted after 90 days.</li>
          </ul>
        </Card>
      </div>

      <Confirm open={clearing !== null} danger busy={busy}
        title={clearing ? `Clear ${possessive(clearing.name)} location history?` : ''}
        body={<p>Every position, arrival, departure and check-in kept for this kid is deleted now. This cannot be undone. Sharing stays as it is set.</p>}
        confirmLabel="Clear history"
        onCancel={() => setClearing(null)}
        onConfirm={() => {
          const k = clearing;
          if (!k) return;
          void act(() => api.clearLocation(k.id), `${possessive(k.name)} location history was cleared.`).then(() => setClearing(null));
        }} />
    </>
  );
}

function CheckInAlert({ c, name, busy, onAnswer, onShow }: { c: MapCheckIn; name: string; busy: boolean; onAnswer: () => void; onShow: () => void }) {
  return (
    <div className={`banner ${c.kind === 'help' ? 'banner-error' : 'banner-warn'}`} role="alert">
      <div className="grow">
        <div className="strong">{c.kind === 'help' ? 'Needs help' : 'Asks for a ride'}: {name} says "{CHECKIN_TEXT[c.kind]}"</div>
        <div className="small">Sent at {clockTime(c.at)}. {c.lat !== null ? 'The phone shares where it is until you answer.' : 'No position came with it.'}</div>
      </div>
      <div className="row">
        <button type="button" className="btn btn-ghost" onClick={onShow}>Show on the map</button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={onAnswer}>On my way</button>
      </div>
    </div>
  );
}

function KidCard({ k, selected, ok, busy, onSelect, onRing }: { k: MapKid; selected: boolean; ok: MapCheckIn | null; busy: boolean; onSelect: () => void; onRing: () => void }) {
  const battery = k.last ? batteryText(k.last.battery, k.last.charging) : '';
  return (
    <section className={`card map-kid${selected ? ' on' : ''}`} aria-label={k.name}>
      <div className="row">
        <Avatar name={k.name} color={k.color} />
        <div className="grow">
          <div className="row-between">
            <h2 className="map-kid-name">{k.name}</h2>
            {k.live && <span className="pill pill-green">Live</span>}
            {!k.sharing && <span className="pill pill-off">Sharing off</span>}
          </div>
          <div className="small">{whereText(k)}{k.last ? `, ${whenText(k)}` : ''}</div>
          {k.last && <div className="tiny muted">{[accuracyText(k.last.accuracy), battery, k.phone].filter(Boolean).join(' · ')}</div>}
        </div>
      </div>
      {ok && <div className="small map-ok">Checked in at {clockTime(ok.at)}: "{CHECKIN_TEXT.ok}"</div>}
      <div className="row">
        <button type="button" className="btn btn-ghost" aria-pressed={selected} disabled={!k.last} onClick={onSelect}>{selected ? 'Hide today' : 'Show today'}<span className="sr-only"> for {k.name}</span></button>
        <button type="button" className="btn btn-secondary" disabled={busy || k.ringing} onClick={onRing}>{k.ringing ? 'Ringing…' : 'Ring phone'}<span className="sr-only">: {k.name}</span></button>
      </div>
      {selected && k.last && (
        <div className="inset stack">
          <div className="label-head">Today</div>
          {k.events.length === 0 && <div className="tiny muted">No arrivals or departures yet.</div>}
          {k.events.length > 0 && (
            <ul className="plain-list small">
              {k.events.map((e, i) => <li key={`${e.at}-${i}`}><span className="muted">{clockTime(e.at)}</span> {e.kind === 'arrive' ? 'Arrived at' : 'Left'} {e.placeName}</li>)}
            </ul>
          )}
          <div className="tiny muted">{plural(k.trail.length, 'position', 'positions')} today. Last: {k.last.lat.toFixed(5)}, {k.last.lng.toFixed(5)}</div>
        </div>
      )}
    </section>
  );
}

function PlacesCard({ d, busy, addMode, newPlace, onStart, onCancel, onSave, onRemove }: {
  d: FamilyMap; busy: boolean; addMode: boolean; newPlace: { lat: number; lng: number } | null;
  onStart: () => void; onCancel: () => void; onSave: (name: string, radius: number) => Promise<void>; onRemove: (id: string, name: string) => void;
}) {
  const ids = { name: useId(), radius: useId() };
  const [name, setName] = useState('');
  const [radius, setRadius] = useState(150);
  useEffect(() => { if (!addMode) setName(''); }, [addMode]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) void onSave(name.trim(), radius);
  }

  return (
    <Card title="Places" action={!addMode ? <button type="button" className="btn btn-ghost" onClick={onStart}>Add a place</button> : undefined}>
      <p className="small muted">Home, school, a friend's house. The map shows when a kid arrives at or leaves a place, and you get an email if you switch that on for the kid.</p>
      {d.places.length === 0 && !addMode && <p className="empty">No places yet.</p>}
      {d.places.length > 0 && (
        <ul className="plain-list">
          {d.places.map((p) => (
            <li key={p.id} className="setting-row">
              <div className="grow"><span className="strong">{p.name}</span> <span className="tiny muted">{p.radius} m around it</span></div>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onRemove(p.id, p.name)}>Remove<span className="sr-only"> {p.name}</span></button>
            </li>
          ))}
        </ul>
      )}
      {addMode && (
        <form className="inset stack" onSubmit={submit} aria-label="Add a place">
          <p className="small">{newPlace ? `Picked: ${newPlace.lat.toFixed(5)}, ${newPlace.lng.toFixed(5)}. Tap the map again to move it.` : 'Tap the map where the place is.'}</p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor={ids.name}>Name</label>
              <input id={ids.name} className="input" value={name} maxLength={60} placeholder="School" onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={ids.radius}>How big</label>
              <select id={ids.radius} className="select" value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
                {RADII.map((r) => <option key={r} value={r}>{r} m around it</option>)}
              </select>
            </div>
          </div>
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy || !newPlace || !name.trim()}>Save place</button>
            <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      )}
    </Card>
  );
}

function KidSettings({ k, busy, options, onSave, onClear }: {
  k: MapKid; busy: boolean; options: KeepDays[]; onSave: (patch: { sharing?: boolean; alerts?: boolean; keepDays?: KeepDays }, okText: string) => void; onClear: () => void;
}) {
  const keepId = useId();
  return (
    <section className="inset stack" aria-label={`Sharing for ${k.name}`}>
      <div className="strong">{k.name}</div>
      <div className="setting-row">
        <div>
          <div>Share location</div>
          <div className="tiny muted">Off: the phone stops sending where it is, and nothing new is kept.</div>
        </div>
        <Switch checked={k.sharing} disabled={busy} label={`Share location for ${k.name}`}
          onChange={(v) => onSave({ sharing: v }, `Location sharing is ${v ? 'on' : 'off'} for ${k.name}.`)} />
      </div>
      <div className="setting-row">
        <div>
          <div>Email me when {k.name} arrives or leaves</div>
          <div className="tiny muted">For the places above. Check-ins are always emailed.</div>
        </div>
        <Switch checked={k.alerts} disabled={busy || !k.sharing} label={`Arrive and leave emails for ${k.name}`}
          onChange={(v) => onSave({ alerts: v }, `Arrive and leave emails are ${v ? 'on' : 'off'} for ${k.name}.`)} />
      </div>
      <div className="setting-row">
        <label htmlFor={keepId}>Keep positions for</label>
        <select id={keepId} className="select w-auto" value={k.keepDays} disabled={busy}
          onChange={(e) => { const v = Number(e.target.value) as KeepDays; onSave({ keepDays: v }, `${possessive(k.name)} positions are kept for ${KEEP_LABEL[v] ?? `${v} days`}.`); }}>
          {options.map((o) => <option key={o} value={o}>{KEEP_LABEL[o] ?? `${o} days`}</option>)}
        </select>
      </div>
      <div><button type="button" className="btn btn-danger" disabled={busy} onClick={onClear}>Clear location history<span className="sr-only"> of {k.name}</span></button></div>
    </section>
  );
}
