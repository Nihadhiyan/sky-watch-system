# SkyWatch — Smart Weather Guard System

An IoT weather-guard system that automatically protects laundry (clothesline) and windows from rain and darkness. An ESP32 device reports live sensor telemetry, an Azure Functions "cloud brain" makes protection decisions (combining on-device sensors with satellite weather forecasts), and a React dashboard lets you monitor and manually override the system in real time.

## How It Works

```
ESP32 (sensors: rain, light, weight, temp, humidity)
        │  telemetry
        ▼
Azure Event Hub (uok-weather-hub)
        │
        ▼
Azure Function: WeatherDecisionEngine
  ├─ fetches satellite forecast (OpenWeatherMap)
  ├─ combines sensor state + forecast → decision
  ├─ sends Cloud-to-Device (C2D) command via Azure IoT Hub
  └─ logs reading + decision to Azure Table Storage
        │
        ▼
Azure Function: GetSensorData / SendCommand (HTTP, anonymous)
        │
        ▼
React Dashboard (smart-weather-system)
  - polls GetSensorData every 2s, charts recent history
  - manual override buttons call SendCommand directly (AI-pause semantics)
```

**Decision logic** (in `WeatherDecisionEngine`): if it's raining now or rain is forecast soon, protect both the clothesline and the window. Otherwise, if it's dark, close the window and bring in the clothesline only if it's dry. During the day with no rain, bring in the clothesline only if it's dry; leave the window open. This yields one of four states: `all_protect`, `cover_clothesline`, `close_window`, or `all_safe`.

## Repository Structure

```
sky-watch-system/
├── SmartCanopyCloud/          # Azure Functions backend (Python)
│   ├── function_app.py         # Event Hub trigger + HTTP endpoints
│   ├── requirements.txt
│   └── host.json
├── smart-weather-system/      # React dashboard (Vite)
│   ├── src/App.jsx              # Main dashboard UI, polling, charts, overrides
│   └── package.json
└── .github/workflows/         # CI/CD — deploys backend to Azure on push to main
```

## Backend — `SmartCanopyCloud`

Python Azure Functions app (Functions v2 programming model).

**Dependencies:** `azure-functions`, `azure-iot-hub`, `azure-data-tables`, `requests`

### Functions

| Function | Trigger | Purpose |
|---|---|---|
| `WeatherDecisionEngine` | Event Hub (`uok-weather-hub`) | Consumes ESP32 telemetry, fetches weather, computes a decision, sends a C2D command to the device (only when the decision changes, to avoid spamming the ESP32), and logs the reading to Table Storage (`SensorData` table) |
| `GetSensorData` | HTTP (anonymous) | Returns the most recent 15 readings from Table Storage as JSON, for the dashboard to poll |
| `SendCommand` | HTTP (anonymous) | Accepts `{ command, device_id, source }` and forwards it to the device as a manual/web-sourced C2D command |

### Required environment variables / app settings

| Variable | Purpose |
|---|---|
| `IOT_HUB_CONNECTION_STRING` | Azure IoT Hub connection string, used to send C2D commands to the ESP32 |
| `AzureWebJobsStorage` | Storage account connection string backing Table Storage (`SensorData` table) and the Functions runtime |
| `EVENT_HUB_CONNECTION_STRING` | Connection string for the Event Hub trigger (`uok-weather-hub`) |
| `OPENWEATHER_API_KEY` | OpenWeatherMap API key used to fetch the satellite forecast (lat/lon currently hardcoded) |

### Running locally

```bash
cd SmartCanopyCloud
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# populate local.settings.json with the variables above (not committed)
func start
```

Deployment is automated via `.github/workflows/main_skywatch-backend-2026.yml`, which deploys this folder to an Azure Function App whenever files under `SmartCanopyCloud/` change on `main`.

## Frontend — `smart-weather-system`

React 19 + Vite dashboard styled with Tailwind CSS v4, charts via Recharts, icons via Lucide.

### Setup

```bash
cd smart-weather-system
npm install
npm run dev
```

### Configuration

The API base URL is read from `VITE_API_BASE_URL` (falling back to `http://localhost:7071` for local `func start` defaults):

```bash
# .env
VITE_API_BASE_URL=https://<your-function-app>.azurewebsites.net
```

The dashboard calls two endpoints off that base:
- `GET /api/GetSensorData` — polled every 2 seconds to update live readings and charts
- `POST /api/SendCommand` — used by the manual override controls (force-close window / cover clothesline / resume AI control)

### Key behaviors

- **Live polling**: readings refresh every 2 seconds; connection errors are surfaced in the UI.
- **Manual override**: operators can force clothesline/window state directly; overrides briefly lock out AI-driven commands to prevent the backend from immediately reversing a manual action.
- **Charts**: recent temperature, humidity, light, rain, and weight history are plotted with Recharts.

## Scripts

| Location | Command | Purpose |
|---|---|---|
| `smart-weather-system` | `npm run dev` | Start Vite dev server |
| `smart-weather-system` | `npm run build` | Production build |
| `smart-weather-system` | `npm run lint` | Run ESLint |
| `SmartCanopyCloud` | `func start` | Run Azure Functions locally |
