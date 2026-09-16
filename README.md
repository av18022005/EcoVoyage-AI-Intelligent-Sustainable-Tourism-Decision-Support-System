# EcoVoyage AI

EcoVoyage AI is a full-stack sustainable-tourism decision-support prototype for the CSE3086 NoSQL project. It implements the Review 1 design with a React interface, Express API, MongoDB data model, role-based access, geospatial queries, time-series environmental data, crowd prediction, carrying-capacity assessment, and a hybrid recommender.

## Run the application

1. In WSL, start MongoDB:

   ```bash
   sudo service mongod start
   ```

2. In this folder, build the React client after any client-side edit:

   ```powershell
   .\node_modules\.bin\vite.cmd build
   ```

3. Start the Express server:

   ```powershell
   & "C:\Users\hp\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.js
   ```

4. Open `http://localhost:3000`.

## Demo accounts

| Role | Email | Password |
|---|---|---|
| Tourist | `tourist@ecovoyage.ai` | `Tourist@123` |
| Government | `government@ecovoyage.ai` | `Gov@123` |
| Administrator | `admin@ecovoyage.ai` | `Admin@123` |

Passwords are bcrypt-hashed before storage. JWTs expire after eight hours.

## Implemented requirements

| Review 1 component | Implementation |
|---|---|
| Tourist / Government / Admin dashboards | Role-based React views secured by JWT middleware |
| MongoDB NoSQL architecture | `users`, `destinations`, `visits`, `environmentReadings`, `festivals`, `modelRuns`, `capacityAssessments` collections |
| Document / GeoJSON data | Destination documents store GeoJSON points; `location_2dsphere` supports `$near` queries |
| Time-series environmental data | Native MongoDB time-series `environmentReadings` collection with a 30-day expiry policy |
| DTIP | Tourist actions update interest weights and append immutable visitor events |
| DTSI++ | AQI, weather, crowd, carbon and heritage weighted sustainability score |
| Crowd prediction | Random Forest Regressor with 60 bootstrapped trees, persisted evaluation evidence |
| Carrying capacity | Safe capacity recalculated from weather, air-quality and heritage-protection penalties |
| Hybrid recommender | DTIP, DTSI++, budget, weather, predicted crowd and capacity combined into a ranking |
| MongoDB aggregation | `$lookup` retrieves the most recent environmental reading for every destination |
| Maps / eco context | React Leaflet map using OpenStreetMap tiles and MongoDB GeoJSON locations |
| Performance evidence | RMSE, MAE, R², Precision@3, Recall@3 and NDCG@3 shown to Government/Admin roles |
| Mobile support | Responsive UI plus installable web-app manifest/service worker |

## Live data connectors

Copy `.env.example` to `.env`, then add your own keys:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=ecovoyage_ai
JWT_SECRET=use-a-long-random-value-here
OPENWEATHER_API_KEY=your_openweather_key
WAQI_TOKEN=your_waqi_token
INGEST_INTERVAL_MINUTES=60
USE_ATLAS_SEARCH=false
ATLAS_SEARCH_INDEX=destination-search
```

The Administrator dashboard’s **Refresh environment & OSM data** button then calls these integrations:

- **OpenWeather**: temperature and weather condition
- **WAQI**: air-quality index
- **OpenStreetMap/Overpass**: nearby tourism POI count

UNESCO heritage information, festivals and tourism statistics remain seeded in this prototype because the source datasets/API access credentials were not supplied. Seeded or fallback values are explicitly labelled in the app and database. Replace those documents with cited official exports before presenting research results as real-world findings.

## Completion additions

- **Automated ingestion:** Set `INGEST_INTERVAL_MINUTES` to `5` or greater to schedule the same validated environmental ingestion job used by the Admin dashboard. Each run is auditable in the `ingestionRuns` collection.
- **Official-data import:** The Admin dashboard accepts JSON records for destinations, tourism statistics, historical environment readings, UNESCO/heritage sites, festivals and tourist-behaviour logs. It validates fields, normalises dates/coordinates/categories, records rejected-row examples and stores provenance in `sourceRegistry`. At 30 or more imported tourism-statistic rows, training uses them instead of the synthetic demonstration history.
- **Full capacity factors:** Carrying-capacity calculations now account for weather, AQI, water availability, heritage protection and protected-area sensitivity.
- **Similarity and eco-routes:** The hybrid ranker includes transparent cosine similarity to destinations in the tourist’s history. The Tourist dashboard also provides an OSRM-based route when reachable, transparent low-carbon travel guidance and an estimated shared-transport versus private-car comparison.
- **Heatmap and latency:** Maps display crowd-pressure heat overlays. The Admin dashboard can persist local MongoDB timing results for `$near`, latest-environment `$lookup` and indexed tag filtering; Government users can view the latest latency evidence.
- **Atlas Search fallback:** With an Atlas Search index configured, text search uses `$search`; a safe indexed-field/regex fallback keeps the local MongoDB classroom demo working without Atlas.

## API endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/login` | Role-aware sign-in and JWT issuance |
| `GET /api/bootstrap` | Role dashboard data, recommendations and data-source status |
| `POST /api/interactions` | Tourist behavioural event / DTIP update |
| `GET /api/destinations/nearby` | MongoDB `$near` geospatial destinations |
| `GET /api/government/overview` | Capacity pressure and engagement analytics |
| `GET /api/analytics/evaluation` | Model / recommender evaluation metrics |
| `GET /api/admin/database/status` | Collection counts, indexes and latest model evidence |
| `POST /api/admin/environment/snapshots` | Manually insert an environmental reading |
| `POST /api/admin/ingestion/run` | Run configured OpenWeather, WAQI and OSM ingestion |
| `POST /api/admin/models/train` | Train and persist a Random Forest evaluation run |
| `GET /api/destinations/search?q=...` | Destination discovery via Atlas Search or local fallback |
| `GET /api/routes/eco?destinationId=...` | Road/fallback geometry and transparent low-impact travel guidance |
| `POST /api/admin/performance/run` | Persist local MongoDB query-latency evidence |
| `POST /api/admin/datasets/import` | Validate, normalise and import official JSON data with provenance |

## Research-data note

The currently stored historical visitor records and relevance labels are synthetic demo data. They validate the pipeline and calculation flow, but they must be replaced with a cited India tourism dataset before the evaluation scores are reported in the paper as experimental results.
