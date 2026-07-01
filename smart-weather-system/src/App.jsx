import { useState, useEffect, useCallback, useRef } from "react";
import {
  CloudSun,
  CloudRain,
  Home,
  Shirt,
  Wind,
  Thermometer,
  Droplets,
  Sun,
  Activity,
  RefreshCw,
  AlertTriangle,
  Radio,
  Maximize2,
  Minimize2,
  ShieldAlert,
  BrainCircuit,
  Sparkles,
  Globe,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

// ── Endpoint configuration ──────────────────────────────────────────────────
// Note: Hardcoded for preview compatibility. In your actual Vite project, 
// you can switch this back to: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:7071"
const API_BASE = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "http://localhost:7071";
const SENSOR_ENDPOINT = `${API_BASE}/api/GetSensorData`;
const COMMAND_ENDPOINT = `${API_BASE}/api/SendCommand`;
const POLL_INTERVAL_MS = 2_000;

// Sensor thresholds
const NO_CLOTHES_THRESHOLD = 1_000;
const DRY_WEIGHT_THRESHOLD = 50_000;
const WET_RAIN_THRESHOLD = 3_000;

export default function App() {
  // Telemetry history & connection state
  const [readings, setReadings] = useState([]);
  const [motorState, setMotorState] = useState({ clothesline: "OUTSIDE", window: "OPEN" });
  const overrideLock = useRef(false);
  const lockTimeoutRef = useRef(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [connectionError, setConnectionError] = useState(null);
  const [lastSyncedAt, setLastSyncedAt] = useState(new Date());
  const [now, setNow] = useState(new Date());

  // Command feedback tracking
  const [isSendingCommand, setIsSendingCommand] = useState(false);
  const [lastCommandStatus, setLastCommandStatus] = useState("Monitoring hardware state");

  // Tick the clock every second
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Database-First Polling Engine ──────────────────────────────────────────
  const syncReadings = useCallback(async () => {
    setIsSyncing(true);
    try {
      const res = await fetch(SENSOR_ENDPOINT);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          const clean_data = data.map((item) => {
            const rawWeight =
              item.weight !== undefined && item.weight !== null && item.weight !== 0
                ? item.weight
                : item.weight_raw !== undefined && item.weight_raw !== null
                ? item.weight_raw
                : item.weight ?? 0;
            return {
              ...item,
              time: item.time ?? "00:00",
              temp: Number(item.temp) || 0,
              humidity: Number(item.humidity) || 0,
              light: Number(item.light ?? item.light_raw) || 0,
              rain: Number(item.rain ?? item.rain_raw) || 0,
              weight: Number(rawWeight) || 0,
              decision: item.decision ?? "unknown",
              satellite_rain: Boolean(item.satellite_rain),
              system_active: typeof item.system_active === "boolean" ? item.system_active : true,
            };
          });
          const truncated_data = clean_data.slice(-20);
          setReadings(truncated_data);
          if (!overrideLock.current && truncated_data.length > 0) {
            const currentLatest = truncated_data[truncated_data.length - 1];
            setMotorState({
              clothesline:
                currentLatest.clothesline_state ??
                (currentLatest.decision === "all_safe" || currentLatest.decision === "close_window"
                  ? "OUTSIDE"
                  : "INSIDE"),
              window:
                currentLatest.window_state ??
                (currentLatest.decision === "all_safe" || currentLatest.decision === "cover_clothesline"
                  ? "OPEN"
                  : "CLOSED"),
            });
          }
          setConnectionError(null);
          setLastSyncedAt(new Date());
          setLastCommandStatus("Synchronized with cloud telemetry");
        }
      } else {
        setConnectionError(`HTTP Error ${res.status}: Unable to reach hardware SENSOR API.`);
      }
    } catch {
      setConnectionError("Hardware backend unreachable. Live telemetry offline.");
    } finally {
      setIsSyncing(false);
    }
  }, []);

  useEffect(() => {
    const initialTimer = setTimeout(syncReadings, 0);
    const id = setInterval(syncReadings, POLL_INTERVAL_MS);
    return () => {
      clearTimeout(initialTimer);
      clearInterval(id);
    };
  }, [syncReadings]);

  // ── Command Handling ────────────────────────────────────────────────────────
  // We added a "source" parameter here. Default is "web".
  const sendCommand = async (command, label, commandSource = "web") => {
    setIsSendingCommand(true);
    setLastCommandStatus(`Dispatching: ${label}…`);

    // Optimistic local UI update and temporary override lock
    overrideLock.current = true;
    if (lockTimeoutRef.current) clearTimeout(lockTimeoutRef.current);
    lockTimeoutRef.current = setTimeout(() => {
      overrideLock.current = false;
    }, 15_000);

    setMotorState((prev) => {
      switch (command) {
        case "uncover_clothesline":
          return { ...prev, clothesline: "OUTSIDE" };
        case "cover_clothesline":
          return { ...prev, clothesline: "INSIDE" };
        case "open_window":
          return { ...prev, window: "OPEN" };
        case "close_window":
          return { ...prev, window: "CLOSED" };
        case "all_safe":
          return { clothesline: "OUTSIDE", window: "OPEN" };
        case "all_protect":
          return { clothesline: "INSIDE", window: "CLOSED" };
        default:
          return prev;
      }
    });

    try {
      const res = await fetch(COMMAND_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Passing our custom source to trick the ESP32 into not pausing the AI for individual motors
        body: JSON.stringify({ command, device_id: "esp32-weather", source: commandSource }),
      });
      if (res.ok) {
        setLastCommandStatus(`Sent "${label}". Awaiting hardware response…`);
      } else {
        setLastCommandStatus(`Failed to send "${label}" (HTTP ${res.status})`);
      }
    } catch (err) {
      console.error("Command execution failure:", err);
      setLastCommandStatus(`Command "${label}" queued in offline demo mode.`);
    } finally {
      setIsSendingCommand(false);
    }
  };

  // Extract latest hardware state strictly from database
  const latest = readings.length > 0 ? readings[readings.length - 1] : undefined;

  // 3-Tier Clothes Weight Logic
  const weightValue = latest?.weight ?? 0;
  const hasClothes = weightValue > NO_CLOTHES_THRESHOLD;
  const isWet = weightValue >= DRY_WEIGHT_THRESHOLD;
  const isDry = hasClothes && !isWet;

  const isRainingLocally = latest ? latest.rain < WET_RAIN_THRESHOLD : false;
  const isRainForecast = latest ? latest.satellite_rain === true : false;

  const explainLatestDecision = () => {
    if (!latest) return "Waiting for hardware telemetry broadcast...";
    switch (latest.decision) {
      case "all_safe":
        if (!hasClothes) return "Clear skies detected. Clothesline is OUTSIDE and window is OPEN for fresh airflow.";
        if (isDry) return "Optimal drying conditions. Clothes are dry on the line outside. Window stays OPEN.";
        return "Weather is clear. Clothes drying outside. Window is OPEN.";
      case "all_protect":
        if (!hasClothes) return "Adverse weather or precipitation detected. House sealed with window CLOSED and line pulled INSIDE.";
        if (isDry) return "Rain approaching. Dry laundry pulled INSIDE safely. Window CLOSED.";
        return "Storm protection active. Clothesline retracted INSIDE and window CLOSED.";
      case "close_window":
        return "Laundry drying OUTSIDE in clear conditions, but window is CLOSED to prevent humidity ingress.";
      case "cover_clothesline":
        return "Clothesline pulled INSIDE to shield laundry from moisture. Window remains OPEN for room ventilation.";
      default:
        return `Mirroring IoT state: Clothesline is ${motorState.clothesline}, Window is ${motorState.window}.`;
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-4 md:p-8 font-sans selection:bg-indigo-500/30 transition-colors duration-300">
      {/* Non-intrusive Connection / Error Alert Banner */}
      {connectionError && (
        <div className="max-w-7xl mx-auto mb-6 p-4 rounded-2xl bg-rose-950/80 border border-rose-700/60 backdrop-blur-md flex items-center justify-between text-rose-200 shadow-xl transition-all duration-300">
          <div className="flex items-center space-x-3">
            <AlertTriangle className="w-6 h-6 text-rose-400 flex-shrink-0 animate-pulse" />
            <div>
              <p className="text-sm font-bold">Hardware Connection Interrupted</p>
              <p className="text-xs text-rose-300/90">{connectionError}</p>
            </div>
          </div>
          <button
            onClick={syncReadings}
            className="px-3.5 py-1.5 bg-rose-900/80 hover:bg-rose-800 rounded-xl text-xs font-semibold border border-rose-600/50 transition-colors"
          >
            Retry Now
          </button>
        </div>
      )}

      {/* Header / Navbar */}
      <header className="max-w-7xl mx-auto mb-8">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 p-6 rounded-2xl bg-slate-900/80 backdrop-blur-xl border border-slate-700 shadow-2xl">
          <div className="flex items-center space-x-3.5">
            <div className="p-3 bg-gradient-to-br from-sky-500 via-indigo-500 to-purple-600 rounded-2xl shadow-lg shadow-indigo-500/25">
              <Radio className="w-7 h-7 text-white animate-pulse" />
            </div>
            <div>
              <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-sky-400 via-indigo-400 to-purple-400">
                Sky Watch
              </h1>
              <p className="text-xs md:text-sm text-slate-400 font-medium flex items-center mt-0.5">
                Enterprise IoT Telemetry &amp; Autonomous Control Mirror
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center space-x-2 px-4 py-2 rounded-xl bg-slate-950/80 border border-slate-700/80 text-xs text-slate-400 shadow-inner">
              <RefreshCw className={`w-3.5 h-3.5 text-sky-400 ${isSyncing ? "animate-spin" : ""}`} />
              <span>Polling: 2s interval</span>
              <span className="text-slate-600">|</span>
              <span>Sync: {lastSyncedAt.toLocaleTimeString()}</span>
            </div>

            <div className="flex items-center space-x-2.5 px-4 py-2 rounded-xl bg-slate-950/80 border border-slate-700/80 shadow-inner">
              <div
                className={`w-2.5 h-2.5 rounded-full ${
                  connectionError
                    ? "bg-rose-500 animate-pulse"
                    : isSendingCommand
                    ? "bg-amber-400 animate-ping"
                    : "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.8)]"
                }`}
              />
              <span className="text-xs font-semibold text-slate-300 tracking-wide">
                {isSyncing ? "Syncing…" : lastCommandStatus}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Responsive Grid Layout: 3 Columns for Motors & Weather Override */}
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        
        {/* Mirror Card 1: Clothesline Status & Position */}
        <div className="rounded-2xl p-6 bg-slate-900/80 border border-slate-700 shadow-xl flex flex-col justify-between transition-all hover:border-slate-600">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2.5">
                <div className={`p-3 rounded-2xl border ${motorState.clothesline === "OUTSIDE" ? "bg-amber-500/10 text-amber-400 border-amber-500/30" : "bg-slate-800 text-slate-300 border-slate-700"}`}>
                  {motorState.clothesline === "OUTSIDE" ? <Maximize2 className="w-6 h-6" /> : <Minimize2 className="w-6 h-6" />}
                </div>
                <div>
                  <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">Clothesline Motor</h3>
                  <p className="text-2xl font-extrabold tracking-tight mt-0.5 text-slate-100">
                    {motorState.clothesline === "OUTSIDE" ? "Outside (Extended)" : "Inside (Retracted)"}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-4 p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center justify-between text-xs">
              <span className="text-slate-400 flex items-center">
                <Shirt className="w-4 h-4 mr-1.5 text-purple-400" /> Status:
              </span>
              <span className={`px-2 py-1 rounded-md font-bold border ${!hasClothes ? "bg-slate-800 text-slate-400 border-slate-700" : isDry ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : "bg-sky-500/10 text-sky-400 border-sky-500/30"}`}>
                {!hasClothes ? "Empty Line" : isDry ? "Clothes Dry" : "Clothes Wet"}
              </span>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-800 grid grid-cols-2 gap-3">
            {/* NOTE: Sent as "web_individual" so AI does NOT pause! */}
            <button
              onClick={() => sendCommand("uncover_clothesline", "Extend Clothesline", "web_individual")}
              disabled={isSendingCommand}
              className="py-3 px-3 rounded-xl bg-slate-950/90 hover:bg-slate-800 border border-slate-700 hover:border-slate-600 text-xs font-semibold text-slate-200 transition-all flex items-center justify-center space-x-2 active:scale-95 disabled:opacity-50"
            >
              <Maximize2 className="w-4 h-4 text-amber-400" />
              <span>Extend</span>
            </button>
            <button
              onClick={() => sendCommand("cover_clothesline", "Retract Clothesline", "web_individual")}
              disabled={isSendingCommand}
              className="py-3 px-3 rounded-xl bg-slate-950/90 hover:bg-slate-800 border border-slate-700 hover:border-slate-600 text-xs font-semibold text-slate-200 transition-all flex items-center justify-center space-x-2 active:scale-95 disabled:opacity-50"
            >
              <Minimize2 className="w-4 h-4 text-slate-400" />
              <span>Retract</span>
            </button>
          </div>
        </div>

        {/* Mirror Card 2: Motorized Window Status */}
        <div className="rounded-2xl p-6 bg-slate-900/80 border border-slate-700 shadow-xl flex flex-col justify-between transition-all hover:border-slate-600">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2.5">
                <div className={`p-3 rounded-2xl border ${motorState.window === "OPEN" ? "bg-teal-500/10 text-teal-400 border-teal-500/30" : "bg-indigo-500/10 text-indigo-400 border-indigo-500/30"}`}>
                  <Home className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">Actuated Window</h3>
                  <p className="text-2xl font-extrabold tracking-tight mt-0.5 text-slate-100">
                    {motorState.window === "OPEN" ? "Open (Ventilating)" : "Closed (Sealed)"}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-4 p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center justify-between text-xs">
              <span className="text-slate-400 flex items-center">
                <Activity className="w-4 h-4 mr-1.5 text-teal-400" /> System Mode:
              </span>
              <span className={`font-semibold ${latest?.system_active ? "text-purple-400" : "text-amber-400"}`}>
                {latest?.system_active ? "AI Autonomous Active" : "Manual Override"}
              </span>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-800 grid grid-cols-2 gap-3">
            {/* NOTE: Sent as "web_individual" so AI does NOT pause! */}
            <button
              onClick={() => sendCommand("open_window", "Open Window", "web_individual")}
              disabled={isSendingCommand}
              className="py-3 px-3 rounded-xl bg-slate-950/90 hover:bg-slate-800 border border-slate-700 hover:border-slate-600 text-xs font-semibold text-slate-200 transition-all flex items-center justify-center space-x-2 active:scale-95 disabled:opacity-50"
            >
              <Wind className="w-4 h-4 text-teal-400" />
              <span>Open (0°)</span>
            </button>
            <button
              onClick={() => sendCommand("close_window", "Close Window", "web_individual")}
              disabled={isSendingCommand}
              className="py-3 px-3 rounded-xl bg-slate-950/90 hover:bg-slate-800 border border-slate-700 hover:border-slate-600 text-xs font-semibold text-slate-200 transition-all flex items-center justify-center space-x-2 active:scale-95 disabled:opacity-50"
            >
              <Home className="w-4 h-4 text-indigo-400" />
              <span>Close (90°)</span>
            </button>
          </div>
        </div>

        {/* Mirror Card 3: Weather & Master Override */}
        <div className="rounded-2xl p-6 bg-slate-900/80 border border-slate-700 shadow-xl flex flex-col justify-between transition-all hover:border-slate-600">
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center space-x-2.5">
                <div className={`p-3 rounded-2xl border ${isRainingLocally ? "bg-blue-500/10 text-blue-400 border-blue-500/30" : "bg-amber-500/10 text-amber-400 border-amber-500/30"}`}>
                  {isRainingLocally ? <CloudRain className="w-6 h-6" /> : <Sun className="w-6 h-6" />}
                </div>
                <div>
                  <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">Weather Status</h3>
                  <p className={`text-2xl font-extrabold tracking-tight mt-0.5 ${isRainingLocally ? "text-blue-400" : "text-amber-400"}`}>
                    {isRainingLocally ? "Raining Locally" : "Clear Skies"}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-4 p-3.5 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center justify-between text-xs">
              <span className="text-slate-400 flex items-center">
                <Globe className="w-4 h-4 mr-1.5 text-indigo-400" /> Satellite Radar:
              </span>
              <span className={`font-semibold ${isRainForecast ? "text-rose-400" : "text-emerald-400"}`}>
                {isRainForecast ? "Storm Approaching" : "No Rain Expected"}
              </span>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-800 space-y-3">
            {/* NOTE: Sent as "web" - This will RESUME the AI and open everything */}
            <button
              onClick={() => sendCommand("all_safe", "Force everything open", "web")}
              disabled={isSendingCommand}
              className="w-full flex items-center justify-center space-x-2 p-3 bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white rounded-xl transition-all font-bold shadow-lg shadow-emerald-600/25 active:scale-95 disabled:opacity-50"
            >
              <Sun className="w-4 h-4" />
              <span>Force All OPEN (Resume AI)</span>
            </button>
            {/* NOTE: Sent as "web" - This will PAUSE the AI and close everything */}
            <button
              onClick={() => sendCommand("all_protect", "Force everything closed", "web")}
              disabled={isSendingCommand}
              className="w-full flex items-center justify-center space-x-2 p-3 bg-gradient-to-r from-rose-600 to-red-500 hover:from-rose-500 hover:to-red-400 text-white rounded-xl transition-all font-bold shadow-lg shadow-rose-600/25 active:scale-95 disabled:opacity-50"
            >
              <ShieldAlert className="w-4 h-4" />
              <span>Force All CLOSED (Pause AI)</span>
            </button>
          </div>
        </div>

      </div>

      {/* Live Hardware Telemetry Grid */}
      <section className="max-w-7xl mx-auto mb-8">
        <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 mb-3 px-1">IoT Telemetry Feed</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-slate-900/70 border border-slate-700 rounded-2xl p-4 flex items-center justify-between shadow-lg">
            <div className="flex items-center space-x-3">
              <div className="p-2.5 bg-rose-500/10 rounded-xl border border-rose-500/20 text-rose-400">
                <Thermometer className="w-5 h-5" />
              </div>
              <div>
                <span className="text-xs font-semibold text-slate-400">Ambient Temp</span>
                <div className="text-lg font-mono font-extrabold text-slate-100">{latest ? `${latest.temp} °C` : "--"}</div>
              </div>
            </div>
          </div>

          <div className="bg-slate-900/70 border border-slate-700 rounded-2xl p-4 flex items-center justify-between shadow-lg">
            <div className="flex items-center space-x-3">
              <div className="p-2.5 bg-sky-500/10 rounded-xl border border-sky-500/20 text-sky-400">
                <Droplets className="w-5 h-5" />
              </div>
              <div>
                <span className="text-xs font-semibold text-slate-400">Relative Humidity</span>
                <div className="text-lg font-mono font-extrabold text-slate-100">{latest ? `${latest.humidity} %` : "--"}</div>
              </div>
            </div>
          </div>

          <div className="bg-slate-900/70 border border-slate-700 rounded-2xl p-4 flex items-center justify-between shadow-lg">
            <div className="flex items-center space-x-3">
              <div className="p-2.5 bg-amber-500/10 rounded-xl border border-amber-500/20 text-amber-400">
                <CloudSun className="w-5 h-5" />
              </div>
              <div>
                <span className="text-xs font-semibold text-slate-400">Solar Intensity</span>
                <div className="text-lg font-mono font-extrabold text-slate-100">{latest ? `${latest.light} ADC` : "--"}</div>
              </div>
            </div>
          </div>

          <div className="bg-slate-900/70 border border-slate-700 rounded-2xl p-4 flex items-center justify-between shadow-lg">
            <div className="flex items-center space-x-3">
              <div className="p-2.5 bg-purple-500/10 rounded-xl border border-purple-500/20 text-purple-400">
                <Shirt className="w-5 h-5" />
              </div>
              <div>
                <span className="text-xs font-semibold text-slate-400">Clothes Weight</span>
                <div className="text-lg font-mono font-extrabold text-slate-100">{latest ? `${latest.weight} ADC` : "--"}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Autonomous Decision Explanation & Satellite Radar Banner */}
      <section className="max-w-7xl mx-auto mb-8">
        <div className="rounded-2xl p-6 md:p-8 bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800/90 border border-slate-700 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-sky-400 via-indigo-500 to-purple-500" />

          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 mb-6">
            <div className="flex items-center space-x-3.5">
              <div className="p-3 bg-purple-500/10 border border-purple-500/30 rounded-2xl">
                <BrainCircuit className="w-8 h-8 text-purple-400" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <h2 className="text-xl md:text-2xl font-bold tracking-tight text-white">AI Control Engine Mirror</h2>
                  <span className={`px-2.5 py-0.5 text-xs font-bold rounded-full border ${latest?.system_active !== false ? "bg-purple-500/20 text-purple-300 border-purple-500/30" : "bg-amber-500/20 text-amber-300 border-amber-500/30"}`}>
                    {latest?.system_active !== false ? "Autonomous" : "Manual Override"}
                  </span>
                </div>
                <p className="text-sm text-slate-400 mt-0.5">Real-time interpretation of Azure cloud decision logic</p>
              </div>
            </div>

            <div className={`flex items-center space-x-3 px-5 py-3 rounded-2xl border ${isRainForecast ? "bg-rose-500/10 border-rose-500/30 text-rose-400" : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"}`}>
              <Globe className="w-6 h-6 flex-shrink-0" />
              <div>
                <p className="text-[10px] uppercase tracking-wider font-bold opacity-75">Satellite Radar Feed</p>
                <p className="text-base font-extrabold">{isRainForecast ? "Storm System Approaching" : "Clear Skies Broadcast"}</p>
              </div>
            </div>
          </div>

          <div className="rounded-xl p-5 bg-slate-950/80 border border-slate-800 flex items-start space-x-4">
            <Sparkles className="w-6 h-6 text-emerald-400 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-emerald-400 mb-1">State Explanation</h4>
              <p className="text-sm md:text-base font-medium text-slate-200 leading-relaxed italic">{explainLatestDecision()}</p>
            </div>
          </div>
        </div>
      </section>

      {/* Historical Telemetry Charts */}
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6 mb-12">
        <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-700 shadow-xl">
          <h3 className="text-base font-bold text-slate-200 mb-4 flex items-center">
            <Thermometer className="w-5 h-5 mr-2 text-rose-400" /> Temperature &amp; Humidity Trends
          </h3>
          <div className="h-64 w-full">
            {readings.length === 0 ? (
              <div className="h-full w-full flex flex-col items-center justify-center space-y-3 bg-slate-950/50 rounded-xl border border-slate-800/80 text-slate-400">
                <RefreshCw className="w-6 h-6 animate-spin text-sky-400" />
                <span className="text-xs font-semibold tracking-wider uppercase">Loading Live Telemetry...</span>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={readings} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="time" stroke="#64748b" tick={{ fill: "#94a3b8", fontSize: 12 }} />
                  <YAxis yAxisId="left" stroke="#fb7185" orientation="left" tick={{ fill: "#94a3b8", fontSize: 12 }} />
                  <YAxis yAxisId="right" stroke="#38bdf8" orientation="right" tick={{ fill: "#94a3b8", fontSize: 12 }} />
                  <Tooltip contentStyle={{ backgroundColor: "#0f172a", borderColor: "#334155", borderRadius: "12px", color: "#f8fafc" }} />
                  <Legend />
                  <Line yAxisId="left" type="monotone" dataKey="temp" name="Temp (°C)" stroke="#fb7185" strokeWidth={3} dot={{ r: 3 }} />
                  <Line yAxisId="right" type="monotone" dataKey="humidity" name="Humidity (%)" stroke="#38bdf8" strokeWidth={3} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-700 shadow-xl">
          <h3 className="text-base font-bold text-slate-200 mb-4 flex items-center">
            <Sun className="w-5 h-5 mr-2 text-amber-400" /> Sunlight &amp; Precipitation ADC Trends
          </h3>
          <div className="h-64 w-full">
            {readings.length === 0 ? (
              <div className="h-full w-full flex flex-col items-center justify-center space-y-3 bg-slate-950/50 rounded-xl border border-slate-800/80 text-slate-400">
                <RefreshCw className="w-6 h-6 animate-spin text-amber-400" />
                <span className="text-xs font-semibold tracking-wider uppercase">Loading Live Telemetry...</span>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={readings} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                  <XAxis dataKey="time" stroke="#64748b" tick={{ fill: "#94a3b8", fontSize: 12 }} />
                  <YAxis stroke="#64748b" domain={[0, 4500]} tick={{ fill: "#94a3b8", fontSize: 12 }} />
                  <Tooltip contentStyle={{ backgroundColor: "#0f172a", borderColor: "#334155", borderRadius: "12px", color: "#f8fafc" }} />
                  <Legend />
                  <Line type="stepAfter" dataKey="light" name="Sunlight ADC" stroke="#fbbf24" strokeWidth={3} dot={false} />
                  <Line type="stepAfter" dataKey="rain" name="Rain ADC (Drops when wet)" stroke="#818cf8" strokeWidth={3} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="max-w-7xl mx-auto text-center pb-8 border-t border-slate-800 pt-6">
        <p className="text-xs text-slate-500">
          <span className="font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-sky-400 via-indigo-400 to-purple-400">Sky Watch</span>{" "}
          &bull; Strictly Reactive Database Mirror &bull; 2000ms Polling Engine &bull; Local Time:{" "}
          <span className="font-mono font-bold text-slate-400">{now.toLocaleTimeString()}</span>
        </p>
      </footer>
    </div>
  );
}