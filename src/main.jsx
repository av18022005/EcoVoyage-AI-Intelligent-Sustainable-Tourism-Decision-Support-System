import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './styles.css';

const demoAccounts = { tourist: ['tourist@ecovoyage.ai', 'Tourist@123'], government: ['government@ecovoyage.ai', 'Gov@123'], admin: ['admin@ecovoyage.ai', 'Admin@123'] };
const money = value => `₹${new Intl.NumberFormat('en-IN').format(value)}`;
const compact = value => new Intl.NumberFormat('en-IN', { notation: 'compact' }).format(value);

function request(path, token, options = {}) {
  return fetch(path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } }).then(async response => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  });
}

const pressureColour = destination => destination.status === 'High pressure' ? '#ef785f' : destination.status === 'Watch' ? '#eeb857' : '#4eaf75';

function MapView({ destinations, route = null, showHeat = true }) {
  const node = useRef(null);
  const map = useRef(null);
  useEffect(() => {
    if (!node.current || map.current) return undefined;
    map.current = L.map(node.current, { zoomControl: false, scrollWheelZoom: false }).setView([18.7, 78.2], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap contributors' }).addTo(map.current);
    L.control.zoom({ position: 'bottomright' }).addTo(map.current);
    return () => { map.current?.remove(); map.current = null; };
  }, []);
  useEffect(() => {
    if (!map.current) return undefined;
    const layer = L.layerGroup().addTo(map.current);
    if (showHeat) destinations.forEach(destination => {
      const [lng, lat] = destination.location.coordinates;
      const intensity = Math.max(18, Math.min(100, destination.capacityUse || 0));
      L.circle([lat, lng], { radius: intensity * 850, color: pressureColour(destination), weight: 0, fillColor: pressureColour(destination), fillOpacity: .16 }).addTo(layer);
    });
    destinations.forEach(destination => {
      const [lng, lat] = destination.location.coordinates;
      L.circleMarker([lat, lng], { radius: 9, color: '#fff', weight: 2, fillColor: pressureColour(destination), fillOpacity: .96 })
        .bindPopup(`<b>${destination.name}</b><br>${destination.capacityUse}% safe capacity use<br>DTSI++ ${destination.dtsi}/100`).addTo(layer);
    });
    if (route?.geometry?.coordinates?.length) {
      const points = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      const line = L.polyline(points, { color: '#174d3b', weight: 4, opacity: .85 }).addTo(layer);
      if (points.length > 1) map.current.fitBounds(line.getBounds(), { padding: [25, 25] });
    }
    return () => layer.remove();
  }, [destinations, route, showHeat]);
  return <div className="map" ref={node} aria-label="Interactive OpenStreetMap destination map" />;
}

function Login({ onLogin }) {
  const [role, setRole] = useState('tourist');
  const [email, setEmail] = useState(demoAccounts.tourist[0]);
  const [password, setPassword] = useState(demoAccounts.tourist[1]);
  const [error, setError] = useState('');
  const chooseRole = value => { setRole(value); setEmail(demoAccounts[value][0]); setPassword(demoAccounts[value][1]); setError(''); };
  const submit = async event => {
    event.preventDefault();
    try { const data = await request('/api/auth/login', null, { method: 'POST', body: JSON.stringify({ role, email, password }) }); onLogin(data.token); }
    catch (reason) { setError(reason.message); }
  };
  return <main className="login-shell"><section className="login-copy"><p className="eyebrow">NO-SQL SUSTAINABLE TOURISM PLATFORM</p><h1>Travel better.<br /><em>Decide smarter.</em></h1><p>EcoVoyage AI combines tourist behaviour, environmental readings, crowd forecasts and carrying capacity to make travel more responsible.</p><div className="role-list"><span>✦ Tourist <small>personalised trips</small></span><span>▦ Government <small>pressure monitoring</small></span><span>⚙ Admin <small>data and model control</small></span></div></section><form className="login-card" onSubmit={submit}><p className="eyebrow">SECURE DEMO LOGIN</p><h2>Welcome to EcoVoyage</h2><label>Account type<select value={role} onChange={event => chooseRole(event.target.value)}><option value="tourist">Tourist</option><option value="government">Government</option><option value="admin">Administrator</option></select></label><label>Email<input value={email} onChange={event => setEmail(event.target.value)} type="email" required /></label><label>Password<input value={password} onChange={event => setPassword(event.target.value)} type="password" required /></label>{error && <p className="error">{error}</p>}<button>Sign in</button><p className="hint">Demo credentials are pre-filled. Password hashes are stored with bcrypt in MongoDB.</p></form></main>;
}

function Header({ user, signOut }) { return <header><div className="brand"><span>◈</span> EcoVoyage <b>AI</b></div><p>{user.role[0].toUpperCase() + user.role.slice(1)} portal · Express + MongoDB</p><div className="live"><i /> MongoDB connected</div><button className="light" onClick={signOut}>Sign out</button></header>; }
function Statistics({ metrics }) { return <section className="stats">{[[metrics.destinations, 'destinations evaluated'], [`${metrics.averageDtsi}/100`, 'average DTSI++'], [metrics.healthy, 'healthy destinations'], [compact(metrics.visitors), 'forecast visitors']].map(([value, label]) => <div className="stat" key={label}><strong>{value}</strong><small>{label}</small></div>)}</section>; }

function DestinationSearch({ token }) {
  const [query, setQuery] = useState(''); const [result, setResult] = useState(null); const [error, setError] = useState('');
  const submit = async event => {
    event.preventDefault(); if (!query.trim()) return;
    try { setError(''); setResult(await request(`/api/destinations/search?q=${encodeURIComponent(query)}`, token)); } catch (reason) { setError(reason.message); }
  };
  return <section className="search-panel"><p className="eyebrow">DESTINATION DISCOVERY</p><form onSubmit={submit}><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search beach, heritage, Kerala…" aria-label="Search destinations" /><button>Search</button></form>{error && <p className="error">{error}</p>}{result && <><p className="hint">{result.provider}</p><div className="search-results">{result.results.length ? result.results.map(destination => <span key={destination.id}><b>{destination.name}</b> · DTSI++ {destination.dtsi}</span>) : 'No destinations matched.'}</div></>}</section>;
}

function RoutePlan({ route }) {
  if (!route) return null;
  const { carbonEstimate, destination } = route;
  return <section className="route-summary"><p className="eyebrow">LOW-IMPACT ROUTE GUIDANCE</p><h3>{destination.name} · {route.route.distanceKm} km</h3><p>{route.guidance}</p><div><span><b>{carbonEstimate.sharedTransportKgCO2e} kg</b>estimated shared transport CO₂e</span><span><b>{carbonEstimate.savedKgCO2e} kg</b>illustrative saving vs private car</span></div><p className="hint">Route source: {route.route.source}. Carbon figures are transparent planning estimates, not measured emissions.</p></section>;
}

function Tourist({ data, refresh, token }) {
  const [notice, setNotice] = useState(''); const [route, setRoute] = useState(null); const [routing, setRouting] = useState('');
  const save = async id => { const update = await request('/api/interactions', token, { method: 'POST', body: JSON.stringify({ destinationId: id, action: 'saved' }) }); setNotice(`Profile updated using ${update.history[0]} behaviour.`); refresh(); };
  const planRoute = async id => { setRouting(id); try { setRoute(await request(`/api/routes/eco?destinationId=${encodeURIComponent(id)}`, token)); } catch (reason) { setNotice(reason.message); } finally { setRouting(''); } };
  return <><section className="hero"><div><p className="eyebrow">TOURIST DASHBOARD</p><h1>Travel better.<br /><em>Leave less behind.</em></h1><p className="lead">Your interests update from observed choices, while each recommendation balances sustainability, budget, live environment and safe visitor capacity.</p></div><div className="profile"><p className="eyebrow">DYNAMIC TOURIST INTEREST PROFILE</p><h3>{data.user.name} · {data.user.home}</h3>{Object.entries(data.user.interests).sort((a, b) => b[1] - a[1]).map(([name, score]) => <div className="bar" key={name}><span>{name}</span><div><i style={{ width: `${score * 100}%` }} /></div><b>{Math.round(score * 100)}%</b></div>)}<p className="budget">Trip budget <b>{money(data.user.budget)}</b></p><p className="geo">⌖ GeoJSON `$near` query found {data.nearby.length} destinations within 1,400 km of Bengaluru.</p></div></section><Statistics metrics={data.metrics}/><DestinationSearch token={token} /><section className="section-head"><div><p className="eyebrow">HYBRID RECOMMENDATION ENGINE</p><h2>Your best sustainable matches</h2></div><span>DTIP + similarity + DTSI++ + ML crowd forecast + weather + budget</span></section>{notice && <p className="notice">{notice}</p>}<section className="cards">{data.recommendations.slice(0, 3).map((destination, index) => <article className="card" key={destination.id}><span className="badge">#{index + 1} · {destination.status}</span><div className="place">{destination.image}</div><h3>{destination.name}</h3><small>{destination.state} · {money(destination.dailyCost)}/day</small><p>{destination.description}</p><div className="score"><b>{destination.recommendationScore}</b><span>/100 MATCH</span><em>DTSI++ {destination.dtsi}</em></div><div className="chips">{destination.why.map(reason => <span key={reason}>{reason}</span>)}</div><div className="card-actions"><button onClick={() => save(destination.id)}>Save & update profile</button><button className="light" disabled={routing === destination.id} onClick={() => planRoute(destination.id)}>{routing === destination.id ? 'Planning…' : 'Plan eco route'}</button></div></article>)}</section><RoutePlan route={route} /><section className="grid-lower"><div className="panel map-panel"><p className="eyebrow">OSM CROWD-PRESSURE HEATMAP</p><h2>Destination sustainability map</h2><MapView destinations={data.destinations} route={route?.route} /></div><PressurePanel destinations={data.destinations} /></section></>;
}

function PressurePanel({ destinations }) { return <section className="panel"><p className="eyebrow">GOVERNMENT SIGNAL</p><h2>Destination pressure monitor</h2>{[...destinations].sort((a, b) => b.capacityUse - a.capacityUse).map(destination => <div className="meter-row" key={destination.id}><span>{destination.name}</span><div><i className={destination.status.replace(' ', '-').toLowerCase()} style={{ width: `${Math.min(100, destination.capacityUse)}%` }} /></div><b>{destination.capacityUse}%</b></div>)}<p className="hint">Capacity considers weather, AQI, water availability, heritage and protected-area sensitivity.</p></section>; }

function PerformanceMetrics({ performance }) {
  if (!performance) return <p className="hint">Run the benchmark from the Admin dashboard to collect local MongoDB timing evidence.</p>;
  return <div className="performance-list">{Object.entries(performance.operations).map(([name, value]) => <span key={name}><b>{value.p95Ms} ms</b>{name.replace(/([A-Z])/g, ' $1')} · p95</span>)}</div>;
}

function Government({ data, token }) {
  const [overview, setOverview] = useState(null); const [evaluation, setEvaluation] = useState(null);
  useEffect(() => { request('/api/government/overview', token).then(setOverview); request('/api/analytics/evaluation', token).then(setEvaluation); }, [token]);
  const pressure = overview?.pressure || data.destinations;
  return <><section className="hero compact"><div><p className="eyebrow">GOVERNMENT DASHBOARD</p><h1>Monitor tourism.<br /><em>Protect places.</em></h1><p className="lead">Use live environmental context, safe carrying capacity and visitor behaviour signals to guide destination policy.</p></div><div className="profile"><p className="eyebrow">POLICY DECISION SUPPORT</p><h3>Pressure alerts</h3><p className="big">{pressure.filter(item => item.status === 'High pressure').length}</p><p className="hint">destinations above adjusted safe capacity</p><p className="big">{pressure.filter(item => item.status === 'Watch').length}</p><p className="hint">destinations requiring close monitoring</p></div></section><Statistics metrics={data.metrics}/><section className="grid-lower"><PressurePanel destinations={pressure} /><section className="panel"><p className="eyebrow">MODEL EVALUATION</p><h2>Crowd & recommendation metrics</h2>{evaluation ? <><div className="metric-grid"><span><b>{evaluation.regression.rmse}</b>RMSE</span><span><b>{evaluation.regression.mae}</b>MAE</span><span><b>{evaluation.regression.r2}</b>R²</span><span><b>{evaluation.recommendation.ndcgAt3}</b>NDCG@3</span></div><p className="hint">{evaluation.algorithm}. {evaluation.dataLabel}</p></> : <p>Loading model metrics…</p>}</section></section><section className="panel"><p className="eyebrow">DATABASE & API LATENCY</p><h2>Local performance evidence</h2><PerformanceMetrics performance={evaluation?.performance} /></section><section className="panel"><p className="eyebrow">GEO-SPATIAL PRESSURE HEATMAP</p><h2>Pressure and sustainability by location</h2><MapView destinations={pressure} /></section></>;
}

function DatasetImporter({ token, onComplete }) {
  const [dataset, setDataset] = useState('tourismStatistics'); const [sourceName, setSourceName] = useState('Official dataset import'); const [sourceUrl, setSourceUrl] = useState(''); const [records, setRecords] = useState('[\n  {"destinationId":"munnar", "date":"2026-01-01", "visitors":4200}\n]'); const [message, setMessage] = useState('');
  const submit = async event => {
    event.preventDefault();
    try { const parsed = JSON.parse(records); const response = await request('/api/admin/datasets/import', token, { method: 'POST', body: JSON.stringify({ dataset, sourceName, sourceUrl, records: parsed }) }); setMessage(response.message); onComplete(); } catch (reason) { setMessage(`Import not saved: ${reason.message}`); }
  };
  return <section className="panel import-panel"><p className="eyebrow">VALIDATED DATA IMPORT</p><h2>Replace prototype data responsibly</h2><form onSubmit={submit}><div className="import-meta"><label>Dataset<select value={dataset} onChange={event => setDataset(event.target.value)}><option value="tourismStatistics">Tourism statistics</option><option value="environmentReadings">Historical environment readings</option><option value="heritageSites">UNESCO / heritage sites</option><option value="festivals">Festivals</option><option value="destinations">Destinations</option><option value="behaviour">Tourist behaviour</option></select></label><label>Source name<input value={sourceName} onChange={event => setSourceName(event.target.value)} required /></label><label>Source URL<input value={sourceUrl} onChange={event => setSourceUrl(event.target.value)} placeholder="https://…" /></label></div><label>JSON records<textarea value={records} onChange={event => setRecords(event.target.value)} spellCheck="false" /></label><button>Validate & import</button></form>{message && <p className="notice">{message}</p>}<p className="hint">The API normalises dates, coordinates and categories; rejects invalid rows; and records the source label. Use cited official data before reporting research metrics.</p></section>;
}

function Admin({ data, token, refresh }) {
  const [status, setStatus] = useState(null); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const load = () => request('/api/admin/database/status', token).then(setStatus);
  useEffect(load, [token]);
  const action = async path => { setBusy(true); try { const result = await request(path, token, { method: 'POST', body: JSON.stringify({}) }); setMessage(result.message); await Promise.all([load(), refresh()]); } catch (reason) { setMessage(reason.message); } finally { setBusy(false); } };
  const sourceEnabled = value => ['configured', 'public', 'imported', 'enabled', 'every'].some(word => String(value).includes(word));
  return <><section className="hero compact"><div><p className="eyebrow">ADMINISTRATOR DASHBOARD</p><h1>Operate clearly.<br /><em>Learn responsibly.</em></h1><p className="lead">Control data ingestion, validation, training, NoSQL collection health and research-evaluation evidence from one place.</p></div><div className="profile"><p className="eyebrow">DATA SOURCE STATUS</p>{Object.entries(data.dataSources).map(([source, state]) => <p className="source" key={source}><span className={sourceEnabled(state) ? 'on' : 'off'} />{source}<b>{state}</b></p>)}</div></section><Statistics metrics={data.metrics}/><section className="admin-actions"><button disabled={busy} onClick={() => action('/api/admin/ingestion/run')}>Refresh environment & OSM data</button><button disabled={busy} onClick={() => action('/api/admin/models/train')}>Train crowd model & evaluate</button><button disabled={busy} onClick={() => action('/api/admin/performance/run')}>Measure MongoDB latency</button></section>{message && <p className="notice">{message}</p>}<section className="grid-lower"><section className="panel"><p className="eyebrow">MONGODB COLLECTION HEALTH</p><h2>Current data store</h2><div className="collection-list">{status ? Object.entries(status.collectionCounts).map(([name, count]) => <span key={name}><b>{count}</b>{name}</span>) : 'Loading collections…'}</div><p className="hint">Geo indexes: {status?.indexes.destinations.join(', ') || '—'}<br />Time-series indexes: {status?.indexes.environmentReadings.join(', ') || '—'}<br />Last ingestion: {status?.latestIngestion?.completedAt ? new Date(status.latestIngestion.completedAt).toLocaleString() : '—'}</p></section><section className="panel"><p className="eyebrow">LATEST MODEL RUN</p><h2>Evaluation evidence</h2>{status?.latestModel ? <div className="metric-grid"><span><b>{status.latestModel.regression.rmse}</b>RMSE</span><span><b>{status.latestModel.regression.mae}</b>MAE</span><span><b>{status.latestModel.regression.r2}</b>R²</span><span><b>{status.latestModel.recommendation.precisionAt3}</b>Precision@3</span></div> : <p>Model pending</p>}<p className="hint">Prototype metrics remain explicitly labelled until official tourism statistics and relevance data are imported.</p></section></section><DatasetImporter token={token} onComplete={() => Promise.all([load(), refresh()])} /><section className="panel"><p className="eyebrow">MOBILE-READY PRESSURE HEATMAP</p><h2>OpenStreetMap and MongoDB GeoJSON</h2><MapView destinations={data.destinations} /></section></>;
}

function App() {
  const [token, setToken] = useState(localStorage.getItem('ecovoyage-token') || '');
  const [data, setData] = useState(null); const [error, setError] = useState('');
  const refresh = async () => { try { setData(await request('/api/bootstrap', token)); setError(''); } catch (reason) { setError(reason.message); setToken(''); localStorage.removeItem('ecovoyage-token'); } };
  useEffect(() => { if (token) refresh(); }, [token]);
  useEffect(() => { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js'); }, []);
  if (!token || !data) return <>{!token ? <Login onLogin={value => { localStorage.setItem('ecovoyage-token', value); setToken(value); }} /> : <main className="loading">Connecting to EcoVoyage AI…{error && <p>{error}</p>}</main>}</>;
  const signOut = () => { localStorage.removeItem('ecovoyage-token'); setToken(''); setData(null); };
  return <><Header user={data.user} signOut={signOut} /><main className="app-shell">{data.user.role === 'tourist' && <Tourist data={data} token={token} refresh={refresh} />} {data.user.role === 'government' && <Government data={data} token={token} />} {data.user.role === 'admin' && <Admin data={data} token={token} refresh={refresh} />}</main><footer>EcoVoyage AI · Express + React + MongoDB · Sustainable Tourism Decision Support</footer></>;
}

createRoot(document.getElementById('root')).render(<App />);
