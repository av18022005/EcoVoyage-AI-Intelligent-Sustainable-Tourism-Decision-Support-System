require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient } = require('mongodb');
const { round, predictModel, trainCrowdModel, capacityAssessment } = require('./lib/analytics');

const ROOT = __dirname;
const SEED = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed.json'), 'utf8'));
const PORT = process.env.PORT || 3000;
const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.MONGODB_DB || 'ecovoyage_ai';
const JWT_SECRET = process.env.JWT_SECRET || 'local-demo-only-change-before-deployment';
const INGEST_INTERVAL_MINUTES = Number(process.env.INGEST_INTERVAL_MINUTES || 0);
const USE_ATLAS_SEARCH = process.env.USE_ATLAS_SEARCH === 'true';
const ATLAS_SEARCH_INDEX = process.env.ATLAS_SEARCH_INDEX || 'destination-search';
const MAX_IMPORT_RECORDS = 5000;
const app = express();
let db;

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store' });
  next();
});
app.use(express.json({ limit: '2mb' }));

const accountSeeds = [
  ['u-tourist', 'Aarav Sharma', 'tourist@ecovoyage.ai', 'Tourist@123', 'tourist'],
  ['u-government', 'Nandini Rao', 'government@ecovoyage.ai', 'Gov@123', 'government'],
  ['u-admin', 'System Administrator', 'admin@ecovoyage.ai', 'Admin@123', 'admin']
];
const touristHome = { type: 'Point', coordinates: [77.5946, 12.9716] };
const festivalSeeds = [
  { destinationId: 'hampi', name: 'Hampi Utsav', month: 11, expectedInflow: 2100, source: 'seeded-demo' },
  { destinationId: 'rishikesh', name: 'International Yoga Festival', month: 3, expectedInflow: 3400, source: 'seeded-demo' },
  { destinationId: 'kaziranga', name: 'Wildlife Tourism Season', month: 1, expectedInflow: 1500, source: 'seeded-demo' }
];

function auth(...roles) {
  return async (req, res, next) => {
    try {
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const payload = jwt.verify(token, JWT_SECRET);
      const user = await db.collection('users').findOne({ id: payload.sub });
      if (!user || (roles.length && !roles.includes(user.role))) return res.status(403).json({ error: 'You do not have permission for this action.' });
      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: 'Please sign in again.' });
    }
  };
}

function cleanUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, home: user.home, homeLocation: user.homeLocation, budget: user.budget, interests: user.interests || {}, history: user.history || [] };
}

const clamp = (value, min = 0, max = 100) => {
  const numeric = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(numeric) ? numeric : min));
};
const average = values => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const slug = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const safeText = value => String(value || '').trim().slice(0, 160);

function cosine(left, right) {
  const dot = left.reduce((sum, value, index) => sum + value * right[index], 0);
  const leftLength = Math.sqrt(left.reduce((sum, value) => sum + value ** 2, 0));
  const rightLength = Math.sqrt(right.reduce((sum, value) => sum + value ** 2, 0));
  return leftLength && rightLength ? dot / (leftLength * rightLength) : 0;
}

function destinationVector(destination, tags) {
  return [
    ...tags.map(tag => destination.tags?.includes(tag) ? 1 : 0),
    clamp(destination.dailyCost, 0, 12000) / 12000,
    1 - clamp(destination.carbon) / 100,
    clamp(destination.heritage) / 100,
    clamp(destination.accessibility ?? 70) / 100,
    clamp(destination.waterAvailability ?? 75) / 100
  ];
}

function similarityFor(user, candidate, destinations) {
  const history = destinations.filter(destination => (user.history || []).includes(destination.name) && destination.id !== candidate.id);
  if (!history.length) return { score: 50, basis: 'new explorer profile' };
  const tags = [...new Set(destinations.flatMap(destination => destination.tags || []))].sort();
  const candidateVector = destinationVector(candidate, tags);
  const profileVector = candidateVector.map((_, index) => average(history.map(destination => destinationVector(destination, tags)[index])));
  const nearest = [...history].sort((left, right) => cosine(candidateVector, destinationVector(right, tags)) - cosine(candidateVector, destinationVector(left, tags)))[0];
  return { score: round(Math.max(0, cosine(candidateVector, profileVector)) * 100), basis: `similar to ${nearest.name}` };
}

function dtsi(destination) {
  const air = Math.max(0, 100 - destination.aqi);
  const weather = destination.weather === 'pleasant' ? 92 : destination.weather === 'warm' ? 70 : 64;
  const crowd = Math.max(0, 100 - destination.crowd / destination.capacity * 100);
  const carbon = Math.max(0, 100 - destination.carbon * 1.6);
  return round(air * .25 + weather * .15 + crowd * .28 + carbon * .17 + destination.heritage * .15);
}

function defaultPrediction(destination) {
  const weatherFactor = destination.weather === 'pleasant' ? 1.12 : .97;
  return destination.crowd * (1 - destination.rainRisk / 500) * weatherFactor;
}

function featureRow(destination, snapshot, festivals) {
  const now = new Date();
  return {
    baseCrowd: destination.crowd,
    temperature: snapshot.temperature ?? destination.temperature,
    rainRisk: snapshot.rainRisk ?? destination.rainRisk,
    aqi: snapshot.aqi ?? destination.aqi,
    festival: festivals.some(festival => festival.destinationId === destination.id && festival.month === now.getMonth() + 1),
    weekend: [0, 6].includes(now.getDay()),
    month: now.getMonth() + 1
  };
}

function destinationView(destination, model, festivals) {
  const snapshot = destination.latestEnvironment || {};
  const hydrated = { ...destination, ...snapshot };
  const prediction = model?.forest || model?.weights ? predictModel(model, featureRow(hydrated, snapshot, festivals)) : defaultPrediction(hydrated);
  const capacity = capacityAssessment(hydrated, prediction);
  return { ...hydrated, dtsi: dtsi({ ...hydrated, crowd: prediction }), predictedCrowd: capacity.predictedCrowd, capacityUse: capacity.utilisation, capacity, status: capacity.status };
}

function recommend(user, destinations) {
  return destinations.map(destination => {
    const interest = destination.tags.reduce((sum, tag) => sum + (user.interests?.[tag] || 0), 0) / destination.tags.length * 100;
    const budgetFit = destination.dailyCost <= user.budget ? 100 : Math.max(0, 100 - (destination.dailyCost - user.budget) / user.budget * 100);
    const weatherFit = destination.weather === 'pleasant' ? 100 : destination.weather === 'warm' ? 70 : 58;
    const capacityFit = Math.max(0, 100 - destination.capacityUse);
    const similarity = similarityFor(user, destination, destinations);
    const recommendationScore = round(interest * .33 + destination.dtsi * .27 + budgetFit * .12 + weatherFit * .10 + capacityFit * .08 + similarity.score * .10);
    return { ...destination, similarity, recommendationScore, why: [`${Math.round(interest)}% DTIP interest match`, `${similarity.score}% ${similarity.basis}`, `DTSI++ ${destination.dtsi}/100`, `${destination.capacityUse}% safe capacity use`] };
  }).sort((left, right) => right.recommendationScore - left.recommendationScore);
}

async function latestDestinations() {
  return db.collection('destinations').aggregate([
    { $lookup: { from: 'environmentReadings', let: { destinationId: '$id' }, pipeline: [ { $match: { $expr: { $eq: ['$meta.destinationId', '$$destinationId'] } } }, { $sort: { recordedAt: -1 } }, { $limit: 1 }, { $project: { _id: 0, meta: 0 } } ], as: 'environment' } },
    { $set: { latestEnvironment: { $ifNull: [{ $arrayElemAt: ['$environment', 0] }, {}] } } },
    { $unset: 'environment' }
  ]).toArray();
}

async function databaseSummary() {
  const names = ['users', 'destinations', 'heritageSites', 'visits', 'environmentReadings', 'festivals', 'tourismStatistics', 'modelRuns', 'capacityAssessments', 'ingestionRuns', 'performanceRuns', 'sourceRegistry'];
  const collectionCounts = Object.fromEntries(await Promise.all(names.map(async name => [name, await db.collection(name).countDocuments()])));
  const [latestRun, latestReading, visitSummary, latestPerformance, latestIngestion] = await Promise.all([
    db.collection('modelRuns').find().sort({ trainedAt: -1 }).limit(1).next(),
    db.collection('environmentReadings').find().sort({ recordedAt: -1 }).limit(1).next(),
    db.collection('visits').aggregate([{ $group: { _id: '$destinationId', actions: { $sum: 1 } } }, { $sort: { actions: -1 } }, { $limit: 5 }]).toArray(),
    db.collection('performanceRuns').find().sort({ recordedAt: -1 }).limit(1).next(),
    db.collection('ingestionRuns').find().sort({ completedAt: -1 }).limit(1).next()
  ]);
  return {
    collectionCounts,
    latestModel: latestRun ? { algorithm: latestRun.algorithm, trainedAt: latestRun.trainedAt, regression: latestRun.regression, recommendation: latestRun.recommendation, dataLabel: latestRun.dataLabel } : null,
    latestReadingAt: latestReading?.recordedAt || null,
    latestPerformance: latestPerformance ? { recordedAt: latestPerformance.recordedAt, operations: latestPerformance.operations, environment: latestPerformance.environment } : null,
    latestIngestion: latestIngestion ? { trigger: latestIngestion.trigger, completedAt: latestIngestion.completedAt, recordsWritten: latestIngestion.recordsWritten, liveRecords: latestIngestion.liveRecords } : null,
    visitSummary
  };
}

async function nearbyDestinations(point) {
  if (!point) return [];
  return db.collection('destinations').find({ location: { $near: { $geometry: point, $maxDistance: 1400000 } } }).limit(3).toArray();
}

async function getModel() { return db.collection('modelRuns').find().sort({ trainedAt: -1 }).limit(1).next(); }

async function runModelTraining() {
  const [destinations, statistics, festivals] = await Promise.all([db.collection('destinations').find().toArray(), db.collection('tourismStatistics').find().toArray(), db.collection('festivals').find().toArray()]);
  const byDestination = Object.fromEntries(destinations.map(destination => [destination.id, destination]));
  const history = statistics.map(record => {
    const destination = byDestination[record.destinationId];
    const reportedAt = new Date(record.reportedAt);
    if (!destination || Number.isNaN(reportedAt.getTime())) return null;
    return {
      destinationId: destination.id, baseCrowd: destination.crowd, temperature: destination.temperature, rainRisk: destination.rainRisk, aqi: destination.aqi,
      festival: festivals.some(festival => festival.destinationId === destination.id && festival.month === reportedAt.getMonth() + 1),
      weekend: [0, 6].includes(reportedAt.getDay()), month: reportedAt.getMonth() + 1, actualCrowd: record.visitors,
      dataLabel: 'imported tourism statistic'
    };
  }).filter(Boolean);
  const run = trainCrowdModel(destinations, history);
  run.trainingData = { importedRowsAvailable: history.length, source: history.length >= 30 ? 'tourismStatistics collection' : 'synthetic fallback until at least 30 imported records are available' };
  await db.collection('modelRuns').insertOne(run);
  return run;
}

async function syncAssessments(destinations, model, festivals) {
  const records = destinations.map(destination => {
    const view = destinationView(destination, model, festivals);
    return { destinationId: view.id, assessment: view.capacity, dtsi: view.dtsi, createdAt: new Date(), dataLabel: model?.dataLabel || 'heuristic fallback' };
  });
  if (records.length) await db.collection('capacityAssessments').insertMany(records);
}

async function fetchLiveData(destination) {
  const point = destination.location.coordinates;
  const result = { destinationId: destination.id, source: [], aqi: destination.aqi, weather: destination.weather, temperature: destination.temperature, rainRisk: destination.rainRisk, poiCount: null, live: false, notes: [] };
  if (process.env.OPENWEATHER_API_KEY) {
    const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${point[1]}&lon=${point[0]}&appid=${process.env.OPENWEATHER_API_KEY}&units=metric`);
    if (!response.ok) throw new Error(`OpenWeather returned ${response.status}`);
    const weather = await response.json();
    result.temperature = weather.main.temp;
    result.rainRisk = Math.min(100, Math.round((weather.clouds?.all || 0) * .65 + (weather.rain ? 35 : 0)));
    result.weather = weather.weather?.[0]?.main?.toLowerCase().includes('clear') ? 'pleasant' : weather.main.temp > 29 ? 'warm' : 'humid';
    result.source.push('OpenWeather'); result.live = true;
  } else result.notes.push('OpenWeather key not configured; seeded weather retained.');
  if (process.env.WAQI_TOKEN) {
    const response = await fetch(`https://api.waqi.info/feed/geo:${point[1]};${point[0]}/?token=${process.env.WAQI_TOKEN}`);
    if (!response.ok) throw new Error(`WAQI returned ${response.status}`);
    const aqi = await response.json();
    if (aqi.status === 'ok') { result.aqi = Number(aqi.data.aqi); result.source.push('WAQI'); result.live = true; }
  } else result.notes.push('WAQI token not configured; seeded AQI retained.');
  try {
    const query = `[out:json][timeout:20];(nwr["tourism"](around:10000,${point[1]},${point[0]}););out center;`;
    const response = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: query });
    if (response.ok) { const osm = await response.json(); result.poiCount = osm.elements?.length || 0; result.source.push('OpenStreetMap'); result.live = true; }
  } catch { result.notes.push('OSM collector unavailable; no POI count refreshed.'); }
  return result;
}

async function ingestEnvironment(destinationIds) {
  const destinations = await db.collection('destinations').find(destinationIds?.length ? { id: { $in: destinationIds } } : {}).toArray();
  const readings = [];
  for (const destination of destinations) {
    try {
      const live = await fetchLiveData(destination);
      readings.push({ meta: { destinationId: destination.id, source: live.source.length ? live.source.join(', ') : 'seeded-fallback' }, aqi: live.aqi, weather: live.weather, temperature: live.temperature, rainRisk: live.rainRisk, poiCount: live.poiCount, isLive: live.live, notes: live.notes, recordedAt: new Date() });
    } catch (error) {
      readings.push({ meta: { destinationId: destination.id, source: 'seeded-fallback' }, aqi: destination.aqi, weather: destination.weather, temperature: destination.temperature, rainRisk: destination.rainRisk, poiCount: null, isLive: false, notes: [error.message], recordedAt: new Date() });
    }
  }
  if (readings.length) await db.collection('environmentReadings').insertMany(readings);
  return readings;
}

async function runIngestionJob(trigger = 'manual', destinationIds) {
  const startedAt = new Date();
  try {
    const readings = await ingestEnvironment(destinationIds);
    const run = {
      trigger,
      startedAt,
      completedAt: new Date(),
      recordsWritten: readings.length,
      liveRecords: readings.filter(reading => reading.isLive).length,
      sources: [...new Set(readings.flatMap(reading => reading.meta.source.split(', ')))],
      status: 'completed'
    };
    await db.collection('ingestionRuns').insertOne(run);
    return { readings, run };
  } catch (error) {
    await db.collection('ingestionRuns').insertOne({ trigger, startedAt, completedAt: new Date(), recordsWritten: 0, liveRecords: 0, status: 'failed', error: error.message });
    throw error;
  }
}

function latencySummary(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return { samples: sorted.length, averageMs: round(average(sorted), 2), p95Ms: round(sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] || 0, 2), minMs: round(sorted[0] || 0, 2), maxMs: round(sorted.at(-1) || 0, 2) };
}

async function timed(operation) {
  const started = process.hrtime.bigint();
  await operation();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

async function runPerformanceEvaluation() {
  const samples = { geoNear: [], latestEnvironmentLookup: [], destinationFilter: [] };
  for (let iteration = 0; iteration < 12; iteration += 1) {
    samples.geoNear.push(await timed(() => nearbyDestinations(touristHome)));
    samples.latestEnvironmentLookup.push(await timed(() => latestDestinations()));
    samples.destinationFilter.push(await timed(() => db.collection('destinations').find({ tags: 'nature' }).limit(10).toArray()));
  }
  const run = {
    recordedAt: new Date(),
    operations: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, latencySummary(values)])),
    environment: { database: DB_NAME, host: process.platform, samplesPerOperation: 12, dataLabel: 'local development benchmark; rerun in the target deployment environment' }
  };
  await db.collection('performanceRuns').insertOne(run);
  return run;
}

function normaliseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normaliseTags(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(values.map(item => slug(item)).filter(Boolean))].slice(0, 12);
}

function normaliseDatasetRecord(dataset, raw, index) {
  const record = raw && typeof raw === 'object' ? raw : {};
  const sourceRow = index + 1;
  if (dataset === 'destinations') {
    const latitude = Number(record.latitude ?? record.lat ?? record.location?.coordinates?.[1]);
    const longitude = Number(record.longitude ?? record.lng ?? record.location?.coordinates?.[0]);
    const name = safeText(record.name);
    if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return { error: `Row ${sourceRow}: destination requires a name and valid latitude/longitude.` };
    return {
      value: {
        id: slug(record.id || name), name, state: safeText(record.state || record.region || 'Unspecified'),
        location: { type: 'Point', coordinates: [longitude, latitude] }, tags: normaliseTags(record.tags),
        dailyCost: clamp(record.dailyCost ?? record.cost ?? 0, 0, 100000), aqi: clamp(record.aqi ?? 50, 0, 500), weather: safeText(record.weather || 'unknown').toLowerCase(),
        temperature: clamp(record.temperature ?? 25, -30, 60), rainRisk: clamp(record.rainRisk ?? 0), crowd: clamp(record.crowd ?? 0, 0, 10000000), capacity: clamp(record.capacity ?? 0, 0, 10000000),
        carbon: clamp(record.carbon ?? 50), heritage: clamp(record.heritage ?? 0), waterAvailability: clamp(record.waterAvailability ?? 75), protectedAreaSensitivity: clamp(record.protectedAreaSensitivity ?? record.protectedArea ?? 50),
        accessibility: clamp(record.accessibility ?? 70), image: safeText(record.image || '📍'), description: safeText(record.description || 'Imported destination record.'), dataLabel: 'external-import'
      }
    };
  }
  if (dataset === 'tourismStatistics') {
    const destinationId = slug(record.destinationId || record.destination || record.place);
    const reportedAt = normaliseDate(record.reportedAt || record.date || record.period);
    const visitors = Number(record.visitors ?? record.arrivals ?? record.count);
    if (!destinationId || !reportedAt || !Number.isFinite(visitors) || visitors < 0) return { error: `Row ${sourceRow}: tourism statistics require destinationId, date and non-negative visitors.` };
    return { value: { destinationId, reportedAt, visitors: Math.round(visitors), domesticVisitors: Number.isFinite(Number(record.domesticVisitors)) ? Math.round(Number(record.domesticVisitors)) : null, foreignVisitors: Number.isFinite(Number(record.foreignVisitors)) ? Math.round(Number(record.foreignVisitors)) : null, sourcePeriod: safeText(record.sourcePeriod || ''), dataLabel: 'external-import' } };
  }
  if (dataset === 'festivals') {
    const destinationId = slug(record.destinationId || record.destination || record.place);
    const month = Number(record.month || (normaliseDate(record.date)?.getMonth() + 1));
    if (!destinationId || !Number.isInteger(month) || month < 1 || month > 12 || !safeText(record.name)) return { error: `Row ${sourceRow}: festival requires destinationId, name and month/date.` };
    return { value: { destinationId, name: safeText(record.name), month, expectedInflow: Math.round(clamp(record.expectedInflow ?? record.visitors ?? 0, 0, 10000000)), source: 'external-import', dataLabel: 'external-import' } };
  }
  if (dataset === 'heritageSites') {
    const destinationId = slug(record.destinationId || record.destination || record.place);
    const latitude = Number(record.latitude ?? record.lat ?? record.location?.coordinates?.[1]);
    const longitude = Number(record.longitude ?? record.lng ?? record.location?.coordinates?.[0]);
    const name = safeText(record.name || record.site);
    if (!destinationId || !name || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return { error: `Row ${sourceRow}: heritage record requires destinationId, name and valid latitude/longitude.` };
    return { value: { id: slug(record.id || `${destinationId}-${name}`), destinationId, name, category: safeText(record.category || 'heritage'), location: { type: 'Point', coordinates: [longitude, latitude] }, protectionLevel: clamp(record.protectionLevel ?? record.heritageScore ?? 75), dataLabel: 'external-import' } };
  }
  if (dataset === 'environmentReadings') {
    const destinationId = slug(record.destinationId || record.destination || record.place);
    const recordedAt = normaliseDate(record.recordedAt || record.date);
    const aqi = Number(record.aqi); const temperature = Number(record.temperature); const rainRisk = Number(record.rainRisk);
    if (!destinationId || !recordedAt || !Number.isFinite(aqi) || !Number.isFinite(temperature) || !Number.isFinite(rainRisk) || !safeText(record.weather)) return { error: `Row ${sourceRow}: environment record requires destinationId, date, AQI, temperature, rainRisk and weather.` };
    return { value: { meta: { destinationId, source: 'external-import' }, aqi: clamp(aqi, 0, 500), weather: safeText(record.weather).toLowerCase(), temperature: clamp(temperature, -30, 60), rainRisk: clamp(rainRisk), poiCount: Number.isFinite(Number(record.poiCount)) ? Math.round(Math.max(0, Number(record.poiCount))) : null, isLive: false, notes: ['Imported historical environmental reading'], recordedAt, dataLabel: 'external-import' } };
  }
  if (dataset === 'behaviour') {
    const userId = safeText(record.userId || record.user);
    const destinationId = slug(record.destinationId || record.destination || record.place);
    const at = normaliseDate(record.at || record.date || new Date());
    if (!userId || !destinationId || !at) return { error: `Row ${sourceRow}: behaviour requires userId, destinationId and date.` };
    return { value: { userId, destinationId, action: safeText(record.action || 'visited'), rating: Number.isFinite(Number(record.rating)) ? clamp(record.rating, 1, 5) : null, durationNights: Number.isFinite(Number(record.durationNights)) ? clamp(record.durationNights, 0, 90) : null, tripBudget: Number.isFinite(Number(record.tripBudget)) ? clamp(record.tripBudget, 0, 1000000) : null, season: safeText(record.season || ''), at, source: 'external-import', dataLabel: 'external-import' } };
  }
  return { error: `Unsupported dataset: ${dataset}.` };
}

async function importDataset({ dataset, records, sourceName, sourceUrl }) {
  const supported = ['destinations', 'tourismStatistics', 'festivals', 'heritageSites', 'environmentReadings', 'behaviour'];
  if (!supported.includes(dataset)) throw new Error('Choose destinations, tourismStatistics, festivals, heritageSites, environmentReadings or behaviour.');
  if (!Array.isArray(records) || !records.length || records.length > MAX_IMPORT_RECORDS) throw new Error(`Provide 1 to ${MAX_IMPORT_RECORDS} JSON records.`);
  const accepted = []; const rejected = [];
  records.forEach((record, index) => {
    const normalised = normaliseDatasetRecord(dataset, record, index);
    if (normalised.error) rejected.push(normalised.error); else accepted.push(normalised.value);
  });
  if (!accepted.length) throw new Error(`No records passed validation. ${rejected.slice(0, 3).join(' ')}`);
  const importedAt = new Date();
  accepted.forEach(record => { record.importedAt = importedAt; record.source = record.source || safeText(sourceName || 'administrator-import'); record.sourceUrl = safeText(sourceUrl || ''); });
  if (dataset === 'destinations') await db.collection('destinations').bulkWrite(accepted.map(record => ({ updateOne: { filter: { id: record.id }, update: { $set: record }, upsert: true } })));
  else if (dataset === 'heritageSites') {
    await db.collection('heritageSites').bulkWrite(accepted.map(record => ({ updateOne: { filter: { id: record.id }, update: { $set: record }, upsert: true } })));
    await db.collection('destinations').bulkWrite(accepted.map(record => ({ updateOne: { filter: { id: record.destinationId }, update: { $set: { heritage: record.protectionLevel, heritageCategory: record.category, heritageSource: sourceName || 'external-import' } } } })));
  } else await db.collection(dataset === 'behaviour' ? 'visits' : dataset).insertMany(accepted);
  const registryKey = dataset === 'heritageSites' ? 'unesco' : dataset;
  await db.collection('sourceRegistry').updateOne({ key: registryKey }, { $set: { key: registryKey, label: sourceName || dataset, sourceUrl: sourceUrl || '', lastImportedAt: importedAt, recordsAccepted: accepted.length, recordsRejected: rejected.length, status: 'imported' } }, { upsert: true });
  return { dataset, accepted: accepted.length, rejected: rejected.length, examples: rejected.slice(0, 5) };
}

async function dataSourceStatus() {
  const imported = await db.collection('sourceRegistry').find().toArray();
  const byKey = Object.fromEntries(imported.map(record => [record.key, record]));
  const state = key => byKey[key]?.lastImportedAt ? `imported ${new Date(byKey[key].lastImportedAt).toLocaleDateString('en-IN')}` : 'awaiting official import';
  return {
    OpenWeather: process.env.OPENWEATHER_API_KEY ? 'configured' : 'needs API key', WAQI: process.env.WAQI_TOKEN ? 'configured' : 'needs API key', OpenStreetMap: 'public connector',
    UNESCO: state('unesco'), festivals: state('festivals'), tourismStatistics: state('tourismStatistics'), touristBehaviour: state('behaviour'), historicalEnvironment: state('environmentReadings'), scheduler: INGEST_INTERVAL_MINUTES > 0 ? `every ${INGEST_INTERVAL_MINUTES} min` : 'manual only', atlasSearch: USE_ATLAS_SEARCH ? 'enabled' : 'MongoDB fallback search'
  };
}

function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function searchDestinations(query) {
  const text = safeText(query);
  if (!text) return { provider: 'fallback', results: [] };
  if (USE_ATLAS_SEARCH) {
    try {
      const results = await db.collection('destinations').aggregate([{ $search: { index: ATLAS_SEARCH_INDEX, text: { query: text, path: ['name', 'state', 'tags', 'description'] } } }, { $limit: 8 }, { $project: { _id: 0 } }]).toArray();
      return { provider: 'MongoDB Atlas Search', results };
    } catch { /* Local MongoDB and unconfigured Atlas indexes use the safe fallback below. */ }
  }
  const pattern = new RegExp(escapeRegex(text), 'i');
  return { provider: 'MongoDB field-search fallback', results: await db.collection('destinations').find({ $or: [{ name: pattern }, { state: pattern }, { tags: pattern }, { description: pattern }] }).limit(8).toArray() };
}

function haversineKm(left, right) {
  const radians = degrees => degrees * Math.PI / 180;
  const [lng1, lat1] = left; const [lng2, lat2] = right;
  const a = Math.sin(radians(lat2 - lat1) / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(radians(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function ecoRoute(origin, destination) {
  const [fromLng, fromLat] = origin; const [toLng, toLat] = destination;
  const straightLineKm = haversineKm(origin, destination);
  const fallback = { geometry: { type: 'LineString', coordinates: [origin, destination] }, distanceKm: round(straightLineKm, 1), durationMinutes: null, source: 'great-circle fallback' };
  try {
    const response = await fetch(`https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return fallback;
    const route = (await response.json()).routes?.[0];
    if (!route?.geometry) return fallback;
    return { geometry: route.geometry, distanceKm: round(route.distance / 1000, 1), durationMinutes: Math.round(route.duration / 60), source: 'OSRM road route' };
  } catch { return fallback; }
}

function startIngestionScheduler() {
  if (!Number.isFinite(INGEST_INTERVAL_MINUTES) || INGEST_INTERVAL_MINUTES < 5) return;
  const timer = setInterval(() => runIngestionJob('scheduled').catch(error => console.error('Scheduled ingestion failed:', error.message)), INGEST_INTERVAL_MINUTES * 60 * 1000);
  timer.unref();
  console.log(`Environmental ingestion scheduled every ${INGEST_INTERVAL_MINUTES} minutes.`);
}

app.post('/api/auth/login', async (req, res) => {
  const { email, password, role } = req.body || {};
  const user = await db.collection('users').findOne({ email: String(email || '').toLowerCase(), role });
  if (!user || !await bcrypt.compare(password || '', user.passwordHash)) return res.status(401).json({ error: 'Incorrect email, password or selected role.' });
  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: cleanUser(user) });
});

app.get('/api/auth/me', auth(), (req, res) => res.json({ user: cleanUser(req.user) }));

app.get('/api/bootstrap', auth(), async (req, res) => {
  const [rawDestinations, model, festivals, database, nearbyRaw, dataSources] = await Promise.all([latestDestinations(), getModel(), db.collection('festivals').find().toArray(), databaseSummary(), nearbyDestinations(req.user.homeLocation), dataSourceStatus()]);
  const destinations = rawDestinations.map(destination => destinationView(destination, model, festivals));
  const nearbyIds = new Set(nearbyRaw.map(destination => destination.id));
  const nearby = destinations.filter(destination => nearbyIds.has(destination.id));
  await syncAssessments(rawDestinations, model, festivals);
  const metrics = { destinations: destinations.length, healthy: destinations.filter(destination => destination.status === 'Healthy').length, averageDtsi: round(destinations.reduce((sum, destination) => sum + destination.dtsi, 0) / Math.max(1, destinations.length)), visitors: destinations.reduce((sum, destination) => sum + destination.predictedCrowd, 0) };
  res.json({ user: cleanUser(req.user), recommendations: req.user.role === 'tourist' ? recommend(req.user, destinations) : [], destinations, nearby, metrics, database, dataSources });
});

app.get('/api/destinations/nearby', auth(), async (req, res) => {
  const lng = Number(req.query.lng); const lat = Number(req.query.lat);
  const centre = Number.isFinite(lng) && Number.isFinite(lat) ? { type: 'Point', coordinates: [lng, lat] } : req.user.homeLocation;
  if (!centre) return res.status(400).json({ error: 'Provide longitude and latitude.' });
  const [destinations, model, festivals] = await Promise.all([nearbyDestinations(centre), getModel(), db.collection('festivals').find().toArray()]);
  res.json({ centre, results: destinations.map(destination => destinationView(destination, model, festivals)) });
});

app.get('/api/destinations/search', auth(), async (req, res) => {
  const search = await searchDestinations(req.query.q);
  const [model, festivals] = await Promise.all([getModel(), db.collection('festivals').find().toArray()]);
  res.json({ provider: search.provider, results: search.results.map(destination => destinationView(destination, model, festivals)) });
});

app.get('/api/routes/eco', auth(), async (req, res) => {
  const destination = await db.collection('destinations').findOne({ id: String(req.query.destinationId || '') });
  if (!destination) return res.status(404).json({ error: 'Destination not found.' });
  if (!req.user.homeLocation?.coordinates) return res.status(400).json({ error: 'The user profile needs a GeoJSON home location for route planning.' });
  const route = await ecoRoute(req.user.homeLocation.coordinates, destination.location.coordinates);
  const sharedTransportCarbonKg = round(route.distanceKm * .041, 1);
  const privateCarCarbonKg = round(route.distanceKm * .171, 1);
  res.json({ destination: { id: destination.id, name: destination.name }, route, carbonEstimate: { sharedTransportKgCO2e: sharedTransportCarbonKg, privateCarKgCO2e: privateCarCarbonKg, savedKgCO2e: round(Math.max(0, privateCarCarbonKg - sharedTransportCarbonKg), 1), method: 'distance × standard illustrative passenger-km factors; confirm local transport emissions before research reporting' }, guidance: route.distanceKm > 450 ? 'Prefer rail or shared inter-city transport, then local public or pooled mobility.' : 'Prefer bus, rail, cycling or shared mobility where practical; avoid a single-occupancy car trip.' });
});

app.post('/api/interactions', auth('tourist'), async (req, res) => {
  const { destinationId, action = 'saved', rating, durationNights, tripBudget, season } = req.body || {};
  const destination = await db.collection('destinations').findOne({ id: destinationId });
  if (!destination) return res.status(404).json({ error: 'Destination not found.' });
  const interests = { ...(req.user.interests || {}) };
  const actionWeight = action === 'visited' ? .12 : action === 'rated' ? .09 : .06;
  const ratingWeight = Number.isFinite(Number(rating)) ? Math.max(.35, Math.min(1.15, Number(rating) / 5)) : 1;
  destination.tags.forEach(tag => interests[tag] = round(Math.min(1, (interests[tag] || 0) + actionWeight * ratingWeight), 2));
  const history = [destination.name, ...(req.user.history || [])].slice(0, 25);
  await Promise.all([
    db.collection('users').updateOne({ id: req.user.id }, { $set: { interests, history } }),
    db.collection('visits').insertOne({ userId: req.user.id, destinationId: destination.id, action: safeText(action || 'saved'), rating: Number.isFinite(Number(rating)) ? clamp(rating, 1, 5) : null, durationNights: Number.isFinite(Number(durationNights)) ? clamp(durationNights, 0, 90) : null, tripBudget: Number.isFinite(Number(tripBudget)) ? clamp(tripBudget, 0, 1000000) : null, season: safeText(season || ''), at: new Date(), source: 'web-dashboard' })
  ]);
  res.status(201).json({ message: 'DTIP profile updated from observed behaviour.', interests, history });
});

app.get('/api/government/overview', auth('government', 'admin'), async (req, res) => {
  const [destinations, model, festivals, visitSummary] = await Promise.all([
    latestDestinations(),
    getModel(),
    db.collection('festivals').find().toArray(),
    db.collection('visits').aggregate([{ $group: { _id: '$destinationId', saved: { $sum: 1 }, averageRating: { $avg: '$rating' } } }]).toArray()
  ]);
  const activity = Object.fromEntries(visitSummary.map(row => [row._id, row]));
  const pressure = destinations.map(destination => ({ ...destinationView(destination, model, festivals), engagement: activity[destination.id] || { saved: 0, averageRating: null } })).sort((left, right) => right.capacityUse - left.capacityUse);
  res.json({ pressure, methodology: 'Safe capacity adjusts base capacity for weather, air quality, water availability, heritage and protected-area sensitivity.' });
});

app.get('/api/analytics/evaluation', auth('government', 'admin'), async (req, res) => {
  const run = await getModel();
  if (!run) return res.status(404).json({ error: 'No training run exists.' });
  const latestPerformance = await db.collection('performanceRuns').find().sort({ recordedAt: -1 }).limit(1).next();
  res.json({ algorithm: run.algorithm, trainedAt: run.trainedAt, trainingRows: run.trainingRows, testRows: run.testRows, regression: run.regression, recommendation: run.recommendation, dataLabel: run.dataLabel, performance: latestPerformance ? { recordedAt: latestPerformance.recordedAt, operations: latestPerformance.operations, environment: latestPerformance.environment } : null });
});

app.get('/api/admin/database/status', auth('admin'), async (req, res) => {
  const [summary, destinationIndexes, readingIndexes] = await Promise.all([databaseSummary(), db.collection('destinations').indexes(), db.collection('environmentReadings').indexes()]);
  res.json({ ...summary, indexes: { destinations: destinationIndexes.map(index => index.name), environmentReadings: readingIndexes.map(index => index.name) } });
});

app.post('/api/admin/environment/snapshots', auth('admin'), async (req, res) => {
  const { destinationId, aqi, weather, temperature, rainRisk, source = 'admin-manual' } = req.body || {};
  if (!destinationId || !Number.isFinite(aqi) || !weather || !Number.isFinite(temperature) || !Number.isFinite(rainRisk)) return res.status(400).json({ error: 'destinationId, aqi, weather, temperature and rainRisk are required.' });
  if (!await db.collection('destinations').findOne({ id: destinationId })) return res.status(404).json({ error: 'Destination not found.' });
  const reading = { meta: { destinationId, source }, aqi, weather, temperature, rainRisk, isLive: false, notes: ['Manual administrator entry'], recordedAt: new Date() };
  await db.collection('environmentReadings').insertOne(reading);
  res.status(201).json({ message: 'Environmental reading stored in the MongoDB time-series collection.', reading });
});

app.post('/api/admin/ingestion/run', auth('admin'), async (req, res) => {
  const { readings, run } = await runIngestionJob('manual', req.body?.destinationIds);
  res.status(201).json({ message: 'Data ingestion completed.', run, readings: readings.map(reading => ({ destinationId: reading.meta.destinationId, source: reading.meta.source, isLive: reading.isLive, notes: reading.notes })) });
});

app.post('/api/admin/models/train', auth('admin'), async (req, res) => res.status(201).json({ message: 'Crowd model trained and stored in MongoDB.', run: await runModelTraining() }));
app.post('/api/admin/performance/run', auth('admin'), async (req, res) => res.status(201).json({ message: 'MongoDB query performance evaluation completed.', run: await runPerformanceEvaluation() }));
app.post('/api/admin/datasets/import', auth('admin'), async (req, res) => {
  try {
    const result = await importDataset(req.body || {});
    res.status(201).json({ message: `${result.accepted} ${result.dataset} records imported after validation.`, result });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.use(express.static(path.join(ROOT, 'dist'), { index: 'index.html' }));
app.get('*splat', (req, res) => res.sendFile(path.join(ROOT, 'dist', 'index.html')));

async function initialise() {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect(); db = client.db(DB_NAME);
  await db.collection('destinations').createIndex({ location: '2dsphere' });
  await db.collection('destinations').createIndex({ tags: 1 });
  await db.collection('heritageSites').createIndex({ location: '2dsphere' });
  await db.collection('heritageSites').createIndex({ destinationId: 1 });
  await db.collection('visits').createIndex({ userId: 1, at: -1 });
  await db.collection('tourismStatistics').createIndex({ destinationId: 1, reportedAt: -1 });
  await db.collection('festivals').createIndex({ destinationId: 1, month: 1 });
  await db.collection('modelRuns').createIndex({ trainedAt: -1 });
  await db.collection('capacityAssessments').createIndex({ destinationId: 1, createdAt: -1 });
  await db.collection('ingestionRuns').createIndex({ completedAt: -1 });
  await db.collection('performanceRuns').createIndex({ recordedAt: -1 });
  const collections = await db.listCollections({ name: 'environmentReadings' }).toArray();
  if (!collections.length) await db.createCollection('environmentReadings', { timeseries: { timeField: 'recordedAt', metaField: 'meta', granularity: 'hours' }, expireAfterSeconds: 2592000 });
  if (!await db.collection('destinations').countDocuments()) await db.collection('destinations').insertMany(SEED.destinations);
  for (const destination of SEED.destinations) {
    await db.collection('destinations').updateOne({ id: destination.id }, [{ $set: {
      waterAvailability: { $ifNull: ['$waterAvailability', destination.waterAvailability] },
      protectedAreaSensitivity: { $ifNull: ['$protectedAreaSensitivity', destination.protectedAreaSensitivity] },
      accessibility: { $ifNull: ['$accessibility', destination.accessibility] }
    } }]);
  }
  if (!await db.collection('festivals').countDocuments()) await db.collection('festivals').insertMany(festivalSeeds);
  await db.collection('sourceRegistry').bulkWrite([
    { updateOne: { filter: { key: 'unesco' }, update: { $setOnInsert: { key: 'unesco', label: 'UNESCO World Heritage data', sourceUrl: 'https://whc.unesco.org/en/list/', status: 'awaiting official import' } }, upsert: true } },
    { updateOne: { filter: { key: 'festivals' }, update: { $setOnInsert: { key: 'festivals', label: 'Festival dataset', sourceUrl: '', status: 'seeded-demo' } }, upsert: true } },
    { updateOne: { filter: { key: 'tourismStatistics' }, update: { $setOnInsert: { key: 'tourismStatistics', label: 'India tourism statistics', sourceUrl: 'https://www.data.gov.in/', status: 'awaiting official import' } }, upsert: true } },
    { updateOne: { filter: { key: 'behaviour' }, update: { $setOnInsert: { key: 'behaviour', label: 'Tourist behaviour logs', sourceUrl: '', status: 'demo-and-import' } }, upsert: true } }
  ]);
  for (const [id, name, email, password, role] of accountSeeds) {
    await db.collection('users').updateOne({ id }, { $set: { id, name, email, passwordHash: await bcrypt.hash(password, 12), role, home: role === 'tourist' ? 'Bengaluru' : 'India', homeLocation: role === 'tourist' ? touristHome : null, budget: 9000, interests: role === 'tourist' ? SEED.users[0].interests : {}, history: role === 'tourist' ? SEED.users[0].history : [] } }, { upsert: true });
  }
  if (!await db.collection('environmentReadings').countDocuments()) await runIngestionJob('initial-seed');
  if (!await db.collection('modelRuns').countDocuments()) await runModelTraining();
  if (!await db.collection('performanceRuns').countDocuments()) await runPerformanceEvaluation();
  app.listen(PORT, () => {
    console.log(`EcoVoyage AI is running at http://localhost:${PORT} with MongoDB database ${DB_NAME}`);
    startIngestionScheduler();
  });
}

initialise().catch(error => { console.error('Startup failed:', error); process.exit(1); });
