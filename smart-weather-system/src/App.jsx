import { useState, useEffect, useCallback, useRef } from "react";
import {
  Shirt,
  CloudRain,
  Maximize2,
  Minimize2,
  Sun,
  Moon,
  ShieldAlert,
  Thermometer,
  Activity,
  Globe,
  Home,
  BrainCircuit,
  Wind,
  Droplets,
  RefreshCw,
  Sparkles,
  AlertTriangle,
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

// Realistic fallback telemetry data used if the live Azure Function is unreachable
const FALLBACK_READINGS = [
  { time: "11:00", temp: 28.5, humidity: 64, light: 3200, rain: 4095, weight: 48000, satellite_rain: false, decision: "all_safe", system_active: true },
  { time: "11:10", temp: 29.2, humidity: 65, light: 3400, rain: 4095, weight: 47500, satellite_rain: false, decision: "all_safe", system_active: true },
  { time: "11:20", temp: 30.0, humidity: 66, light: 3500, rain: 4095, weight: 47000, satellite_rain: false, decision: "all_safe", system_active: true },
  { time: "11:30", temp: 30.8, humidity: 68, light: 3600, rain: 4095, weight: 46500, satellite_rain: false, decision: "all_safe", system_active: true },
  { time: "11:40", temp: 30.5, humidity: 72, light: 1200, rain: 4095, weight: 46500, satellite_rain: true, decision: "cover_clothesline", system_active: true },
  { time: "11:50", temp: 27.5, humidity: 85, light: 300, rain: 2100, weight: 52000, satellite_rain: true, decision: "all_protect", system_active: true },
];

// ── Endpoint configuration ──────────────────────────────────────────────────
// Set VITE_API_BASE_URL in your .env file to point at Azure:
//   VITE_API_BASE_URL=https://uok-weather-brain.azurewebsites.net
const API_BASE =
  import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ??
  "http://localhost:7071";
const SENSOR_ENDPOINT = `${API_BASE}/api/GetSensorData`;
const COMMAND_ENDPOINT = `${API_BASE}/api/SendCommand`;
const POLL_INTERVAL_MS = 5_000;

// Sensor thresholds
const NO_CLOTHES_THRESHOLD = 1_000;
const DRY_WEIGHT_THRESHOLD = 50_000;
const WET_RAIN_THRESHOLD = 3_000;

export default function App() {
  const [readings, setReadings] = useState(FALLBACK_READINGS);
  const [systemActive, setSystemActive] = useState(true);
  const [motorState, setMotorState] = useState({ clothesline: "INSIDE", window: "CLOSED" });
  const overrideLock = useRef(false);

  const [statusMessage, setStatusMessage] = useState("System ready and monitoring");
  const [isCloudError, setIsCloudError] = useState(false);
  const [isSendingCommand, setIsSendingCommand] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState(new Date());
  const [now, setNow] = useState(new Date());
  const [theme, setTheme] = useState("dark");
  const isDark = theme === "dark";

  // Tick the footer clock once a second.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Polling engine: fetch latest telemetry every 5s
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
              temp: Number(item.temp ?? 0),
              humidity: Number(item.humidity ?? 0),
              light: Number(item.light ?? item.light_raw ?? 0),
              rain: Number(item.rain ?? item.rain_raw ?? 0),
              weight: Number(rawWeight),
              decision: item.decision ?? "unknown",
              satellite_rain: Boolean(item.satellite_rain),
              system_active: typeof item.system_active === "boolean" ? item.system_active : true,
            };
          });
          setReadings(clean_data);

          // 15-Second Lock Guard: When active, block syncReadings from overriding manual motor/system state
          if (!overrideLock.current) {
            const latest = clean_data[clean_data.length - 1];
            const activeFlag = typeof latest.system_active === "boolean" ? latest.system_active : true;
            setSystemActive(activeFlag);

            if (activeFlag) {
              const shouldOut = latest.decision === "all_safe" || latest.decision === "close_window";
              const shouldOpen = latest.decision === "all_safe" || latest.decision === "cover_clothesline";
              setMotorState({
                clothesline: shouldOut ? "OUTSIDE" : "INSIDE",
                window: shouldOpen ? "OPEN" : "CLOSED",
              });
            }
          }
          setIsCloudError(false);
          setLastSyncedAt(new Date());
          setStatusMessage("Live telemetry synced");
        }
      } else {
        console.warn(`Backend responded with HTTP ${res.status}`);
        setIsCloudError(true);
        setStatusMessage("Connecting to Cloud…");
      }
    } catch (err) {
      console.warn(`Couldn't reach ${SENSOR_ENDPOINT}, staying on local fallback data.`, err);
      setIsCloudError(true);
      setStatusMessage("Connecting to Cloud…");
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

  // ── Manual Command Handler with 15-Second Override Lock ─────────────────────
  const sendCommand = async (command, label) => {
    setIsSendingCommand(true);
    setStatusMessage(`Sending command: ${label}…`);

    // Engage 15-second override lock immediately to block background sync overwrites
    overrideLock.current = true;
    setTimeout(() => {
      overrideLock.current = false;
    }, 15000);

    // Individual Motor & System State Logic
    if (command === "all_safe") {
      setSystemActive(true); // Force Everything Open resumes AI control
      setMotorState({ clothesline: "OUTSIDE", window: "OPEN" });
    } else if (command === "all_protect") {
      setSystemActive(false); // Force Everything Closed pauses AI control
      setMotorState({ clothesline: "INSIDE", window: "CLOSED" });
    } else if (command === "uncover_clothesline") {
      setMotorState((prev) => ({ ...prev, clothesline: "OUTSIDE" }));
    } else if (command === "cover_clothesline") {
      setMotorState((prev) => ({ ...prev, clothesline: "INSIDE" }));
    } else if (command === "open_window") {
      setMotorState((prev) => ({ ...prev, window: "OPEN" }));
    } else if (command === "close_window") {
      setMotorState((prev) => ({ ...prev, window: "CLOSED" }));
    }

    try {
      const res = await fetch(COMMAND_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, device_id: "esp32-weather", source: "web" }),
      });
      setStatusMessage(res.ok ? `${label} sent` : "Command failed — is the Function app running?");
    } catch (err) {
      console.error("Command error:", err);
      setStatusMessage(`Offline demo mode — pretending to run "${label}"`);
    } finally {
      setIsSendingCommand(false);
    }
  };

  const latest = readings.length > 0 ? readings[readings.length - 1] : undefined;

  // ── 3-tier clothes weight logic ────────────────────────────────────────────
  const weightValue = latest ? latest.weight : 0;
  const hasClothes = weightValue > NO_CLOTHES_THRESHOLD;
  const isWet = weightValue >= DRY_WEIGHT_THRESHOLD;
  const isDry = hasClothes && !isWet;

  const isRainingLocally = latest ? latest.rain < WET_RAIN_THRESHOLD : false;
  const isRainForecast = latest ? latest.satellite_rain === true : false;

  const explainLatestDecision = () => {
    if (!latest) return "Waiting on the first sensor reading before deciding anything...";
    switch (latest.decision) {
      case "all_safe":
        if (!hasClothes) return "The weather is clear — beautiful day outside! The clothesline is OUTSIDE and window is OPEN for fresh air.";
        if (isDry) return "The weather's clear and your clothes are drying nicely! Clothesline stays OUTSIDE, window stays OPEN.";
        return "The weather is clear — great time to dry those clothes! Clothesline is OUTSIDE and window is OPEN.";
      case "all_protect":
        if (!hasClothes) return "Rain or rough conditions detected — closed the window to protect the house. Clothesline is INSIDE (nothing on it anyway).";
        if (isDry) return "Rain approaching — your clothes are already dry so I pulled them INSIDE. Window is CLOSED to protect the house.";
        return "Rain or rough conditions detected — I've pulled the clothesline INSIDE and closed the window to keep everything protected.";
      case "close_window":
        if (!hasClothes) return "The clothesline is OUTSIDE (empty), window is CLOSED to keep out drafts and moisture.";
        if (isDry) return "Clothes are dry and OUTSIDE. Window is CLOSED to stop moisture getting in — perfect conditions.";
        return "Your clothes are still OUTSIDE drying, but I closed the window to keep drafts and moisture out.";
      case "cover_clothesline":
        if (!hasClothes) return "Brought the clothesline INSIDE as a precaution (nothing on it). Window is OPEN for airflow.";
        if (isDry) return "Your laundry's already dry — brought the clothesline INSIDE to keep it safe. Window stays OPEN for airflow.";
        return "I brought the clothesline INSIDE to keep your clothes from getting soaked, but left the window OPEN for airflow.";
      default:
        if (isRainingLocally) return "Rain on the rooftop sensor — defenses are up to protect the laundry and the house.";
        if (isRainForecast) return "Satellite radar shows rain moving in. Getting ahead of it.";
        return `Monitoring as usual: clothesline is ${motorState.clothesline}, window is ${motorState.window}.`;
    }
  };

  // --- Theme tokens -------------------------------------------------------
  const t = {
    wrapper: isDark
      ? "min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 font-sans selection:bg-emerald-500/30 transition-colors duration-300"
      : "min-h-screen bg-gradient-to-br from-slate-100 via-sky-50/50 to-slate-200 text-slate-800 p-4 md:p-8 font-sans selection:bg-emerald-500/30 transition-colors duration-300",
    navbar: isDark
      ? "bg-slate-900/60 backdrop-blur-xl border-slate-800/80 shadow-2xl"
      : "bg-white/80 backdrop-blur-xl border-slate-200/80 shadow-xl shadow-slate-200/50",
    navTitle: isDark ? "from-sky-400 via-indigo-400 to-purple-400" : "from-sky-600 via-indigo-600 to-purple-600",
    navSub: isDark ? "text-slate-400" : "text-slate-600 font-medium",
    badge: isDark ? "bg-slate-950/80 border-slate-800 text-slate-400" : "bg-slate-100/90 border-slate-200/80 text-slate-600 shadow-sm",
    refreshBtn: isDark ? "text-slate-300 hover:text-white" : "text-slate-700 hover:text-slate-950 font-medium",
    statusPill: isDark
      ? "bg-slate-950/80 border-slate-800 shadow-inner text-slate-300"
      : "bg-slate-100/90 border-slate-200/80 shadow-sm text-slate-700",
    sectionHeading: isDark ? "text-slate-500" : "text-slate-500 font-bold",
    card: isDark
      ? "bg-slate-900/70 backdrop-blur-md border-slate-800/80 shadow-xl hover:border-slate-700"
      : "bg-white/85 backdrop-blur-md border-slate-200/80 shadow-lg shadow-slate-200/40 hover:border-slate-300",
    cardHeader: isDark ? "text-slate-400" : "text-slate-600 font-bold",
    cardSub: isDark ? "text-slate-500" : "text-slate-500 font-medium",
    telemetryCard: isDark
      ? "bg-slate-900/60 backdrop-blur-md border border-slate-800/70 rounded-2xl p-4 flex items-center justify-between shadow-lg hover:border-slate-700/80 transition-all"
      : "bg-white/75 backdrop-blur-md border border-slate-200/80 rounded-2xl p-4 flex items-center justify-between shadow-sm hover:border-slate-300 transition-all",
    telemetryLabel: isDark ? "text-xs font-semibold text-slate-400" : "text-xs font-bold text-slate-500",
    telemetryValue: isDark ? "text-base md:text-lg font-mono font-extrabold text-slate-200" : "text-base md:text-lg font-mono font-extrabold text-slate-800",
    aiBanner: isDark
      ? "bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800/90 border-slate-700/80 shadow-2xl"
      : "bg-gradient-to-br from-white via-slate-50 to-blue-50/50 border-slate-200/80 shadow-xl shadow-slate-200/50",
    aiTitle: isDark ? "text-white" : "text-slate-900",
    aiSub: isDark ? "text-slate-400" : "text-slate-600",
    aiCallout: isDark ? "bg-slate-950/70 border-slate-800 text-slate-100 shadow-inner" : "bg-white/95 border-slate-200/80 text-slate-800 shadow-sm",
    aiCodeBadge: isDark ? "bg-slate-900 border-slate-800 text-slate-400" : "bg-slate-100 border-slate-200 text-slate-700 font-medium",
    chartTitle: isDark ? "text-white" : "text-slate-900",
    chartSub: isDark ? "text-slate-400" : "text-slate-500 font-medium",
    chartGrid: isDark ? "#1e293b" : "#cbd5e1",
    chartAxis: isDark ? "#94a3b8" : "#475569",
    chartTooltipBg: isDark ? "#0f172a" : "#ffffff",
    chartTooltipBorder: isDark ? "#334155" : "#cbd5e1",
    chartTooltipColor: isDark ? "#f8fafc" : "#0f172a",
    manualPanel: isDark ? "bg-slate-900/80 backdrop-blur-xl border-slate-800 shadow-xl" : "bg-white/85 backdrop-blur-xl border-slate-200/80 shadow-xl shadow-slate-200/50",
    manualTitle: isDark ? "text-white" : "text-slate-900",
    manualSub: isDark ? "text-slate-400" : "text-slate-600",
    manualBtn: isDark
      ? "bg-slate-950/80 hover:bg-slate-800 text-slate-200 border-slate-800 hover:border-slate-600"
      : "bg-slate-50 hover:bg-slate-100 text-slate-800 border-slate-200 hover:border-slate-300 shadow-sm",
    footerBorder: isDark ? "border-slate-900" : "border-slate-200",
    footerText: isDark ? "text-slate-500" : "text-slate-500 font-medium",
    footerTime: isDark ? "text-slate-300" : "text-slate-700 font-bold",
  };

  return (
    <div className={t.wrapper}>
      {/* Non-intrusive Connection / Error Alert Banner */}
      {isCloudError && (
        <div className="max-w-7xl mx-auto mb-6 p-4 rounded-2xl bg-rose-950/80 border border-rose-700/60 backdrop-blur-md flex items-center justify-between text-rose-200 shadow-xl transition-all duration-300">
          <div className="flex items-center space-x-3">
            <AlertTriangle className="w-6 h-6 text-rose-400 flex-shrink-0 animate-pulse" />
            <div>
              <p className="text-sm font-bold">Hardware Connection Interrupted</p>
              <p className="text-xs text-rose-300/90">Backend unreachable. Mirroring offline fallback data.</p>
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

      {/* Header / navbar */}
      <header className="max-w-7xl mx-auto mb-8">
        <div className={`flex flex-col lg:flex-row lg:items-center justify-between gap-4 p-6 rounded-3xl transition-all duration-300 ${t.navbar}`}>
          <div className="flex items-center space-x-3">
            <div className="p-2.5 bg-gradient-to-br from-blue-500 to-emerald-500 rounded-2xl shadow-lg shadow-emerald-500/20">
              <Home className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className={`text-3xl md:text-4xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r tracking-tight ${t.navTitle}`}>
                Sky Watch
              </h1>
              <p className={`text-sm md:text-base flex items-center mt-0.5 ${t.navSub}`}>
                Autonomous home &amp; laundry dashboard
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => setTheme(isDark ? "light" : "dark")}
              className={`flex items-center space-x-2 px-3.5 py-2 rounded-xl border transition-all duration-200 shadow-sm active:scale-95 ${
                isDark
                  ? "bg-slate-950/80 border-slate-800 text-amber-400 hover:bg-slate-800 hover:border-slate-700"
                  : "bg-slate-100/90 border-slate-200 text-amber-600 hover:bg-slate-200 hover:border-slate-300"
              }`}
              title={`Switch to ${isDark ? "light" : "dark"} mode`}
            >
              {isDark ? (
                <>
                  <Sun className="w-4 h-4" />
                  <span className="text-xs font-semibold text-slate-300">Light mode</span>
                </>
              ) : (
                <>
                  <Moon className="w-4 h-4 text-indigo-600" />
                  <span className="text-xs font-semibold text-slate-700">Dark mode</span>
                </>
              )}
            </button>

            <div className={`flex items-center space-x-2 px-4 py-2 rounded-xl border text-xs ${t.badge}`}>
              <RefreshCw className={`w-3.5 h-3.5 text-blue-400 ${isSyncing ? "animate-spin" : ""}`} />
              <span>Updated {lastSyncedAt.toLocaleTimeString()}</span>
              <button onClick={syncReadings} disabled={isSyncing} className={`ml-1 underline decoration-slate-500 transition-colors ${t.refreshBtn}`}>
                Refresh
              </button>
            </div>

            <div className={`flex items-center space-x-2.5 px-4 py-2 rounded-xl border ${t.statusPill}`}>
              <div
                className={`w-2.5 h-2.5 rounded-full ${
                  isCloudError
                    ? "bg-rose-500 animate-pulse"
                    : isSendingCommand || isSyncing
                    ? "bg-amber-400 animate-ping"
                    : "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.8)]"
                }`}
              />
              <span className={`text-xs font-semibold tracking-wide ${isDark ? "text-slate-300" : "text-slate-700"}`}>{statusMessage}</span>
            </div>
          </div>
        </div>
      </header>

      {/* At-a-glance status cards */}
      <section className="max-w-7xl mx-auto mb-8">
        <h2 className={`text-xs font-bold uppercase tracking-widest mb-3 px-1 ${t.sectionHeading}`}>Instant house status</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {/* Clothes status — 3-tier: No clothes / Dry / Wet */}
          <div className={`rounded-3xl p-6 relative overflow-hidden group transition-all ${t.card}`}>
            <div className="flex items-center justify-between mb-4">
              <span className={`text-sm ${t.cardHeader}`}>Clothes status</span>
              <div
                className={`p-3 rounded-2xl ${
                  !hasClothes
                    ? isDark
                      ? "bg-slate-800 text-slate-400 border border-slate-700"
                      : "bg-slate-100 text-slate-400 border border-slate-200"
                    : isDry
                    ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20"
                    : "bg-sky-500/10 text-sky-500 border border-sky-500/20"
                }`}
              >
                <Shirt className="w-6 h-6" />
              </div>
            </div>
            <h3
              className={`text-2xl md:text-3xl font-extrabold tracking-tight ${
                !hasClothes
                  ? isDark ? "text-slate-400" : "text-slate-500"
                  : isDry
                  ? isDark ? "text-emerald-400" : "text-emerald-600"
                  : isDark ? "text-sky-400" : "text-sky-600"
              }`}
            >
              {!hasClothes ? "No clothes on line" : isDry ? "Clothes are dry" : "Clothes are wet"}
            </h3>
            <p className={`text-xs mt-2 flex items-center ${t.cardSub}`}>
              <span
                className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
                  !hasClothes ? "bg-slate-500" : isDry ? "bg-emerald-500" : "bg-sky-500"
                }`}
              />
              Weight sensor: {latest ? `${latest.weight} ADC` : "no reading"}
            </p>
          </div>

          {/* Clothesline position */}
          <div className={`rounded-3xl p-6 relative overflow-hidden group transition-all ${t.card}`}>
            <div className="flex items-center justify-between mb-4">
              <span className={`text-sm ${t.cardHeader}`}>Clothesline position</span>
              <div className={`p-3 rounded-2xl ${motorState.clothesline === "OUTSIDE" ? "bg-amber-500/10 text-amber-500 border border-amber-500/20" : isDark ? "bg-slate-800 text-slate-300 border border-slate-700" : "bg-slate-100 text-slate-600 border border-slate-200"}`}>
                {motorState.clothesline === "OUTSIDE" ? <Maximize2 className="w-6 h-6" /> : <Minimize2 className="w-6 h-6" />}
              </div>
            </div>
            <h3 className={`text-2xl md:text-3xl font-extrabold tracking-tight ${motorState.clothesline === "OUTSIDE" ? (isDark ? "text-amber-400" : "text-amber-600") : isDark ? "text-slate-200" : "text-slate-800"}`}>
              {motorState.clothesline === "OUTSIDE" ? "Outside (drying)" : "Inside (protected)"}
            </h3>
            <p className={`text-xs mt-2 flex items-center ${t.cardSub}`}>
              <Wind className="w-3.5 h-3.5 mr-1" />
              Motorized clothesline track
            </p>
          </div>

          {/* Window position */}
          <div className={`rounded-3xl p-6 relative overflow-hidden group transition-all ${t.card}`}>
            <div className="flex items-center justify-between mb-4">
              <span className={`text-sm ${t.cardHeader}`}>Window position</span>
              <div className={`p-3 rounded-2xl ${motorState.window === "OPEN" ? "bg-teal-500/10 text-teal-500 border border-teal-500/20" : "bg-indigo-500/10 text-indigo-500 border border-indigo-500/20"}`}>
                <Home className="w-6 h-6" />
              </div>
            </div>
            <h3 className={`text-2xl md:text-3xl font-extrabold tracking-tight ${motorState.window === "OPEN" ? (isDark ? "text-teal-400" : "text-teal-600") : isDark ? "text-indigo-300" : "text-indigo-600"}`}>
              {motorState.window === "OPEN" ? "Open" : "Closed"}
            </h3>
            <p className={`text-xs mt-2 flex items-center ${t.cardSub}`}>
              <Activity className="w-3.5 h-3.5 mr-1" />
              {motorState.window === "OPEN" ? "Fresh air ventilation active" : "Draft & storm protection active"}
            </p>
          </div>

          {/* Current weather */}
          <div className={`rounded-3xl p-6 relative overflow-hidden group transition-all ${t.card}`}>
            <div className="flex items-center justify-between mb-4">
              <span className={`text-sm ${t.cardHeader}`}>Current weather</span>
              <div className={`p-3 rounded-2xl ${isRainingLocally ? "bg-blue-500/10 text-blue-500 border border-blue-500/20" : "bg-amber-500/10 text-amber-500 border border-amber-500/20"}`}>
                {isRainingLocally ? <CloudRain className="w-6 h-6" /> : <Sun className="w-6 h-6" />}
              </div>
            </div>
            <h3 className={`text-2xl md:text-3xl font-extrabold tracking-tight ${isRainingLocally ? (isDark ? "text-blue-400" : "text-blue-600") : isDark ? "text-amber-400" : "text-amber-600"}`}>
              {isRainingLocally ? "Raining locally" : "Clear"}
            </h3>
            <p className={`text-xs mt-2 flex items-center ${t.cardSub}`}>
              <Droplets className="w-3.5 h-3.5 mr-1" />
              Rooftop rain sensor: {latest ? `${latest.rain} ADC` : "n/a"}
            </p>
          </div>
        </div>
      </section>

      {/* Live telemetry tiles */}
      <section className="max-w-7xl mx-auto mb-8">
        <h3 className={`text-xs font-bold uppercase tracking-widest mb-2.5 px-1 ${t.sectionHeading}`}>Live hardware telemetry</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className={t.telemetryCard}>
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-rose-500/10 rounded-xl border border-rose-500/20 text-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.15)]">
                <Thermometer className="w-5 h-5" />
              </div>
              <div>
                <span className={t.telemetryLabel}>Temperature</span>
                <div className={t.telemetryValue}>{latest ? `${latest.temp} °C` : "--"}</div>
              </div>
            </div>
          </div>

          <div className={t.telemetryCard}>
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-sky-500/10 rounded-xl border border-sky-500/20 text-sky-500 shadow-[0_0_8px_rgba(14,165,233,0.15)]">
                <Droplets className="w-5 h-5" />
              </div>
              <div>
                <span className={t.telemetryLabel}>Humidity</span>
                <div className={t.telemetryValue}>{latest ? `${latest.humidity} %` : "--"}</div>
              </div>
            </div>
          </div>

          <div className={t.telemetryCard}>
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-amber-500/10 rounded-xl border border-amber-500/20 text-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.15)]">
                <Sun className="w-5 h-5" />
              </div>
              <div>
                <span className={t.telemetryLabel}>Light level</span>
                <div className={t.telemetryValue}>{latest ? `${latest.light} ADC` : "--"}</div>
              </div>
            </div>
          </div>

          <div className={t.telemetryCard}>
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-purple-500/10 rounded-xl border border-purple-500/20 text-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.15)]">
                <Shirt className="w-5 h-5" />
              </div>
              <div>
                <span className={t.telemetryLabel}>Clothes Weight</span>
                <div className={t.telemetryValue}>{latest ? `${latest.weight} ADC` : "--"}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* AI decision banner */}
      <section className="max-w-7xl mx-auto mb-10">
        <div className={`rounded-3xl p-6 md:p-8 relative overflow-hidden transition-all duration-300 ${t.aiBanner}`}>
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 via-teal-400 to-emerald-400" />

          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6 mb-6">
            <div className="flex items-center space-x-3.5">
              <div className="p-3 bg-purple-500/10 border border-purple-500/30 rounded-2xl">
                <BrainCircuit className="w-8 h-8 text-purple-400" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <h2 className={`text-xl md:text-2xl font-bold tracking-tight ${t.aiTitle}`}>Autonomous decision engine</h2>
                  {systemActive ? (
                    <span className="px-2.5 py-0.5 bg-purple-500/20 text-purple-400 text-xs font-bold rounded-full border border-purple-500/30">
                      Active
                    </span>
                  ) : (
                    <span className="px-2.5 py-0.5 bg-amber-500/20 text-amber-400 text-xs font-bold rounded-full border border-amber-500/30">
                      Paused
                    </span>
                  )}
                </div>
                <p className={`text-sm mt-0.5 ${t.aiSub}`}>Synced with satellite weather radar and local house telemetry</p>
              </div>
            </div>

            <div
              className={`flex items-center space-x-3 px-5 py-3 rounded-2xl border ${
                isRainForecast ? "bg-rose-500/10 border-rose-500/30 text-rose-500 font-semibold" : "bg-emerald-500/10 border-emerald-500/30 text-emerald-500 font-semibold"
              }`}
            >
              <Globe className="w-6 h-6 flex-shrink-0" />
              <div>
                <p className="text-xs uppercase tracking-wider font-bold opacity-75">Satellite radar forecast</p>
                <p className="text-base font-extrabold">{isRainForecast ? "Storm approaching" : "Clear skies expected"}</p>
              </div>
            </div>
          </div>

          <div className={`rounded-2xl p-5 md:p-6 flex items-start space-x-4 transition-all duration-300 ${t.aiCallout}`}>
            <div className="p-2.5 bg-emerald-500/10 rounded-xl text-emerald-500 mt-0.5 flex-shrink-0">
              <Sparkles className="w-6 h-6" />
            </div>
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-emerald-500 mb-1">Why it took this action</h4>
              <p className="text-base md:text-lg font-medium leading-relaxed italic">{explainLatestDecision()}</p>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
                <span className={`px-2.5 py-1 rounded-md border ${t.aiCodeBadge}`}>
                  Decision code: <code className="text-purple-500 font-mono font-bold">{latest?.decision ?? "n/a"}</code>
                </span>
                <span className={`px-2.5 py-1 rounded-md border ${t.aiCodeBadge}`}>
                  Dry threshold: <code className="text-emerald-500 font-mono font-bold">&lt; {DRY_WEIGHT_THRESHOLD.toLocaleString()} ADC</code>
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Charts + manual override */}
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          {/* Temperature & humidity */}
          <div className={`p-6 md:p-8 rounded-3xl border transition-all duration-300 ${t.card}`}>
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center space-x-3">
                <div className="p-2.5 bg-rose-500/10 rounded-xl border border-rose-500/20">
                  <Thermometer className="w-6 h-6 text-rose-500" />
                </div>
                <div>
                  <h3 className={`text-xl font-bold ${t.chartTitle}`}>Temperature &amp; humidity</h3>
                  <p className={`text-xs ${t.chartSub}`}>Last {readings.length} readings</p>
                </div>
              </div>
              {latest && (
                <div className="flex items-center space-x-4 text-right">
                  <div>
                    <span className={`text-xs block font-semibold ${t.chartSub}`}>Temp</span>
                    <span className="text-lg font-bold text-rose-500">{latest.temp}°C</span>
                  </div>
                  <div className={`h-6 w-px ${isDark ? "bg-slate-800" : "bg-slate-200"}`} />
                  <div>
                    <span className={`text-xs block font-semibold ${t.chartSub}`}>Humidity</span>
                    <span className="text-lg font-bold text-sky-500">{latest.humidity}%</span>
                  </div>
                </div>
              )}
            </div>

            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={readings} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid} vertical={false} />
                  <XAxis dataKey="time" stroke={t.chartAxis} tick={{ fill: t.chartAxis, fontSize: 12 }} tickMargin={10} />
                  <YAxis yAxisId="left" stroke="#fb7185" orientation="left" tick={{ fill: t.chartAxis, fontSize: 12 }} />
                  <YAxis yAxisId="right" stroke="#38bdf8" orientation="right" tick={{ fill: t.chartAxis, fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: t.chartTooltipBg,
                      border: t.chartTooltipBorder,
                      borderRadius: "12px",
                      color: t.chartTooltipColor,
                      boxShadow: isDark ? "none" : "0 10px 15px -3px rgba(0, 0, 0, 0.1)",
                    }}
                  />
                  <Legend wrapperStyle={{ paddingTop: "15px" }} />
                  <Line yAxisId="left" type="monotone" dataKey="temp" name="Temperature (°C)" stroke="#fb7185" strokeWidth={3} dot={{ r: 4, fill: t.chartTooltipBg, strokeWidth: 2 }} activeDot={{ r: 7 }} />
                  <Line yAxisId="right" type="monotone" dataKey="humidity" name="Humidity (%)" stroke="#38bdf8" strokeWidth={3} dot={{ r: 4, fill: t.chartTooltipBg, strokeWidth: 2 }} activeDot={{ r: 7 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Sunlight & rain */}
          <div className={`p-6 md:p-8 rounded-3xl border transition-all duration-300 ${t.card}`}>
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center space-x-3">
                <div className="p-2.5 bg-amber-500/10 rounded-xl border border-amber-500/20">
                  <Sun className="w-6 h-6 text-amber-500" />
                </div>
                <div>
                  <h3 className={`text-xl font-bold ${t.chartTitle}`}>Sunlight &amp; rain sensor</h3>
                  <p className={`text-xs ${t.chartSub}`}>Rain reading below {WET_RAIN_THRESHOLD.toLocaleString()} ADC means moisture</p>
                </div>
              </div>
              {latest && (
                <div className="flex items-center space-x-4 text-right">
                  <div>
                    <span className={`text-xs block font-semibold ${t.chartSub}`}>Light</span>
                    <span className="text-lg font-bold text-amber-500">{latest.light}</span>
                  </div>
                  <div className={`h-6 w-px ${isDark ? "bg-slate-800" : "bg-slate-200"}`} />
                  <div>
                    <span className={`text-xs block font-semibold ${t.chartSub}`}>Rain ADC</span>
                    <span className="text-lg font-bold text-indigo-500">{latest.rain}</span>
                  </div>
                </div>
              )}
            </div>

            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={readings} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={t.chartGrid} vertical={false} />
                  <XAxis dataKey="time" stroke={t.chartAxis} tick={{ fill: t.chartAxis, fontSize: 12 }} tickMargin={10} />
                  <YAxis stroke={t.chartAxis} domain={[0, 4500]} tick={{ fill: t.chartAxis, fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: t.chartTooltipBg,
                      border: t.chartTooltipBorder,
                      borderRadius: "12px",
                      color: t.chartTooltipColor,
                      boxShadow: isDark ? "none" : "0 10px 15px -3px rgba(0, 0, 0, 0.1)",
                    }}
                  />
                  <Legend wrapperStyle={{ paddingTop: "15px" }} />
                  <Line type="stepAfter" dataKey="light" name="Sunlight strength" stroke="#fbbf24" strokeWidth={3} dot={false} />
                  <Line type="stepAfter" dataKey="rain" name="Rain sensor (drops when wet)" stroke="#818cf8" strokeWidth={3} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Manual override panel */}
        <div className="space-y-6">
          <div className={`p-6 md:p-8 rounded-3xl border sticky top-8 transition-all duration-300 ${t.manualPanel}`}>
            <div className="flex items-center space-x-3 mb-2">
              <ShieldAlert className="w-6 h-6 text-amber-500" />
              <h3 className={`text-xl font-bold ${t.manualTitle}`}>Manual override</h3>
            </div>
            <p className={`text-xs md:text-sm mb-6 ${t.manualSub}`}>
              Send commands straight to the ESP32, bypassing the automated decision engine.
            </p>

            <div className="space-y-6">
              <div className="space-y-3">
                <button
                  onClick={() => sendCommand("all_safe", "Force everything open")}
                  disabled={isSendingCommand}
                  className="w-full flex items-center justify-center space-x-3 p-4 bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white rounded-2xl transition-all font-bold shadow-lg shadow-emerald-600/25 active:scale-95 disabled:opacity-50 group"
                >
                  <Sun className="w-5 h-5 group-hover:rotate-45 transition-transform" />
                  <span>Force everything open</span>
                </button>

                <button
                  onClick={() => sendCommand("all_protect", "Force everything closed")}
                  disabled={isSendingCommand}
                  className="w-full flex items-center justify-center space-x-3 p-4 bg-gradient-to-r from-rose-600 to-red-500 hover:from-rose-500 hover:to-red-400 text-white rounded-2xl transition-all font-bold shadow-lg shadow-rose-600/25 active:scale-95 disabled:opacity-50 group"
                >
                  <ShieldAlert className="w-5 h-5 group-hover:scale-110 transition-transform" />
                  <span>Force everything closed</span>
                </button>
              </div>

              <div className={`h-px w-full my-2 ${isDark ? "bg-slate-800/80" : "bg-slate-200"}`} />

              <div className="space-y-5">
                <div>
                  <label className={`text-xs font-bold uppercase tracking-wider mb-2.5 flex items-center justify-between ${t.manualSub}`}>
                    <span>Clothesline motor</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${motorState.clothesline === "OUTSIDE" ? "bg-amber-500/20 text-amber-500" : isDark ? "bg-slate-800 text-slate-400" : "bg-slate-200 text-slate-700"}`}>
                      {motorState.clothesline}
                    </span>
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => sendCommand("uncover_clothesline", "Extend clothesline")}
                      disabled={isSendingCommand}
                      className={`py-3.5 px-3 text-xs md:text-sm font-semibold rounded-xl transition-all border active:scale-95 flex flex-col items-center justify-center group ${t.manualBtn}`}
                    >
                      <Maximize2 className="w-4 h-4 mb-1.5 text-amber-500 group-hover:scale-110 transition-transform" />
                      Extend outside
                    </button>
                    <button
                      onClick={() => sendCommand("cover_clothesline", "Retract clothesline")}
                      disabled={isSendingCommand}
                      className={`py-3.5 px-3 text-xs md:text-sm font-semibold rounded-xl transition-all border active:scale-95 flex flex-col items-center justify-center group ${t.manualBtn}`}
                    >
                      <Minimize2 className={`w-4 h-4 mb-1.5 group-hover:scale-110 transition-transform ${isDark ? "text-slate-400" : "text-slate-600"}`} />
                      Retract inside
                    </button>
                  </div>
                </div>

                <div>
                  <label className={`text-xs font-bold uppercase tracking-wider mb-2.5 flex items-center justify-between ${t.manualSub}`}>
                    <span>Motorized window</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${motorState.window === "OPEN" ? "bg-teal-500/20 text-teal-500" : isDark ? "bg-slate-800 text-slate-400" : "bg-slate-200 text-slate-700"}`}>
                      {motorState.window}
                    </span>
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => sendCommand("open_window", "Open window")}
                      disabled={isSendingCommand}
                      className={`py-3.5 px-3 text-xs md:text-sm font-semibold rounded-xl transition-all border active:scale-95 flex flex-col items-center justify-center group ${t.manualBtn}`}
                    >
                      <Wind className="w-4 h-4 mb-1.5 text-teal-500 group-hover:scale-110 transition-transform" />
                      Open (0°)
                    </button>
                    <button
                      onClick={() => sendCommand("close_window", "Close window")}
                      disabled={isSendingCommand}
                      className={`py-3.5 px-3 text-xs md:text-sm font-semibold rounded-xl transition-all border active:scale-95 flex flex-col items-center justify-center group ${t.manualBtn}`}
                    >
                      <Home className="w-4 h-4 mb-1.5 text-indigo-500 group-hover:scale-110 transition-transform" />
                      Close (90°)
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <footer className={`max-w-7xl mx-auto text-center mt-12 pb-8 pt-6 border-t transition-colors duration-300 ${t.footerBorder}`}>
        <p className={`text-xs sm:text-sm ${t.footerText}`}>
          <span className={`font-extrabold bg-clip-text text-transparent bg-gradient-to-r ${t.navTitle}`}>Sky Watch</span>{" "}
          &bull; ESP32 telemetry &bull; Azure IoT Functions &bull; Local time:{" "}
          <span className={`font-mono font-bold ${t.footerTime}`}>{now.toLocaleTimeString()}</span>
        </p>
      </footer>
    </div>
  );
}