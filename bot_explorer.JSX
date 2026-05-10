import { useState, useEffect, useCallback, useRef } from “react”;

// ─── BOT API Config ───────────────────────────────────────────
// ใช้ apiportal.bot.or.th (old system ยังใช้ได้ถึง 31 ธ.ค. 2568)
// ผ่าน Cloudflare Worker proxy (CORS + key hiding)
// Worker URL ตั้งค่าได้ด้านล่าง
const WORKER_BASE = “https://iaa-ingest.9vk92zm5z2.workers.dev”;

// BOT API Categories (hardcoded จาก BOT documentation)
// เพราะ /categories endpoint ต้องการ auth เหมือนกัน → ใช้ catalog ที่รู้แล้ว
const BOT_CATEGORIES = [
{ id: “EC”,  name_th: “เศรษฐกิจ”,                    name_en: “Economic”              },
{ id: “FM”,  name_th: “ตลาดการเงิน”,                 name_en: “Financial Market”      },
{ id: “FI”,  name_th: “สถาบันการเงิน”,               name_en: “Financial Institutions”},
{ id: “PS”,  name_th: “ระบบการชำระเงิน”,             name_en: “Payment Systems”       },
{ id: “BOP”, name_th: “ดุลการชำระเงิน”,              name_en: “Balance of Payments”   },
{ id: “GS”,  name_th: “ภาคการคลัง”,                  name_en: “Government Sector”     },
{ id: “PF”,  name_th: “ตราสารหนี้ภาคเอกชน”,         name_en: “Private Finance”       },
{ id: “ER”,  name_th: “อัตราแลกเปลี่ยน”,             name_en: “Exchange Rates”        },
{ id: “IR”,  name_th: “อัตราดอกเบี้ย”,               name_en: “Interest Rates”        },
{ id: “DB”,  name_th: “ผลการประมูลตราสารหนี้”,       name_en: “Debt Securities Auction”},
];

// ─── Cloudflare Worker code ที่ต้อง deploy แยก ───────────────
// (แสดงใน UI ให้ copy ไป deploy)
const WORKER_CODE = `// Cloudflare Worker — BOT API Proxy (Phase 5)
// deploy ที่: Cloudflare Dashboard → Workers → iaa-ingest (เพิ่ม route)
// หรือสร้าง Worker ใหม่ชื่อ bot-api-proxy

const BOT_API_KEY = env.BOT_API_KEY;  // เก็บใน Cloudflare Secret
const BOT_BASE    = “https://apiportal.bot.or.th/bot/public”;
const KV_CATALOG  = “bot_catalog”;    // KV namespace สำหรับ catalog

export default {
async fetch(request, env) {
const url    = new URL(request.url);
const origin = request.headers.get(“Origin”) ?? “*”;
const cors   = {
“Access-Control-Allow-Origin”:  origin,
“Access-Control-Allow-Methods”: “GET, POST, OPTIONS”,
“Access-Control-Allow-Headers”: “Content-Type, Authorization”,
};
if (request.method === “OPTIONS”)
return new Response(null, { status: 204, headers: cors });

```
// Auth check (GitHub Pages frontend)
const auth = request.headers.get("Authorization") ?? "";
if (auth !== \`Bearer \${env.INGEST_SECRET_TOKEN}\`)
  return new Response("Unauthorized", { status: 401, headers: cors });

// GET /bot/series?category=EC
if (url.pathname === "/bot/series") {
  const cat = url.searchParams.get("category") ?? "";
  const cacheKey = \`catalog_\${cat}\`;
  const cached = await env.KV.get(cacheKey);
  if (cached) return new Response(cached, { headers: { ...cors, "Content-Type": "application/json" }});

  // ดึงจาก BOT API
  const res = await fetch(\`\${BOT_BASE}/series?category=\${cat}\`, {
    headers: { "X-IBM-Client-Id": BOT_API_KEY }
  });
  if (!res.ok) return new Response(await res.text(), { status: res.status, headers: cors });
  const data = await res.text();
  await env.KV.put(cacheKey, data, { expirationTtl: 60 * 60 * 24 });
  return new Response(data, { headers: { ...cors, "Content-Type": "application/json" }});
}

// GET /bot/observations?series_code=XX&start_period=YYYY-MM-DD
if (url.pathname === "/bot/observations") {
  const sc = url.searchParams.get("series_code") ?? "";
  const sp = url.searchParams.get("start_period") ?? "";
  const ep = url.searchParams.get("end_period") ?? "";
  let botUrl = \`\${BOT_BASE}/observations?series_code=\${sc}\`;
  if (sp) botUrl += \`&start_period=\${sp}\`;
  if (ep) botUrl += \`&end_period=\${ep}\`;
  const res = await fetch(botUrl, { headers: { "X-IBM-Client-Id": BOT_API_KEY }});
  if (!res.ok) return new Response(await res.text(), { status: res.status, headers: cors });
  const data = await res.text();
  return new Response(data, { headers: { ...cors, "Content-Type": "application/json" }});
}

// GET /bot/status — เช็คสถานะ BOT API
if (url.pathname === "/bot/status") {
  const start = Date.now();
  try {
    const res = await fetch(
      \`\${BOT_BASE}/observations?series_code=IR_1103500_13&start_period=2024-01-01\`,
      { headers: { "X-IBM-Client-Id": BOT_API_KEY }, signal: AbortSignal.timeout(8000) }
    );
    const latency = Date.now() - start;
    return new Response(JSON.stringify({
      ok: res.ok, status: res.status, latency_ms: latency,
      checked_at: new Date().toISOString()
    }), { headers: { ...cors, "Content-Type": "application/json" }});
  } catch(e) {
    return new Response(JSON.stringify({
      ok: false, error: e.message, latency_ms: Date.now() - start,
      checked_at: new Date().toISOString()
    }), { status: 503, headers: { ...cors, "Content-Type": "application/json" }});
  }
}

// POST /bot/save — บันทึก series code ที่เลือกไว้ใน D1
if (request.method === "POST" && url.pathname === "/bot/save") {
  const body = await request.json();
  const { series_code, series_name_th, series_name_eng, category, frequency, unit_eng } = body;
  await env.DB.prepare(\`
    INSERT OR REPLACE INTO bot_series_saved (
      series_code, series_name_th, series_name_eng,
      category, frequency, unit_eng, saved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  \`).bind(
    series_code, series_name_th ?? "", series_name_eng ?? "",
    category ?? "", frequency ?? "", unit_eng ?? "",
    new Date().toISOString()
  ).run();
  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...cors, "Content-Type": "application/json" }
  });
}

// GET /bot/saved — ดู series ที่บันทึกไว้
if (url.pathname === "/bot/saved") {
  const rows = await env.DB.prepare(
    "SELECT * FROM bot_series_saved ORDER BY category, series_code"
  ).all();
  return new Response(JSON.stringify(rows.results ?? []), {
    headers: { ...cors, "Content-Type": "application/json" }
  });
}

return new Response("Not Found", { status: 404, headers: cors });
```

}
};`;

// ─── D1 Schema SQL ────────────────────────────────────────────
const SCHEMA_SQL = `– รัน 1 ครั้งใน Cloudflare D1 Console
– iaa-consensus-db → Console

CREATE TABLE IF NOT EXISTS bot_series_saved (
id              INTEGER PRIMARY KEY AUTOINCREMENT,
series_code     TEXT NOT NULL UNIQUE,
series_name_th  TEXT,
series_name_eng TEXT,
category        TEXT,
frequency       TEXT,
unit_eng        TEXT,
saved_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_series_cat ON bot_series_saved(category);`;

// ─── Mock series data (ใช้ simulate ก่อน API key จริง) ────────
const MOCK_SERIES = {
EC: [
{ series_code: “EIRPPIM00080”, series_name_th: “ดัชนีราคาที่ดินเปล่า กรุงเทพฯ”, series_name_eng: “Land monthly price index: Bangkok”, unit_eng: “Index”, frequency: “Monthly”, last_update_date: “2026-03-31” },
{ series_code: “BORCPI01”,     series_name_th: “ดัชนีราคาผู้บริโภค CPI”, series_name_eng: “Consumer Price Index”, unit_eng: “%”, frequency: “Monthly”, last_update_date: “2026-04-30” },
{ series_code: “BORGDP01”,     series_name_th: “ผลิตภัณฑ์มวลรวมในประเทศ GDP”, series_name_eng: “GDP Growth Rate”, unit_eng: “%”, frequency: “Quarterly”, last_update_date: “2026-03-31” },
{ series_code: “BORUNP01”,     series_name_th: “อัตราการว่างงาน”, series_name_eng: “Unemployment Rate”, unit_eng: “%”, frequency: “Quarterly”, last_update_date: “2026-03-31” },
{ series_code: “BORPMI01”,     series_name_th: “ดัชนีผู้จัดการฝ่ายจัดซื้อ PMI”, series_name_eng: “Manufacturing PMI”, unit_eng: “Index”, frequency: “Monthly”, last_update_date: “2026-04-30” },
],
IR: [
{ series_code: “IR_1103500_13”, series_name_th: “อัตราดอกเบี้ย MLR”, series_name_eng: “MLR Interest Rate”, unit_eng: “%”, frequency: “Daily”, last_update_date: “2026-05-09” },
{ series_code: “IR_1103500_06”, series_name_th: “อัตราดอกเบี้ยนโยบาย”, series_name_eng: “Policy Rate”, unit_eng: “%”, frequency: “Monthly”, last_update_date: “2026-04-30” },
{ series_code: “IR_1103500_14”, series_name_th: “อัตราดอกเบี้ย MRR”, series_name_eng: “MRR Interest Rate”, unit_eng: “%”, frequency: “Daily”, last_update_date: “2026-05-09” },
],
ER: [
{ series_code: “EREF01”,  series_name_th: “อัตราแลกเปลี่ยน USD/THB ถัวเฉลี่ย”, series_name_eng: “USD/THB Interbank Rate”, unit_eng: “THB/USD”, frequency: “Daily”, last_update_date: “2026-05-09” },
{ series_code: “EREF02”,  series_name_th: “อัตราแลกเปลี่ยน EUR/THB”, series_name_eng: “EUR/THB Rate”, unit_eng: “THB/EUR”, frequency: “Daily”, last_update_date: “2026-05-09” },
{ series_code: “EREF03”,  series_name_th: “อัตราแลกเปลี่ยน JPY/THB”, series_name_eng: “JPY/THB Rate”, unit_eng: “THB/JPY”, frequency: “Daily”, last_update_date: “2026-05-09” },
],
FM: [
{ series_code: “PF00000000Q00232”, series_name_th: “FSIs ยอดรวมตราสารหนี้”, series_name_eng: “Government debt securities_Total”, unit_eng: “Millions of Baht”, frequency: “Quarterly”, last_update_date: “2026-03-31” },
{ series_code: “FM_SETIDX_01”,     series_name_th: “ดัชนีหุ้น SET”, series_name_eng: “SET Index”, unit_eng: “Index”, frequency: “Daily”, last_update_date: “2026-05-09” },
],
};

const MOCK_OBSERVATIONS = {
BORCPI01: [
{ period_start: “2026-01”, value: “0.35” }, { period_start: “2026-02”, value: “0.55” },
{ period_start: “2026-03”, value: “0.78” }, { period_start: “2026-04”, value: “1.12” },
{ period_start: “2025-10”, value: “0.89” }, { period_start: “2025-11”, value: “0.72” },
{ period_start: “2025-12”, value: “0.65” }, { period_start: “2025-09”, value: “0.91” },
],
IR_1103500_06: [
{ period_start: “2026-04”, value: “2.50” }, { period_start: “2026-03”, value: “2.50” },
{ period_start: “2026-02”, value: “2.50” }, { period_start: “2026-01”, value: “2.50” },
{ period_start: “2025-12”, value: “2.25” }, { period_start: “2025-11”, value: “2.25” },
{ period_start: “2025-10”, value: “2.25” }, { period_start: “2025-09”, value: “2.25” },
],
};

// ─── Components ───────────────────────────────────────────────

function StatusBadge({ ok, latency }) {
if (ok === null) return <span style={{ color: “#888”, fontSize: 12 }}>ยังไม่ได้ตรวจสอบ</span>;
return (
<span style={{
display: “inline-flex”, alignItems: “center”, gap: 6,
padding: “3px 10px”, borderRadius: 20, fontSize: 12, fontWeight: 600,
background: ok ? “#0d2b1a” : “#2b0d0d”,
color: ok ? “#3ddc84” : “#ff6b6b”,
border: `1px solid ${ok ? "#1a4a2a" : "#4a1a1a"}`,
}}>
<span style={{ width: 7, height: 7, borderRadius: “50%”, background: ok ? “#3ddc84” : “#ff6b6b”, display: “inline-block”, animation: ok ? “pulse 2s infinite” : “none” }} />
{ok ? `Online ${latency ? `· ${latency}ms` : ""}` : “Offline”}
</span>
);
}

function MiniChart({ data }) {
if (!data || data.length < 2) return null;
const vals = data.map(d => parseFloat(d.value)).filter(v => !isNaN(v));
if (vals.length < 2) return null;
const min = Math.min(…vals), max = Math.max(…vals);
const range = max - min || 1;
const W = 200, H = 50;
const pts = vals.slice(-20).map((v, i, arr) => {
const x = (i / (arr.length - 1)) * W;
const y = H - ((v - min) / range) * (H - 8) - 4;
return `${x},${y}`;
});
const lastVal = vals[vals.length - 1];
const prevVal = vals[vals.length - 2];
const isUp = lastVal >= prevVal;
return (
<div style={{ marginTop: 8 }}>
<svg width={W} height={H} style={{ display: “block” }}>
<defs>
<linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
<stop offset=“0%” stopColor={isUp ? “#3ddc84” : “#ff6b6b”} stopOpacity=“0.3” />
<stop offset=“100%” stopColor={isUp ? “#3ddc84” : “#ff6b6b”} stopOpacity=“0” />
</linearGradient>
</defs>
<polyline points={pts.join(” “)} fill=“none” stroke={isUp ? “#3ddc84” : “#ff6b6b”} strokeWidth=“1.5” />
</svg>
<div style={{ display: “flex”, justifyContent: “space-between”, fontSize: 11, color: “#666”, marginTop: 2 }}>
<span>{data[Math.max(0, data.length - 20)]?.period_start}</span>
<span style={{ color: isUp ? “#3ddc84” : “#ff6b6b”, fontWeight: 600 }}>{lastVal}</span>
<span>{data[data.length - 1]?.period_start}</span>
</div>
</div>
);
}

// ─── Main App ─────────────────────────────────────────────────

export default function BotExplorer() {
const [tab, setTab] = useState(“explore”);
const [apiKey, setApiKey] = useState(””);
const [workerToken, setWorkerToken] = useState(””);
const [useWorker, setUseWorker] = useState(false);
const [useMock, setUseMock] = useState(true);

// explore state
const [selectedCat, setSelectedCat] = useState(null);
const [seriesList, setSeriesList] = useState([]);
const [seriesLoading, setSeriesLoading] = useState(false);
const [search, setSearch] = useState(””);

// observation state
const [selectedSeries, setSelectedSeries] = useState(null);
const [obsData, setObsData] = useState(null);
const [obsLoading, setObsLoading] = useState(false);
const [startPeriod, setStartPeriod] = useState(“2023-01-01”);
const [endPeriod, setEndPeriod] = useState(””);

// catalog / saved
const [catalog, setCatalog] = useState({});
const [savedList, setSavedList] = useState([]);

// bot status
const [botStatus, setBotStatus] = useState({ ok: null, latency: null, checkedAt: null });
const [statusLoading, setStatusLoading] = useState(false);

// code modal
const [showWorkerCode, setShowWorkerCode] = useState(false);
const [showSchema, setShowSchema] = useState(false);
const [copiedKey, setCopiedKey] = useState(””);

// ── API Calls ────────────────────────────────────────────────

const botFetch = useCallback(async (path, params = {}) => {
if (useMock) {
await new Promise(r => setTimeout(r, 400));
if (path === “/series”) {
const cat = params.category ?? “”;
return { result: { series: MOCK_SERIES[cat] ?? [] } };
}
if (path === “/observations”) {
const sc = params.series_code ?? “”;
const obs = MOCK_OBSERVATIONS[sc] ?? Array.from({ length: 12 }, (_, i) => ({
period_start: `${2026 - Math.floor(i / 12)}-${String(12 - (i % 12)).padStart(2, "0")}`,
value: (Math.random() * 5 + 1).toFixed(2),
}));
return { result: { series: [{ series_code: sc, observations: obs }] } };
}
if (path === “/status”) return { ok: true, latency_ms: 234, checked_at: new Date().toISOString() };
if (path === “/saved”) return [];
return {};
}

```
if (useWorker) {
  const qp = new URLSearchParams(params);
  const res = await fetch(`${WORKER_BASE}/bot${path}?${qp}`, {
    headers: { Authorization: `Bearer ${workerToken}` },
  });
  if (!res.ok) throw new Error(`Worker ${res.status}`);
  return res.json();
}

// Direct BOT API
const qp = new URLSearchParams(params);
const res = await fetch(`https://apiportal.bot.or.th/bot/public${path}?${qp}`, {
  headers: { "X-IBM-Client-Id": apiKey },
});
if (!res.ok) throw new Error(`BOT API ${res.status}`);
return res.json();
```

}, [useMock, useWorker, apiKey, workerToken]);

const loadSeries = useCallback(async (cat) => {
setSeriesLoading(true);
setSeriesList([]);
setSelectedSeries(null);
setObsData(null);
try {
const data = await botFetch(”/series”, { category: cat.id });
const list = data?.result?.series ?? [];
setSeriesList(list);
// cache to catalog
setCatalog(prev => ({ …prev, [cat.id]: list }));
} catch (e) {
console.error(e);
}
setSeriesLoading(false);
}, [botFetch]);

const loadObservations = useCallback(async (series) => {
setObsLoading(true);
setObsData(null);
try {
const params = { series_code: series.series_code, start_period: startPeriod };
if (endPeriod) params.end_period = endPeriod;
const data = await botFetch(”/observations”, params);
const obs = data?.result?.series?.[0]?.observations ?? [];
setObsData({ series, observations: obs });
} catch (e) {
console.error(e);
}
setObsLoading(false);
}, [botFetch, startPeriod, endPeriod]);

const checkBotStatus = useCallback(async () => {
setStatusLoading(true);
try {
const data = await botFetch(”/status”);
setBotStatus({ ok: data.ok, latency: data.latency_ms, checkedAt: data.checked_at });
} catch {
setBotStatus({ ok: false, latency: null, checkedAt: new Date().toISOString() });
}
setStatusLoading(false);
}, [botFetch]);

const saveSeries = useCallback(async (series) => {
const entry = {
series_code: series.series_code,
series_name_th: series.series_name_th,
series_name_eng: series.series_name_eng,
category: selectedCat?.id ?? “”,
frequency: series.frequency,
unit_eng: series.unit_eng,
};
// local state first
setSavedList(prev => {
const exists = prev.find(s => s.series_code === series.series_code);
if (exists) return prev;
return […prev, entry];
});
// save to worker (if not mock)
if (!useMock && useWorker) {
try {
await fetch(`${WORKER_BASE}/bot/save`, {
method: “POST”,
headers: { Authorization: `Bearer ${workerToken}`, “Content-Type”: “application/json” },
body: JSON.stringify(entry),
});
} catch {}
}
setCopiedKey(series.series_code + “_saved”);
setTimeout(() => setCopiedKey(””), 2000);
}, [selectedCat, useMock, useWorker, workerToken]);

const copyText = (text, key) => {
navigator.clipboard.writeText(text);
setCopiedKey(key);
setTimeout(() => setCopiedKey(””), 2000);
};

// filtered series
const filtered = seriesList.filter(s =>
!search ||
s.series_code?.toLowerCase().includes(search.toLowerCase()) ||
s.series_name_th?.includes(search) ||
s.series_name_eng?.toLowerCase().includes(search.toLowerCase())
);

const totalCatalogCount = Object.values(catalog).reduce((a, b) => a + b.length, 0);

// ── Styles ───────────────────────────────────────────────────

const styles = {
app: {
minHeight: “100vh”,
background: “#0a0a0f”,
color: “#e0e0e0”,
fontFamily: “‘IBM Plex Mono’, ‘Courier New’, monospace”,
fontSize: 13,
},
header: {
background: “#0d0d18”,
borderBottom: “1px solid #1a1a2e”,
padding: “14px 24px”,
display: “flex”,
alignItems: “center”,
justifyContent: “space-between”,
position: “sticky”,
top: 0,
zIndex: 100,
},
logo: {
display: “flex”, alignItems: “center”, gap: 10,
},
logoIcon: {
width: 32, height: 32,
background: “linear-gradient(135deg, #1a3a5c, #0d6efd)”,
borderRadius: 6,
display: “flex”, alignItems: “center”, justifyContent: “center”,
fontSize: 14, fontWeight: 700, color: “#fff”,
letterSpacing: -1,
},
logoText: {
fontWeight: 700, fontSize: 15, color: “#a0c4ff”,
letterSpacing: 1,
},
tabs: {
display: “flex”, gap: 2,
},
tab: (active) => ({
padding: “6px 16px”,
borderRadius: 6,
border: “none”,
background: active ? “#1a2744” : “transparent”,
color: active ? “#a0c4ff” : “#666”,
cursor: “pointer”,
fontSize: 12,
fontFamily: “inherit”,
fontWeight: active ? 600 : 400,
transition: “all 0.15s”,
}),
body: {
display: “grid”,
gridTemplateColumns: “220px 1fr”,
minHeight: “calc(100vh - 57px)”,
},
sidebar: {
background: “#0d0d18”,
borderRight: “1px solid #1a1a2e”,
padding: “16px 0”,
overflowY: “auto”,
},
sideSection: {
padding: “8px 16px 4px”,
fontSize: 10,
color: “#444”,
letterSpacing: 2,
textTransform: “uppercase”,
},
catBtn: (active) => ({
display: “block”,
width: “100%”,
textAlign: “left”,
padding: “8px 16px”,
border: “none”,
background: active ? “#1a2744” : “transparent”,
color: active ? “#a0c4ff” : “#888”,
cursor: “pointer”,
fontSize: 12,
fontFamily: “inherit”,
borderLeft: `2px solid ${active ? "#0d6efd" : "transparent"}`,
transition: “all 0.1s”,
}),
main: {
padding: 20,
overflowY: “auto”,
maxHeight: “calc(100vh - 57px)”,
},
card: {
background: “#0d0d18”,
border: “1px solid #1a1a2e”,
borderRadius: 8,
padding: 16,
marginBottom: 12,
},
seriesCard: (selected) => ({
background: selected ? “#0d1f3c” : “#0d0d18”,
border: `1px solid ${selected ? "#0d6efd" : "#1a1a2e"}`,
borderRadius: 6,
padding: 12,
marginBottom: 8,
cursor: “pointer”,
transition: “all 0.15s”,
}),
input: {
background: “#0a0a14”,
border: “1px solid #1a1a2e”,
borderRadius: 6,
color: “#e0e0e0”,
fontFamily: “inherit”,
fontSize: 12,
padding: “7px 12px”,
outline: “none”,
width: “100%”,
boxSizing: “border-box”,
},
btn: (variant = “default”) => ({
padding: “7px 14px”,
border: “none”,
borderRadius: 6,
cursor: “pointer”,
fontFamily: “inherit”,
fontSize: 12,
fontWeight: 600,
background: variant === “primary” ? “#0d6efd”
: variant === “success” ? “#0a3d1f”
: variant === “danger”  ? “#3d0a0a”
: “#1a1a2e”,
color: variant === “primary” ? “#fff”
: variant === “success” ? “#3ddc84”
: variant === “danger”  ? “#ff6b6b”
: “#aaa”,
border: variant === “success” ? “1px solid #1a4a2a”
: variant === “danger”  ? “1px solid #4a1a1a”
: “1px solid #2a2a3e”,
transition: “all 0.15s”,
}),
codeBlock: {
background: “#050508”,
border: “1px solid #1a1a2e”,
borderRadius: 6,
padding: 16,
fontSize: 11,
lineHeight: 1.6,
color: “#8fbcbb”,
overflowX: “auto”,
whiteSpace: “pre”,
maxHeight: 400,
overflowY: “auto”,
},
tag: (color = “#1a1a2e”) => ({
display: “inline-block”,
padding: “2px 8px”,
borderRadius: 4,
fontSize: 10,
fontWeight: 600,
background: color,
color: “#aaa”,
letterSpacing: 0.5,
}),
grid2: {
display: “grid”,
gridTemplateColumns: “1fr 1fr”,
gap: 12,
},
grid3: {
display: “grid”,
gridTemplateColumns: “1fr 1fr 1fr”,
gap: 10,
},
flexRow: {
display: “flex”, alignItems: “center”, gap: 8, flexWrap: “wrap”,
},
label: {
fontSize: 10, color: “#555”, marginBottom: 4, letterSpacing: 1, textTransform: “uppercase”,
},
h2: {
fontSize: 14, fontWeight: 700, color: “#c0d8ff”, margin: “0 0 12px”,
},
dimText: {
fontSize: 11, color: “#555”,
},
};

// ── Render: Explore Tab ──────────────────────────────────────

const renderExplore = () => (
<div style={styles.body}>
{/* Sidebar: Categories */}
<aside style={styles.sidebar}>
<div style={styles.sideSection}>หมวดหมู่</div>
{BOT_CATEGORIES.map(cat => (
<button
key={cat.id}
style={styles.catBtn(selectedCat?.id === cat.id)}
onClick={() => { setSelectedCat(cat); loadSeries(cat); setSearch(””); }}
>
<div style={{ fontWeight: 600, fontSize: 11 }}>{cat.id}</div>
<div style={{ fontSize: 10, color: “#666”, marginTop: 2 }}>{cat.name_th}</div>
</button>
))}

```
    {/* Saved count */}
    {savedList.length > 0 && (
      <>
        <div style={{ ...styles.sideSection, marginTop: 12 }}>บันทึกแล้ว</div>
        <div style={{ padding: "6px 16px", fontSize: 11, color: "#3ddc84" }}>
          {savedList.length} series
        </div>
      </>
    )}

    {/* Catalog stats */}
    {totalCatalogCount > 0 && (
      <>
        <div style={{ ...styles.sideSection, marginTop: 12 }}>Catalog</div>
        <div style={{ padding: "6px 16px", fontSize: 11, color: "#888" }}>
          {totalCatalogCount} series ใน {Object.keys(catalog).length} หมวด
        </div>
      </>
    )}
  </aside>

  {/* Main */}
  <main style={styles.main}>
    {!selectedCat ? (
      /* Welcome screen */
      <div>
        <div style={{ ...styles.card, borderColor: "#1a2744" }}>
          <div style={styles.h2}>🏦 BOT API Explorer</div>
          <div style={{ color: "#888", lineHeight: 1.7, marginBottom: 16 }}>
            สำรวจข้อมูลสถิติของธนาคารแห่งประเทศไทย<br />
            เลือกหมวดทางซ้ายเพื่อดู series ทั้งหมดในหมวดนั้น
          </div>
          <div style={styles.grid3}>
            {[
              { label: "หมวดหมู่", value: BOT_CATEGORIES.length, color: "#1a2744" },
              { label: "Series ใน Catalog", value: totalCatalogCount, color: "#0a3d1f" },
              { label: "Series บันทึก", value: savedList.length, color: "#2d1a00" },
            ].map(s => (
              <div key={s.label} style={{ ...styles.card, background: s.color, margin: 0, textAlign: "center" }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: "#fff", marginBottom: 4 }}>{s.value}</div>
                <div style={styles.dimText}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={styles.card}>
          <div style={{ ...styles.h2, marginBottom: 8 }}>📋 Series ที่บันทึกไว้</div>
          {savedList.length === 0 ? (
            <div style={styles.dimText}>ยังไม่มี series ที่บันทึก<br />กดปุ่ม ⭐ ใน series เพื่อบันทึก</div>
          ) : (
            savedList.map(s => (
              <div key={s.series_code} style={{ ...styles.seriesCard(false), cursor: "default" }}
                onClick={() => { setSelectedSeries(s); loadObservations(s); setTab("observe"); }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <span style={{ color: "#a0c4ff", fontWeight: 700 }}>{s.series_code}</span>
                    <span style={{ ...styles.tag("#0a3d1f"), marginLeft: 8, color: "#3ddc84" }}>{s.frequency}</span>
                  </div>
                  <button style={styles.btn("primary")} onClick={e => { e.stopPropagation(); loadObservations(s); setSelectedSeries(s); setTab("observe"); }}>
                    ดูข้อมูล →
                  </button>
                </div>
                <div style={{ color: "#aaa", fontSize: 11, marginTop: 4 }}>{s.series_name_eng}</div>
                <div style={{ color: "#666", fontSize: 10, marginTop: 2 }}>{s.series_name_th} · {s.unit_eng}</div>
              </div>
            ))
          )}
        </div>
      </div>
    ) : (
      /* Series list */
      <div>
        <div style={{ ...styles.flexRow, marginBottom: 12 }}>
          <div>
            <div style={styles.h2}>{selectedCat.id} — {selectedCat.name_th}</div>
            <div style={styles.dimText}>{selectedCat.name_en} · {seriesList.length} series</div>
          </div>
        </div>

        {/* Search */}
        <div style={{ marginBottom: 12 }}>
          <input
            style={styles.input}
            placeholder="🔍 ค้นหา series code, ชื่อภาษาไทย หรือ English..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {seriesLoading ? (
          <div style={{ color: "#555", padding: 20, textAlign: "center" }}>กำลังโหลด series...</div>
        ) : filtered.length === 0 ? (
          <div style={{ color: "#555", padding: 20, textAlign: "center" }}>ไม่พบ series ที่ค้นหา</div>
        ) : (
          filtered.map(s => {
            const isSaved = savedList.some(sv => sv.series_code === s.series_code);
            const isSelected = selectedSeries?.series_code === s.series_code;
            return (
              <div key={s.series_code} style={styles.seriesCard(isSelected)}
                onClick={() => { setSelectedSeries(s); loadObservations(s); setTab("observe"); }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <span style={{ color: "#a0c4ff", fontWeight: 700, fontSize: 12 }}>{s.series_code}</span>
                    <span style={{ ...styles.tag(), marginLeft: 8 }}>{s.frequency ?? "-"}</span>
                    {s.unit_eng && <span style={{ ...styles.tag("#1a1a2e"), marginLeft: 4 }}>{s.unit_eng}</span>}
                    {isSaved && <span style={{ ...styles.tag("#0a3d1f"), marginLeft: 4, color: "#3ddc84" }}>⭐ saved</span>}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginLeft: 8, flexShrink: 0 }}>
                    <button style={styles.btn(isSaved ? "success" : "default")}
                      onClick={e => { e.stopPropagation(); saveSeries(s); }}>
                      {copiedKey === s.series_code + "_saved" ? "✓ saved" : isSaved ? "⭐" : "☆ save"}
                    </button>
                    <button style={styles.btn("primary")}
                      onClick={e => { e.stopPropagation(); setSelectedSeries(s); loadObservations(s); setTab("observe"); }}>
                      ดูข้อมูล
                    </button>
                  </div>
                </div>
                <div style={{ color: "#ccc", fontSize: 11, marginTop: 6 }}>{s.series_name_eng}</div>
                <div style={{ color: "#666", fontSize: 10, marginTop: 2 }}>{s.series_name_th}</div>
                <div style={{ ...styles.dimText, marginTop: 4 }}>อัปเดต: {s.last_update_date ?? "-"}</div>
              </div>
            );
          })
        )}
      </div>
    )}
  </main>
</div>
```

);

// ── Render: Observations Tab ─────────────────────────────────

const renderObserve = () => (
<div style={{ padding: 20 }}>
<div style={styles.card}>
<div style={styles.h2}>🔍 ดึงข้อมูล Observations</div>
<div style={styles.grid3}>
<div>
<div style={styles.label}>Series Code</div>
<input style={styles.input} placeholder=“เช่น BORCPI01”
value={selectedSeries?.series_code ?? “”}
onChange={e => setSelectedSeries({ series_code: e.target.value })} />
</div>
<div>
<div style={styles.label}>Start Period</div>
<input style={styles.input} type=“date” value={startPeriod}
onChange={e => setStartPeriod(e.target.value)} />
</div>
<div>
<div style={styles.label}>End Period (optional)</div>
<input style={styles.input} type=“date” value={endPeriod}
onChange={e => setEndPeriod(e.target.value)} />
</div>
</div>
<div style={{ marginTop: 12, display: “flex”, gap: 8 }}>
<button style={styles.btn(“primary”)}
onClick={() => selectedSeries && loadObservations(selectedSeries)}
disabled={!selectedSeries}>
{obsLoading ? “กำลังดึงข้อมูล…” : “▶ ดึงข้อมูล”}
</button>
{selectedSeries && (
<button style={styles.btn()} onClick={() => {
const isSaved = savedList.some(s => s.series_code === selectedSeries.series_code);
if (!isSaved) saveSeries(selectedSeries);
}}>
☆ บันทึก series นี้
</button>
)}
</div>
</div>

```
  {obsData && (
    <div style={styles.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div>
          <div style={{ color: "#a0c4ff", fontWeight: 700, fontSize: 14 }}>{obsData.series.series_code}</div>
          <div style={{ color: "#aaa", fontSize: 11, marginTop: 2 }}>{obsData.series.series_name_eng ?? ""}</div>
          <div style={{ color: "#666", fontSize: 10, marginTop: 1 }}>{obsData.series.series_name_th ?? ""}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={styles.dimText}>{obsData.observations.length} รายการ</div>
          <div style={{ ...styles.tag(), marginTop: 4 }}>{obsData.series.unit_eng ?? ""}</div>
        </div>
      </div>

      <MiniChart data={obsData.observations} />

      <div style={{ marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={styles.dimText}>ข้อมูลทั้งหมด {obsData.observations.length} จุด</div>
          <button style={styles.btn()} onClick={() => {
            const csv = ["period_start,value", ...obsData.observations.map(o => `${o.period_start},${o.value}`)].join("\n");
            const blob = new Blob([csv], { type: "text/csv" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = `${obsData.series.series_code}.csv`; a.click();
          }}>⬇ Export CSV</button>
        </div>
        <div style={{ ...styles.codeBlock, height: 250 }}>
          {obsData.observations.slice().reverse().map(o =>
            `${o.period_start.padEnd(12)}  ${o.value}`
          ).join("\n")}
        </div>
      </div>

      {/* Raw JSON */}
      <div style={{ marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={styles.dimText}>Raw JSON</div>
          <button style={styles.btn()} onClick={() => copyText(JSON.stringify(obsData, null, 2), "obs_json")}>
            {copiedKey === "obs_json" ? "✓ copied" : "copy JSON"}
          </button>
        </div>
        <div style={{ ...styles.codeBlock, height: 120 }}>
          {JSON.stringify(obsData.observations.slice(0, 3), null, 2)}...
        </div>
      </div>
    </div>
  )}
</div>
```

);

// ── Render: Catalog Tab ──────────────────────────────────────

const renderCatalog = () => (
<div style={{ padding: 20 }}>
<div style={styles.card}>
<div style={styles.h2}>📚 Catalog — Series ทั้งหมดที่โหลดแล้ว</div>
<div style={styles.dimText}>
กด Load All เพื่อดึง series ทุกหมวดมาเก็บใน catalog (ใช้เวลานาน)
</div>
<div style={{ display: “flex”, gap: 8, marginTop: 12 }}>
<button style={styles.btn(“primary”)} onClick={async () => {
for (const cat of BOT_CATEGORIES) {
if (!catalog[cat.id]) {
setSeriesLoading(true);
const data = await botFetch(”/series”, { category: cat.id });
const list = data?.result?.series ?? [];
setCatalog(prev => ({ …prev, [cat.id]: list }));
}
}
setSeriesLoading(false);
}}>
{seriesLoading ? “กำลังโหลด…” : “⬇ Load All Categories”}
</button>
<div style={{ …styles.dimText, alignSelf: “center” }}>
{Object.keys(catalog).length} / {BOT_CATEGORIES.length} หมวด · {totalCatalogCount} series
</div>
</div>
</div>

```
  {Object.entries(catalog).map(([catId, series]) => {
    const cat = BOT_CATEGORIES.find(c => c.id === catId);
    return (
      <div key={catId} style={styles.card}>
        <div style={{ ...styles.flexRow, marginBottom: 8 }}>
          <div style={{ fontWeight: 700, color: "#a0c4ff" }}>{catId}</div>
          <div style={{ color: "#888" }}>{cat?.name_th}</div>
          <span style={styles.tag()}>{series.length} series</span>
        </div>
        {series.map(s => (
          <div key={s.series_code} style={{ ...styles.flexRow, padding: "5px 0", borderBottom: "1px solid #111" }}>
            <span style={{ color: "#6fa3e0", fontSize: 11, minWidth: 160 }}>{s.series_code}</span>
            <span style={{ color: "#888", fontSize: 11, flex: 1 }}>{s.series_name_eng}</span>
            <span style={styles.tag()}>{s.frequency}</span>
            <button style={{ ...styles.btn(), fontSize: 10, padding: "3px 8px" }}
              onClick={() => { setSelectedSeries(s); loadObservations(s); setTab("observe"); }}>
              ดูข้อมูล
            </button>
            <button style={{ ...styles.btn("success"), fontSize: 10, padding: "3px 8px" }}
              onClick={() => saveSeries(s)}>
              {savedList.find(sv => sv.series_code === s.series_code) ? "⭐" : "☆"}
            </button>
          </div>
        ))}
      </div>
    );
  })}
</div>
```

);

// ── Render: Setup Tab ────────────────────────────────────────

const renderSetup = () => (
<div style={{ padding: 20 }}>
{/* BOT API Status */}
<div style={styles.card}>
<div style={{ …styles.flexRow, marginBottom: 12 }}>
<div style={styles.h2}>🔌 BOT API Status</div>
<StatusBadge ok={botStatus.ok} latency={botStatus.latency} />
</div>
<div style={styles.dimText}>
ตรวจสอบว่า BOT API ยังใช้งานได้และ latency เป็นอย่างไร
</div>
{botStatus.checkedAt && (
<div style={{ …styles.dimText, marginTop: 4 }}>
ตรวจสอบล่าสุด: {new Date(botStatus.checkedAt).toLocaleString(“th-TH”)}
</div>
)}
<div style={{ marginTop: 12 }}>
<button style={styles.btn(“primary”)} onClick={checkBotStatus} disabled={statusLoading}>
{statusLoading ? “กำลังตรวจสอบ…” : “🔄 ตรวจสอบ BOT API”}
</button>
</div>
</div>

```
  {/* API Mode */}
  <div style={styles.card}>
    <div style={styles.h2}>⚙️ API Mode</div>
    <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
      {[
        { key: "mock", label: "🎭 Mock Data", desc: "ทดสอบโดยไม่ต้องใช้ API key" },
        { key: "direct", label: "🔑 Direct BOT API", desc: "เรียก BOT API โดยตรง (ต้องการ API key)" },
        { key: "worker", label: "☁️ Via CF Worker", desc: "ผ่าน Cloudflare Worker (แนะนำสำหรับ production)" },
      ].map(m => {
        const isActive = m.key === "mock" ? useMock : m.key === "worker" ? useWorker : !useMock && !useWorker;
        return (
          <button key={m.key}
            style={{ ...styles.btn(isActive ? "primary" : "default"), textAlign: "left", flex: 1 }}
            onClick={() => {
              setUseMock(m.key === "mock");
              setUseWorker(m.key === "worker");
            }}>
            <div style={{ fontWeight: 600 }}>{m.label}</div>
            <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>{m.desc}</div>
          </button>
        );
      })}
    </div>

    {!useMock && !useWorker && (
      <div>
        <div style={styles.label}>BOT API Client ID (X-IBM-Client-Id)</div>
        <input style={styles.input} type="password" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          value={apiKey} onChange={e => setApiKey(e.target.value)} />
        <div style={{ ...styles.dimText, marginTop: 6 }}>
          สมัครได้ที่ <a href="https://portal.api.bot.or.th" target="_blank" rel="noreferrer" style={{ color: "#a0c4ff" }}>portal.api.bot.or.th</a> (ระบบใหม่) หรือ <a href="https://apiportal.bot.or.th/bot/public/" target="_blank" rel="noreferrer" style={{ color: "#a0c4ff" }}>apiportal.bot.or.th</a> (ระบบเก่า ใช้ได้ถึง 31 ธ.ค. 2568)
        </div>
      </div>
    )}

    {useWorker && (
      <div>
        <div style={styles.label}>Cloudflare Worker Token (INGEST_SECRET_TOKEN)</div>
        <input style={styles.input} type="password" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          value={workerToken} onChange={e => setWorkerToken(e.target.value)} />
      </div>
    )}
  </div>

  {/* Cloudflare Worker Code */}
  <div style={styles.card}>
    <div style={{ ...styles.flexRow, marginBottom: 12 }}>
      <div style={styles.h2}>☁️ Cloudflare Worker Code</div>
      <button style={styles.btn()} onClick={() => setShowWorkerCode(!showWorkerCode)}>
        {showWorkerCode ? "ซ่อน" : "แสดง Code"}
      </button>
      {showWorkerCode && (
        <button style={styles.btn()} onClick={() => copyText(WORKER_CODE, "worker_code")}>
          {copiedKey === "worker_code" ? "✓ copied" : "copy"}
        </button>
      )}
    </div>
    <div style={styles.dimText}>
      เพิ่ม route เหล่านี้ใน iaa-ingest Worker:<br />
      <code style={{ color: "#a0c4ff" }}>GET /bot/series?category=EC</code><br />
      <code style={{ color: "#a0c4ff" }}>GET /bot/observations?series_code=BORCPI01</code><br />
      <code style={{ color: "#a0c4ff" }}>GET /bot/status</code><br />
      <code style={{ color: "#a0c4ff" }}>POST /bot/save</code><br />
      <code style={{ color: "#a0c4ff" }}>GET /bot/saved</code>
    </div>
    {showWorkerCode && (
      <div style={{ ...styles.codeBlock, marginTop: 12 }}>{WORKER_CODE}</div>
    )}
  </div>

  {/* D1 Schema */}
  <div style={styles.card}>
    <div style={{ ...styles.flexRow, marginBottom: 12 }}>
      <div style={styles.h2}>🗄️ D1 Schema</div>
      <button style={styles.btn()} onClick={() => setShowSchema(!showSchema)}>
        {showSchema ? "ซ่อน" : "แสดง SQL"}
      </button>
      {showSchema && (
        <button style={styles.btn()} onClick={() => copyText(SCHEMA_SQL, "schema_sql")}>
          {copiedKey === "schema_sql" ? "✓ copied" : "copy SQL"}
        </button>
      )}
    </div>
    <div style={styles.dimText}>รัน 1 ครั้งใน Cloudflare D1 Console → iaa-consensus-db</div>
    {showSchema && <div style={{ ...styles.codeBlock, marginTop: 12 }}>{SCHEMA_SQL}</div>}
  </div>

  {/* KV Variables */}
  <div style={styles.card}>
    <div style={styles.h2}>🔑 Environment Variables ที่ต้องตั้ง</div>
    {[
      { name: "BOT_API_KEY", desc: "BOT API Client ID จาก apiportal.bot.or.th", type: "Secret" },
      { name: "INGEST_SECRET_TOKEN", desc: "Token สำหรับ frontend auth กับ Worker", type: "Secret" },
    ].map(v => (
      <div key={v.name} style={{ ...styles.seriesCard(false), cursor: "default" }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <code style={{ color: "#a0c4ff" }}>{v.name}</code>
          <span style={styles.tag("#2d1a00")} >{v.type}</span>
        </div>
        <div style={{ ...styles.dimText, marginTop: 4 }}>{v.desc}</div>
      </div>
    ))}
    <div style={{ ...styles.dimText, marginTop: 8 }}>
      ตั้งค่าใน: Cloudflare Dashboard → Workers → iaa-ingest → Settings → Variables and Secrets
    </div>
  </div>
</div>
```

);

// ── Main Render ──────────────────────────────────────────────

return (
<div style={styles.app}>
<style>{`@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap'); * { box-sizing: border-box; } body { margin: 0; } ::-webkit-scrollbar { width: 6px; height: 6px; } ::-webkit-scrollbar-track { background: #0a0a0f; } ::-webkit-scrollbar-thumb { background: #2a2a3e; border-radius: 3px; } @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } } button:hover { opacity: 0.85; }`}</style>

```
  {/* Header */}
  <header style={styles.header}>
    <div style={styles.logo}>
      <div style={styles.logoIcon}>B</div>
      <div>
        <div style={styles.logoText}>BOT API Explorer</div>
        <div style={{ fontSize: 10, color: "#444" }}>Bank of Thailand Statistics</div>
      </div>
    </div>

    <div style={styles.tabs}>
      {[
        { key: "explore", label: "🗂 Explore" },
        { key: "observe", label: "📊 Observations" },
        { key: "catalog", label: "📚 Catalog" },
        { key: "setup",   label: "⚙️ Setup" },
      ].map(t => (
        <button key={t.key} style={styles.tab(tab === t.key)} onClick={() => setTab(t.key)}>
          {t.label}
        </button>
      ))}
    </div>

    <div style={styles.flexRow}>
      <span style={styles.dimText}>{useMock ? "🎭 Mock" : useWorker ? "☁️ Worker" : "🔑 Direct"}</span>
      <StatusBadge ok={useMock ? true : botStatus.ok} latency={botStatus.latency} />
    </div>
  </header>

  {/* Body */}
  {tab === "explore" && renderExplore()}
  {tab === "observe" && renderObserve()}
  {tab === "catalog"  && renderCatalog()}
  {tab === "setup"   && renderSetup()}
</div>
```

);
}
