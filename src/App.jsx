// @ts-nocheck
import { useEffect, useMemo, useRef, useState } from "react";
import { Scissors, Search, Plus, Trash2, Check, X, MessageCircle, CreditCard, Users, Settings, CalendarDays, Clock, LogOut, Lock, UserPlus, UserRound, AlertTriangle, PhoneCall, TrendingUp, Wallet, ArrowUpRight, ArrowDownRight, Minus, Activity, ChevronDown, ChevronLeft, ChevronRight, Download, Eye, EyeOff, CalendarClock, Maximize2, Minimize2, ShieldCheck, Megaphone, MapPin, Send, RefreshCw, Loader2, CircleCheck, CircleAlert } from "lucide-react";
import { supabase } from "./supabase";
const LS_KEY = "mabel_hair_art_clean_v1";
const CUSTOMER_SESSION_KEY = "mabel_hair_art_customer_session_v1";
const ADMIN_SESSION_KEY = "mabel_hair_art_admin_session_v1";
const DEBT_CONTACT_PHONE = "05411731405";
const ANNOUNCEMENT_DATE_LABEL = "19 Ağustos 2026";
const MAX_UNPAID_DEBT_APPOINTMENTS = 1;
const REMOTE_ERROR_LOG_INTERVAL = 60_000;
const REMOTE_OK_POLL_INTERVAL = 5_000;
const REMOTE_DOWN_POLL_INTERVAL = 30_000;
const remoteErrorLogTimes = {};
const ANNOUNCEMENT_ROUND_STATE_LABELS = Object.freeze({
  idle: "Hazır",
  running: "Gönderiliyor",
  completed: "Tamamlandı",
  partial: "Kısmi tamamlandı",
  failed: "Başarısız",
});
const EMPTY_ANNOUNCEMENT_STATUS = Object.freeze({
  campaign: "",
  seriesId: "",
  roundId: "",
  roundNumber: 0,
  campaignState: "idle",
  template: "",
  templateStatus: "UNKNOWN",
  recipientCount: 0,
  sent: 0,
  failed: 0,
  pending: 0,
  processing: 0,
  locked: false,
  canSend: false,
  canStartNewRound: false,
});

function countValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : fallback;
}

function normalizeAnnouncementStatus(payload, previous = EMPTY_ANNOUNCEMENT_STATUS) {
  const nestedStatus = payload?.status && typeof payload.status === "object" ? payload.status : null;
  const source = nestedStatus ? { ...payload, ...nestedStatus } : (payload || {});
  const recipientCount = countValue(source.recipientCount ?? source.total, previous.recipientCount);
  const sent = countValue(source.sent, previous.sent);
  const failed = countValue(source.failed, previous.failed);
  const processing = countValue(source.processing, previous.processing);
  const pending = countValue(source.pending ?? source.remaining, Math.max(0, recipientCount - sent - failed - processing));
  const locked = typeof source.locked === "boolean" ? source.locked : previous.locked;
  const canSend = typeof source.canSend === "boolean" ? source.canSend : previous.canSend;
  const canStartNewRound = typeof source.canStartNewRound === "boolean"
    ? source.canStartNewRound
    : previous.canStartNewRound;

  return {
    campaign: source.campaign || previous.campaign || "",
    seriesId: source.seriesId || previous.seriesId || "",
    roundId: source.roundId || source.campaignId || source.campaign || previous.roundId || "",
    roundNumber: countValue(source.roundNumber, previous.roundNumber),
    campaignState: String(source.campaignState || previous.campaignState || "idle"),
    template: source.template || previous.template || "",
    templateStatus: String(source.templateStatus || previous.templateStatus || "UNKNOWN").toUpperCase(),
    recipientCount,
    sent,
    failed,
    pending,
    processing,
    locked,
    canSend,
    canStartNewRound,
  };
}

async function edgeFunctionErrorMessage(error, fallback) {
  const response = error?.context;
  try {
    const readableResponse = response?.clone ? response.clone() : response;
    const payload = await readableResponse?.json?.();
    if (payload?.error || payload?.message) {
      const message = String(payload.error || payload.message);
      const code = String(payload.diagnosticCode || "").toUpperCase();
      return /^[A-Z0-9_]{1,32}$/.test(code)
        ? `${message} (Hata kodu: ${code})`
        : message;
    }
  } catch {
    // Some function clients expose an already-consumed Response body.
  }

  const message = String(error?.message || "");
  return message && !/non-2xx status code/i.test(message) ? message : fallback;
}

async function invokeAdminEdgeFunction(functionName, { body, token = "" }) {
  const options = { body };
  if (token) options.headers = { "x-admin-session": token };
  const { data, error } = await supabase.functions.invoke(functionName, options);

  if (error) {
    const wrappedError = new Error(await edgeFunctionErrorMessage(error, "Sunucu isteği tamamlanamadı. Lütfen tekrar deneyin."));
    wrappedError.status = error?.context?.status || error?.status || 0;
    throw wrappedError;
  }

  if (data?.ok === false) {
    const wrappedError = new Error(data.error || data.message || "İşlem tamamlanamadı.");
    wrappedError.status = data.status || 0;
    throw wrappedError;
  }

  return data || {};
}

function shouldLogRemoteError(key) {
  const now = Date.now();
  if (!remoteErrorLogTimes[key] || now - remoteErrorLogTimes[key] > REMOTE_ERROR_LOG_INTERVAL) {
    remoteErrorLogTimes[key] = now;
    return true;
  }
  return false;
}

function logRemoteError(key, label, error) {
  if (shouldLogRemoteError(key)) console.log(label, error);
}

function isSupabaseUnavailable(error) {
  return error?.code === "PGRST002" || error?.status === 503 || /service unavailable|schema cache|failed to fetch/i.test(error?.message || "");
}

function dbErrorMessage(error) {
  if (isSupabaseUnavailable(error)) {
    return "Veritabanina su an ulasilamiyor. Site otomatik tekrar deneyecek; birazdan tekrar deneyin.";
  }
  return `Veritabanina kayit olmadi: ${error?.message || error?.code || "Bilinmeyen hata"}`;
}

const defaultServices = [
  { id: "sac", name: "Saç Kesimi", time: 30, price: 500, desc: "Modern saç kesimi." },
  { id: "sac-sakal", name: "Saç + Sakal", time: 50, price: 700, desc: "Tam bakım, kesim ve sakal tasarımı." },
];

const defaultStaff = [
  { id: "mabel", name: "Mabel Hair Art", role: "Ana Salon", active: true },
  { id: "usta1", name: "Usta Berber", role: "Saç & Sakal", active: true },
];

const defaultSettings = {
  openTime: "10:00",
  closeTime: "21:00",
  slotStep: 30,
  reminderHours: 2,
  lunchEnabled: true,
  lunchStart: "13:00",
  lunchEnd: "14:00",
  closedWeekdays: [0],
};

const WEEKDAYS = [
  { value: 1, label: "Pazartesi" },
  { value: 2, label: "Salı" },
  { value: 3, label: "Çarşamba" },
  { value: 4, label: "Perşembe" },
  { value: 5, label: "Cuma" },
  { value: 6, label: "Cumartesi" },
  { value: 0, label: "Pazar" },
];

function todayISO(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}
function addDaysISO(iso, offset = 0) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + offset);

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}
function prettyDate(iso) {
  return new Date(iso + "T12:00:00").toLocaleDateString("tr-TR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
function money(value) {
  return new Intl.NumberFormat("tr-TR").format(Number(value || 0));
}
function weekdayOf(iso) {
  return new Date(`${iso}T12:00:00`).getDay();
}
function isWeeklyClosed(settings, iso) {
  return (settings.closedWeekdays || []).map(Number).includes(weekdayOf(iso));
}
function id() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
function toMin(t) {
  const [h, m] = String(t || "00:00").split(":").map(Number);
  return h * 60 + m;
}
function toTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function overlap(a1, a2, b1, b2) {
  return a1 < b2 && a2 > b1;
}
function normPhone(p) {
  let n = String(p || "").replace(/[^0-9]/g, "");
  if (n.startsWith("0")) n = "9" + n;
  if (n.startsWith("5")) n = "90" + n;
  return n;
}
function normText(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("tr-TR");
}
function wa(phone, text) {
  const clean = normPhone(phone);
  return text ? `https://wa.me/${clean}?text=${encodeURIComponent(text)}` : `https://wa.me/${clean}`;
}
function sms(phone) {
  return `sms:${normPhone(phone)}`;
}
function tel(phone) {
  return `tel:${normPhone(phone)}`;
}
async function sendAppointmentWhatsApp(event, appointment) {
  try {
    const { error } = await supabase.functions.invoke("send-whatsapp-message", {
      body: { event, appointment },
    });
    if (error) console.log("WhatsApp message error:", error);
  } catch (error) {
    console.log("WhatsApp message failed:", error);
  }
}

function loadData() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) throw new Error("no data");
    const d = JSON.parse(raw);
    return {
      services: d.services || defaultServices,
      staff: d.staff || defaultStaff,
      settings: { ...defaultSettings, ...(d.settings || {}) },
      appointments: d.appointments || [],
      staffLeaves: d.staffLeaves || [],
      blockedSlots: d.blockedSlots || [],
      customerAccounts: d.customerAccounts || [],
    };
  } catch {
    return {
      services: defaultServices,
      staff: defaultStaff,
      settings: defaultSettings,
      staffLeaves: [],
      blockedSlots: [],
      customerAccounts: [],
      appointments: [
        {
          id: id(),
          customerName: "Ahmet Kutucu",
          phone: "905551112233",
          serviceId: "sac-sakal",
          staffId: "mabel",
          date: todayISO(0),
          time: "15:00",
          note: "",
          status: "active",
          paidAmount: 0,
          remainingDebt: 0,
        },
      ],
    };
  }
}

function getSavedCustomerSession() {
  try {
    const saved = localStorage.getItem(CUSTOMER_SESSION_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

function findSavedCustomerAccount(sourceData) {
  const session = getSavedCustomerSession();
  if (!session) return null;
  return (sourceData?.customerAccounts || []).find((u) => u.id === session.id || u.username === session.username) || null;
}

function Card({ children, className = "", ...props }) {
  return <div {...props} className={`min-w-0 rounded-3xl border border-white/10 bg-white/[0.06] p-5 shadow-2xl shadow-black/30 backdrop-blur ${className}`}>{children}</div>;
}
function Input(props) {
  return <input {...props} className={`rounded-2xl border border-white/10 bg-black/30 px-4 py-3 outline-none ${props.className || ""}`} />;
}
function Select({ children, ...props }) {
  return <select {...props} className={`rounded-2xl border border-white/10 bg-black/30 px-4 py-3 outline-none ${props.className || ""}`}>{children}</select>;
}
function Textarea(props) {
  return <textarea {...props} className={`rounded-2xl border border-white/10 bg-black/30 px-4 py-3 outline-none ${props.className || ""}`} />;
}
function monthStartISO(iso) {
  const base = iso || todayISO(0);
  return `${base.slice(0, 7)}-01`;
}
function addMonthsISO(iso, offset = 0) {
  const d = new Date(`${monthStartISO(iso)}T12:00:00`);
  d.setMonth(d.getMonth() + offset);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

const MONTH_NAMES = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function dateParts(iso) {
  const safe = iso || todayISO(0);
  return {
    year: Number(safe.slice(0, 4)),
    monthIndex: Number(safe.slice(5, 7)) - 1,
    day: Number(safe.slice(8, 10)),
  };
}

function isoFromParts(year, monthIndex, day) {
  const clampedMonth = Math.max(0, Math.min(11, monthIndex));
  const clampedDay = Math.max(1, Math.min(daysInMonth(year, clampedMonth), day));
  return `${year}-${String(clampedMonth + 1).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
}

function clampISO(iso, min, max) {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

function wheelItemClass(active) {
  return `flex min-h-10 items-center justify-center rounded-xl text-sm font-bold transition ${active ? "border border-amber-300 bg-amber-300 text-black shadow-lg shadow-amber-500/15" : "border border-transparent text-zinc-500"}`;
}

function LegacyDatePicker({ value, onChange, min, max, className = "" }) {
  const selected = clampISO(value || todayISO(0), min, max);
  const [open, setOpen] = useState(false);
  const { year, monthIndex, day } = dateParts(selected);
  const selectedWeekday = new Date(`${selected}T12:00:00`).toLocaleDateString("tr-TR", { weekday: "long" });

  function commit(nextIso) {
    onChange(clampISO(nextIso, min, max));
  }

  function shiftDay(delta) {
    const d = new Date(`${selected}T12:00:00`);
    d.setDate(d.getDate() + delta);
    commit(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }

  function shiftMonth(delta) {
    const nextMonth = monthIndex + delta;
    const d = new Date(year, nextMonth, 1, 12);
    commit(isoFromParts(d.getFullYear(), d.getMonth(), day));
  }

  function shiftYear(delta) {
    commit(isoFromParts(year + delta, monthIndex, day));
  }

  const prevDay = dateParts(addDaysISO(selected, -1)).day;
  const nextDay = dateParts(addDaysISO(selected, 1)).day;
  const prevMonth = MONTH_NAMES[(monthIndex + 11) % 12].slice(0, 3);
  const nextMonth = MONTH_NAMES[(monthIndex + 1) % 12].slice(0, 3);
  const quickDates = [
    { label: "Bugün", iso: todayISO(0) },
    { label: "Yarın", iso: todayISO(1) },
  ].filter((item) => (!min || item.iso >= min) && (!max || item.iso <= max));

  const WheelColumn = ({ title, previous, current, next, onPrev, onNext }) => (
    <div className="min-w-0">
      <div className="mb-1 text-center text-[11px] font-bold text-zinc-500">{title}</div>
      <button type="button" onClick={onPrev} className="mx-auto mb-1 block rounded-lg px-4 py-1 text-zinc-500 transition hover:bg-white/10 hover:text-amber-200">▲</button>
      <div className="space-y-1">
        <div className={wheelItemClass(false)}>{previous}</div>
        <div className={wheelItemClass(true)}>{current}</div>
        <div className={wheelItemClass(false)}>{next}</div>
      </div>
      <button type="button" onClick={onNext} className="mx-auto mt-1 block rounded-lg px-4 py-1 text-zinc-500 transition hover:bg-white/10 hover:text-amber-200">▼</button>
    </div>
  );

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-left outline-none transition hover:border-amber-300/40"
      >
        <span className="min-w-0">
          <span className="block truncate font-bold text-white">{prettyDate(selected)}</span>
          <span className="block text-xs capitalize text-zinc-400">{selectedWeekday}</span>
        </span>
        <ChevronDown className={`h-5 w-5 shrink-0 text-amber-300 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="fixed inset-x-3 top-1/2 z-[80] -translate-y-1/2 rounded-3xl border border-amber-300/20 bg-[#11100d] p-3 shadow-2xl shadow-black/60 sm:absolute sm:left-0 sm:right-auto sm:top-auto sm:mt-2 sm:w-full sm:min-w-[21rem] sm:translate-y-0">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-black text-white">{prettyDate(selected)}</div>
              <div className="text-xs capitalize text-zinc-500">{selectedWeekday}</div>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="rounded-xl bg-white/10 p-2 text-zinc-300 hover:bg-white/15">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-black/25 p-2">
            <WheelColumn title="Gün" previous={String(prevDay).padStart(2, "0")} current={String(day).padStart(2, "0")} next={String(nextDay).padStart(2, "0")} onPrev={() => shiftDay(-1)} onNext={() => shiftDay(1)} />
            <WheelColumn title="Ay" previous={prevMonth} current={MONTH_NAMES[monthIndex].slice(0, 3)} next={nextMonth} onPrev={() => shiftMonth(-1)} onNext={() => shiftMonth(1)} />
            <WheelColumn title="Yıl" previous={year - 1} current={year} next={year + 1} onPrev={() => shiftYear(-1)} onNext={() => shiftYear(1)} />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            {quickDates.map((item) => (
              <button key={item.iso} type="button" onClick={() => commit(item.iso)} className="rounded-xl bg-white/10 px-3 py-2 text-xs font-bold text-zinc-200 hover:bg-white/15">
                {item.label}
              </button>
            ))}
            <button type="button" onClick={() => setOpen(false)} className="rounded-xl bg-amber-300 px-3 py-2 text-xs font-black text-black">
              Tamam
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
function DatePicker({ value, onChange, min, max, className = "", triggerContent = null, triggerClassName = "" }) {
  const selected = clampISO(value || todayISO(0), min, max);
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [viewMonth, setViewMonth] = useState(monthStartISO(selected));
  const triggerRef = useRef(null);
  const selectedWeekday = new Date(`${selected}T12:00:00`).toLocaleDateString("tr-TR", { weekday: "long" });

  useEffect(() => {
    if (open) setViewMonth(monthStartISO(selected));
  }, [open, selected]);

  useEffect(() => {
    if (!open) return;
    const updatePlacement = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setDropUp(spaceBelow < 360 && spaceAbove > spaceBelow);
    };

    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [open]);

  function commit(nextIso) {
    const clamped = clampISO(nextIso, min, max);
    onChange(clamped);
    setOpen(false);
  }

  function canPick(iso) {
    return (!min || iso >= min) && (!max || iso <= max);
  }

  function shiftMonth(delta) {
    setViewMonth((current) => addMonthsISO(current, delta));
  }

  const { year, monthIndex } = dateParts(viewMonth);
  const firstWeekday = new Date(year, monthIndex, 1, 12).getDay();
  const leadingCells = (firstWeekday + 6) % 7;
  const totalDays = daysInMonth(year, monthIndex);
  const previousMonth = addMonthsISO(viewMonth, -1);
  const nextMonth = addMonthsISO(viewMonth, 1);
  const previousParts = dateParts(previousMonth);
  const previousTotalDays = daysInMonth(previousParts.year, previousParts.monthIndex);
  const days = [];

  for (let index = leadingCells - 1; index >= 0; index -= 1) {
    const day = previousTotalDays - index;
    days.push({
      iso: isoFromParts(previousParts.year, previousParts.monthIndex, day),
      day,
      muted: true,
    });
  }

  for (let day = 1; day <= totalDays; day += 1) {
    days.push({
      iso: isoFromParts(year, monthIndex, day),
      day,
      muted: false,
    });
  }

  const nextParts = dateParts(nextMonth);
  let nextDay = 1;
  while (days.length % 7 !== 0) {
    days.push({
      iso: isoFromParts(nextParts.year, nextParts.monthIndex, nextDay),
      day: nextDay,
      muted: true,
    });
    nextDay += 1;
  }

  const weekDays = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
  const defaultTriggerClass = "flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-left outline-none transition hover:border-amber-300/40";
  return (
    <div className={`relative min-w-0 ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={triggerClassName || defaultTriggerClass}
      >
        {triggerContent || (
          <>
            <span className="min-w-0">
              <span className="block truncate font-bold text-white">{prettyDate(selected)}</span>
              <span className="block text-xs capitalize text-zinc-400">{selectedWeekday}</span>
            </span>
            <ChevronDown className={`h-5 w-5 shrink-0 text-amber-300 transition ${open ? "rotate-180" : ""}`} />
          </>
        )}
      </button>

      {open && (
        <div className={`app-scrollbar absolute left-0 z-[120] w-[min(20rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-3xl border border-amber-300/20 bg-[#11100d] p-3 shadow-2xl shadow-black/70 ${dropUp ? "bottom-full mb-2 max-h-[min(21rem,calc(100dvh-7rem))]" : "top-full mt-2 max-h-[min(24rem,calc(100dvh-7rem))]"}`}>
          <div className="mb-3 flex items-center justify-between gap-2">
            <button type="button" onClick={() => shiftMonth(-1)} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm font-black text-amber-200 hover:border-amber-300/40">‹</button>
            <button type="button" onClick={() => setViewMonth(monthStartISO(selected))} className="min-w-0 flex-1 rounded-2xl bg-white/[0.04] px-3 py-2 text-center">
              <span className="block truncate text-sm font-black text-white">{MONTH_NAMES[monthIndex]} {year}</span>
              <span className="block text-[11px] capitalize text-zinc-500">{selectedWeekday}</span>
            </button>
            <button type="button" onClick={() => shiftMonth(1)} className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm font-black text-amber-200 hover:border-amber-300/40">›</button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-xl bg-white/10 p-2 text-zinc-300 hover:bg-white/15">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 rounded-2xl border border-white/10 bg-black/25 p-2">
            {weekDays.map((label) => (
              <div key={label} className="py-1 text-center text-[11px] font-bold text-zinc-500">{label}</div>
            ))}
            {days.map((item) => {
              const active = item.iso === selected;
              const disabled = !canPick(item.iso);
              return (
                <button
                  key={`${item.iso}-${item.muted ? "muted" : "month"}`}
                  type="button"
                  disabled={disabled}
                  onClick={() => commit(item.iso)}
                  className={`aspect-square rounded-xl text-sm font-bold transition ${
                    active
                      ? "bg-amber-300 text-black shadow-lg shadow-amber-500/20"
                      : disabled
                        ? "cursor-not-allowed text-zinc-700"
                        : item.muted
                          ? "text-zinc-600 hover:bg-white/5"
                          : "text-zinc-200 hover:bg-amber-300/10 hover:text-amber-100"
                  }`}
                >
                  {item.day}
                </button>
              );
            })}
          </div>

          <div className="mt-3">
            <button type="button" onClick={() => setOpen(false)} className="w-full rounded-xl bg-amber-300 px-3 py-2 text-xs font-black text-black">
              Tamam
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function BetterDatePicker({ value, onChange, min, max, className = "" }) {
  const selected = clampISO(value || todayISO(0), min, max);
  const [open, setOpen] = useState(false);
  const { year, monthIndex, day } = dateParts(selected);
  const selectedWeekday = new Date(`${selected}T12:00:00`).toLocaleDateString("tr-TR", { weekday: "long" });

  function commit(nextIso) {
    onChange(clampISO(nextIso, min, max));
  }

  function commitParts(nextYear = year, nextMonthIndex = monthIndex, nextDay = day) {
    commit(isoFromParts(nextYear, nextMonthIndex, nextDay));
  }

  const minYear = min ? dateParts(min).year : new Date().getFullYear() - 3;
  const maxYear = max ? dateParts(max).year : new Date().getFullYear() + 8;
  const yearStart = Math.min(minYear, year);
  const yearEnd = Math.max(maxYear, year);
  const dayOptions = Array.from({ length: daysInMonth(year, monthIndex) }, (_, i) => ({ value: i + 1, label: String(i + 1).padStart(2, "0") }));
  const monthOptions = MONTH_NAMES.map((name, i) => ({ value: i, label: name.slice(0, 3) }));
  const yearOptions = Array.from({ length: yearEnd - yearStart + 1 }, (_, i) => {
    const nextYear = yearStart + i;
    return { value: nextYear, label: String(nextYear) };
  });

  const WheelColumn = ({ title, options, current, onSelect }) => {
    const listRef = useRef(null);
    const scrollTimerRef = useRef(null);
    const activeIndex = Math.max(0, options.findIndex((option) => option.value === current));

    useEffect(() => {
      if (!open || !listRef.current) return;
      listRef.current.scrollTo({ top: activeIndex * 40, behavior: "auto" });
    }, [activeIndex, open, options.length]);

    function selectByIndex(index) {
      const option = options[Math.max(0, Math.min(options.length - 1, index))];
      if (option) onSelect(option.value);
    }

    function handleWheel(event) {
      event.preventDefault();
      if (Math.abs(event.deltaY) < 3) return;
      selectByIndex(activeIndex + (event.deltaY > 0 ? 1 : -1));
    }

    function settleScroll(event) {
      window.clearTimeout(scrollTimerRef.current);
      const target = event.currentTarget;
      scrollTimerRef.current = window.setTimeout(() => {
        selectByIndex(Math.round(target.scrollTop / 40));
      }, 90);
    }

    return (
      <div className="min-w-0 select-none">
        <div className="mb-1 text-center text-[11px] font-bold text-zinc-500">{title}</div>
        <div
          ref={listRef}
          onWheel={handleWheel}
          onScroll={settleScroll}
          className="app-scrollbar h-32 overflow-y-auto scroll-smooth rounded-2xl border border-white/10 bg-black/25 py-11"
          style={{ scrollSnapType: "y mandatory", touchAction: "pan-y" }}
        >
          {options.map((option) => {
            const active = option.value === current;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onSelect(option.value)}
                className={`flex h-10 w-full items-center justify-center rounded-xl text-sm font-bold transition ${active ? "bg-amber-300 text-black shadow-lg shadow-amber-500/15" : "text-zinc-500"}`}
                style={{ scrollSnapAlign: "center" }}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-left outline-none transition hover:border-amber-300/40"
      >
        <span className="min-w-0">
          <span className="block truncate font-bold text-white">{prettyDate(selected)}</span>
          <span className="block text-xs capitalize text-zinc-400">{selectedWeekday}</span>
        </span>
        <ChevronDown className={`h-5 w-5 shrink-0 text-amber-300 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-[80] mt-2 w-full min-w-[19rem] rounded-3xl border border-amber-300/20 bg-[#11100d] p-3 shadow-2xl shadow-black/60">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-black text-white">{prettyDate(selected)}</div>
              <div className="text-xs capitalize text-zinc-500">{selectedWeekday}</div>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="rounded-xl bg-white/10 p-2 text-zinc-300 hover:bg-white/15">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2 rounded-2xl border border-white/10 bg-black/25 p-2">
            <WheelColumn title="Gün" options={dayOptions} current={day} onSelect={(nextDay) => commitParts(year, monthIndex, nextDay)} />
            <WheelColumn title="Ay" options={monthOptions} current={monthIndex} onSelect={(nextMonth) => commitParts(year, nextMonth, day)} />
            <WheelColumn title="Yıl" options={yearOptions} current={year} onSelect={(nextYear) => commitParts(nextYear, monthIndex, day)} />
          </div>

          <button type="button" onClick={() => setOpen(false)} className="mt-3 w-full rounded-xl bg-amber-300 px-3 py-2 text-xs font-black text-black">
            Tamam
          </button>
        </div>
      )}
    </div>
  );
}

function CustomerDateStrip({ value, onChange, maxDays = 30, startDate, title = "Tarih Seç", rightLabel, getBadge, headerAction = null }) {
  const baseDate = startDate || todayISO(0);
  const today = todayISO(0);
  const days = Array.from({ length: maxDays + 1 }, (_, index) => {
    const iso = addDaysISO(baseDate, index);
    const d = new Date(`${iso}T12:00:00`);
    return {
      iso,
      weekday: d.toLocaleDateString("tr-TR", { weekday: "short" }),
      day: d.toLocaleDateString("tr-TR", { day: "2-digit" }),
      month: d.toLocaleDateString("tr-TR", { month: "short" }),
    };
  });

  return (
    <div className="w-full min-w-0 max-w-full overflow-visible rounded-3xl border border-white/10 bg-black/25 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        {headerAction || (
          <h3 className="flex min-w-0 items-center gap-2 text-base font-bold">
            <CalendarDays className="h-5 w-5 text-amber-300" /> {title}
          </h3>
        )}
        <span className="min-w-0 text-right text-xs font-semibold leading-snug text-zinc-500">{rightLabel || `Bugün ${prettyDate(today)}`}</span>
      </div>
      <div className="customer-date-scroll app-scrollbar pb-1">
        <div className="flex w-max max-w-none snap-x gap-2">
        {days.map((item) => {
          const active = item.iso === value;
          const badge = getBadge?.(item.iso);
          return (
            <button
              key={item.iso}
              type="button"
              onClick={() => onChange(item.iso)}
              className={`w-[4.35rem] flex-none snap-start rounded-2xl border px-2 py-3 text-center transition sm:w-[4.6rem] sm:px-3 ${active ? "border-amber-300 bg-amber-300 text-black shadow-lg shadow-amber-500/20" : "border-white/10 bg-white/[0.04] text-zinc-200 hover:border-amber-300/30 hover:bg-amber-300/10"}`}
            >
              <span className={`block text-xs font-semibold capitalize ${active ? "text-black/70" : "text-zinc-500"}`}>{item.weekday}</span>
              <span className="block text-2xl font-black leading-none">{item.day}</span>
              <span className={`mt-1 block text-xs capitalize ${active ? "text-black/70" : "text-zinc-500"}`}>{item.month}</span>
              {badge && <span className={`mt-2 block rounded-full px-1.5 py-1 text-[10px] font-black leading-none ${active ? "bg-black/10 text-black" : badge.tone || "bg-white/10 text-zinc-300"}`}>{badge.label || badge}</span>}
            </button>
          );
        })}
        </div>
      </div>
    </div>
  );
}

function PasswordInput({ value, onChange, placeholder = "Şifre", className = "", ...props }) {
  const [visible, setVisible] = useState(false);

  return (
    <div className={`relative ${className}`}>
      <Input
        {...props}
        type={visible ? "text" : "password"}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        className="w-full pr-12"
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        className="absolute right-1 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-xl text-zinc-400 transition hover:bg-white/10 hover:text-amber-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
        aria-label={visible ? "Şifreyi gizle" : "Şifreyi göster"}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
function TimePicker({ value, onChange, className = "", step = 30 }) {
  const [open, setOpen] = useState(false);
  const options = useMemo(() => {
    const items = [];
    for (let minutes = 0; minutes < 24 * 60; minutes += step) items.push(toTime(minutes));
    return items;
  }, [step]);

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-left outline-none transition hover:border-amber-300/40"
      >
        <span className="font-bold text-white">{value || "Saat seç"}</span>
        <ChevronDown className={`h-5 w-5 shrink-0 text-amber-300 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="app-scrollbar absolute left-0 z-50 mt-2 max-h-64 w-full overflow-y-auto rounded-3xl border border-amber-300/20 bg-[#11100d] p-2 shadow-2xl shadow-black/50">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
              className={`block w-full rounded-2xl px-4 py-2 text-left text-sm font-bold transition ${
                option === value ? "bg-amber-300 text-black" : "text-zinc-200 hover:bg-white/10"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
function OptionPicker({ value, onChange, options = [], placeholder = "Seç", className = "" }) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const triggerRef = useRef(null);
  const selected = options.find((option) => String(option.value) === String(value));

  useEffect(() => {
    if (!open) return;

    const updatePlacement = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setDropUp(spaceBelow < 300 && spaceAbove > spaceBelow);
    };

    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [open]);

  return (
    <div className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-left outline-none transition hover:border-amber-300/40"
      >
        <span className="min-w-0">
          <span className="block truncate font-bold text-white">{selected?.label || placeholder}</span>
          {selected?.description && <span className="block truncate text-xs text-zinc-400">{selected.description}</span>}
        </span>
        <ChevronDown className={`h-5 w-5 shrink-0 text-amber-300 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className={`app-scrollbar absolute left-0 z-[120] w-full min-w-0 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-3xl border border-amber-300/20 bg-[#11100d] p-2 shadow-2xl shadow-black/60 sm:min-w-[18rem] ${dropUp ? "bottom-full mb-2 max-h-[min(18rem,calc(100dvh-7rem))]" : "top-full mt-2 max-h-[min(18rem,calc(100dvh-7rem))]"}`}>
          <div className="mb-2 flex items-center justify-between px-2 py-1">
            <span className="text-sm font-black text-white">{placeholder}</span>
            <button type="button" onClick={() => setOpen(false)} className="rounded-xl bg-white/10 p-2 text-zinc-300 hover:bg-white/15">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-1">
            {options.map((option) => {
              const active = String(option.value) === String(value);
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={`block w-full rounded-2xl border px-4 py-3 text-left transition ${active ? "border-amber-300 bg-amber-300 text-black" : "border-transparent bg-white/[0.04] text-zinc-200 hover:bg-white/10"}`}
                >
                  <span className="block font-bold">{option.label}</span>
                  {option.description && <span className={`mt-0.5 block text-xs ${active ? "text-black/70" : "text-zinc-500"}`}>{option.description}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
function Status({ value }) {
  const cls = value === "done" ? "text-blue-300 bg-blue-400/10" : value === "cancelled" ? "text-red-300 bg-red-400/10" : "text-emerald-300 bg-emerald-400/10";
  const label = value === "done" ? "Tamamlandı" : value === "cancelled" ? "İptal" : "Aktif";
  return <span className={`rounded-full px-3 py-1 text-xs ${cls}`}>{label}</span>;
}

function AppointmentStatus({ appointment }) {
  if (appointment.status !== "done") return <Status value={appointment.status} />;

  const paidAmount = Number(appointment.paidAmount || 0);
  const remainingDebt = Number(appointment.remainingDebt || 0);
  const hasDebt = remainingDebt > 0;
  const isUnpaid = hasDebt && paidAmount <= 0;
  const isPartial = hasDebt && paidAmount > 0;
  const label = isUnpaid ? "Ödenmedi" : isPartial ? "Kısmi Ödendi" : "Ödendi";
  const cls = isUnpaid
    ? "bg-red-400/10 text-red-300"
    : isPartial
      ? "bg-amber-300/10 text-amber-200"
      : "bg-blue-400/10 text-blue-300";

  return <span className={`rounded-full px-3 py-1 text-xs ${cls}`}>{label}</span>;
}

export default function MabelHairArt() {
  const [data, setData] = useState(loadData);
  const initialCustomerRef = useRef(undefined);
  if (initialCustomerRef.current === undefined) initialCustomerRef.current = findSavedCustomerAccount(data);
  const initialCustomer = initialCustomerRef.current;
  const [view, setView] = useState("customer");
  const [customerAuthMode, setCustomerAuthMode] = useState("login");
  const [currentCustomer, setCurrentCustomer] = useState(initialCustomer);
  const [customerSessionChecked, setCustomerSessionChecked] = useState(() => !getSavedCustomerSession() || Boolean(initialCustomer));
  const [customerPanel, setCustomerPanel] = useState("booking");
  const [customerBookingStep, setCustomerBookingStep] = useState("service");
  const [customerPastOpen, setCustomerPastOpen] = useState(false);
  const [profileForm, setProfileForm] = useState({
    name: initialCustomer?.name || "",
    phone: initialCustomer?.phone || "",
    username: initialCustomer?.username || "",
    password: initialCustomer?.password || "",
  });
  const [customerLogin, setCustomerLogin] = useState({ username: "", password: "" });
  const [customerRegister, setCustomerRegister] = useState({ username: "", password: "", phone: "", name: "" });
  const [customerRecovery, setCustomerRecovery] = useState({ phone: "", name: "", newPassword: "" });
  const [adminSessionToken, setAdminSessionToken] = useState(() => sessionStorage.getItem(ADMIN_SESSION_KEY) || "");
  const [adminSessionValidated, setAdminSessionValidated] = useState(false);
  const [adminSessionChecking, setAdminSessionChecking] = useState(() => Boolean(sessionStorage.getItem(ADMIN_SESSION_KEY)));
  const [adminLoginLoading, setAdminLoginLoading] = useState(false);
  const [adminLoginError, setAdminLoginError] = useState("");
  const [pin, setPin] = useState("");
  const [tab, setTab] = useState("appointments");
  const [panelSwitchOpen, setPanelSwitchOpen] = useState(false);
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const [adminSettingsReturnTab, setAdminSettingsReturnTab] = useState("appointments");
  const [appHistory, setAppHistory] = useState([]);
  const [adminSummaryOpen, setAdminSummaryOpen] = useState(false);
  const [revenueFlowOpen, setRevenueFlowOpen] = useState(false);
  const [revenueFlowRange, setRevenueFlowRange] = useState("custom");
  const [revenueFlowCustomStart, setRevenueFlowCustomStart] = useState(todayISO(-29));
  const [revenueFlowCustomEnd, setRevenueFlowCustomEnd] = useState(todayISO(0));
  const [revenueFlowHoverIndex, setRevenueFlowHoverIndex] = useState(null);
  const [revenueFlowSelectedDate, setRevenueFlowSelectedDate] = useState(null);
  const [revenueFlowFullscreen, setRevenueFlowFullscreen] = useState(false);
  const [staffRevenueDetailId, setStaffRevenueDetailId] = useState(null);
  const [staffRevenueMonthOffset, setStaffRevenueMonthOffset] = useState(0);
  const [staffRevenueDayOffset, setStaffRevenueDayOffset] = useState(0);
  const [staffRevenueWeekOffset, setStaffRevenueWeekOffset] = useState(0);
  const [staffPeriodDetail, setStaffPeriodDetail] = useState(null);
  const [monthlyRevenueOpen, setMonthlyRevenueOpen] = useState(false);
  const [recentRevenueOpen, setRecentRevenueOpen] = useState(false);
  const [adminDate, setAdminDate] = useState(todayISO(0));
  const [adminDateStripStart, setAdminDateStripStart] = useState(todayISO(0));
  const [adminAppointmentStaffId, setAdminAppointmentStaffId] = useState(data.staff.find((s) => s.active)?.id || data.staff[0]?.id || "mabel");
  const [customerSearch, setCustomerSearch] = useState("");
  const [selectedCustomerPhone, setSelectedCustomerPhone] = useState(null);
  const [customerDetailReturnTab, setCustomerDetailReturnTab] = useState("customers");
  const [announcementStatus, setAnnouncementStatus] = useState(null);
  const [announcementLoading, setAnnouncementLoading] = useState(false);
  const [announcementSending, setAnnouncementSending] = useState(false);
  const [announcementError, setAnnouncementError] = useState("");
  const announcementPollGenerationRef = useRef(0);
  const announcementSendLockRef = useRef(false);
  const skipNextAdminValidationRef = useRef(false);
  const [adminBookingSlot, setAdminBookingSlot] = useState(null);
  const [adminBookingForm, setAdminBookingForm] = useState({
    customerPhone: "",
    serviceId: data.services[0]?.id || "sac",
    staffId: data.staff.find((s) => s.active)?.id || data.staff[0]?.id || "mabel",
    note: "",
  });
  const [adminBookingCustomerSearch, setAdminBookingCustomerSearch] = useState("");

  const [serviceId, setServiceId] = useState("");
  const [staffId, setStaffId] = useState(data.staff[0]?.id || "mabel");
  const [date, setDate] = useState(todayISO(0));
  const [time, setTime] = useState("10:00");
  const [customerName, setCustomerName] = useState(initialCustomer?.name || "");
  const [phone, setPhone] = useState(initialCustomer?.phone || "");
  const [note, setNote] = useState("");

  const [complete, setComplete] = useState(null);
  const [debtPay, setDebtPay] = useState(null);
  const [debtWarning, setDebtWarning] = useState(null);
  const [notice, setNotice] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [installGuide, setInstallGuide] = useState(null);
  const [isStandaloneApp, setIsStandaloneApp] = useState(() => Boolean(window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator?.standalone));
  const [newService, setNewService] = useState({ name: "", price: "", time: 30, desc: "" });
  const [editingService, setEditingService] = useState(null);
  const [newStaff, setNewStaff] = useState({ name: "", role: "" });
  const [newLeave, setNewLeave] = useState({ staffId: data.staff[0]?.id || "mabel", startDate: todayISO(0), endDate: todayISO(0), reason: "İzin" });
  const [newBlock, setNewBlock] = useState({ staffId: "all", date: todayISO(0), startTime: "12:00", endTime: "13:00", reason: "Kapalı" });

  const [appStateReady, setAppStateReady] = useState(false);
  const [appStateLoadSucceeded, setAppStateLoadSucceeded] = useState(false);
  const remoteUnavailableRef = useRef(false);
  const [remoteStatus, setRemoteStatus] = useState({ state: "checking", source: "", checkedAt: Date.now() });
  const logged = Boolean(adminSessionToken) && adminSessionValidated;

  function adminStatePayload(source = data) {
    return {
      services: source.services || defaultServices,
      staff: source.staff || defaultStaff,
      settings: { ...defaultSettings, ...(source.settings || {}) },
      staffLeaves: source.staffLeaves || [],
      blockedSlots: source.blockedSlots || [],
      customerAccounts: source.customerAccounts || [],
    };
  }

  function markRemoteHealthy() {
    remoteUnavailableRef.current = false;
    setRemoteStatus((status) => (
      status.state === "online"
        ? status
        : { state: "online", source: "", checkedAt: Date.now() }
    ));
  }

  function markRemoteProblem(error, source) {
    if (!isSupabaseUnavailable(error)) return;
    remoteUnavailableRef.current = true;
    setRemoteStatus({ state: "offline", source, checkedAt: Date.now() });
  }

  function handleRemoteError(key, label, error, source) {
    logRemoteError(key, label, error);
    markRemoteProblem(error, source);
  }

  async function loadRemoteAppState() {
    let row = null;

    try {
      const result = await supabase
        .from("app_state")
        .select("data")
        .eq("id", 1)
        .maybeSingle();

      row = result.data;

      if (result.error) {
        handleRemoteError("app_state_load", "App state load error:", result.error, "app_state");
        setAppStateReady(true);
        return false;
      }
    } catch (error) {
      handleRemoteError("app_state_load", "App state load error:", error, "app_state");
      setAppStateReady(true);
      return false;
    }

    markRemoteHealthy();
    setAppStateLoadSucceeded(true);

    if (row?.data) {
      setData((d) => ({
        ...d,
        services: row.data.services?.length ? row.data.services : d.services,
        staff: row.data.staff?.length ? row.data.staff : d.staff,
        settings: { ...defaultSettings, ...(row.data.settings || d.settings || {}) },
        staffLeaves: row.data.staffLeaves || [],
        blockedSlots: row.data.blockedSlots || [],
        customerAccounts: row.data.customerAccounts || [],
      }));
    }

    setAppStateReady(true);
    return true;
  }

  function normalizeAppointmentRow(a) {
    return {
      id: a.id,
      customerName: a.customer_name || "",
      phone: a.phone || "",
      serviceId: a.service || "sac",
      staffId: a.staff_key || "mabel",
      date: a.appointment_date,
      time: a.appointment_time,
      note: a.note || "",
      status: a.status || "active",
      paidAmount: Number(a.paid_amount || 0),
      remainingDebt: Number(a.remaining_debt || 0),
      paymentStatus: a.payment_status || "pending",
    };
  }

  async function loadRemoteAppointments() {
    let rows = null;

    try {
      const result = await supabase
        .from("appointments")
        .select("*")
        .order("appointment_date", { ascending: true })
        .order("appointment_time", { ascending: true });

      rows = result.data;

      if (result.error) {
        handleRemoteError("appointments_load", "Appointments load error:", result.error, "appointments");
        return false;
      }
    } catch (error) {
      handleRemoteError("appointments_load", "Appointments load error:", error, "appointments");
      return false;
    }

    markRemoteHealthy();
    if (rows) {
      setData((d) => ({
        ...d,
        appointments: rows.map(normalizeAppointmentRow),
      }));
    }
    return true;
  }

  useEffect(() => {
    let disposed = false;
    let timer = null;

    const poll = async () => {
      await loadRemoteAppointments();
      if (disposed) return;
      timer = window.setTimeout(
        poll,
        remoteUnavailableRef.current ? REMOTE_DOWN_POLL_INTERVAL : REMOTE_OK_POLL_INTERVAL
      );
    };

    poll();

    const channel = supabase
      .channel("appointments-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "appointments" },
        () => {
          if (!remoteUnavailableRef.current) loadRemoteAppointments();
        }
      )
      .subscribe();

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer = null;

    const poll = async () => {
      await loadRemoteAppState();
      if (disposed) return;
      timer = window.setTimeout(
        poll,
        remoteUnavailableRef.current ? REMOTE_DOWN_POLL_INTERVAL : REMOTE_OK_POLL_INTERVAL
      );
    };

    poll();

    const channel = supabase
      .channel("app-state-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "app_state" },
        () => {
          if (!remoteUnavailableRef.current) loadRemoteAppState();
        }
      )
      .subscribe();

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    const handleBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const handleAppInstalled = () => {
      setInstallPrompt(null);
      setInstallGuide(null);
      setIsStandaloneApp(true);
      setNotice({ message: "Uygulama cihazınıza eklendi.", tone: "success" });
    };
    const standaloneQuery = window.matchMedia?.("(display-mode: standalone)");
    const updateStandaloneMode = () => setIsStandaloneApp(Boolean(standaloneQuery?.matches || window.navigator?.standalone));

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    standaloneQuery?.addEventListener?.("change", updateStandaloneMode);
    standaloneQuery?.addListener?.(updateStandaloneMode);
    updateStandaloneMode();

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
      standaloneQuery?.removeEventListener?.("change", updateStandaloneMode);
      standaloneQuery?.removeListener?.(updateStandaloneMode);
    };
  }, []);

  useEffect(() => {
    localStorage.removeItem(ADMIN_SESSION_KEY);

    if (!adminSessionToken) {
      return undefined;
    }

    if (skipNextAdminValidationRef.current) {
      skipNextAdminValidationRef.current = false;
      return undefined;
    }

    let disposed = false;

    invokeAdminEdgeFunction("send-customer-announcement", {
      token: adminSessionToken,
      body: { action: "status" },
    })
      .then((payload) => {
        if (disposed) return;
        setAnnouncementStatus((current) => normalizeAnnouncementStatus(payload, current || EMPTY_ANNOUNCEMENT_STATUS));
        setAnnouncementError("");
        setAdminSessionValidated(true);
      })
      .catch((error) => {
        if (disposed) return;
        if (error.status === 401 || error.status === 403) {
          sessionStorage.removeItem(ADMIN_SESSION_KEY);
          setAdminSessionToken("");
          setAdminSessionValidated(false);
          setAnnouncementStatus(null);
          setNotice({ message: "Yönetici oturumunuzun süresi doldu. Lütfen yeniden giriş yapın.", tone: "error" });
          return;
        }

        setAdminSessionValidated(true);
        const message = error.message || "Duyuru durumu alınamadı. Durumu yenileyip tekrar deneyin.";
        setAnnouncementError(message);
        setNotice({ message, tone: "error" });
      })
      .finally(() => {
        if (!disposed) setAdminSessionChecking(false);
      });

    return () => {
      disposed = true;
    };
  }, [adminSessionToken]);

  useEffect(() => {
    if (!logged || tab !== "customers") return undefined;

    let disposed = false;
    Promise.resolve()
      .then(() => {
        if (disposed) return null;
        setAnnouncementLoading(true);
        setAnnouncementError("");
        return invokeAdminEdgeFunction("send-customer-announcement", {
          token: adminSessionToken,
          body: { action: "status" },
        });
      })
      .then((payload) => {
        if (!disposed && payload) {
          setAnnouncementStatus((current) => normalizeAnnouncementStatus(payload, current || EMPTY_ANNOUNCEMENT_STATUS));
        }
      })
      .catch((error) => {
        if (disposed) return;
        if (error.status === 401 || error.status === 403) {
          sessionStorage.removeItem(ADMIN_SESSION_KEY);
          setAdminSessionToken("");
          setAdminSessionValidated(false);
          setNotice({ message: "Yönetici oturumunuzun süresi doldu. Lütfen yeniden giriş yapın.", tone: "error" });
          return;
        }
        setAnnouncementError(error.message || "Duyuru durumu alınamadı. Durumu yenileyip tekrar deneyin.");
      })
      .finally(() => {
        if (!disposed) setAnnouncementLoading(false);
      });

    return () => {
      disposed = true;
    };
  }, [adminSessionToken, logged, tab]);


  useEffect(() => {
    const session = getSavedCustomerSession();

    if (!session) {
      setCustomerSessionChecked(true);
      return;
    }

    const acc = (data.customerAccounts || []).find((u) => u.id === session.id || u.username === session.username);

    if (acc) {
      setCurrentCustomer(acc);
      setCustomerName(acc.name || "");
      setPhone(acc.phone || "");
      setProfileForm({
        name: acc.name || "",
        phone: acc.phone || "",
        username: acc.username || "",
        password: acc.password || "",
      });
      setCustomerSessionChecked(true);
      return;
    }

    if (currentCustomer) {
      setCustomerSessionChecked(true);
      return;
    }

    if (appStateReady && appStateLoadSucceeded) {
      localStorage.removeItem(CUSTOMER_SESSION_KEY);
      setCustomerSessionChecked(true);
    }
  }, [data.customerAccounts, currentCustomer, appStateReady, appStateLoadSucceeded]);

  useEffect(() => {
    if (!currentCustomer) return;
    setProfileForm({
      name: currentCustomer.name || "",
      phone: currentCustomer.phone || "",
      username: currentCustomer.username || "",
      password: currentCustomer.password || "",
    });
  }, [currentCustomer?.id]);

  const adminStateJson = JSON.stringify(adminStatePayload());

  useEffect(() => {
    if (!appStateReady) return;
    if (remoteUnavailableRef.current) return;

    const timer = setTimeout(async () => {
      try {
        const { error } = await supabase
          .from("app_state")
          .upsert({
            id: 1,
            data: adminStatePayload(),
            updated_at: new Date().toISOString(),
          });

        if (error) {
          handleRemoteError("app_state_save", "App state save error:", error, "app_state_save");
          return;
        }
        markRemoteHealthy();
      } catch (error) {
        handleRemoteError("app_state_save", "App state save error:", error, "app_state_save");
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [appStateReady, adminStateJson, remoteStatus.state]);

  useEffect(() => localStorage.setItem(LS_KEY, JSON.stringify(data)), [data]);

  const serviceMap = useMemo(() => Object.fromEntries(data.services.map((s) => [s.id, s])), [data.services]);
  const staffMap = useMemo(() => Object.fromEntries(data.staff.map((s) => [s.id, s])), [data.staff]);
  const activeStaff = useMemo(() => data.staff.filter((s) => s.active), [data.staff]);
  const selectedService = serviceMap[serviceId] || null;
  const selectedStaff = staffMap[staffId] || activeStaff[0] || data.staff[0];
  const selectedStaffIsActive = activeStaff.some((s) => s.id === staffId);
  const selectedDateWeeklyClosed = isWeeklyClosed(data.settings, date);
  const selectedDateStaffOnLeave = data.staffLeaves.some((l) => l.staffId === staffId && date >= l.startDate && date <= l.endDate);
  const noAvailableSlotMessage = selectedDateWeeklyClosed
    ? "Bu gün işletme kapalı. Randevu alınmıyor."
    : selectedDateStaffOnLeave
      ? `${selectedStaff?.name || "Personel"} bu gün izinli.`
      : serviceId
        ? `${selectedService?.name || "Seçili hizmet"} için bu gün uygun saat yok.`
        : "Uygun saat yok.";

  useEffect(() => {
    if (!activeStaff.some((s) => s.id === adminAppointmentStaffId)) {
      setAdminAppointmentStaffId(activeStaff[0]?.id || data.staff[0]?.id || "mabel");
    }
  }, [activeStaff, adminAppointmentStaffId, data.staff]);

  useEffect(() => {
    if (!activeStaff.length) return;
    if (!activeStaff.some((s) => s.id === staffId)) {
      setStaffId(activeStaff[0].id);
    }
  }, [activeStaff, staffId]);

  const slots = useMemo(() => {
    const out = [];
    for (let m = toMin(data.settings.openTime); m <= toMin(data.settings.closeTime) - Number(data.settings.slotStep); m += Number(data.settings.slotStep)) out.push(toTime(m));
    return out;
  }, [data.settings]);

  function isBaseClosed(d, startTime, stf, srv) {
    const srvObj = serviceMap[srv] || { time: 30 };
    const start = toMin(startTime);
    const end = start + Number(srvObj.time || 30);
    if (isWeeklyClosed(data.settings, d)) return true;
    if (end > toMin(data.settings.closeTime)) return true;
    if (data.settings.lunchEnabled && overlap(start, end, toMin(data.settings.lunchStart), toMin(data.settings.lunchEnd))) return true;
    if (data.staffLeaves.some((l) => l.staffId === stf && d >= l.startDate && d <= l.endDate)) return true;
    if (data.blockedSlots.some((b) => b.date === d && (b.staffId === "all" || b.staffId === stf) && overlap(start, end, toMin(b.startTime), toMin(b.endTime)))) return true;
    return false;
  }

  function isClosed(d, startTime, stf, srv) {
    if (isBaseClosed(d, startTime, stf, srv)) return true;
    const srvObj = serviceMap[srv] || { time: 30 };
    const start = toMin(startTime);
    const end = start + Number(srvObj.time || 30);
    return data.appointments.some((a) => {
      if (a.status !== "active" || a.date !== d || a.staffId !== stf) return false;
      const otherStart = toMin(a.time);
      const otherEnd = otherStart + Number(serviceMap[a.serviceId]?.time || 30);
      return overlap(start, end, otherStart, otherEnd);
    });
  }

  const serviceCandidateSlots = serviceId && selectedStaffIsActive ? slots.filter((s) => {
  if (isBaseClosed(date, s, staffId, serviceId)) return false;

  const slotDateTime = new Date(`${date}T${s}:00`);
  const now = new Date();

  if (slotDateTime <= now) return false;

  return true;
}) : [];

  const availableSlots = serviceCandidateSlots.filter((s) => !isClosed(date, s, staffId, serviceId));
  useEffect(() => {
  const today = todayISO(0);
  const maxCustomerDate = todayISO(30);

  if (date < today) {
    setDate(today);
    return;
  }
  if (date > maxCustomerDate) {
    setDate(maxCustomerDate);
    return;
  }

  if (availableSlots.length && !availableSlots.includes(time)) {
    setTime(availableSlots[0]);
  }
  if (serviceId && !availableSlots.length && time) {
    setTime("");
  }
}, [date, availableSlots.join("|"), serviceId, time]);
  const completed = data.appointments.filter((a) => a.status === "done");
  const todayCompleted = completed.filter((a) => a.date === todayISO(0));
  const todayRevenue = todayCompleted.reduce((s, a) => s + Number(a.paidAmount || 0), 0);
  const yesterdayRevenue = completed.filter((a) => a.date === todayISO(-1)).reduce((s, a) => s + Number(a.paidAmount || 0), 0);
  const todayAppointmentCount = data.appointments.filter((a) => a.date === todayISO(0) && a.status !== "cancelled").length;
  const yesterdayAppointmentCount = data.appointments.filter((a) => a.date === todayISO(-1) && a.status !== "cancelled").length;
  const weekStart = addDaysISO(todayISO(0), -6);
  const weekRevenue = completed.filter((a) => a.date >= weekStart && a.date <= todayISO(0)).reduce((s, a) => s + Number(a.paidAmount || 0), 0);
  const previousWeekStart = addDaysISO(todayISO(0), -13);
  const previousWeekEnd = addDaysISO(todayISO(0), -7);
  const previousWeekRevenue = completed.filter((a) => a.date >= previousWeekStart && a.date <= previousWeekEnd).reduce((s, a) => s + Number(a.paidAmount || 0), 0);
  const monthKey = todayISO(0).slice(0, 7);
  const monthRevenue = completed.filter((a) => String(a.date || "").slice(0, 7) === monthKey).reduce((s, a) => s + Number(a.paidAmount || 0), 0);
  const previousMonthDate = new Date();
  previousMonthDate.setMonth(previousMonthDate.getMonth() - 1);
  const previousMonthKey = `${previousMonthDate.getFullYear()}-${String(previousMonthDate.getMonth() + 1).padStart(2, "0")}`;
  const previousMonthRevenue = completed.filter((a) => String(a.date || "").slice(0, 7) === previousMonthKey).reduce((s, a) => s + Number(a.paidAmount || 0), 0);
  const totalDebt = data.appointments.reduce((s, a) => s + Number(a.remainingDebt || 0), 0);
  const revenueFlowRanges = [
    { id: "d14", label: "Son 14", days: 14 },
    { id: "month1", label: "Son 30", days: 30 },
    { id: "month2", label: "Son 60", days: 60 },
    { id: "month3", label: "Son 90", days: 90 },
    { id: "month6", label: "Son 180", days: 180 },
    { id: "year", label: "Son 365", days: 365 },
    { id: "all", label: "Tüm Zamanlar", days: null },
    { id: "custom", label: "Tarih Seç", days: null },
  ];
  const activeRevenueFlowRange = revenueFlowRanges.find((item) => item.id === revenueFlowRange) || revenueFlowRanges[1];
  const completedDateValues = completed.map((a) => a.date).filter(Boolean).sort();
  const oldestCompletedDate = completedDateValues[0] || todayISO(0);
  const customRevenueStart = revenueFlowCustomStart <= revenueFlowCustomEnd ? revenueFlowCustomStart : revenueFlowCustomEnd;
  const customRevenueEnd = revenueFlowCustomStart <= revenueFlowCustomEnd ? revenueFlowCustomEnd : revenueFlowCustomStart;
  const revenueFlowStart = activeRevenueFlowRange.id === "custom"
    ? customRevenueStart
    : activeRevenueFlowRange.id === "all"
      ? oldestCompletedDate
      : addDaysISO(todayISO(0), -(activeRevenueFlowRange.days - 1));
  const revenueFlowEnd = activeRevenueFlowRange.id === "custom" ? customRevenueEnd : todayISO(0);
  const revenueFlowDayCount = Math.max(1, Math.round((new Date(`${revenueFlowEnd}T12:00:00`) - new Date(`${revenueFlowStart}T12:00:00`)) / 86400000) + 1);
  const revenueFlowRows = Array.from({ length: revenueFlowDayCount }, (_, i) => {
    const day = addDaysISO(revenueFlowStart, i);
    const amount = completed
      .filter((a) => a.date === day)
      .reduce((s, a) => s + Number(a.paidAmount || 0), 0);
    const label = new Date(`${day}T12:00:00`).toLocaleDateString("tr-TR", { day: "numeric", month: "short" });
    return { iso: day, end: day, label, amount };
  });
  const revenueFlowTotal = revenueFlowRows.reduce((sum, row) => sum + row.amount, 0);
  const revenueFlowAppointmentCount = completed.filter((a) => a.date >= revenueFlowStart && a.date <= revenueFlowEnd).length;
  const maxRevenueFlowAmount = Math.max(...revenueFlowRows.map((d) => d.amount), 1);
  const revenueFlowChart = { left: 34, right: 606, top: 58, bottom: 238 };
  const revenueFlowChartCoords = revenueFlowRows.map((row, i) => {
    const x = revenueFlowRows.length === 1 ? 320 : revenueFlowChart.left + (i * (revenueFlowChart.right - revenueFlowChart.left)) / Math.max(revenueFlowRows.length - 1, 1);
    const y = revenueFlowChart.bottom - (row.amount / maxRevenueFlowAmount) * (revenueFlowChart.bottom - revenueFlowChart.top);
    return { ...row, x, y };
  });
  const revenueFlowLinePath = revenueFlowChartCoords.map((point, i) => `${i === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const revenueFlowAreaPath = revenueFlowChartCoords.length
    ? `${revenueFlowLinePath} L ${revenueFlowChartCoords[revenueFlowChartCoords.length - 1].x.toFixed(1)} ${revenueFlowChart.bottom} L ${revenueFlowChartCoords[0].x.toFixed(1)} ${revenueFlowChart.bottom} Z`
    : "";
  const lastRevenueFlowIndex = Math.max(0, revenueFlowRows.length - 1);
  const activeRevenueFlowIndex = revenueFlowHoverIndex === null
    ? -1
    : Math.min(lastRevenueFlowIndex, Math.max(0, revenueFlowHoverIndex));
  const activeRevenueFlowPoint = activeRevenueFlowIndex >= 0 ? revenueFlowChartCoords[activeRevenueFlowIndex] : null;
  const previousRevenueFlowPoint = revenueFlowRows[activeRevenueFlowIndex - 1];
  const activeRevenueFlowChange = activeRevenueFlowPoint && previousRevenueFlowPoint
    ? activeRevenueFlowPoint.amount - previousRevenueFlowPoint.amount
    : 0;
  const activeRevenueFlowDateLabel = activeRevenueFlowPoint ? prettyDate(activeRevenueFlowPoint.iso) : "";
  const selectedRevenueFlowDate = revenueFlowSelectedDate && revenueFlowSelectedDate >= revenueFlowStart && revenueFlowSelectedDate <= revenueFlowEnd
    ? revenueFlowSelectedDate
    : null;
  const revenueFlowSelectedAppointments = selectedRevenueFlowDate
    ? completed.filter((a) => a.date === selectedRevenueFlowDate)
    : [];
  const revenueFlowSelectedTotal = revenueFlowSelectedAppointments.reduce((sum, a) => sum + Number(a.paidAmount || 0), 0);
  const revenueFlowSelectedCustomerCount = new Set(revenueFlowSelectedAppointments.map((a) => normPhone(a.phone) || a.customerName || a.id)).size;
  const revenueFlowSelectedStaffRows = Object.values(revenueFlowSelectedAppointments.reduce((map, a) => {
    const key = a.staffId || "mabel";
    if (!map[key]) map[key] = { id: key, name: staffMap[key]?.name || "Personel", amount: 0, count: 0 };
    map[key].amount += Number(a.paidAmount || 0);
    map[key].count += 1;
    return map;
  }, {})).sort((a, b) => b.amount - a.amount);
  const revenueFlowSelectedServiceRows = revenueFlowSelectedAppointments
    .slice()
    .sort((a, b) => `${a.time}`.localeCompare(`${b.time}`));
  const revenueFlowLabelTarget = revenueFlowRows.length <= 7 ? revenueFlowRows.length : revenueFlowDayCount > 95 ? 5 : 6;
  const revenueFlowLabelIndexes = Array.from(
    { length: Math.max(1, revenueFlowLabelTarget) },
    (_, i) => Math.round((i * Math.max(revenueFlowRows.length - 1, 0)) / Math.max(revenueFlowLabelTarget - 1, 1))
  ).filter((index, pos, list) => list.indexOf(index) === pos);
  const monthlyRevenueRows = Array.from({ length: 12 }, (_, i) => {
    const month = String(i + 1).padStart(2, "0");
    const amount = completed.filter((a) => String(a.date || "").slice(5, 7) === month).reduce((s, a) => s + Number(a.paidAmount || 0), 0);
    return {
      label: new Date(new Date().getFullYear(), i).toLocaleDateString("tr-TR", { month: "long" }),
      amount,
    };
  });
  const maxMonthlyRevenue = Math.max(...monthlyRevenueRows.map((m) => m.amount), 1);
  const topServiceRevenue = Object.values(completed.reduce((map, a) => {
    const key = a.serviceId || "unknown";
    if (!map[key]) map[key] = { name: serviceMap[key]?.name || "Hizmet", amount: 0, count: 0 };
    map[key].amount += Number(a.paidAmount || 0);
    map[key].count += 1;
    return map;
  }, {})).sort((a, b) => b.amount - a.amount)[0] || { name: "-", amount: 0, count: 0 };
  const serviceRevenueRows = Object.values(completed.reduce((map, a) => {
    const key = a.serviceId || "unknown";
    if (!map[key]) map[key] = { name: serviceMap[key]?.name || "Hizmet", amount: 0, count: 0 };
    map[key].amount += Number(a.paidAmount || 0);
    map[key].count += 1;
    return map;
  }, {})).sort((a, b) => b.amount - a.amount);
  const staffRevenueRows = Object.values(completed.reduce((map, a) => {
    const key = a.staffId || "mabel";
    if (!map[key]) map[key] = { id: key, name: staffMap[key]?.name || "Personel", amount: 0, count: 0, records: [] };
    map[key].amount += Number(a.paidAmount || 0);
    map[key].count += 1;
    map[key].records.push(a);
    return map;
  }, {})).map((row) => ({ ...row, records: row.records.slice().sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`)) })).sort((a, b) => b.amount - a.amount);
  const staffRevenueDetail = staffRevenueRows.find((row) => row.id === staffRevenueDetailId) || null;
  const staffDetailRecords = staffRevenueDetail?.records || [];
  const staffSelectedDayISO = addDaysISO(todayISO(0), staffRevenueDayOffset);
  const staffSelectedWeekStartISO = addDaysISO(weekStart, staffRevenueWeekOffset * 7);
  const staffSelectedWeekEndISO = addDaysISO(staffSelectedWeekStartISO, 6);
  const staffSelectedMonthISO = addMonthsISO(todayISO(0), staffRevenueMonthOffset);
  const staffSelectedMonthKey = staffSelectedMonthISO.slice(0, 7);
  const staffPreviousSelectedMonthKey = addMonthsISO(staffSelectedMonthISO, -1).slice(0, 7);
  const staffSelectedDayLabel = prettyDate(staffSelectedDayISO);
  const staffSelectedWeekLabel = `${prettyDate(staffSelectedWeekStartISO)} - ${prettyDate(staffSelectedWeekEndISO)}`;
  const staffSelectedMonthLabel = new Date(`${staffSelectedMonthISO}T12:00:00`).toLocaleDateString("tr-TR", { month: "long", year: "numeric" });
  const staffDayRecords = staffDetailRecords.filter((a) => a.date === staffSelectedDayISO);
  const staffWeekRecords = staffDetailRecords.filter((a) => a.date >= staffSelectedWeekStartISO && a.date <= staffSelectedWeekEndISO);
  const staffMonthRecords = staffDetailRecords.filter((a) => String(a.date || "").slice(0, 7) === staffSelectedMonthKey);
  const staffTodayRevenue = staffDayRecords.reduce((s, a) => s + Number(a.paidAmount || 0), 0);
  const staffWeekRevenue = staffWeekRecords.reduce((s, a) => s + Number(a.paidAmount || 0), 0);
  const staffMonthRevenue = staffDetailRecords.filter((a) => String(a.date || "").slice(0, 7) === staffSelectedMonthKey).reduce((s, a) => s + Number(a.paidAmount || 0), 0);
  const staffPreviousMonthRevenue = staffDetailRecords.filter((a) => String(a.date || "").slice(0, 7) === staffPreviousSelectedMonthKey).reduce((s, a) => s + Number(a.paidAmount || 0), 0);
  const staffMonthTrend = trendMeta(staffMonthRevenue, staffPreviousMonthRevenue);
  const StaffMonthTrendIcon = staffMonthTrend.icon;

  const customers = useMemo(() => {
    const map = {};
    (data.customerAccounts || []).forEach((c) => {
      const key = normPhone(c.phone);
      if (!key) return;
      map[key] = {
        name: c.name || c.username || "Musteri",
        phone: key,
        count: 0,
        debt: 0,
        spent: 0,
        last: "",
      };
    });
    data.appointments.forEach((a) => {
      const key = normPhone(a.phone);
      if (!map[key]) map[key] = { name: a.customerName, phone: a.phone, count: 0, debt: 0, spent: 0, last: a.date + " " + a.time };
      map[key].name = a.customerName || map[key].name;
      map[key].phone = key;
      map[key].count += 1;
      map[key].debt += Number(a.remainingDebt || 0);
      map[key].spent += Number(a.paidAmount || 0);
      if ((a.date + a.time) > map[key].last.replace(" ", "")) map[key].last = a.date + " " + a.time;
    });
    return Object.values(map);
  }, [data.appointments, data.customerAccounts]);
  const adminCustomerOptions = useMemo(() => {
    const map = {};

    (data.customerAccounts || []).forEach((c) => {
      const phoneKey = normPhone(c.phone);
      if (!phoneKey) return;
      map[phoneKey] = {
        name: c.name || c.username || "Müşteri",
        phone: phoneKey,
      };
    });

    customers.forEach((c) => {
      const phoneKey = normPhone(c.phone);
      if (!phoneKey) return;
      map[phoneKey] = {
        name: c.name || map[phoneKey]?.name || "Müşteri",
        phone: phoneKey,
      };
    });

    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name, "tr-TR"));
  }, [customers, data.customerAccounts]);
  const filteredAdminCustomerOptions = adminCustomerOptions.filter((c) => {
    const q = adminBookingCustomerSearch.trim().toLowerCase();
    if (!q) return true;
    return `${c.name} ${c.phone}`.toLowerCase().includes(q);
  });

  const filteredCustomers = customers.filter((c) => {
    const q = customerSearch.trim().toLowerCase();
    if (!q) return true;
    return `${c.name} ${c.phone}`.toLowerCase().includes(q);
  });

  const announcementSummary = announcementStatus || EMPTY_ANNOUNCEMENT_STATUS;
  const announcementTemplateApproved = announcementSummary.templateStatus === "APPROVED";
  const announcementProcessed = Math.min(
    announcementSummary.recipientCount,
    announcementSummary.sent + announcementSummary.failed + announcementSummary.processing
  );
  const announcementProgress = announcementSummary.recipientCount > 0
    ? Math.round((announcementProcessed / announcementSummary.recipientCount) * 100)
    : 0;
  const announcementTemplateLabel = announcementLoading && !announcementStatus
    ? "Meta durumu kontrol ediliyor"
    : announcementTemplateApproved
      ? "Meta onaylı"
      : announcementSummary.templateStatus === "PENDING"
        ? "Meta onayı bekleniyor"
        : announcementSummary.templateStatus === "REJECTED"
          ? "Meta tarafından reddedildi"
          : "Meta durumu alınamadı";
  const announcementRoundStateLabel = ANNOUNCEMENT_ROUND_STATE_LABELS[announcementSummary.campaignState] || "Durum bekleniyor";
  const announcementActionDisabled = !announcementTemplateApproved
    || announcementLoading
    || announcementSending
    || !announcementStatus
    || announcementSummary.locked
    || announcementSummary.processing > 0
    || (!announcementSummary.canSend && !announcementSummary.canStartNewRound);

  const customerAppointments = selectedCustomerPhone ? data.appointments.filter((a) => a.phone === selectedCustomerPhone) : [];
  const selectedCustomer = selectedCustomerPhone ? customers.find((c) => c.phone === selectedCustomerPhone) : null;
  const selectedCustomerAppointments = customerAppointments
    .slice()
    .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
  const selectedCustomerActiveAppointments = selectedCustomerAppointments.filter((a) => a.status === "active");
  const selectedCustomerPastAppointments = selectedCustomerAppointments.filter((a) => a.status !== "active");
  const debtAppointments = data.appointments.filter((a) => Number(a.remainingDebt || 0) > 0);
  const debtGroups = useMemo(() => {
    const map = {};
    debtAppointments.forEach((a) => {
      const key = a.phone || a.customerName || a.id;
      if (!map[key]) {
        map[key] = {
          phone: a.phone,
          name: a.customerName,
          totalDebt: 0,
          paidAmount: 0,
          count: 0,
          appointments: [],
          last: `${a.date} ${a.time}`,
        };
      }
      map[key].totalDebt += Number(a.remainingDebt || 0);
      map[key].paidAmount += Number(a.paidAmount || 0);
      map[key].count += 1;
      map[key].appointments.push(a);
      if (`${a.date} ${a.time}` > map[key].last) map[key].last = `${a.date} ${a.time}`;
    });

    return Object.values(map).sort((a, b) => b.last.localeCompare(a.last));
  }, [debtAppointments]);
  const densityDate = date || todayISO(0);
  const densityDateClosed = isWeeklyClosed(data.settings, densityDate);
  const densityCapacity = serviceCandidateSlots.length;
  const densityAvailable = availableSlots.length;
  const densityBusy = Math.max(densityCapacity - densityAvailable, 0);
  const densityPct = densityDateClosed ? 0 : densityCapacity ? Math.min(100, Math.round((densityBusy / densityCapacity) * 100)) : 100;
  const densityDateLabel = densityDate === todayISO(0)
    ? "Bugün"
    : new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long" }).format(new Date(`${densityDate}T12:00:00`));
  const densityTitle = densityDate === todayISO(0) ? "Bugünün yoğunluğu" : `${densityDateLabel} yoğunluğu`;
  const density = densityDateClosed
    ? { text: `${densityDateLabel} kapalı`, desc: "Bu gün randevu alınmıyor", pct: 0 }
    : densityCapacity === 0
    ? { text: `${densityDateLabel} uygun değil`, desc: "Seçtiğiniz hizmet için uygun başlangıç saati yok", pct: 100 }
    : densityAvailable === 0
    ? { text: `${densityDateLabel} dolu`, desc: `${selectedService?.name || "Seçili hizmet"} için uygun saat kalmadı`, pct: 100 }
    : densityBusy === 0
    ? { text: `${densityDateLabel} boş`, desc: `${selectedService?.name || "Seçili hizmet"} için tüm saatler rahat görünüyor`, pct: 0 }
    : densityPct <= 30
      ? { text: `${densityDateLabel} sakin`, desc: `${densityAvailable} uygun saat var`, pct: densityPct }
      : densityPct <= 65
        ? { text: `${densityDateLabel} orta yoğun`, desc: `${densityAvailable} uygun saat kaldı`, pct: densityPct }
        : { text: `${densityDateLabel} yoğun`, desc: `${densityAvailable} uygun saat kaldı, erken randevu önerilir`, pct: densityPct };
  const myAppointments = currentCustomer
    ? data.appointments
        .filter((a) => a.phone === currentCustomer.phone)
        .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))
    : [];
  const myActiveAppointments = myAppointments.filter((a) => a.status === "active" && new Date(`${a.date}T${a.time}:00`) >= new Date());
  const myPastAppointments = myAppointments.filter((a) => a.status !== "active" || new Date(`${a.date}T${a.time}:00`) < new Date());

  function noticeTone(message) {
    const text = String(message || "").toLocaleLowerCase("tr-TR");
    if (text.includes("oluşturuldu") || text.includes("güncellendi") || text.includes("kaydedildi")) return "success";
    if (text.includes("hata") || text.includes("veritabani") || text.includes("olmadı") || text.includes("edilemedi") || text.includes("yanlış")) return "error";
    return "warning";
  }

  function alert(message, tone = noticeTone(message)) {
    setNotice({ message: String(message || ""), tone });
  }

  async function installApp() {
    const isStandalone = window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator?.standalone;
    if (isStandalone) {
      alert("Uygulama zaten cihazınızda yüklü.", "success");
      return;
    }

    if (installPrompt) {
      installPrompt.prompt();
      const result = await installPrompt.userChoice;
      setInstallPrompt(null);
      if (result?.outcome === "accepted") {
        setIsStandaloneApp(true);
        alert("Uygulama indiriliyor.", "success");
      } else {
        setInstallGuide("manual");
      }
      return;
    }

    const isiPhone = /iphone|ipad|ipod/i.test(window.navigator?.userAgent || "");
    setInstallGuide(isiPhone ? "ios" : "manual");
  }

  function askConfirm(options) {
    setConfirmDialog(options);
  }

  async function handleAdminLogin(event) {
    event?.preventDefault?.();
    const submittedPin = pin.trim();

    if (!submittedPin) {
      setAdminLoginError("Yönetici PIN'ini girin.");
      return;
    }

    setAdminLoginLoading(true);
    setAdminLoginError("");

    try {
      const payload = await invokeAdminEdgeFunction("admin-session", {
        body: { pin: submittedPin },
      });

      if (!payload.token) throw new Error("Güvenli oturum oluşturulamadı. Lütfen tekrar deneyin.");

      sessionStorage.setItem(ADMIN_SESSION_KEY, payload.token);
      localStorage.removeItem(ADMIN_SESSION_KEY);
      skipNextAdminValidationRef.current = true;
      setAdminSessionToken(payload.token);
      setAdminSessionValidated(true);
      setAdminSessionChecking(false);
      setPin("");
      setAdminLoginError("");
    } catch (error) {
      sessionStorage.removeItem(ADMIN_SESSION_KEY);
      setAdminSessionToken("");
      setAdminSessionValidated(false);
      setAdminLoginError(error.message || "PIN doğrulanamadı. Bilgilerinizi kontrol edip tekrar deneyin.");
    } finally {
      setAdminLoginLoading(false);
    }
  }

  function logoutAdmin() {
    announcementPollGenerationRef.current += 1;
    announcementSendLockRef.current = false;
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    localStorage.removeItem(ADMIN_SESSION_KEY);
    setAdminSessionToken("");
    setAdminSessionValidated(false);
    setAdminSessionChecking(false);
    setAdminLoginError("");
    setPin("");
    setAnnouncementStatus(null);
    setAnnouncementError("");
    setAnnouncementLoading(false);
    setAnnouncementSending(false);
  }

  function expireAdminSession() {
    logoutAdmin();
    setNotice({ message: "Yönetici oturumunuzun süresi doldu. Lütfen yeniden giriş yapın.", tone: "error" });
  }

  async function refreshAnnouncementStatus({ silent = false } = {}) {
    if (!adminSessionToken) return null;
    if (!silent) {
      setAnnouncementLoading(true);
      setAnnouncementError("");
    }

    try {
      const payload = await invokeAdminEdgeFunction("send-customer-announcement", {
        token: adminSessionToken,
        body: { action: "status" },
      });
      const nextStatus = normalizeAnnouncementStatus(payload, announcementStatus || EMPTY_ANNOUNCEMENT_STATUS);
      setAnnouncementStatus(nextStatus);
      setAnnouncementError("");
      return nextStatus;
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        expireAdminSession();
        return null;
      }
      if (!silent) setAnnouncementError(error.message || "Duyuru durumu alınamadı. Durumu yenileyip tekrar deneyin.");
      return null;
    } finally {
      if (!silent) setAnnouncementLoading(false);
    }
  }

  async function sendCustomerAnnouncement() {
    if (!adminSessionToken || announcementSending || announcementSendLockRef.current) return;
    announcementSendLockRef.current = true;
    const generation = announcementPollGenerationRef.current + 1;
    announcementPollGenerationRef.current = generation;
    setAnnouncementSending(true);
    setAnnouncementError("");
    let progressTimer = null;

    try {
      let activeStatus = announcementStatus || EMPTY_ANNOUNCEMENT_STATUS;
      if (activeStatus.canStartNewRound) {
        if (!globalThis.crypto?.randomUUID) {
          throw new Error("Tarayıcınız güvenli gönderim kimliği oluşturamıyor. Sayfayı güncelleyip tekrar deneyin.");
        }
        const preparedPayload = await invokeAdminEdgeFunction("send-customer-announcement", {
          token: adminSessionToken,
          body: { action: "new-round", requestId: globalThis.crypto.randomUUID() },
        });
        if (announcementPollGenerationRef.current !== generation) return;
        activeStatus = normalizeAnnouncementStatus(preparedPayload, activeStatus);
        setAnnouncementStatus(activeStatus);
      }

      if (!activeStatus.canSend || !activeStatus.roundId) {
        throw new Error("Yeni gönderim turu hazırlanamadı. Durumu yenileyip tekrar deneyin.");
      }

      progressTimer = window.setTimeout(async function pollAnnouncementProgress() {
        try {
          const statusPayload = await invokeAdminEdgeFunction("send-customer-announcement", {
            token: adminSessionToken,
            body: { action: "status" },
          });
          if (announcementPollGenerationRef.current !== generation) return;
          setAnnouncementStatus((current) => normalizeAnnouncementStatus(statusPayload, current || EMPTY_ANNOUNCEMENT_STATUS));
        } catch {
          // The main send request owns final error and session feedback.
        } finally {
          if (announcementPollGenerationRef.current === generation) {
            progressTimer = window.setTimeout(pollAnnouncementProgress, 1_200);
          }
        }
      }, 1_200);

      const payload = await invokeAdminEdgeFunction("send-customer-announcement", {
        token: adminSessionToken,
        body: { action: "send", roundId: activeStatus.roundId },
      });
      if (announcementPollGenerationRef.current !== generation) return;
      const nextStatus = normalizeAnnouncementStatus(payload, activeStatus);
      setAnnouncementStatus(nextStatus);
      const resultTitle = nextStatus.failed > 0 || nextStatus.processing > 0
        ? `Tur ${nextStatus.roundNumber} kısmi tamamlandı.`
        : `Tur ${nextStatus.roundNumber} tamamlandı.`;
      alert([
        resultTitle,
        `Gönderilen: ${nextStatus.sent}`,
        `Başarısız: ${nextStatus.failed}`,
        `İşleniyor/belirsiz: ${nextStatus.processing}`,
        `Kalan: ${nextStatus.pending}`,
      ].join("\n"), nextStatus.failed > 0 || nextStatus.processing > 0 ? "warning" : "success");
    } catch (error) {
      if (announcementPollGenerationRef.current !== generation) return;
      if (error.status === 401 || error.status === 403) {
        expireAdminSession();
      } else {
        const message = error.message || "Duyuru gönderilemedi. Durumu yenileyip tekrar deneyin.";
        setAnnouncementError(message);
        alert(message, "error");
      }
    } finally {
      announcementPollGenerationRef.current += 1;
      if (progressTimer !== null) window.clearTimeout(progressTimer);
      announcementSendLockRef.current = false;
      setAnnouncementSending(false);
    }
  }

  function confirmCustomerAnnouncement() {
    if (!announcementTemplateApproved) {
      alert("Duyuru şablonu Meta tarafından onaylanmadan gönderim başlatılamaz.");
      return;
    }
    if (announcementSummary.locked) {
      alert("Bu gönderim turu için başka bir işlem devam ediyor. Durumu yenileyip tekrar kontrol edin.");
      return;
    }
    if (announcementSummary.processing > 0) {
      alert(`${announcementSummary.processing} alıcının sonucu belirsiz. Yanlışlıkla ikinci mesaj gitmemesi için yeni tur başlatılamaz.`, "warning");
      return;
    }
    if (announcementSummary.canStartNewRound) {
      const nextRound = Math.max(2, announcementSummary.roundNumber + 1);
      askConfirm({
        title: `Duyuru Tur ${nextRound} ile tekrar gönderilsin mi?`,
        message: `Tur ${announcementSummary.roundNumber} tamamlandı. Yeni Tur ${nextRound} oluşturulacak ve güncel izin kontrollerinden geçen en fazla ${announcementSummary.recipientCount} müşteriye ${ANNOUNCEMENT_DATE_LABEL} tarihli yeni adres duyurusu tekrar gönderilecek. Önceki turda mesaj alan müşteriler ikinci mesajı alabilir. Bu işlem geri alınamaz.`,
        confirmText: "Duyuruyu tekrar gönder",
        tone: "danger",
        onConfirm: sendCustomerAnnouncement,
      });
      return;
    }
    if (announcementSummary.pending <= 0) {
      alert(announcementSummary.failed > 0 ? "Bu tur kısmi tamamlandı; başarısız kayıtlar aynı tur içinde güvenlik nedeniyle yeniden gönderilmeyecek." : "Bu turdaki tüm müşterilere duyuru gönderildi.", announcementSummary.failed > 0 ? "warning" : "success");
      return;
    }
    if (!announcementSummary.canSend) {
      alert("Sunucu bu kampanya için yeni gönderime şu anda izin vermiyor. Durumu yenileyip tekrar kontrol edin.");
      return;
    }

    const isRepeatRound = announcementSummary.roundNumber > 1;
    askConfirm({
      title: isRepeatRound ? `Duyuru Tur ${announcementSummary.roundNumber} gönderilsin mi?` : "WhatsApp duyurusu gönderilsin mi?",
      message: `${announcementSummary.pending} müşteriye ${ANNOUNCEMENT_DATE_LABEL} tarihli yeni adres duyurusu ${isRepeatRound ? "tekrar " : ""}gönderilecek. Aynı tur içinde müşteriye ikinci kez mesaj gönderilmez. Yalnızca WhatsApp üzerinden iletişim izni bulunan müşterilere gönderdiğinizi onaylıyorsunuz.`,
      confirmText: `${announcementSummary.pending} müşteriye ${isRepeatRound ? "tekrar " : ""}gönder`,
      tone: isRepeatRound ? "danger" : undefined,
      onConfirm: sendCustomerAnnouncement,
    });
  }


  async function addAppointment(payload, options = {}) {
    const { allowClosedSlot = false } = options;
    if (!payload.customerName || normPhone(payload.phone).length < 10) return alert("Ad ve telefon girin.");
    if (!payload.serviceId || !serviceMap[payload.serviceId]) return alert("Hizmet seçin.");
    const selectedStaffKey = payload.staffId || activeStaff[0]?.id || "";
    if (!selectedStaffKey || !activeStaff.some((s) => s.id === selectedStaffKey)) {
      return alert("Bu personel şu anda aktif değil. Lütfen aktif bir personel seçin.");
    }
    const requestedService = serviceMap[payload.serviceId] || { time: 30 };
    const requestedStart = toMin(payload.time);
    const requestedEnd = requestedStart + Number(requestedService.time || 30);
    if (!allowClosedSlot && isBaseClosed(payload.date, payload.time, selectedStaffKey, payload.serviceId)) return alert("Bu saat uygun değil.");

    const hasLocalConflict = data.appointments.some((a) => {
      if (a.status !== "active" || a.date !== payload.date || a.staffId !== selectedStaffKey) return false;
      const otherStart = toMin(a.time);
      const otherEnd = otherStart + Number(serviceMap[a.serviceId]?.time || 30);
      return overlap(requestedStart, requestedEnd, otherStart, otherEnd);
    });

    if (hasLocalConflict) return alert("Bu saat uygun değil.");

    let latestRows = [];
    let latestError = null;

    try {
      const result = await supabase
        .from("appointments")
        .select("*")
        .eq("appointment_date", payload.date)
        .eq("staff_key", selectedStaffKey)
        .eq("status", "active");

      latestRows = result.data || [];
      latestError = result.error;
    } catch (error) {
      latestError = error;
    }

    if (latestError) {
      handleRemoteError("latest_appointments_check", "Latest appointments check error:", latestError, "appointments_check");
      alert(dbErrorMessage(latestError));
      return false;
    }

    const latestAppointments = (latestRows || []).map(normalizeAppointmentRow);
    const hasLiveConflict = latestAppointments.some((a) => {
      const otherService = serviceMap[a.serviceId] || { time: 30 };
      const otherStart = toMin(a.time);
      const otherEnd = otherStart + Number(otherService.time || 30);
      return overlap(requestedStart, requestedEnd, otherStart, otherEnd);
    });

    if (hasLiveConflict) {
      await loadRemoteAppointments();
      alert("Bu saat az önce doldu. Lütfen başka bir saat seçin.");
      return false;
    }

    let error = null;

    try {
      const result = await supabase
        .from("appointments")
        .insert([
        {
          customer_name: payload.customerName,
          phone: normPhone(payload.phone),
          service: payload.serviceId,
          appointment_date: payload.date,
          appointment_time: payload.time,
          staff_key: selectedStaffKey,
          staff_id: null,
          note: payload.note || "",
          status: "active",
          paid_amount: 0,
          remaining_debt: 0,
          payment_status: "pending",
        },
      ]);

      error = result.error;
    } catch (err) {
      error = err;
    }

    if (error) {
      handleRemoteError("appointment_insert", "Appointment insert error:", error, "appointments_insert");
      await loadRemoteAppointments();
      if (error.code === "23505") {
        alert("Bu saat az önce doldu. Lütfen başka bir saat seçin.");
      } else {
        alert(dbErrorMessage(error));
      }
      return false;
    }

    const appointmentForMessage = {
      ...payload,
      phone: normPhone(payload.phone),
      serviceName: serviceMap[payload.serviceId]?.name || payload.serviceId || "Randevu",
      staffName: staffMap[selectedStaffKey]?.name || selectedStaffKey,
      status: "active",
      paidAmount: 0,
      remainingDebt: 0,
    };

    setData((d) => ({
      ...d,
      appointments: [
        ...d.appointments,
        {
          ...appointmentForMessage,
          id: id(),
        },
      ],
    }));

    loadRemoteAppointments();
    sendAppointmentWhatsApp("appointment_created", appointmentForMessage);

    return true;
  }

  async function book() {
    if (!currentCustomer) return alert("Randevu almak için giriş yapın veya kayıt olun.");
    const safeStaff = activeStaff.find((s) => s.id === staffId);
    if (!safeStaff) {
      if (activeStaff[0]) setStaffId(activeStaff[0].id);
      setCustomerBookingStep("service");
      return alert(activeStaff.length ? "Seçtiğiniz personel şu anda aktif değil. Lütfen aktif bir personel seçin." : "Şu anda aktif personel bulunmuyor.");
    }

    const customerPhoneForDebt = normPhone(currentCustomer.phone || phone);
    const localUnpaidDebtCount = data.appointments.filter((a) => normPhone(a.phone) === customerPhoneForDebt && Number(a.remainingDebt || 0) > 0).length;
    let unpaidDebtCount = localUnpaidDebtCount;

    try {
      const { data: debtRows, error: debtError } = await supabase
        .from("appointments")
        .select("id, remaining_debt")
        .eq("phone", customerPhoneForDebt)
        .gt("remaining_debt", 0);

      if (debtError) {
        handleRemoteError("debt_check", "Debt check error:", debtError, "appointments_debt_check");
        alert(dbErrorMessage(debtError));
        return;
      }

      unpaidDebtCount = debtRows?.length || 0;
    } catch (error) {
      handleRemoteError("debt_check", "Debt check failed:", error, "appointments_debt_check");
      alert(dbErrorMessage(error));
      return;
    }

    if (unpaidDebtCount >= MAX_UNPAID_DEBT_APPOINTMENTS) {
      setDebtWarning({ count: unpaidDebtCount, phone: DEBT_CONTACT_PHONE });
      return;
    }

    const bookedService = selectedService;
    const bookedStaff = safeStaff;
    const bookedDate = date;
    const bookedTime = time;
    const bookedNote = note.trim();

    const ok = await addAppointment({
      customerName: currentCustomer.name || customerName,
      phone: currentCustomer.phone || phone,
      serviceId,
      staffId: safeStaff.id,
      date,
      time,
      note,
    });

    if (ok) {
      setCustomerName("");
      setPhone("");
      setNote("");
      setServiceId("");
      setCustomerPanel("appointments");
      setCustomerBookingStep("service");
      alert([
        "Randevu oluşturuldu.",
        "",
        "Randevu özeti",
        `Hizmet: ${bookedService?.name || "Hizmet"}`,
        `Personel: ${bookedStaff?.name || "Personel"}`,
        `Tarih: ${prettyDate(bookedDate)}`,
        `Saat: ${bookedTime}`,
        bookedService ? `Süre: ${bookedService.time} dk` : null,
        bookedService ? `Ücret: ${bookedService.price} TL` : null,
        bookedNote ? `Not: ${bookedNote}` : null,
      ].filter(Boolean).join("\n"), "success");
    }
  }

  function openCustomerDetail(phoneValue, returnTab = "customers") {
    if (!phoneValue) return;
    setCustomerDetailReturnTab(returnTab);
    setTab("customers");
    setSelectedCustomerPhone(phoneValue);
  }

  function closeCustomerDetail() {
    setSelectedCustomerPhone(null);
    if (customerDetailReturnTab !== "customers") {
      setTab(customerDetailReturnTab);
    }
    setCustomerDetailReturnTab("customers");
  }

  function openAdminBooking(slot) {
    const slotDateTime = new Date(`${adminDate}T${slot}:00`);
    if (slotDateTime <= new Date()) return alert("Geçmiş tarih veya saate randevu eklenemez.");

    const firstCustomer = adminCustomerOptions[0];
    setAdminBookingSlot({ date: adminDate, time: slot });
    setAdminBookingCustomerSearch("");
    setAdminBookingForm({
      customerPhone: firstCustomer?.phone || "",
      serviceId: data.services[0]?.id || "sac",
      staffId: adminAppointmentStaffId || data.staff.find((s) => s.active)?.id || data.staff[0]?.id || "mabel",
      note: "",
    });
  }

  async function createAdminBooking() {
    if (!adminBookingSlot) return;
    const customer = adminCustomerOptions.find((c) => c.phone === adminBookingForm.customerPhone);
    if (!customer) return alert("Müşteri seçin.");

    const ok = await addAppointment({
      customerName: customer.name,
      phone: customer.phone,
      serviceId: adminBookingForm.serviceId,
      staffId: adminBookingForm.staffId,
      date: adminBookingSlot.date,
      time: adminBookingSlot.time,
      note: adminBookingForm.note,
    }, { allowClosedSlot: true });

    if (ok) {
      setAdminBookingSlot(null);
      setAdminBookingForm((form) => ({ ...form, note: "" }));
    }
  }


  function saveCustomerSession(acc) {
    localStorage.setItem(CUSTOMER_SESSION_KEY, JSON.stringify({ id: acc.id, username: acc.username }));
  }

  function logoutCustomer() {
    localStorage.removeItem(CUSTOMER_SESSION_KEY);
    setCurrentCustomer(null);
    setCustomerPanel("booking");
    setCustomerBookingStep("service");
  }

  async function updateCustomerProfile() {
    if (!currentCustomer) return;
    const nextName = (profileForm.name || "").trim();
    const nextPhone = normPhone(profileForm.phone || "");
    const nextUsername = (profileForm.username || "").trim();
    const nextPassword = profileForm.password || "";

    if (!nextName || nextPhone.length < 10 || !nextUsername || !nextPassword) {
      return alert("Ad soyad, telefon, kullanıcı adı ve şifre zorunlu.");
    }

    const usernameTaken = (data.customerAccounts || []).some((u) => u.username === nextUsername && u.id !== currentCustomer.id);
    if (usernameTaken) return alert("Bu kullanıcı adı başka müşteri tarafından kullanılıyor.");

    const phoneTaken = (data.customerAccounts || []).some((u) => normPhone(u.phone) === nextPhone && u.id !== currentCustomer.id);
    if (phoneTaken) return alert("Bu telefon başka müşteri tarafından kullanılıyor.");

    const updated = {
      ...currentCustomer,
      name: nextName,
      phone: nextPhone,
      username: nextUsername,
      password: nextPassword,
    };

    const oldPhone = currentCustomer.phone;

    if (oldPhone !== updated.phone || currentCustomer.name !== updated.name) {
      const { error } = await supabase
        .from("appointments")
        .update({
          customer_name: updated.name,
          phone: updated.phone,
        })
        .eq("phone", oldPhone);

      if (error) {
        handleRemoteError("profile_appointments_update", "Profile appointment update error:", error, "appointments_profile_update");
        alert(dbErrorMessage(error));
        return;
      }
    }

    setData((d) => ({
      ...d,
      customerAccounts: (d.customerAccounts || []).map((u) => u.id === currentCustomer.id ? updated : u),
      appointments: d.appointments.map((a) => normPhone(a.phone) === normPhone(oldPhone) ? { ...a, customerName: updated.name, phone: updated.phone } : a),
    }));
    setCurrentCustomer(updated);
    setCustomerName(updated.name);
    setPhone(updated.phone);
    setProfileForm({
      name: updated.name || "",
      phone: updated.phone || "",
      username: updated.username || "",
      password: updated.password || "",
    });
    saveCustomerSession(updated);
    loadRemoteAppointments();
    alert("Profil güncellendi.");
  }

  function registerCustomer() {
    if (!customerRegister.username || !customerRegister.password || normPhone(customerRegister.phone).length < 10) return alert("Kullanıcı adı, şifre ve telefon zorunlu.");
    if ((data.customerAccounts || []).some((u) => u.username === customerRegister.username)) return alert("Bu kullanıcı adı zaten var.");
    const acc = { ...customerRegister, phone: normPhone(customerRegister.phone), name: customerRegister.name || customerRegister.username, id: id() };
    setData((d) => ({ ...d, customerAccounts: [...(d.customerAccounts || []), acc] }));
    setCurrentCustomer(acc);
    setCustomerPanel("booking");
    setCustomerBookingStep("service");
    setCustomerName(acc.name);
    setPhone(acc.phone);
    setProfileForm({ name: acc.name, phone: acc.phone, username: acc.username, password: acc.password });
    saveCustomerSession(acc);
  }

  function loginCustomer() {
    const acc = (data.customerAccounts || []).find((u) => u.username === customerLogin.username && u.password === customerLogin.password);
    if (!acc) return alert("Kullanıcı adı veya şifre hatalı.");
    setCurrentCustomer(acc);
    setCustomerPanel("booking");
    setCustomerBookingStep("service");
    setCustomerName(acc.name);
    setPhone(acc.phone);
    setProfileForm({ name: acc.name || "", phone: acc.phone || "", username: acc.username || "", password: acc.password || "" });
    saveCustomerSession(acc);
  }

  function recoverCustomerAccount() {
    const normalizedPhone = normPhone(customerRecovery.phone);
    const normalizedName = normText(customerRecovery.name);
    const nextPassword = customerRecovery.newPassword.trim();

    if (normalizedPhone.length < 10 || !normalizedName || nextPassword.length < 4) {
      return alert("Telefon, ad soyad ve en az 4 karakter yeni şifre girin.");
    }

    const acc = (data.customerAccounts || []).find((u) =>
      normPhone(u.phone) === normalizedPhone &&
      normText(u.name || u.username) === normalizedName
    );

    if (!acc) {
      return alert("Bu telefon ve ad soyad ile kayıtlı müşteri bulunamadı.");
    }

    const updated = { ...acc, password: nextPassword };

    setData((d) => ({
      ...d,
      customerAccounts: (d.customerAccounts || []).map((u) => u.id === acc.id ? updated : u),
    }));

    setCustomerLogin({ username: acc.username, password: "" });
    setCustomerRecovery({ phone: "", name: "", newPassword: "" });
    setCustomerAuthMode("login");
    alert(`Kullanıcı adınız: ${acc.username}\nYeni şifreniz kaydedildi. Bu kullanıcı adıyla giriş yapabilirsiniz.`);
  }

  function openComplete(a) {
    const price = Number(serviceMap[a.serviceId]?.price || 0);
    setComplete({ id: a.id, amount: price, paymentStatus: "paid", remainingDebt: 0, tariff: price, totalAmount: price });
  }

  async function saveComplete() {
    const total = Math.max(Number(complete.totalAmount ?? complete.tariff ?? 0), 0);
    let paid = Number(complete.amount || 0);
    let debt = Number(complete.remainingDebt || 0);
    if (complete.paymentStatus === "debt") { paid = 0; debt = total; }
    if (complete.paymentStatus === "partial") debt = Math.max(total - paid, 0);
    if (complete.paymentStatus === "paid" || complete.paymentStatus === "card") debt = 0;

    const { error } = await supabase
      .from("appointments")
      .update({
        status: "done",
        paid_amount: paid,
        remaining_debt: debt,
        payment_status: complete.paymentStatus,
      })
      .eq("id", complete.id);

    if (error) {
      handleRemoteError("complete_appointment", "Complete appointment error:", error, "appointments_complete");
      alert(dbErrorMessage(error));
      return;
    }

    setData((d) => ({ ...d, appointments: d.appointments.map((a) => a.id === complete.id ? { ...a, status: "done", paidAmount: paid, remainingDebt: debt, paymentStatus: complete.paymentStatus } : a) }));
    setComplete(null);
    loadRemoteAppointments();
  }

  async function payDebt() {
    const amount = Number(debtPay.amount || 0);
    const targets = debtPay.appointments?.length
      ? debtPay.appointments
      : data.appointments.filter((a) => a.id === debtPay.id);
    if (!targets.length || amount <= 0) return;

    let remainingPayment = amount;
    const updates = targets
      .slice()
      .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
      .map((target) => {
        const oldDebt = Number(target.remainingDebt || 0);
        const paid = Math.min(remainingPayment, oldDebt);
        remainingPayment -= paid;
        const nextDebt = Math.max(oldDebt - paid, 0);
        return {
          id: target.id,
          paidAmount: Number(target.paidAmount || 0) + paid,
          remainingDebt: nextDebt,
          paymentStatus: nextDebt > 0 ? "partial" : "paid",
        };
      })
      .filter((u) => targets.some((a) => a.id === u.id && Number(a.remainingDebt || 0) !== u.remainingDebt));

    const results = await Promise.all(updates.map((u) =>
      supabase
        .from("appointments")
        .update({
          paid_amount: u.paidAmount,
          remaining_debt: u.remainingDebt,
          payment_status: u.paymentStatus,
        })
        .eq("id", u.id)
    ));

    const error = results.find((r) => r.error)?.error;
    if (error) {
      handleRemoteError("debt_payment", "Debt payment error:", error, "appointments_debt_payment");
      alert(dbErrorMessage(error));
      return;
    }

    setData((d) => ({ ...d, appointments: d.appointments.map((a) => {
      const update = updates.find((u) => u.id === a.id);
      if (!update) return a;
      return { ...a, paidAmount: update.paidAmount, remainingDebt: update.remainingDebt, paymentStatus: update.paymentStatus };
    }) }));
    setDebtPay(null);
    loadRemoteAppointments();
  }

  async function cancelAppointment(apptId, confirmed = false) {
    if (!confirmed) {
      askConfirm({
        title: "Randevu iptal edilsin mi?",
        message: "Bu randevu iptal edildi olarak işaretlenecek. Eminseniz devam edin.",
        confirmText: "İptal Et",
        tone: "danger",
        onConfirm: async () => cancelAppointment(apptId, true),
      });
      return;
    }

    const appointment = data.appointments.find((x) => x.id === apptId);
    const { error } = await supabase
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", apptId);

    if (error) {
      handleRemoteError("cancel_appointment", "Cancel appointment error:", error, "appointments_cancel");
      alert(dbErrorMessage(error));
      return;
    }

    setData((d) => ({ ...d, appointments: d.appointments.map((x) => x.id === apptId ? { ...x, status: "cancelled" } : x) }));
    loadRemoteAppointments();
    if (appointment) {
      sendAppointmentWhatsApp("appointment_cancelled", {
        ...appointment,
        serviceName: serviceMap[appointment.serviceId]?.name || appointment.serviceId || "Randevu",
        staffName: staffMap[appointment.staffId]?.name || appointment.staffId,
      });
    }
  }

  async function deleteAppointment(apptId) {
    askConfirm({
      title: "Randevu silinsin mi?",
      message: "Bu işlem randevuyu tamamen kaldırır.",
      confirmText: "Sil",
      tone: "danger",
      onConfirm: async () => {
        const { error } = await supabase
          .from("appointments")
          .delete()
          .eq("id", apptId);

        if (error) {
          handleRemoteError("delete_appointment", "Delete appointment error:", error, "appointments_delete");
          alert(dbErrorMessage(error));
          return;
        }

        setData((d) => ({ ...d, appointments: d.appointments.filter((x) => x.id !== apptId) }));
        loadRemoteAppointments();
      },
    });
  }

  function startEditService(service) {
    setEditingService({ ...service });
  }

  function saveEditService() {
    if (!editingService?.name) return alert("Hizmet adı boş olamaz.");
    setData((d) => ({
      ...d,
      services: d.services.map((s) =>
        s.id === editingService.id
          ? { ...editingService, price: Number(editingService.price || 0), time: Number(editingService.time || 0) }
          : s
      ),
    }));
    setEditingService(null);
  }

  function addBlockedSlot() {
    if (!newBlock.date || !newBlock.startTime || !newBlock.endTime) return alert("Kapalı saat bilgilerini doldurun.");
    setData((d) => ({ ...d, blockedSlots: [...(d.blockedSlots || []), { ...newBlock, id: id() }] }));
    setNewBlock({ staffId: "all", date: todayISO(0), startTime: "12:00", endTime: "13:00", reason: "Kapalı" });
  }

  function toggleClosedWeekday(day) {
    setData((d) => {
      const closed = new Set((d.settings.closedWeekdays || []).map(Number));
      if (closed.has(day)) closed.delete(day);
      else closed.add(day);

      return {
        ...d,
        settings: {
          ...d.settings,
          closedWeekdays: WEEKDAYS.map((w) => w.value).filter((value) => closed.has(value)),
        },
      };
    });
  }

  function msg(a) {
    return `Sayın ${a.customerName}, Mabel Hair Art randevunuz ${prettyDate(a.date)} saat ${a.time}. Gelemeyecekseniz lütfen iptal etmeyi unutmayınız.`;
  }

  const adminDays = useMemo(() => {
    const weekday = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
    const today = todayISO(0);
    const tomorrow = addDaysISO(today, 1);
    const yesterday = addDaysISO(today, -1);
    const selected = adminDate || today;
    return Array.from({ length: 21 }, (_, i) => {
      const iso = addDaysISO(selected, i);
      const d = new Date(`${iso}T12:00:00`);
      return {
        iso,
        day: d.getDate(),
        label: iso === today ? "Bugün" : iso === tomorrow ? "Yarın" : iso === yesterday ? "Dün" : weekday[d.getDay()],
        month: d.toLocaleDateString("tr-TR", { month: "long" }),
        closed: isWeeklyClosed(data.settings, iso),
        count: data.appointments.filter((a) => a.date === iso && a.status === "active" && a.staffId === adminAppointmentStaffId).length,
      };
    });
  }, [adminAppointmentStaffId, adminDate, data.appointments, data.settings]);

  function getAdminDateBadge(iso) {
    if (isWeeklyClosed(data.settings, iso)) return { label: "Kapalı", tone: "bg-red-400/10 text-red-300" };
    const count = data.appointments.filter((a) => a.date === iso && a.status === "active" && a.staffId === adminAppointmentStaffId).length;
    return count ? { label: `${count} aktif`, tone: "bg-emerald-400/10 text-emerald-300" } : null;
  }

  function selectAdminDateFromPicker(value) {
    setAdminDate(value);
    setAdminDateStripStart(value);
  }

  function shiftAdminAppointmentStaff(delta) {
    const list = data.staff.filter((s) => s.active);
    if (!list.length) return;
    const currentIndex = Math.max(0, list.findIndex((s) => s.id === adminAppointmentStaffId));
    const nextIndex = (currentIndex + delta + list.length) % list.length;
    setAdminAppointmentStaffId(list[nextIndex].id);
  }

  const adminDateClosed = isWeeklyClosed(data.settings, adminDate);
  const adminSchedule = useMemo(() => {
    return slots
      .map((slot) => {
        const slotStart = toMin(slot);
        const dayAppointments = data.appointments.filter((a) => a.date === adminDate && a.staffId === adminAppointmentStaffId && (a.status === "active" || a.status === "done"));
        const appointment = dayAppointments.find((a) => a.time === slot);
        const coveredByAppointment = dayAppointments.find((a) => {
          if (a.time === slot || (a.status !== "active" && a.status !== "done")) return false;
          const appointmentStart = toMin(a.time);
          const appointmentEnd = appointmentStart + Number(serviceMap[a.serviceId]?.time || data.settings.slotStep || 30);
          return slotStart > appointmentStart && slotStart < appointmentEnd;
        });
        const block = (data.blockedSlots || []).find((b) => b.date === adminDate && (b.staffId === "all" || b.staffId === adminAppointmentStaffId) && b.startTime === slot);
        const closure = !appointment && block
          ? { label: block.reason || "Kapalı Saat", end: block.endTime }
          : !appointment && data.settings.lunchEnabled && data.settings.lunchStart === slot
            ? { label: "Yemek Saati", end: data.settings.lunchEnd }
            : null;
        if (isWeeklyClosed(data.settings, adminDate) && !appointment) return null;
        const duration = closure ? Math.max(toMin(closure.end) - toMin(slot), Number(data.settings.slotStep || 30)) : Number(serviceMap[appointment?.serviceId]?.time || data.settings.slotStep || 30);
        return {
          slot,
          end: toTime(toMin(slot) + duration),
          appointment,
          coveredByAppointment,
          closure,
        };
      })
      .filter(Boolean)
      .filter(({ appointment, coveredByAppointment }) => {
        if (coveredByAppointment) return false;
        return true;
      });
  }, [adminAppointmentStaffId, adminDate, data.appointments, data.blockedSlots, data.settings, serviceMap, slots]);
  const adminDayAppointments = data.appointments.filter((a) => a.date === adminDate && a.staffId === adminAppointmentStaffId && (a.status === "active" || a.status === "done"));
  const adminDayActiveCount = adminDayAppointments.filter((a) => a.status === "active").length;
  const adminDayDoneCount = adminDayAppointments.filter((a) => a.status === "done").length;
  const adminDayRevenue = adminDayAppointments.filter((a) => a.status === "done").reduce((s, a) => s + Number(a.paidAmount || 0), 0);
  const adminDayCardRevenue = adminDayAppointments.filter((a) => a.status === "done" && a.paymentStatus === "card").reduce((s, a) => s + Number(a.paidAmount || 0), 0);
  const adminDayDebt = adminDayAppointments.reduce((s, a) => s + Number(a.remainingDebt || 0), 0);
  const adminDayEmptyCount = adminDateClosed ? 0 : adminSchedule.filter((x) => !x.appointment).length;
  function trendMeta(current, previous, lowerIsBetter = false) {
    const diff = Number(current || 0) - Number(previous || 0);
    const pct = previous > 0 ? Math.round((diff / previous) * 100) : current > 0 ? 100 : 0;
    if (!diff) return { label: "%0", tone: "text-zinc-400 bg-white/10", icon: Minus };
    const positive = lowerIsBetter ? diff < 0 : diff > 0;
    return {
      label: `${diff > 0 ? "+" : ""}${pct}%`,
      tone: positive ? "text-emerald-300 bg-emerald-400/10" : "text-red-300 bg-red-400/10",
      icon: diff > 0 ? ArrowUpRight : ArrowDownRight,
    };
  }
  function RevenueMetric({ title, value, sub, current, previous, icon: Icon = TrendingUp, lowerIsBetter = false }) {
    const trend = trendMeta(current, previous, lowerIsBetter);
    const TrendIcon = trend.icon;
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.06] p-4 shadow-xl shadow-black/20">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="rounded-2xl bg-black/25 p-2 text-amber-200"><Icon className="h-5 w-5" /></div>
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-bold ${trend.tone}`}>
            <TrendIcon className="h-3.5 w-3.5" />{trend.label}
          </span>
        </div>
        <div className="text-sm text-zinc-400">{title}</div>
        <div className="mt-1 text-2xl font-black text-white">{value}</div>
        <div className="mt-1 text-xs text-zinc-500">{sub}</div>
      </div>
    );
  }
  function CompactRevenueMetric({ title, value, current, previous, compareLabel = "", icon: Icon = TrendingUp, lowerIsBetter = false }) {
    const trend = trendMeta(current, previous, lowerIsBetter);
    const TrendIcon = trend.icon;
    return (
      <div className="flex min-w-0 flex-col gap-3 rounded-2xl bg-white/[0.04] px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="rounded-xl bg-black/30 p-2 text-amber-200"><Icon className="h-4 w-4" /></span>
          <span className="min-w-0 flex-1">
            <span className="block whitespace-normal break-words text-xs leading-tight text-zinc-500">{title}</span>
            <b className="block text-[clamp(0.95rem,2.8vw,1.15rem)] font-black leading-tight text-white">{value}</b>
          </span>
        </div>
        <span className={`inline-flex w-fit max-w-full shrink-0 flex-wrap items-center gap-x-1 gap-y-0.5 self-start rounded-full px-2 py-1 text-[11px] font-bold leading-tight sm:self-center ${trend.tone}`} title={compareLabel}>
          <TrendIcon className="h-3 w-3" />
          <span>{trend.label}</span>
          {compareLabel && <span>{compareLabel}</span>}
        </span>
      </div>
    );
  }
  const adminTabs = [
    { key: "appointments", label: "Randevular", icon: CalendarDays },
    { key: "customers", label: "Müşteriler", icon: Users },
    { key: "debts", label: "Borçlar", icon: CreditCard },
    { key: "revenue", label: "Finans", icon: Activity },
    { key: "staff", label: "Personel", icon: UserRound },
    { key: "availability", label: "İzin / Kapalı", icon: CalendarDays },
    { key: "services", label: "Hizmetler", icon: Scissors },
    { key: "settings", label: "Çalışma Saatleri", icon: CalendarClock },
  ];
  const activeAdminTab = adminTabs.find((item) => item.key === tab) || adminTabs[0];
  const adminBottomTabs = [
    { key: "appointments", label: "Randevular", icon: CalendarDays },
    { key: "revenue", label: "Finans", icon: Activity },
    { key: "customers", label: "Müşteriler", icon: Users },
  ];
  const adminSettingsTabs = adminTabs.filter((item) => !["appointments", "customers", "revenue"].includes(item.key));
  const isAdminSettingsSection = adminSettingsTabs.some((item) => item.key === tab);
  const customerBottomTabs = [
    { key: "booking", label: "Randevu Al", icon: CalendarDays },
    { key: "appointments", label: "Randevularım", icon: Clock },
    { key: "profile", label: "Profilim", icon: UserRound },
  ];

  function rememberAppState() {
    if (typeof window !== "undefined") window.history.pushState({ mabelInternal: true }, "");
    setAppHistory((items) => [...items, { view, tab, customerPanel }].slice(-30));
  }

  function goCustomerPanel(nextPanel) {
    if (nextPanel === customerPanel) return;
    rememberAppState();
    setCustomerPanel(nextPanel);
  }

  function goView(nextView) {
    if (nextView === view) return;
    rememberAppState();
    setView(nextView);
    setAdminMenuOpen(false);
    setSelectedCustomerPhone(null);
  }

  function goAdminTab(nextTab) {
    if (nextTab === tab) return;
    const nextIsSettings = adminSettingsTabs.some((item) => item.key === nextTab);
    if (nextIsSettings && !isAdminSettingsSection) setAdminSettingsReturnTab(tab);
    if (!nextIsSettings) setAdminSettingsReturnTab(nextTab);
    rememberAppState();
    setSelectedCustomerPhone(null);
    setCustomerDetailReturnTab("customers");
    setTab(nextTab);
    setAdminMenuOpen(false);
  }

  function goBackInsideApp() {
    if (appHistory.length > 0 && typeof window !== "undefined") {
      window.history.back();
      return;
    }
    if (isAdminSettingsSection) {
      setSelectedCustomerPhone(null);
      setCustomerDetailReturnTab("customers");
      setTab(adminSettingsReturnTab || "appointments");
      setAdminMenuOpen(false);
    }
  }

  function openStaffRevenueDetail(idValue) {
    if (typeof window !== "undefined") window.history.pushState({ mabelModal: "staffRevenue" }, "");
    setStaffRevenueMonthOffset(0);
    setStaffRevenueDayOffset(0);
    setStaffRevenueWeekOffset(0);
    setStaffPeriodDetail(null);
    setStaffRevenueDetailId(idValue);
  }

  function closeStaffRevenueDetail() {
    setStaffPeriodDetail(null);
    setStaffRevenueDetailId(null);
  }

  function openRevenueFlow() {
    setRevenueFlowOpen(true);
    setRevenueFlowFullscreen(false);
  }

  function selectRevenueFlowPointFromPointer(event, shouldSelect = false) {
    if (!revenueFlowChartCoords.length) return;
    event.preventDefault?.();
    const rect = event.currentTarget.getBoundingClientRect();
    const viewX = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 640;
    let nearest = 0;
    revenueFlowChartCoords.forEach((point, index) => {
      if (Math.abs(point.x - viewX) < Math.abs(revenueFlowChartCoords[nearest].x - viewX)) nearest = index;
    });
    setRevenueFlowHoverIndex(nearest);
    if (shouldSelect) setRevenueFlowSelectedDate(revenueFlowChartCoords[nearest]?.iso || null);
  }

  async function enterRevenueFlowFullscreen() {
    setRevenueFlowFullscreen(true);
    const panel = document.getElementById("revenue-flow-panel");
    try {
      await panel?.requestFullscreen?.();
      await window.screen?.orientation?.lock?.("landscape");
    } catch {
      // Browser desteklemiyorsa sadece tam ekran düzeni uygulanır.
    }
  }

  async function exitRevenueFlowFullscreen() {
    setRevenueFlowFullscreen(false);
    try {
      window.screen?.orientation?.unlock?.();
      if (document.fullscreenElement) await document.exitFullscreen?.();
    } catch {
      // Sessiz geç; bazı mobil tarayıcılar çıkışı otomatik yönetir.
    }
  }

  useEffect(() => {
    const onPopState = () => {
      if (staffPeriodDetail) {
        setStaffPeriodDetail(null);
        return;
      }
      if (staffRevenueDetailId) {
        setStaffRevenueDetailId(null);
        return;
      }
      if (revenueFlowOpen) {
        exitRevenueFlowFullscreen();
        setRevenueFlowOpen(false);
        return;
      }
      setAppHistory((items) => {
        const previous = items[items.length - 1];
        if (!previous) return items;
        setView(previous.view);
        setTab(previous.tab);
        setCustomerPanel(previous.customerPanel);
        setAdminMenuOpen(false);
        setSelectedCustomerPhone(null);
        setCustomerDetailReturnTab("customers");
        return items.slice(0, -1);
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [staffPeriodDetail, staffRevenueDetailId, revenueFlowOpen]);

  useEffect(() => {
    const syncFullscreen = () => {
      if (!document.fullscreenElement) setRevenueFlowFullscreen(false);
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[#080808] text-white">
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute left-1/2 top-[-12rem] h-[34rem] w-[34rem] -translate-x-1/2 rounded-full bg-amber-500/20 blur-3xl" />
        <div className="absolute bottom-[-10rem] right-[-8rem] h-[28rem] w-[28rem] rounded-full bg-amber-700/10 blur-3xl" />
      </div>
      <header className="relative z-30 mx-auto flex max-w-7xl items-center justify-between gap-3 px-3 py-5 sm:px-5 sm:py-6">
        <div className="flex shrink-0 items-center gap-3">
          <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-amber-400/40 bg-amber-400/10 shadow-lg shadow-amber-500/10">
            <Scissors className="h-6 w-6 text-amber-300" />
          </div>
          <div className="hidden min-[390px]:block">
            <div className="text-xl font-semibold tracking-wide text-white">Mabel</div>
            <div className="-mt-1 text-xs tracking-[0.35em] text-amber-300">HAIR ART</div>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 justify-end gap-2 text-sm sm:flex-none sm:flex-wrap">
          {!isStandaloneApp && <button onClick={installApp} className="inline-flex min-w-0 items-center justify-center gap-1.5 rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-2 font-semibold text-amber-100 hover:bg-amber-300/15 sm:gap-2 sm:px-4">
            <Download className="h-4 w-4 shrink-0" /> <span className="sm:hidden">İndir</span><span className="hidden sm:inline">Uygulamayı İndir</span>
          </button>}
          <div className="relative min-w-0">
            <button
              type="button"
              onClick={() => {
                setPanelSwitchOpen(false);
                goView(view === "customer" ? "admin" : "customer");
              }}
              title={view === "customer" ? "Admin paneline geç" : "Müşteri paneline geç"}
              aria-label={view === "customer" ? "Admin paneline geç" : "Müşteri paneline geç"}
              className={`grid h-10 w-10 place-items-center rounded-full border text-sm font-bold transition ${view === "customer" ? "border-amber-300/60 bg-amber-300 text-black" : "border-white/10 bg-white/5 text-amber-200 hover:border-amber-300/35"}`}
            >
              {view === "customer" ? <ShieldCheck className="h-5 w-5" /> : <UserRound className="h-5 w-5" />}
            </button>
          </div>
        </div>
      </header>

      {remoteStatus.state === "offline" && (
        <div className="relative z-30 mx-auto w-full max-w-7xl px-3 pb-3 sm:px-5">
          <div className="flex flex-col gap-3 rounded-3xl border border-amber-300/25 bg-black/80 p-4 shadow-2xl shadow-amber-950/20 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <div className="rounded-2xl bg-amber-300/10 p-2 text-amber-200">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="font-bold text-amber-100">Veritabani baglantisi gecici olarak yenileniyor</div>
                <div className="mt-1 text-sm leading-5 text-zinc-300">
                  Supabase su an cevap vermiyor. Site otomatik tekrar deniyor; sayfayi yenilemen gerekmez.
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                loadRemoteAppState();
                loadRemoteAppointments();
              }}
              className="rounded-2xl bg-amber-300 px-4 py-2 text-sm font-bold text-black"
            >
              Tekrar dene
            </button>
          </div>
        </div>
      )}

      {view === "customer" && (
        <main className="relative z-10 mx-auto w-full max-w-7xl overflow-x-hidden px-3 pb-28 sm:px-5">
          {currentCustomer && customerPanel === "booking" && customerBookingStep === "datetime" && (
            <section className="py-4">
              <Card className="relative w-full max-w-full overflow-hidden">
                <div className="absolute right-0 top-0 h-32 w-32 rounded-bl-full bg-amber-300/10" />
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="text-2xl font-semibold">{densityTitle}</h2>
                  </div>
                  <div className="rounded-2xl border border-amber-300/30 bg-amber-300/10 p-3 text-amber-200">
                    <CalendarDays className="h-6 w-6" />
                  </div>
                </div>
                <div className="mt-8 rounded-3xl border border-white/10 bg-black/30 p-5">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="min-w-0 truncate text-3xl font-bold text-amber-200">{density.text}</div>
                    <div className="shrink-0 text-sm text-zinc-400">{density.pct}%</div>
                  </div>
                  <div className="h-3 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-amber-300" style={{ width: `${density.pct}%` }} />
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-zinc-300">
                    <span>{density.desc}</span>
                    <span className="rounded-full bg-white/10 px-2 py-1 text-xs text-zinc-400">{densityAvailable}/{densityCapacity || 0} uygun</span>
                  </div>
                </div>
              </Card>
            </section>
          )}

          <section id="randevu" className="grid gap-6">
            <Card className="max-w-full overflow-hidden">
              {!customerSessionChecked ? (
                <div className="rounded-3xl border border-amber-300/20 bg-amber-300/10 p-5">
                  <div className="h-3 w-32 rounded-full bg-amber-200/40" />
                  <div className="mt-4 h-11 rounded-2xl bg-black/25" />
                  <div className="mt-3 h-11 rounded-2xl bg-black/25" />
                </div>
              ) : !currentCustomer ? (
                <div className="rounded-3xl border border-amber-300/20 bg-amber-300/10 p-5">
                  <div className="mb-4 flex flex-wrap gap-2">
                    <button onClick={() => setCustomerAuthMode("login")} className={`rounded-full px-4 py-2 text-sm ${customerAuthMode === "login" ? "bg-amber-300 text-black" : "bg-black/30 text-zinc-200"}`}>Giriş Yap</button>
                    <button onClick={() => setCustomerAuthMode("register")} className={`rounded-full px-4 py-2 text-sm ${customerAuthMode === "register" ? "bg-amber-300 text-black" : "bg-black/30 text-zinc-200"}`}>Kayıt Ol</button>
                  </div>
                  {customerAuthMode === "login" ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      <Input placeholder="Kullanıcı adı" value={customerLogin.username} onChange={(e) => setCustomerLogin({ ...customerLogin, username: e.target.value })} />
                      <PasswordInput value={customerLogin.password} onChange={(e) => setCustomerLogin({ ...customerLogin, password: e.target.value })} />
                      <button onClick={loginCustomer} className="rounded-2xl bg-amber-300 px-5 py-3 font-bold text-black md:col-span-2"><UserRound className="mr-2 inline h-4 w-4" /> Giriş Yap</button>
                      <button type="button" onClick={() => setCustomerAuthMode("recovery")} className="rounded-2xl bg-black/30 px-5 py-3 text-sm font-semibold text-amber-200 md:col-span-2">Kullanıcı adımı veya şifremi unuttum</button>
                    </div>
                  ) : customerAuthMode === "register" ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      <Input placeholder="Ad Soyad" value={customerRegister.name} onChange={(e) => setCustomerRegister({ ...customerRegister, name: e.target.value })} />
                      <Input placeholder="Telefon" value={customerRegister.phone} onChange={(e) => setCustomerRegister({ ...customerRegister, phone: e.target.value })} />
                      <Input placeholder="Kullanıcı adı" value={customerRegister.username} onChange={(e) => setCustomerRegister({ ...customerRegister, username: e.target.value })} />
                      <PasswordInput value={customerRegister.password} onChange={(e) => setCustomerRegister({ ...customerRegister, password: e.target.value })} />
                      <button onClick={registerCustomer} className="rounded-2xl bg-amber-300 px-5 py-3 font-bold text-black md:col-span-2"><UserPlus className="mr-2 inline h-4 w-4" /> Kayıt Ol</button>
                    </div>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2">
                      <Input placeholder="Kayıtlı telefon" value={customerRecovery.phone} onChange={(e) => setCustomerRecovery({ ...customerRecovery, phone: e.target.value })} />
                      <Input placeholder="Ad Soyad" value={customerRecovery.name} onChange={(e) => setCustomerRecovery({ ...customerRecovery, name: e.target.value })} />
                      <PasswordInput placeholder="Yeni şifre" value={customerRecovery.newPassword} onChange={(e) => setCustomerRecovery({ ...customerRecovery, newPassword: e.target.value })} className="md:col-span-2" />
                      <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-zinc-300 md:col-span-2">
                        Telefon ve ad soyad kaydınızla eşleşirse kullanıcı adınız gösterilir, yeni şifreniz kaydedilir.
                      </div>
                      <button onClick={recoverCustomerAccount} className="rounded-2xl bg-amber-300 px-5 py-3 font-bold text-black md:col-span-2">Bilgilerimi Güncelle</button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="min-w-0 overflow-hidden">
                  {customerPanel === "booking" && (
                    <div className="min-w-0 max-w-full space-y-6 overflow-hidden">
                      <div className="grid min-w-0 grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                        <button onClick={() => setCustomerBookingStep("service")} className={`min-w-0 rounded-2xl border px-4 py-3 text-left ${customerBookingStep === "service" ? "border-amber-300 bg-amber-300 text-black" : "border-white/10 bg-black/20 text-zinc-300"}`}><b>1</b> Hizmet & Personel</button>
                        <button onClick={() => serviceId ? setCustomerBookingStep("datetime") : alert("Önce hizmet seçin.")} className={`min-w-0 rounded-2xl border px-4 py-3 text-left ${customerBookingStep === "datetime" ? "border-amber-300 bg-amber-300 text-black" : "border-white/10 bg-black/20 text-zinc-300"}`}><b>2</b> Tarih & Saat</button>
                      </div>

                      {customerBookingStep === "service" && (
                        <div className="space-y-8">
                          <div>
                            <h3 className="mb-3 flex items-center gap-2 font-semibold"><Scissors className="h-5 w-5 text-amber-300" /> Hizmet Seç</h3>
                            <div className="grid gap-3 md:grid-cols-2">
                              {data.services.map((s) => (
                                <button key={s.id} onClick={() => setServiceId(s.id)} className={`rounded-2xl border p-4 text-left transition ${serviceId === s.id ? "border-amber-300 bg-amber-300/10" : "border-white/10 bg-black/20 hover:border-white/25"}`}>
                                  <div className="flex items-center justify-between gap-3">
                                    <b>{s.name}</b>
                                    <span className="text-amber-200">{s.price} TL</span>
                                  </div>
                                  <p className="mt-2 text-sm text-zinc-400">{s.desc}</p>
                                  <div className="mt-3 text-xs text-zinc-500">Süre: {s.time} dk</div>
                                </button>
                              ))}
                            </div>
                          </div>

                          <div>
                            <h3 className="mb-3 flex items-center gap-2 font-semibold"><Users className="h-5 w-5 text-amber-300" /> Personel Seç</h3>
                            <div className="grid gap-3 md:grid-cols-2">
                              {activeStaff.map((s) => (
                                <button key={s.id} onClick={() => setStaffId(s.id)} className={`rounded-2xl border p-4 text-left transition ${staffId === s.id ? "border-amber-300 bg-amber-300/10" : "border-white/10 bg-black/20 hover:border-white/25"}`}>
                                  <b>{s.name}</b>
                                  <div className="mt-1 text-sm text-zinc-400">{s.role}</div>
                                </button>
                              ))}
                              {activeStaff.length === 0 && (
                                <div className="rounded-2xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-200">
                                  Şu anda aktif personel bulunmuyor.
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-zinc-300">
                            {serviceId ? <>Seçiminiz hazır. Üstteki <b className="text-amber-200">2 Tarih & Saat</b> adımına dokunup uygun saati seçin.</> : <>Önce almak istediğiniz hizmeti seçin.</>}
                          </div>
                        </div>
                      )}

                      {customerBookingStep === "datetime" && (
                        <div className="min-w-0 max-w-full space-y-6 overflow-hidden">
                          <CustomerDateStrip value={date} onChange={setDate} maxDays={30} />
                          <div className="min-w-0">
                            <h3 className="mb-3 flex items-center gap-2 font-semibold"><Clock className="h-5 w-5 text-amber-300" /> Uygun Saatler</h3>
                            <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                              {availableSlots.map((s) => (
                                <button key={s} onClick={() => setTime(s)} className={`min-w-0 rounded-2xl border px-3 py-3 text-sm transition ${time === s ? "border-amber-300 bg-amber-300 text-black" : "border-white/10 bg-black/20 hover:border-white/25"}`}>{s}</button>
                              ))}
                              {availableSlots.length === 0 && <div className={`col-span-full rounded-2xl border p-4 text-sm ${selectedDateWeeklyClosed ? "border-amber-300/25 bg-amber-300/10 text-amber-100" : "border-red-400/20 bg-red-400/10 text-red-200"}`}>{noAvailableSlotMessage}</div>}
                            </div>
                          </div>
                          <Textarea placeholder="Not / İstek" value={note} onChange={(e) => setNote(e.target.value)} className="min-h-24 w-full py-4" />
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <button onClick={() => setCustomerBookingStep("service")} className="rounded-2xl bg-white/10 px-5 py-4 font-semibold">Geri</button>
                            <button onClick={book} disabled={!serviceId || !selectedStaffIsActive || !availableSlots.length} className="flex-1 rounded-2xl bg-amber-300 px-5 py-4 font-bold text-black shadow-xl shadow-amber-500/20 disabled:opacity-40">Randevuyu Oluştur</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {customerPanel === "appointments" && (
                    <div className="space-y-4">
                      <div>
                        <h4 className="mb-2 font-semibold text-white">Aktif Randevularım</h4>
                        <div className="space-y-2">
                          {myActiveAppointments.length === 0 && <div className="rounded-2xl bg-black/30 p-3 text-sm text-zinc-300">Aktif randevunuz yok.</div>}
                          {myActiveAppointments.map((a) => (
                            <div key={a.id} className="rounded-2xl bg-black/30 p-4">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <b>{prettyDate(a.date)} · {a.time}</b>
                                  <div className="text-sm text-zinc-400">{serviceMap[a.serviceId]?.name} · {staffMap[a.staffId]?.name}</div>
                                  {a.note && <div className="mt-1 text-xs text-zinc-500">Not: {a.note}</div>}
                                </div>
                                <button onClick={() => cancelAppointment(a.id)} className="rounded-xl bg-red-400/10 px-3 py-2 text-xs text-red-300">İptal Et</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/25">
                        <button
                          type="button"
                          onClick={() => setCustomerPastOpen((open) => !open)}
                          className="flex w-full items-center justify-between gap-3 p-3 text-left transition hover:bg-white/[0.03]"
                        >
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold text-zinc-200">Geçmiş / İptal Randevularım</span>
                            <span className="block text-xs text-zinc-500">{myPastAppointments.length} kayıt</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-zinc-300">{customerPastOpen ? "Gizle" : "Göster"}</span>
                            <ChevronDown className={`h-4 w-4 text-amber-200 transition ${customerPastOpen ? "rotate-180" : ""}`} />
                          </span>
                        </button>

                        {customerPastOpen && (
                          <div className="space-y-2 border-t border-white/10 p-3">
                            {myPastAppointments.length === 0 && <div className="rounded-2xl bg-black/30 p-3 text-sm text-zinc-300">Geçmiş randevunuz yok.</div>}
                            {myPastAppointments.slice(0, 8).map((a) => (
                              <div key={a.id} className="flex items-center justify-between gap-3 rounded-2xl bg-black/30 p-3">
                                <div className="min-w-0">
                                  <b className="block truncate text-sm text-zinc-100">{prettyDate(a.date)} · {a.time}</b>
                                  <div className="truncate text-xs text-zinc-400">{serviceMap[a.serviceId]?.name || "Hizmet"} · {staffMap[a.staffId]?.name || "Personel"}</div>
                                </div>
                                <Status value={a.status} />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {customerPanel === "profile" && (
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="mb-2 flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/25 p-4 md:col-span-2">
                        <div className="min-w-0">
                          <div className="truncate text-lg font-bold text-white">{currentCustomer.name}</div>
                          <div className="mt-1 text-sm text-zinc-400">{currentCustomer.phone}</div>
                        </div>
                        <button onClick={logoutCustomer} className="shrink-0 rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-white/15">Çıkış</button>
                      </div>
                      <Input placeholder="Ad Soyad" value={profileForm.name} onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })} />
                      <Input placeholder="Telefon" value={profileForm.phone} onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })} />
                      <Input placeholder="Kullanıcı adı" value={profileForm.username} onChange={(e) => setProfileForm({ ...profileForm, username: e.target.value })} />
                      <PasswordInput value={profileForm.password} onChange={(e) => setProfileForm({ ...profileForm, password: e.target.value })} />
                      <button onClick={updateCustomerProfile} className="rounded-2xl bg-amber-300 px-5 py-3 font-bold text-black md:col-span-2">Profili Kaydet</button>
                    </div>
                  )}
                </div>
              )}
            </Card>

          </section>
        </main>
      )}

      {view === "customer" && currentCustomer && (
        <nav className="fixed inset-x-0 bottom-0 z-40 px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2">
          <div className="mx-auto grid max-w-lg grid-cols-3 gap-1.5 rounded-[1.7rem] border border-white/10 bg-white/[0.06] p-1.5 shadow-2xl shadow-black/30 backdrop-blur">
            {customerBottomTabs.map((item) => {
              const Icon = item.icon;
              const active = customerPanel === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => goCustomerPanel(item.key)}
                  className={`relative flex min-h-14 flex-col items-center justify-center gap-1 rounded-[1.25rem] px-2 text-[11px] font-bold transition sm:text-xs ${active ? "border border-[#ffd22e] bg-[#ffd22e] text-black shadow-[0_0_18px_rgba(255,210,46,0.20)]" : "border border-transparent text-zinc-300 hover:bg-white/10 hover:text-amber-100"}`}
                >
                  {active && <span className="absolute top-1.5 h-1 w-8 rounded-full bg-black/25" />}
                  <Icon className="h-5 w-5" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </nav>
      )}

      {view === "admin" && (
        <main className="relative z-10 mx-auto max-w-7xl px-5 pb-28">
          {adminSessionChecking && !adminSessionValidated ? (
            <Card className="mx-auto mt-12 max-w-md" role="status" aria-live="polite">
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-amber-300/10 text-amber-200">
                  <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                </span>
                <div>
                  <h2 className="text-xl font-bold">Güvenli oturum doğrulanıyor</h2>
                  <p className="mt-1 text-sm text-zinc-400">Yönetici erişiminiz sunucu üzerinden kontrol ediliyor.</p>
                </div>
              </div>
            </Card>
          ) : !logged ? (
            <Card className="mx-auto mt-12 max-w-md">
              <form onSubmit={handleAdminLogin} aria-busy={adminLoginLoading} noValidate>
                <span className="mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-amber-300/10 text-amber-300">
                  <Lock className="h-6 w-6" aria-hidden="true" />
                </span>
                <h2 className="text-2xl font-bold">Admin Girişi</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-400">PIN sunucuda doğrulanır; yönetici oturumu bu tarayıcı sekmesi kapandığında sona erer.</p>
                <label htmlFor="admin-pin" className="mt-5 block text-sm font-semibold text-zinc-200">Yönetici PIN'i</label>
                <PasswordInput
                  id="admin-pin"
                  name="admin-pin"
                  value={pin}
                  onChange={(event) => {
                    setPin(event.target.value);
                    if (adminLoginError) setAdminLoginError("");
                  }}
                  disabled={adminLoginLoading}
                  autoComplete="current-password"
                  aria-invalid={Boolean(adminLoginError)}
                  aria-describedby={adminLoginError ? "admin-pin-error" : "admin-pin-help"}
                  className="mt-2"
                  required
                />
                <p id="admin-pin-help" className="mt-2 text-xs leading-5 text-zinc-500">Yetkili yönetici PIN'inizi girin.</p>
                {adminLoginError && <p id="admin-pin-error" role="alert" className="mt-2 text-sm font-semibold text-red-300">{adminLoginError}</p>}
                <button
                  type="submit"
                  disabled={adminLoginLoading}
                  className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl bg-amber-300 px-5 py-3 font-bold text-black transition hover:bg-amber-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {adminLoginLoading ? <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ShieldCheck className="h-5 w-5" aria-hidden="true" />}
                  {adminLoginLoading ? "Doğrulanıyor…" : "Güvenli Giriş Yap"}
                </button>
              </form>
            </Card>
          ) : (
            <>
              <div className="mb-6 flex items-center justify-between gap-3">
                <div>
                  <h1 className="text-3xl font-bold sm:text-4xl">Admin Panel</h1>
                  <p className="mt-1 text-sm font-semibold text-amber-200">{activeAdminTab.label}</p>
                </div>
                <div className="flex items-center gap-2">
                  {isAdminSettingsSection && (
                    <button type="button" onClick={goBackInsideApp} className="min-h-11 rounded-2xl border border-[#ffd22e]/30 bg-[#ffd22e]/10 px-4 py-2 font-bold text-[#ffd22e] transition hover:bg-[#ffd22e]/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300">
                      Geri
                    </button>
                  )}
                  <button type="button" onClick={logoutAdmin} className="inline-flex min-h-11 items-center rounded-2xl bg-white/10 px-4 py-2 transition hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"><LogOut className="mr-2 h-4 w-4" aria-hidden="true" />Çıkış</button>
                </div>
              </div>

              {tab === "appointments" && <Card className="p-4 sm:p-5">
                <div className="mb-5">
                  <CustomerDateStrip
                    value={adminDate}
                    onChange={setAdminDate}
                    startDate={adminDateStripStart}
                    maxDays={30}
                    title="Tarih Seç"
                    rightLabel={`Seçili ${prettyDate(adminDate)}`}
                    getBadge={getAdminDateBadge}
                    headerAction={
                      <DatePicker
                        value={adminDate}
                        onChange={selectAdminDateFromPicker}
                        className="w-auto"
                        triggerClassName="inline-flex items-center gap-2 rounded-2xl border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-sm font-black text-amber-100 outline-none transition hover:border-amber-300/40 hover:bg-amber-300/15"
                        triggerContent={
                          <>
                            <CalendarDays className="h-5 w-5 text-amber-300" />
                            <span>Tarih Seç</span>
                            <ChevronDown className="h-4 w-4 text-amber-200" />
                          </>
                        }
                      />
                    }
                  />
                </div>

                <div className="mb-4 overflow-visible rounded-2xl border border-amber-300/20 bg-black/35 shadow-xl shadow-black/20">
                  <div className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
                    <button
                      type="button"
                      onClick={() => setAdminSummaryOpen((open) => !open)}
                      className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-2xl text-left transition hover:bg-white/[0.03] sm:pr-2"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="rounded-xl bg-amber-300/10 p-2 text-amber-200">
                          <CalendarDays className="h-5 w-5" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-xs text-zinc-400">Günün Özeti</span>
                          <span className="block truncate text-base font-bold text-white sm:text-lg">{prettyDate(adminDate)}</span>
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-sm">
                        <span className={`rounded-full px-3 py-1 font-bold ${adminDateClosed ? "bg-red-400/10 text-red-300" : "bg-emerald-400/10 text-emerald-300"}`}>
                          {adminDateClosed ? "Kapalı" : `${adminDayAppointments.length} randevu`}
                        </span>
                        <ChevronDown className={`h-5 w-5 text-amber-200 transition ${adminSummaryOpen ? "rotate-180" : ""}`} />
                      </span>
                    </button>
                    <div className="flex w-full items-center justify-between gap-2 rounded-2xl border border-white/10 bg-black/30 px-3 py-2 sm:w-64">
                      <button type="button" onClick={() => shiftAdminAppointmentStaff(-1)} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/10 text-amber-200 transition hover:bg-amber-300/10">
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <div className="min-w-0 text-center">
                        <div className="truncate text-sm font-black text-white">{staffMap[adminAppointmentStaffId]?.name || "Personel"}</div>
                        <div className="text-[11px] text-zinc-500">Personel</div>
                      </div>
                      <button type="button" onClick={() => shiftAdminAppointmentStaff(1)} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/10 text-amber-200 transition hover:bg-amber-300/10">
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {adminSummaryOpen && (
                    <div className="border-t border-white/10 p-3 sm:p-4">
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
                        <div className="rounded-xl border border-emerald-300/20 bg-emerald-400/10 p-3">
                          <div className="text-xs text-zinc-400">Aktif</div>
                          <div className="mt-1 text-xl font-black text-emerald-300">{adminDayActiveCount}</div>
                        </div>
                        <div className="rounded-xl border border-blue-300/20 bg-blue-400/10 p-3">
                          <div className="text-xs text-zinc-400">Tamamlanan</div>
                          <div className="mt-1 text-xl font-black text-blue-300">{adminDayDoneCount}</div>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
                          <div className="text-xs text-zinc-400">Tahsilat</div>
                          <div className="mt-1 text-lg font-black text-zinc-100">{money(adminDayRevenue)} TL</div>
                        </div>
                        <div className="rounded-xl border border-amber-300/20 bg-amber-300/10 p-3">
                          <div className="text-xs text-zinc-400">Kredi Kartı</div>
                          <div className="mt-1 text-lg font-black text-amber-100">{money(adminDayCardRevenue)} TL</div>
                        </div>
                        <div className="rounded-xl border border-red-300/20 bg-red-400/10 p-3">
                          <div className="text-xs text-zinc-400">Borç</div>
                          <div className="mt-1 text-lg font-black text-red-300">{money(adminDayDebt)} TL</div>
                        </div>
                        <div className="rounded-xl border border-white/10 bg-white/[0.04] p-3">
                          <div className="text-xs text-zinc-400">Durum</div>
                          <div className="mt-1 text-lg font-black text-amber-100">{adminDateClosed ? "Kapalı" : "Açık"}</div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  {adminSchedule.map(({ slot, end, appointment, closure }) => appointment ? (
                    <div key={`${slot}-${appointment.id}`} className={`min-h-[5.25rem] rounded-2xl border px-4 py-2.5 ${appointment.status === "active" ? "border-amber-300/30 bg-amber-300/10" : appointment.status === "done" ? "border-blue-300/20 bg-blue-400/10" : "border-white/10 bg-white/[0.04]"}`}>
                      <div className="flex h-full items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-400">
                            <span className="shrink-0 font-semibold text-zinc-200">{slot}-{end}</span>
                            <AppointmentStatus appointment={appointment} />
                          </div>
                          <button onClick={() => openCustomerDetail(appointment.phone, "appointments")} className="mt-1 block max-w-full truncate text-left text-base font-bold text-amber-200 sm:text-lg">{appointment.customerName}</button>
                          <div className="mt-0.5 max-w-full truncate text-xs text-zinc-400">
                            {serviceMap[appointment.serviceId]?.name} · {serviceMap[appointment.serviceId]?.price} TL
                          </div>
                          {appointment.note && <div className="mt-1 max-w-full truncate text-xs text-zinc-300"><span className="font-semibold text-amber-200">Not:</span> {appointment.note}</div>}
                        </div>
                        <div className="grid shrink-0 grid-cols-3 gap-1 sm:flex sm:items-center sm:gap-2">
                          <button title="Tamamla" onClick={() => openComplete(appointment)} className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-blue-400/10 text-xs font-semibold text-blue-300 sm:h-9 sm:w-auto sm:px-3"><Check className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">Tamamla</span></button>
                          <button title="İptal" onClick={() => cancelAppointment(appointment.id)} className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-red-400/10 text-xs font-semibold text-red-300 sm:h-9 sm:w-auto sm:px-3"><X className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">İptal</span></button>
                          <button title="Sil" onClick={() => deleteAppointment(appointment.id)} className="inline-flex h-8 w-8 items-center justify-center rounded-xl bg-white/10 text-xs font-semibold sm:h-9 sm:w-auto sm:px-3"><Trash2 className="h-3.5 w-3.5 sm:mr-1" /><span className="hidden sm:inline">Sil</span></button>
                        </div>
                      </div>
                    </div>
                  ) : closure ? (
                    <div key={`${slot}-closure`} className="flex w-full items-center justify-between gap-3 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-left">
                      <div>
                        <div className="text-sm font-semibold text-zinc-300">{slot}-{end}</div>
                        <div className="mt-1 text-lg font-bold text-amber-100">{closure.label}</div>
                      </div>
                      <span className="rounded-xl bg-black/30 px-4 py-2 text-sm font-bold text-amber-200">Kapalı</span>
                    </div>
                  ) : (
                    <button type="button" key={slot} onClick={() => openAdminBooking(slot)} disabled={!adminCustomerOptions.length} className="flex w-full items-center justify-between gap-3 rounded-2xl border border-emerald-300/20 bg-emerald-400/10 p-4 text-left transition hover:border-amber-300/40 hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-50">
                      <div>
                        <div className="text-sm font-semibold text-zinc-300">{slot}-{end}</div>
                        <div className="mt-1 text-lg font-bold text-emerald-200">Boş</div>
                      </div>
                      <span className="rounded-xl bg-black/30 px-4 py-2 text-sm font-bold text-emerald-200">{adminCustomerOptions.length ? "Randevu Ekle" : "Müşteri Yok"}</span>
                    </button>
                  ))}
                  {adminSchedule.length === 0 && <div className="rounded-2xl border border-white/10 bg-black/30 p-5 text-sm text-zinc-300">{adminDateClosed ? "Bu gün haftalık kapalı gün olarak ayarlı." : "Aramaya uygun randevu bulunamadı."}</div>}
                </div>
              </Card>}

              {tab === "customers" && <Card className="p-4 sm:p-5">
                <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h2 className="text-2xl font-bold"><Users className="mr-2 inline text-amber-300" />Müşteriler</h2>
                    <p className="mt-1 text-sm text-zinc-400">Müşteri bilgileri, mevcut randevular ve geçmiş işlemler.</p>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-sm sm:flex">
                    <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 px-3 py-2"><b className="block text-amber-200">{customers.length}</b><span className="text-xs text-zinc-400">Müşteri</span></div>
                    <div className="rounded-2xl border border-white/10 bg-black/30 px-3 py-2"><b className="block text-emerald-300">{data.appointments.filter((a) => a.status === "active").length}</b><span className="text-xs text-zinc-400">Aktif</span></div>
                    <div className="rounded-2xl border border-red-300/20 bg-red-400/10 px-3 py-2"><b className="block text-red-300">{totalDebt} TL</b><span className="text-xs text-zinc-400">Borç</span></div>
                  </div>
                </div>

                <section aria-labelledby="customer-announcement-title" className="mb-5 overflow-hidden rounded-3xl border border-amber-300/20 bg-gradient-to-br from-amber-300/[0.10] via-black/35 to-emerald-400/[0.05] shadow-xl shadow-black/20">
                  <div className="flex flex-col gap-3 border-b border-white/10 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-amber-300 text-black shadow-lg shadow-amber-500/10">
                        <Megaphone className="h-5 w-5" aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-xs font-black uppercase tracking-[0.16em] text-amber-200">WhatsApp toplu duyuru</p>
                        <h3 id="customer-announcement-title" className="mt-1 text-xl font-black text-white">Yeni adres duyurusu</h3>
                        <p className="mt-1 text-sm leading-6 text-zinc-400">Onaylı Meta şablonunu kayıtlı müşterilere güvenli ve ayrı gönderim turlarıyla gönderin.</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 self-start sm:self-center">
                      <span className={`inline-flex min-h-9 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black ${announcementTemplateApproved ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-200" : announcementLoading ? "border-white/10 bg-white/[0.05] text-zinc-300" : "border-amber-300/20 bg-amber-300/10 text-amber-100"}`} role="status" aria-live="polite">
                        {announcementLoading ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : announcementTemplateApproved ? <CircleCheck className="h-4 w-4" aria-hidden="true" /> : <CircleAlert className="h-4 w-4" aria-hidden="true" />}
                        {announcementTemplateLabel}
                      </span>
                      <button
                        type="button"
                        onClick={() => refreshAnnouncementStatus()}
                        disabled={announcementLoading || announcementSending}
                        className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-white/10 bg-black/30 text-zinc-300 transition hover:border-amber-300/30 hover:text-amber-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label="Duyuru durumunu yenile"
                        title="Duyuru durumunu yenile"
                      >
                        <RefreshCw className={`h-4 w-4 ${announcementLoading ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  <div className="grid gap-4 p-4 sm:p-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(22rem,0.9fr)]">
                    <div className="min-w-0 rounded-2xl border border-white/10 bg-black/35 p-4 sm:p-5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-black text-zinc-200">Mesaj önizlemesi</p>
                        <span className="max-w-full truncate rounded-full bg-white/[0.06] px-3 py-1 font-mono text-[11px] text-zinc-400" title={announcementSummary.template || undefined}>
                          {announcementSummary.template || "Şablon adı bekleniyor"}
                        </span>
                      </div>
                      <div className="mt-4 space-y-3 rounded-2xl border border-emerald-300/10 bg-emerald-950/20 p-4 text-sm leading-6 text-zinc-200">
                        <p>Merhaba <span className="rounded-md bg-amber-300/15 px-1.5 py-0.5 font-mono font-bold text-amber-100" title="Müşteri adı değişkeni">{"{{1}}"}</span> 🌸</p>
                        <p>Uzun bir aranın ardından Mabel Hair Art olarak yeniden hizmet vermeye başlıyorum.</p>
                        <p>{ANNOUNCEMENT_DATE_LABEL} tarihinden itibaren <strong className="font-black text-white">yeni adresimde</strong> sizlerle olacağım.</p>
                        <p>Randevu için: <strong className="font-black text-amber-100">mabelhairart.com.tr</strong></p>
                        <p>Sizi yeniden görmek dileğiyle.</p>
                        <p className="font-black text-white">Mabel Hair Art</p>
                        <div className="flex items-start gap-2 rounded-xl border border-white/10 bg-black/25 p-3 text-xs leading-5 text-zinc-300">
                          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" />
                          <span>Mesajdaki <strong className="text-emerald-200">Konumu Gör</strong> düğmesi müşteriyi yeni adresin harita konumuna yönlendirir.</span>
                        </div>
                      </div>
                    </div>

                    <div className="min-w-0 rounded-2xl border border-white/10 bg-black/35 p-4 sm:p-5" aria-live="polite">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-black text-zinc-200">Gönderim durumu</p>
                          <p className="mt-1 text-xs text-zinc-500">{announcementSummary.roundNumber > 0 ? `Tur ${announcementSummary.roundNumber} · ${announcementRoundStateLabel}` : "Gönderim turu sunucudan bekleniyor"}</p>
                        </div>
                        {(announcementSending || announcementSummary.locked) && <span className="inline-flex items-center gap-2 text-xs font-bold text-amber-200"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{announcementSending ? "İşleniyor" : "Kampanya kilitli"}</span>}
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5 xl:grid-cols-2">
                        {[
                          { label: "Toplam", value: announcementStatus ? announcementSummary.recipientCount : "—", tone: "text-white" },
                          { label: "Gönderilen", value: announcementStatus ? announcementSummary.sent : "—", tone: "text-emerald-300" },
                          { label: "Kalan", value: announcementStatus ? announcementSummary.pending : "—", tone: "text-amber-200" },
                          { label: "İşleniyor/Belirsiz", value: announcementStatus ? announcementSummary.processing : "—", tone: "text-blue-300" },
                          { label: "Başarısız", value: announcementStatus ? announcementSummary.failed : "—", tone: "text-red-300" },
                        ].map((metric) => (
                          <div key={metric.label} className="rounded-xl border border-white/[0.07] bg-white/[0.04] px-3 py-2.5">
                            <span className="block text-[11px] font-semibold text-zinc-500">{metric.label}</span>
                            <strong className={`mt-1 block text-xl font-black tabular-nums ${metric.tone}`}>{metric.value}</strong>
                          </div>
                        ))}
                      </div>

                      <div className="mt-4">
                        <div className="mb-2 flex items-center justify-between gap-2 text-xs text-zinc-400">
                          <span>{announcementSending ? "Gönderim ilerlemesi" : "İşlenen kayıt"}</span>
                          <span className="font-bold tabular-nums text-zinc-200">{announcementStatus ? `${announcementProcessed}/${announcementSummary.recipientCount}` : "—"}</span>
                        </div>
                        <div
                          className="h-2 overflow-hidden rounded-full bg-white/10"
                          role="progressbar"
                          aria-label="Duyuru gönderim ilerlemesi"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={announcementProgress}
                          aria-valuetext={announcementStatus ? `${announcementProcessed} / ${announcementSummary.recipientCount} kayıt işlendi; ${announcementSummary.processing} kaydın sonucu belirsiz` : "Duyuru durumu bekleniyor"}
                        >
                          <div className={`h-full w-full origin-left rounded-full bg-gradient-to-r from-amber-300 to-emerald-300 transition-transform duration-300 motion-reduce:transition-none ${announcementSending ? "animate-pulse motion-reduce:animate-none" : ""}`} style={{ transform: `scaleX(${announcementProgress / 100})` }} />
                        </div>
                      </div>

                      {announcementError && <p role="alert" className="mt-4 rounded-xl border border-red-300/20 bg-red-400/10 p-3 text-xs font-semibold leading-5 text-red-200">{announcementError}</p>}
                      {announcementSummary.processing > 0 && <p role="status" className="mt-4 flex items-start gap-2 rounded-xl border border-blue-300/20 bg-blue-400/10 p-3 text-xs font-semibold leading-5 text-blue-100"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>{announcementSummary.processing} alıcının gönderim sonucu belirsiz. Bu alıcılara yeniden gönderilmez, durum kontrol ediliyor.</span></p>}

                      <button
                        type="button"
                        onClick={confirmCustomerAnnouncement}
                        disabled={announcementActionDisabled}
                        aria-busy={announcementSending}
                        aria-describedby="announcement-action-help"
                        className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-amber-300 px-4 py-3 font-black text-black transition hover:bg-amber-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400 disabled:opacity-70"
                      >
                        {announcementSending || announcementSummary.locked ? <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : announcementSummary.canStartNewRound ? <Send className="h-5 w-5" aria-hidden="true" /> : announcementSummary.pending <= 0 && announcementStatus ? <CircleCheck className="h-5 w-5" aria-hidden="true" /> : <Send className="h-5 w-5" aria-hidden="true" />}
                        {announcementSending
                          ? `Gönderiliyor · ${announcementSummary.sent}/${announcementSummary.recipientCount}`
                          : announcementSummary.locked
                            ? "Gönderim devam ediyor"
                            : announcementSummary.canStartNewRound
                              ? "Duyuruyu tekrar gönder"
                            : announcementSummary.pending <= 0 && announcementStatus
                              ? announcementSummary.failed > 0 || announcementSummary.processing > 0 ? "Kısmi tamamlandı" : "Gönderim tamamlandı"
                              : !announcementSummary.canSend && announcementStatus
                                ? "Gönderim kullanılamıyor"
                                : "Duyuruyu gönder"}
                      </button>
                      <p id="announcement-action-help" className="mt-2 text-xs leading-5 text-zinc-500">
                        {!announcementTemplateApproved
                          ? "Ana gönderim eylemi yalnızca Meta şablon durumu APPROVED olduğunda açılır."
                          : announcementSummary.locked
                            ? "Başka bir güvenli gönderim çalışıyor; kampanya kilidi açılana kadar durum kontrol ediliyor."
                            : announcementSummary.processing > 0
                              ? `${announcementSummary.processing} alıcının sonucu belirsiz; yeniden gönderilmez, durum kontrol ediliyor.${announcementSummary.pending > 0 ? ` Kalan ${announcementSummary.pending} alıcı yeni gönderime uygundur.` : ""}`
                              : announcementSummary.canStartNewRound
                                ? `Tur ${announcementSummary.roundNumber} tamamlandı. Son onaydan sonra yeni tur oluşturulur ve uygun müşterilere duyuru tekrar gönderilir.`
                              : announcementSummary.pending <= 0 && announcementStatus
                                ? announcementSummary.failed > 0 ? "Kampanya kısmi tamamlandı; başarısız kayıtlar yeniden gönderilmez." : "Bu kampanyadaki tüm alıcılar işlendi."
                                : !announcementSummary.canSend && announcementStatus
                                  ? "Sunucu bu kampanya için yeni gönderime şu anda izin vermiyor."
                                  : `${announcementSummary.pending} müşteriye gönderim için son onayınız istenecek.`}
                      </p>
                    </div>
                  </div>
                </section>

                {!selectedCustomerPhone ? (
                  <>
                    <div className="mb-4 flex items-center gap-3 rounded-2xl border border-white/10 bg-black/30 px-3 py-2">
                      <Search className="h-5 w-5 shrink-0 text-zinc-400" />
                      <Input placeholder="Müşteri ara: ad veya telefon" value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} className="w-full border-0 bg-transparent p-0" />
                    </div>

                    <div className="grid gap-3 lg:grid-cols-2">
                      {filteredCustomers.map((c) => {
                        const activeCount = data.appointments.filter((a) => a.phone === c.phone && a.status === "active").length;
                        return (
                          <button key={c.phone} onClick={() => openCustomerDetail(c.phone, "customers")} className="rounded-2xl border border-white/10 bg-black/30 p-4 text-left transition hover:border-amber-300/40 hover:bg-amber-300/5">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-lg font-bold text-white">{c.name}</div>
                                <div className="mt-1 text-sm text-zinc-400">{c.phone}</div>
                              </div>
                              <span className="rounded-full bg-amber-300/10 px-3 py-1 text-xs font-semibold text-amber-200">Detay</span>
                            </div>
                            <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">
                              <div className="rounded-xl bg-white/[0.05] px-2 py-2"><b className="block text-zinc-100">{c.count}</b><span className="text-zinc-500">Toplam</span></div>
                              <div className="rounded-xl bg-emerald-400/10 px-2 py-2"><b className="block text-emerald-300">{activeCount}</b><span className="text-zinc-500">Aktif</span></div>
                              <div className="rounded-xl bg-red-400/10 px-2 py-2"><b className="block text-red-300">{c.debt} TL</b><span className="text-zinc-500">Borç</span></div>
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {filteredCustomers.length === 0 && <div className="rounded-2xl bg-black/30 p-5 text-sm text-zinc-300">Aramaya uygun müşteri bulunamadı.</div>}
                  </>
                ) : (
                  <div>
                    <button onClick={closeCustomerDetail} className="mb-4 rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold">Geri</button>

                    <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
                      <div className="h-fit rounded-2xl border border-amber-300/20 bg-amber-300/10 p-5">
                        <div className="text-sm text-amber-200">Müşteri Profili</div>
                        <h3 className="mt-2 text-2xl font-bold">{selectedCustomer?.name || "Müşteri"}</h3>
                        <div className="mt-1 text-sm text-zinc-300">{selectedCustomerPhone}</div>
                        <div className="mt-5 grid grid-cols-2 gap-2 text-center text-sm">
                          <div className="rounded-xl bg-black/30 px-3 py-3"><b className="block text-white">{selectedCustomer?.count || 0}</b><span className="text-xs text-zinc-400">Randevu</span></div>
                          <div className="rounded-xl bg-black/30 px-3 py-3"><b className="block text-emerald-300">{selectedCustomerActiveAppointments.length}</b><span className="text-xs text-zinc-400">Mevcut</span></div>
                          <div className="rounded-xl bg-black/30 px-3 py-3"><b className="block text-red-300">{selectedCustomer?.debt || 0} TL</b><span className="text-xs text-zinc-400">Borç</span></div>
                        </div>
                        <div className="mt-4 grid grid-cols-3 gap-2">
                          <a target="_blank" rel="noreferrer" href={wa(selectedCustomerPhone)} className="rounded-2xl bg-emerald-400/10 px-3 py-3 text-center text-sm font-semibold text-emerald-300"><MessageCircle className="mx-auto mb-1 h-4 w-4" />WhatsApp</a>
                          <a href={sms(selectedCustomerPhone)} className="rounded-2xl bg-blue-400/10 px-3 py-3 text-center text-sm font-semibold text-blue-300"><MessageCircle className="mx-auto mb-1 h-4 w-4" />SMS</a>
                          <a href={tel(selectedCustomerPhone)} className="rounded-2xl bg-amber-300/10 px-3 py-3 text-center text-sm font-semibold text-amber-200"><PhoneCall className="mx-auto mb-1 h-4 w-4" />Ara</a>
                        </div>
                      </div>

                      <div className="space-y-5">
                        <div>
                          <h3 className="mb-3 text-xl font-bold text-emerald-200">Mevcut Randevular</h3>
                          <div className="space-y-3">
                            {selectedCustomerActiveAppointments.length === 0 && <div className="rounded-2xl bg-black/30 p-4 text-sm text-zinc-300">Mevcut randevu yok.</div>}
                            {selectedCustomerActiveAppointments.map((a) => (
                              <div key={a.id} className="rounded-2xl border border-emerald-300/20 bg-emerald-400/10 p-4">
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                  <div>
                                    <b>{prettyDate(a.date)} · {a.time}</b>
                                    <div className="mt-1 text-sm text-zinc-300">{serviceMap[a.serviceId]?.name} · {staffMap[a.staffId]?.name}</div>
                                    {a.note && <div className="mt-1 text-xs text-zinc-500">Not: {a.note}</div>}
                                  </div>
                                  <div className="flex flex-wrap gap-2">
                                    <button onClick={() => openComplete(a)} className="rounded-xl bg-blue-400/10 px-3 py-2 text-xs font-semibold text-blue-300">Tamamla</button>
                                    <button onClick={() => cancelAppointment(a.id)} className="rounded-xl bg-red-400/10 px-3 py-2 text-xs font-semibold text-red-300">İptal</button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div>
                          <h3 className="mb-3 text-xl font-bold">Geçmiş / İptal Randevular</h3>
                          <div className="space-y-3">
                            {selectedCustomerPastAppointments.length === 0 && <div className="rounded-2xl bg-black/30 p-4 text-sm text-zinc-300">Geçmiş randevu yok.</div>}
                            {selectedCustomerPastAppointments.map((a) => (
                              <div key={a.id} className="rounded-2xl border border-white/10 bg-black/30 p-4">
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                  <div>
                                    <b>{prettyDate(a.date)} · {a.time}</b>
                                    <div className="mt-1 text-sm text-zinc-400">{serviceMap[a.serviceId]?.name} · {staffMap[a.staffId]?.name}</div>
                                    <div className="mt-2 text-sm">Alınan: {a.paidAmount || 0} TL {Number(a.remainingDebt || 0) > 0 && <span className="ml-2 text-red-300">Borç: {a.remainingDebt} TL</span>}</div>
                                  </div>
                                  <Status value={a.status} />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </Card>}

              {tab === "debts" && <Card className="p-4 sm:p-5">
                <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h2 className="text-2xl font-bold"><CreditCard className="mr-2 inline text-red-300" />Borçlar</h2>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-center text-sm sm:flex">
                    <div className="rounded-2xl border border-red-300/20 bg-red-400/10 px-4 py-3"><b className="block text-red-300">{totalDebt} TL</b><span className="text-xs text-zinc-400">Toplam Borç</span></div>
                    <div className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3"><b className="block text-white">{debtGroups.length}</b><span className="text-xs text-zinc-400">Borçlu Müşteri</span></div>
                  </div>
                </div>

                <div className="grid gap-4 xl:grid-cols-2">
                  {debtGroups.map((group) => (
                    <div key={group.phone || group.name} className="rounded-2xl border border-red-300/20 bg-red-400/10 p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <button onClick={() => openCustomerDetail(group.phone, "debts")} className="block max-w-full truncate text-left text-xl font-bold text-white">{group.name}</button>
                          <div className="mt-1 text-sm text-zinc-400">{group.phone}</div>
                        </div>
                        <div className="rounded-2xl bg-black/30 px-4 py-3 text-left sm:text-right">
                          <div className="text-xs text-zinc-400">Mevcut borç</div>
                          <div className="text-2xl font-bold text-red-300">{group.totalDebt} TL</div>
                        </div>
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-2 text-center text-sm">
                        <div className="rounded-xl bg-black/30 px-3 py-2"><b className="block text-zinc-100">{group.count}</b><span className="text-xs text-zinc-400">Borç kaydı</span></div>
                        <div className="rounded-xl bg-black/30 px-3 py-2"><b className="block text-amber-200">{group.paidAmount} TL</b><span className="text-xs text-zinc-400">Alınan</span></div>
                      </div>

                      <div className="mt-4 space-y-2">
                        {group.appointments.map((a) => (
                          <div key={a.id} className="rounded-xl border border-white/10 bg-black/25 p-3 text-sm">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <b>{prettyDate(a.date)} · {a.time}</b>
                                <div className="mt-1 text-zinc-400">{serviceMap[a.serviceId]?.name} · {staffMap[a.staffId]?.name}</div>
                              </div>
                              <div className="shrink-0 text-right font-bold text-red-300">{a.remainingDebt} TL</div>
                            </div>
                          </div>
                        ))}
                      </div>

                      <button onClick={() => setDebtPay({ phone: group.phone, name: group.name, amount: group.totalDebt, totalDebt: group.totalDebt, appointments: group.appointments })} className="mt-4 w-full rounded-2xl bg-amber-300 px-4 py-3 font-bold text-black">Ödeme Al</button>
                    </div>
                  ))}
                </div>

                {debtGroups.length === 0 && <div className="rounded-2xl border border-emerald-300/20 bg-emerald-400/10 p-5 text-sm text-emerald-200">Açık borç bulunmuyor.</div>}
              </Card>}

              {tab === "revenue" && <Card className="overflow-hidden p-4 sm:p-5">
                <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h2 className="text-2xl font-bold sm:text-3xl"><Activity className="mr-2 inline text-amber-300" />Finans Paneli</h2>
                    <p className="mt-1 text-sm text-zinc-400">Günlük, haftalık ve aylık durumu kompakt takip edin.</p>
                  </div>
                  <button
                    type="button"
                    onClick={openRevenueFlow}
                    className="inline-flex items-center justify-center gap-2 rounded-2xl border border-amber-300/25 bg-amber-300/10 px-4 py-3 text-sm font-bold text-amber-100 transition hover:bg-amber-300/15"
                  >
                    <TrendingUp className="h-4 w-4" /> Finans Akışı
                  </button>
                </div>

                <div className="rounded-3xl border border-white/10 bg-black/35 p-4 sm:p-5">
                  <div className="mb-3">
                    <div>
                      <h3 className="text-lg font-bold">Finans Özeti</h3>
                      <p className="text-xs text-zinc-500">Düne ve önceki dönemlere göre değişim</p>
                    </div>
                  </div>
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                    <CompactRevenueMetric title="Bugünkü Gelir" value={`${money(todayRevenue)} TL`} current={todayRevenue} previous={yesterdayRevenue} compareLabel="düne göre" icon={Wallet} />
                    <CompactRevenueMetric title="Bugünkü Randevu" value={todayAppointmentCount} current={todayAppointmentCount} previous={yesterdayAppointmentCount} compareLabel="düne göre" icon={CalendarDays} />
                    <CompactRevenueMetric title="Bu Hafta" value={`${money(weekRevenue)} TL`} current={weekRevenue} previous={previousWeekRevenue} compareLabel="geçen haftaya göre" icon={TrendingUp} />
                    <CompactRevenueMetric title="Bu Ay" value={`${money(monthRevenue)} TL`} current={monthRevenue} previous={previousMonthRevenue} compareLabel="geçen aya göre" icon={CreditCard} />
                  </div>
                </div>

                <div className="mt-4 rounded-3xl border border-white/10 bg-black/35 p-4 sm:p-5">
                  <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <h3 className="text-lg font-bold">Personel Kazancı</h3>
                      <p className="text-xs text-zinc-500">Tamamlanan randevulardan personele göre tahsilat</p>
                    </div>
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {staffRevenueRows.map((row) => (
                      <button key={row.id} type="button" onClick={() => openStaffRevenueDetail(row.id)} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-left transition hover:border-amber-300/40 hover:bg-amber-300/10">
                        <div className="mb-3 flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-base font-bold text-white">{row.name}</div>
                            <div className="text-xs text-zinc-500">{row.count} tamamlanan işlem</div>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="text-lg font-black text-amber-200">{money(row.amount)} TL</div>
                          </div>
                        </div>
                        <div className="text-xs font-semibold text-amber-200">Detayları gör</div>
                      </button>
                    ))}
                    {staffRevenueRows.length === 0 && <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-zinc-400">Henüz personele bağlı tamamlanan işlem yok.</div>}
                  </div>
                </div>

                <div className="mt-4">
                  <div className="overflow-hidden rounded-3xl border border-white/10 bg-black/30">
                    <button
                      type="button"
                      onClick={() => setMonthlyRevenueOpen((open) => !open)}
                      className="flex w-full items-center justify-between gap-3 p-4 text-left transition hover:bg-white/[0.03]"
                    >
                      <span>
                        <span className="block text-lg font-semibold">Aylık Performans</span>
                        <span className="text-xs text-zinc-500">12 aylık gelir dağılımı</span>
                      </span>
                      <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-zinc-300">
                        {monthlyRevenueOpen ? "Gizle" : "Göster"}
                        <ChevronDown className={`h-4 w-4 transition ${monthlyRevenueOpen ? "rotate-180" : ""}`} />
                      </span>
                    </button>
                    {monthlyRevenueOpen && (
                      <div className="space-y-2 border-t border-white/10 p-3">
                        {monthlyRevenueRows.map((row) => (
                          <div key={row.label} className="rounded-2xl bg-white/[0.04] p-3">
                            <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                              <span className="capitalize text-zinc-200">{row.label}</span>
                              <b className="text-amber-200">{money(row.amount)} TL</b>
                            </div>
                            <div className="h-2 overflow-hidden rounded-full bg-white/10">
                              <div className="h-full rounded-full bg-amber-300" style={{ width: `${Math.max(4, Math.round((row.amount / maxMonthlyRevenue) * 100))}%` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </Card>}

              {tab === "staff" && <div className="grid gap-6 lg:grid-cols-[1fr_360px]"><Card><h2 className="mb-4 text-2xl font-bold">Personel</h2>{data.staff.map((s) => <div key={s.id} className="mb-3 flex items-center justify-between rounded-2xl bg-black/30 p-4"><div><b>{s.name}</b><div className="text-sm text-zinc-400">{s.role}</div></div><div className="flex items-center gap-2"><button onClick={() => setData((d) => ({...d, staff: d.staff.map((x) => x.id === s.id ? {...x, active: !x.active} : x)}))} className="rounded-xl bg-white/10 px-3 py-2">{s.active ? "Aktif" : "Kapalı"}</button><button onClick={() => setData((d) => ({...d, staff: d.staff.filter((x) => x.id !== s.id)}))} className="rounded-xl bg-red-400/10 px-3 py-2 text-red-300"><Trash2 className="h-4 w-4" /></button></div></div>)}</Card><Card><h2 className="mb-4 text-xl font-bold">Yeni Personel</h2><Input placeholder="Ad" value={newStaff.name} onChange={(e) => setNewStaff({...newStaff, name:e.target.value})} className="mb-3 w-full" /><Input placeholder="Uzmanlık" value={newStaff.role} onChange={(e) => setNewStaff({...newStaff, role:e.target.value})} className="mb-3 w-full" /><button onClick={() => { if(newStaff.name) { setData((d)=>({...d, staff:[...d.staff,{...newStaff,id:id(),active:true}]})); setNewStaff({name:"",role:""}); } }} className="w-full rounded-2xl bg-amber-300 px-4 py-3 font-bold text-black"><Plus className="mr-1 inline" />Ekle</button></Card></div>}

              {tab === "availability" && <Card className="space-y-6">
                <section className="rounded-3xl border border-white/10 bg-black/20 p-4">
                  <h2 className="mb-4 text-2xl font-bold">Personel İzni</h2>
                  <OptionPicker value={newLeave.staffId} onChange={(value)=>setNewLeave({...newLeave,staffId:value})} options={data.staff.map((s)=>({ value: s.id, label: s.name, description: s.role }))} placeholder="Personel seç" className="mb-3" />
                  <DatePicker value={newLeave.startDate} onChange={(value)=>setNewLeave({...newLeave,startDate:value})} className="mb-3" />
                  <DatePicker value={newLeave.endDate} onChange={(value)=>setNewLeave({...newLeave,endDate:value})} min={newLeave.startDate} className="mb-3" />
                  <button onClick={()=>setData((d)=>({...d,staffLeaves:[...d.staffLeaves,{...newLeave,id:id()}]}))} className="rounded-2xl bg-amber-300 px-4 py-3 font-bold text-black">İzin Ekle</button>
                  <div className="mt-5 space-y-3">
                    {data.staffLeaves.map((l)=><div key={l.id} className="flex items-center justify-between rounded-2xl bg-black/30 p-4">
                      <div><b>{staffMap[l.staffId]?.name}</b><div className="text-sm text-zinc-400">{prettyDate(l.startDate)} - {prettyDate(l.endDate)}</div></div>
                      <button onClick={()=>setData((d)=>({...d,staffLeaves:d.staffLeaves.filter((x)=>x.id!==l.id)}))} className="rounded-xl bg-red-400/10 px-3 py-2 text-red-300"><Trash2 className="h-4 w-4" /></button>
                    </div>)}
                  </div>
                </section>

                <section className="rounded-3xl border border-white/10 bg-black/20 p-4">
                  <h2 className="mb-4 text-2xl font-bold">Yemek / Kapalı Saat</h2>
                  <div className="grid gap-3 md:grid-cols-3">
                    <OptionPicker value={data.settings.lunchEnabled ? "yes" : "no"} onChange={(value)=>setData((d)=>({...d,settings:{...d.settings,lunchEnabled:value==="yes"}}))} options={[{ value: "yes", label: "Yemek saati açık" }, { value: "no", label: "Yemek saati kapalı" }]} placeholder="Yemek saati" />
                    <TimePicker value={data.settings.lunchStart} onChange={(value)=>setData((d)=>({...d,settings:{...d.settings,lunchStart:value}}))} />
                    <TimePicker value={data.settings.lunchEnd} onChange={(value)=>setData((d)=>({...d,settings:{...d.settings,lunchEnd:value}}))} />
                  </div>

                  <div className="mt-6 rounded-3xl border border-white/10 bg-black/20 p-4">
                    <h3 className="font-semibold">Haftalık kapalı günler</h3>
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {WEEKDAYS.map((day) => {
                        const checked = (data.settings.closedWeekdays || []).map(Number).includes(day.value);
                        return (
                          <button
                            key={day.value}
                            type="button"
                            onClick={() => toggleClosedWeekday(day.value)}
                            className={`flex items-center justify-center gap-2 rounded-2xl border px-3 py-3 text-sm font-semibold transition ${checked ? "border-amber-300 bg-amber-300 text-black" : "border-white/10 bg-black/30 text-zinc-300 hover:border-amber-300/40"}`}
                          >
                            {checked && <Check className="h-4 w-4" />}
                            {day.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="mt-6 rounded-3xl border border-white/10 bg-black/20 p-4">
                    <h3 className="mb-3 font-semibold">İstediğin saat aralığını kapat</h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      <OptionPicker value={newBlock.staffId} onChange={(value)=>setNewBlock({...newBlock,staffId:value})} options={[{ value: "all", label: "Tüm personel" }, ...data.staff.map((s)=>({ value: s.id, label: s.name, description: s.role }))]} placeholder="Personel seç" />
                      <Input placeholder="Sebep" value={newBlock.reason} onChange={(e)=>setNewBlock({...newBlock,reason:e.target.value})} />
                      <DatePicker value={newBlock.date} onChange={(value)=>setNewBlock({...newBlock,date:value})} />
                      <div className="grid grid-cols-2 gap-2">
                        <TimePicker value={newBlock.startTime} onChange={(value)=>setNewBlock({...newBlock,startTime:value})} />
                        <TimePicker value={newBlock.endTime} onChange={(value)=>setNewBlock({...newBlock,endTime:value})} />
                      </div>
                    </div>
                    <button onClick={addBlockedSlot} className="mt-3 rounded-2xl bg-amber-300 px-4 py-3 font-bold text-black">Kapalı Saat Ekle</button>
                  </div>

                  <div className="mt-5 space-y-3">
                    {data.blockedSlots.map((b)=><div key={b.id} className="flex items-center justify-between rounded-2xl bg-black/30 p-4">
                      <div><b>{b.staffId === "all" ? "Tüm personel" : staffMap[b.staffId]?.name}</b><div className="text-sm text-zinc-400">{prettyDate(b.date)} · {b.startTime}-{b.endTime} · {b.reason}</div></div>
                      <button onClick={()=>setData((d)=>({...d,blockedSlots:d.blockedSlots.filter((x)=>x.id!==b.id)}))} className="rounded-xl bg-red-400/10 px-3 py-2 text-red-300"><Trash2 className="h-4 w-4" /></button>
                    </div>)}
                  </div>
                </section>
              </Card>}

              {tab === "services" && <div className="grid gap-6 lg:grid-cols-[1fr_360px]"><Card><h2 className="mb-4 text-2xl font-bold">Hizmetler</h2>{data.services.map((s)=><div key={s.id} className="mb-3 rounded-2xl bg-black/30 p-4">{editingService?.id === s.id ? <div className="grid gap-3 md:grid-cols-2"><Input placeholder="Hizmet adı" value={editingService.name} onChange={(e)=>setEditingService({...editingService,name:e.target.value})} /><Input type="number" placeholder="Fiyat" value={editingService.price} onChange={(e)=>setEditingService({...editingService,price:e.target.value})} /><Input type="number" placeholder="Süre dk" value={editingService.time} onChange={(e)=>setEditingService({...editingService,time:e.target.value})} /><Input placeholder="Açıklama" value={editingService.desc || ""} onChange={(e)=>setEditingService({...editingService,desc:e.target.value})} /><div className="flex gap-2 md:col-span-2"><button onClick={saveEditService} className="rounded-xl bg-amber-300 px-4 py-2 font-bold text-black">Kaydet</button><button onClick={()=>setEditingService(null)} className="rounded-xl bg-white/10 px-4 py-2">İptal</button></div></div> : <div className="flex items-center justify-between gap-4"><div><b>{s.name}</b><div className="text-sm text-zinc-400">{s.time} dk · {s.price} TL</div>{s.desc && <div className="mt-1 text-xs text-zinc-500">{s.desc}</div>}</div><div className="flex items-center gap-2"><button onClick={()=>startEditService(s)} className="rounded-xl bg-amber-300/10 px-3 py-2 text-xs text-amber-300">Düzenle</button><button onClick={()=>setData((d)=>({...d,services:d.services.filter((x)=>x.id!==s.id)}))} className="rounded-xl bg-red-400/10 px-3 py-2 text-red-300"><Trash2 className="h-4 w-4" /></button></div></div>}</div>)}</Card><Card><h2 className="mb-4 text-xl font-bold">Yeni Hizmet</h2><Input placeholder="Ad" value={newService.name} onChange={(e)=>setNewService({...newService,name:e.target.value})} className="mb-3 w-full" /><Input type="number" placeholder="Fiyat" value={newService.price} onChange={(e)=>setNewService({...newService,price:e.target.value})} className="mb-3 w-full" /><Input type="number" placeholder="Süre" value={newService.time} onChange={(e)=>setNewService({...newService,time:e.target.value})} className="mb-3 w-full" /><Input placeholder="Açıklama" value={newService.desc} onChange={(e)=>setNewService({...newService,desc:e.target.value})} className="mb-3 w-full" /><button onClick={()=>{ if(newService.name){ setData((d)=>({...d,services:[...d.services,{...newService,id:id(),price:Number(newService.price),time:Number(newService.time)}]})); setNewService({name:"",price:"",time:30,desc:""}); } }} className="w-full rounded-2xl bg-amber-300 px-4 py-3 font-bold text-black">Ekle</button></Card></div>}

              {tab === "settings" && <Card>
                <h2 className="mb-4 text-2xl font-bold"><CalendarClock className="mr-2 inline text-amber-300" />Çalışma Saatleri</h2>
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                  <label>
                    <span className="mb-2 block text-sm text-zinc-400">Salon açılış saati</span>
                    <TimePicker value={data.settings.openTime} onChange={(value)=>setData((d)=>({...d,settings:{...d.settings,openTime:value}}))} />
                  </label>
                  <label>
                    <span className="mb-2 block text-sm text-zinc-400">Salon kapanış saati</span>
                    <TimePicker value={data.settings.closeTime} onChange={(value)=>setData((d)=>({...d,settings:{...d.settings,closeTime:value}}))} />
                  </label>
                  <label>
                    <span className="mb-2 block text-sm text-zinc-400">Randevu saat aralığı</span>
                    <OptionPicker
                      value={String(data.settings.slotStep)}
                      onChange={(value)=>setData((d)=>({...d,settings:{...d.settings,slotStep:Number(value)}}))}
                      options={[5, 10, 15, 20, 30, 45, 60].map((minute)=>({ value: String(minute), label: `${minute} dakika` }))}
                      placeholder="Saat aralığı seç"
                    />
                  </label>
                  <label>
                    <span className="mb-2 block text-sm text-zinc-400">WhatsApp hatırlatma kaç saat önce</span>
                    <Input type="number" value={data.settings.reminderHours} onChange={(e)=>setData((d)=>({...d,settings:{...d.settings,reminderHours:Number(e.target.value)}}))} className="w-full" />
                  </label>
                </div>
              </Card>}
            </>
          )}
        </main>
      )}

      {view === "admin" && logged && (
        <>
          {adminMenuOpen && (
            <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" onClick={() => setAdminMenuOpen(false)}>
              <aside className="m-3 flex h-[calc(100%-1.5rem)] w-[min(22rem,88vw)] flex-col rounded-3xl border border-white/10 bg-white/[0.06] p-4 shadow-2xl shadow-black/40 backdrop-blur-xl" onClick={(e) => e.stopPropagation()}>
                <div className="mb-5 flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs font-bold uppercase tracking-[0.24em] text-amber-300">Panel</div>
                    <h2 className="mt-1 text-2xl font-black text-white">Ayarlar</h2>
                    <p className="mt-1 text-sm text-zinc-400">Diğer yönetim bölümleri</p>
                  </div>
                  <button type="button" onClick={() => setAdminMenuOpen(false)} className="rounded-2xl border border-white/10 bg-black/30 p-3 text-amber-100 transition hover:bg-white/10" aria-label="Menüyü kapat">
                    <X className="h-5 w-5" />
                  </button>
                </div>

                <div className="grid gap-2 rounded-[1.75rem] border border-white/10 bg-black/20 p-2">
                  {adminSettingsTabs.map((item) => {
                    const Icon = item.icon;
                    const active = tab === item.key;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => {
                          goAdminTab(item.key);
                        }}
                        className={`flex items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition ${active ? "border-[#ffd22e] bg-[#ffd22e] text-black shadow-[0_0_18px_rgba(255,210,46,0.20)]" : "border-white/10 bg-black/30 text-zinc-100 hover:border-amber-300/35 hover:bg-white/10 hover:text-amber-50"}`}
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          <Icon className="h-5 w-5 shrink-0" />
                          <span className="truncate font-bold">{item.label}</span>
                        </span>
                        {active && <Check className="h-4 w-4 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </aside>
            </div>
          )}

          <nav className="fixed inset-x-0 bottom-0 z-40 px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2">
            <div className="mx-auto grid max-w-2xl grid-cols-4 gap-1.5 rounded-[1.7rem] border border-white/10 bg-white/[0.06] p-1.5 shadow-2xl shadow-black/30 backdrop-blur">
              {adminBottomTabs.map((item) => {
                const Icon = item.icon;
                const active = tab === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => {
                      goAdminTab(item.key);
                    }}
                    className={`relative flex min-h-14 flex-col items-center justify-center gap-1 rounded-[1.25rem] px-2 text-[11px] font-bold transition sm:text-xs ${active ? "border border-[#ffd22e] bg-[#ffd22e] text-black shadow-[0_0_18px_rgba(255,210,46,0.20)]" : "border border-transparent text-zinc-300 hover:bg-white/10 hover:text-amber-100"}`}
                  >
                    {active && <span className="absolute top-1.5 h-1 w-8 rounded-full bg-black/25" />}
                    <Icon className="h-5 w-5" />
                    <span>{item.label}</span>
                  </button>
                );
              })}

              <button
                type="button"
                onClick={() => setAdminMenuOpen(true)}
                className={`relative flex min-h-14 flex-col items-center justify-center gap-1 rounded-[1.25rem] px-2 text-[11px] font-bold transition sm:text-xs ${adminMenuOpen || adminSettingsTabs.some((item) => item.key === tab) ? "border border-[#ffd22e] bg-[#ffd22e] text-black shadow-[0_0_18px_rgba(255,210,46,0.20)]" : "border border-transparent text-zinc-300 hover:bg-white/10 hover:text-amber-100"}`}
              >
                {(adminMenuOpen || adminSettingsTabs.some((item) => item.key === tab)) && <span className="absolute top-1.5 h-1 w-8 rounded-full bg-black/25" />}
                <Settings className="h-5 w-5" />
                <span>Ayarlar</span>
              </button>
            </div>
          </nav>
        </>
      )}

      {staffRevenueDetail && <div className="fixed inset-0 z-50 overflow-y-auto bg-black/80 p-3 backdrop-blur sm:p-6">
        <Card className="mx-auto w-full max-w-3xl p-4 sm:p-6">
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-2xl font-black sm:text-3xl">{staffRevenueDetail.name}</h2>
              <p className="mt-1 text-sm text-zinc-400">Personel kazanç detayı</p>
            </div>
            <button onClick={closeStaffRevenueDetail} className="rounded-2xl bg-white/10 px-4 py-3 text-sm font-bold text-zinc-100 hover:bg-white/15">
              Kapat
            </button>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4">
              <div className="text-xs text-zinc-400">Toplam Kazanç</div>
              <div className="mt-2 text-2xl font-black text-amber-200">{money(staffRevenueDetail.amount)} TL</div>
            </div>
            <div role="button" tabIndex={0} onClick={() => setStaffPeriodDetail({ title: staffSelectedDayLabel, records: staffDayRecords })} onKeyDown={(e) => e.key === "Enter" && setStaffPeriodDetail({ title: staffSelectedDayLabel, records: staffDayRecords })} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-left transition hover:border-amber-300/30">
              <div className="mb-2 flex items-center justify-between gap-2">
                <button type="button" onClick={(e) => { e.stopPropagation(); setStaffRevenueDayOffset((value) => value - 1); }} className="grid h-8 w-8 place-items-center rounded-xl bg-black/30 text-amber-200 transition hover:bg-amber-300/10"><ChevronLeft className="h-4 w-4" /></button>
                <div className="min-w-0 text-center">
                  <div className="text-xs text-zinc-400">{staffRevenueDayOffset === 0 ? "Bugün" : "Seçili Gün"}</div>
                  <div className="truncate text-xs font-bold text-amber-200">{staffSelectedDayLabel}</div>
                </div>
                <button type="button" onClick={(e) => { e.stopPropagation(); setStaffRevenueDayOffset((value) => Math.min(value + 1, 0)); }} disabled={staffRevenueDayOffset === 0} className="grid h-8 w-8 place-items-center rounded-xl bg-black/30 text-amber-200 transition hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
              </div>
              <div className="mt-2 text-2xl font-black text-white">{money(staffTodayRevenue)} TL</div>
              <div className="mt-1 text-xs text-zinc-500">{staffDayRecords.length} işlem</div>
            </div>
            <div role="button" tabIndex={0} onClick={() => setStaffPeriodDetail({ title: staffSelectedWeekLabel, records: staffWeekRecords })} onKeyDown={(e) => e.key === "Enter" && setStaffPeriodDetail({ title: staffSelectedWeekLabel, records: staffWeekRecords })} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-left transition hover:border-amber-300/30">
              <div className="mb-2 flex items-center justify-between gap-2">
                <button type="button" onClick={(e) => { e.stopPropagation(); setStaffRevenueWeekOffset((value) => value - 1); }} className="grid h-8 w-8 place-items-center rounded-xl bg-black/30 text-amber-200 transition hover:bg-amber-300/10"><ChevronLeft className="h-4 w-4" /></button>
                <div className="min-w-0 text-center">
                  <div className="text-xs text-zinc-400">{staffRevenueWeekOffset === 0 ? "Bu Hafta" : "Seçili Hafta"}</div>
                  <div className="truncate text-xs font-bold text-amber-200">{staffSelectedWeekLabel}</div>
                </div>
                <button type="button" onClick={(e) => { e.stopPropagation(); setStaffRevenueWeekOffset((value) => Math.min(value + 1, 0)); }} disabled={staffRevenueWeekOffset === 0} className="grid h-8 w-8 place-items-center rounded-xl bg-black/30 text-amber-200 transition hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
              </div>
              <div className="mt-2 text-2xl font-black text-white">{money(staffWeekRevenue)} TL</div>
              <div className="mt-1 text-xs text-zinc-500">{staffWeekRecords.length} işlem</div>
            </div>
            <div role="button" tabIndex={0} onClick={() => setStaffPeriodDetail({ title: staffSelectedMonthLabel, records: staffMonthRecords })} onKeyDown={(e) => e.key === "Enter" && setStaffPeriodDetail({ title: staffSelectedMonthLabel, records: staffMonthRecords })} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-left transition hover:border-amber-300/30">
              <div className="mb-2 flex items-center justify-between gap-2">
                <button type="button" onClick={(e) => { e.stopPropagation(); setStaffRevenueMonthOffset((value) => value - 1); }} className="grid h-8 w-8 place-items-center rounded-xl bg-black/30 text-amber-200 transition hover:bg-amber-300/10"><ChevronLeft className="h-4 w-4" /></button>
                <div className="min-w-0 text-center">
                  <div className="text-xs text-zinc-400">{staffRevenueMonthOffset === 0 ? "Bu Ay" : "Seçili Ay"}</div>
                  <div className="truncate text-xs font-bold capitalize text-amber-200">{staffSelectedMonthLabel}</div>
                </div>
                <button type="button" onClick={(e) => { e.stopPropagation(); setStaffRevenueMonthOffset((value) => Math.min(value + 1, 0)); }} disabled={staffRevenueMonthOffset === 0} className="grid h-8 w-8 place-items-center rounded-xl bg-black/30 text-amber-200 transition hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
              </div>
              <div className="mt-2 text-2xl font-black text-white">{money(staffMonthRevenue)} TL</div>
              <div className="mt-1 text-xs text-zinc-500">{staffMonthRecords.length} işlem</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
              <div className="text-xs text-zinc-400">Önceki Aya Göre</div>
              <div className={`mt-2 flex items-center gap-2 text-2xl font-black ${staffMonthTrend.tone.split(" ")[0]}`}>
                <StaffMonthTrendIcon className="h-6 w-6" />
                <span>{staffMonthTrend.label}</span>
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
              <div className="text-xs text-zinc-400">Tamamlanan İşlem</div>
              <div className="mt-2 text-2xl font-black text-white">{staffRevenueDetail.count}</div>
            </div>
          </div>
        </Card>
      </div>}

      {staffPeriodDetail && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4 backdrop-blur">
        <Card className="w-full max-w-lg p-4 sm:p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-xl font-black">{staffPeriodDetail.title}</h3>
              <p className="mt-1 text-sm text-zinc-400">{staffPeriodDetail.records.length} işlem · {money(staffPeriodDetail.records.reduce((sum, item) => sum + Number(item.paidAmount || 0), 0))} TL</p>
            </div>
            <button type="button" onClick={() => setStaffPeriodDetail(null)} className="rounded-xl bg-white/10 px-3 py-2 text-sm font-bold">Kapat</button>
          </div>
          <div className="max-h-[55dvh] space-y-2 overflow-y-auto pr-1">
            {staffPeriodDetail.records.length === 0 && <div className="rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-zinc-300">Bu aralıkta tamamlanan işlem yok.</div>}
            {staffPeriodDetail.records.map((item) => (
              <div key={item.id} className="rounded-2xl border border-white/10 bg-black/30 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-bold text-white">{item.customerName}</div>
                    <div className="mt-1 text-sm text-zinc-400">{prettyDate(item.date)} · {item.time} · {serviceMap[item.serviceId]?.name || "Hizmet"}</div>
                  </div>
                  <div className="shrink-0 font-black text-amber-200">{money(item.paidAmount || 0)} TL</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>}

      {revenueFlowOpen && <div className={`fixed inset-0 z-50 ${revenueFlowFullscreen ? "overflow-hidden bg-[#080808]" : "overflow-y-auto bg-black/80 p-3 sm:p-6"}`}>
        <Card id="revenue-flow-panel" className={revenueFlowFullscreen ? "revenue-flow-fullscreen relative flex h-[100dvh] min-h-[100dvh] max-w-none flex-col rounded-none border-0 bg-[#080808] p-3 sm:p-5" : "relative mx-auto flex min-h-[min(92dvh,760px)] max-w-6xl flex-col border-amber-300/15 bg-[#0b0b0b]/95 p-4 sm:p-5"}>
          {revenueFlowFullscreen && (
            <button onClick={() => exitRevenueFlowFullscreen()} className="absolute right-3 top-3 z-10 rounded-2xl bg-white/10 p-3 text-zinc-100 hover:bg-white/15" aria-label="Tam ekrandan çık">
              <Minimize2 className="h-5 w-5" />
            </button>
          )}
          {!revenueFlowFullscreen && <>
          <div className="mb-3 flex shrink-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-zinc-500">{prettyDate(revenueFlowStart)} - {prettyDate(revenueFlowEnd)}</div>
              <h2 className="mt-1 text-2xl font-black sm:text-3xl">Finans Grafiği</h2>
            </div>
            <div className="flex shrink-0 items-start gap-2">
              <div className="hidden text-right sm:block">
                <div className="text-2xl font-black text-amber-200">{money(revenueFlowTotal)} TL</div>
                <div className="text-xs text-zinc-500">{revenueFlowAppointmentCount} tamamlanan işlem</div>
              </div>
              <button onClick={enterRevenueFlowFullscreen} className="rounded-2xl bg-white/10 p-3 text-zinc-100 hover:bg-white/15" aria-label="Finans grafiğini büyüt">
                <Maximize2 className="h-5 w-5" />
              </button>
              <button onClick={() => { exitRevenueFlowFullscreen(); setRevenueFlowOpen(false); }} className="rounded-2xl bg-white/10 p-3 text-zinc-100 hover:bg-white/15" aria-label="Finans grafiğini kapat">
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          <div className="mb-3 rounded-3xl border border-white/10 bg-black/30 p-3">
            <div className="hidden">
              {revenueFlowRanges.map((range) => (
                <button
                  key={range.id}
                  type="button"
                  onClick={() => {
                    setRevenueFlowRange(range.id);
                    setRevenueFlowHoverIndex(null);
                  }}
                  className={`rounded-2xl px-3 py-2 text-xs font-black transition ${revenueFlowRange === range.id ? "bg-amber-300 text-black" : "border border-white/10 bg-white/[0.04] text-zinc-300 hover:border-amber-300/30 hover:bg-amber-300/10"}`}
                >
                  {range.label}
                </button>
              ))}
            </div>
            {true && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-zinc-500">Başlangıç</span>
                  <DatePicker value={revenueFlowCustomStart} onChange={(nextValue) => { setRevenueFlowCustomStart(nextValue); setRevenueFlowHoverIndex(null); setRevenueFlowSelectedDate(null); }} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold text-zinc-500">Bitiş</span>
                  <DatePicker value={revenueFlowCustomEnd} onChange={(nextValue) => { setRevenueFlowCustomEnd(nextValue); setRevenueFlowHoverIndex(null); setRevenueFlowSelectedDate(null); }} />
                </label>
              </div>
            )}
          </div>
          </>}

          <div className={revenueFlowFullscreen ? "flex min-h-0 flex-1 flex-col" : "flex min-h-[24rem] flex-1 flex-col rounded-3xl border border-white/10 bg-black/35 p-3 sm:p-5"}>
            {!revenueFlowFullscreen && <div className="mb-3 flex shrink-0 items-end justify-between gap-3 sm:hidden">
              <div className="text-xs text-zinc-500">{revenueFlowAppointmentCount} tamamlanan işlem</div>
              <div className="text-xl font-black text-amber-200">{money(revenueFlowTotal)} TL</div>
            </div>}
            <div className={revenueFlowFullscreen ? "relative min-h-0 flex-1 overflow-hidden bg-[#080808]" : "relative min-h-0 flex-1 overflow-hidden rounded-3xl border border-white/10 bg-[#0c0d0f] p-2 sm:p-3"}>
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(251,191,36,.10),transparent_38%)]" />
              <svg
                viewBox="0 0 640 300"
                className={`relative h-full w-full touch-none ${revenueFlowFullscreen ? "min-h-0" : "min-h-[18rem]"}`}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  selectRevenueFlowPointFromPointer(event, true);
                }}
                onPointerMove={selectRevenueFlowPointFromPointer}
                onPointerLeave={() => setRevenueFlowHoverIndex(null)}
              >
                <defs>
                  <linearGradient id="revenueFlowFill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="rgba(251,191,36,.45)" />
                    <stop offset="58%" stopColor="rgba(251,191,36,.14)" />
                    <stop offset="100%" stopColor="rgba(251,191,36,0)" />
                  </linearGradient>
                  <filter id="revenueFlowGlow" x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur stdDeviation="4" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>
                {[0, 1, 2, 3, 4].map((line) => (
                  <line key={line} x1="34" x2="606" y1={58 + line * 45} y2={58 + line * 45} stroke="rgba(255,255,255,.07)" strokeDasharray={line === 2 ? "2 4" : "0"} />
                ))}
                {revenueFlowAreaPath && <path d={revenueFlowAreaPath} fill="url(#revenueFlowFill)" />}
                {revenueFlowLinePath && <path d={revenueFlowLinePath} fill="none" stroke="rgba(251,191,36,.18)" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />}
                {revenueFlowLinePath && <path d={revenueFlowLinePath} fill="none" stroke="#facc15" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" filter="url(#revenueFlowGlow)" />}
                {activeRevenueFlowPoint && (
                  <>
                    <line x1={activeRevenueFlowPoint.x} x2={activeRevenueFlowPoint.x} y1="42" y2="252" stroke="rgba(255,255,255,.48)" strokeDasharray="2 4" />
                    <line x1="34" x2="606" y1={activeRevenueFlowPoint.y} y2={activeRevenueFlowPoint.y} stroke="rgba(255,255,255,.22)" strokeDasharray="2 5" />
                    <circle cx={activeRevenueFlowPoint.x} cy={activeRevenueFlowPoint.y} r="6" fill="#facc15" stroke="#0c0d0f" strokeWidth="3" />
                  </>
                )}
                {revenueFlowRows.map((row, i) => revenueFlowLabelIndexes.includes(i) ? (
                  <text key={row.iso} x={revenueFlowChartCoords[i]?.x || 34} y="282" textAnchor="middle" fill="rgba(255,255,255,.48)" fontSize="11">{row.label}</text>
                ) : null)}
                {revenueFlowChartCoords.map((point, i) => {
                  const prevX = revenueFlowChartCoords[i - 1]?.x ?? revenueFlowChart.left;
                  const nextX = revenueFlowChartCoords[i + 1]?.x ?? revenueFlowChart.right;
                  const width = Math.max(8, (nextX - prevX) / 2);
                  return (
                    <rect
                      key={`hit-${point.iso}`}
                      x={point.x - width / 2}
                      y="36"
                      width={width}
                      height="228"
                      fill="transparent"
                      className="cursor-crosshair"
                      onMouseEnter={() => setRevenueFlowHoverIndex(i)}
                      onClick={() => {
                        setRevenueFlowHoverIndex(i);
                        setRevenueFlowSelectedDate(point.iso);
                      }}
                    />
                  );
                })}
              </svg>
              {activeRevenueFlowPoint && (
                <div
                  className="pointer-events-none absolute min-w-44 rounded-2xl border border-white/10 bg-[#242932]/95 px-4 py-3 text-sm shadow-2xl shadow-black/40"
                  style={{
                    left: `${(activeRevenueFlowPoint.x / 640) * 100}%`,
                    top: `${(activeRevenueFlowPoint.y / 300) * 100}%`,
                    transform: activeRevenueFlowPoint.x > 470 ? "translate(-105%, -50%)" : "translate(12px, -50%)",
                  }}
                >
                  <div className="text-xs font-semibold text-zinc-400">{activeRevenueFlowDateLabel}</div>
                  <div className="mt-2 text-lg font-black text-white">{money(activeRevenueFlowPoint.amount)} TL</div>
                  <div className={`mt-1 text-xs font-bold ${activeRevenueFlowChange > 0 ? "text-emerald-300" : activeRevenueFlowChange < 0 ? "text-red-300" : "text-zinc-500"}`}>
                    {activeRevenueFlowChange > 0 ? "+" : ""}{money(activeRevenueFlowChange)} TL
                  </div>
                </div>
              )}
              {revenueFlowAppointmentCount === 0 && <div className="absolute inset-x-4 top-1/2 -translate-y-1/2 rounded-2xl border border-white/10 bg-black/60 p-4 text-center text-sm text-zinc-300">Seçili aralıkta tamamlanan işlem yok.</div>}
            </div>
            {!revenueFlowFullscreen && selectedRevenueFlowDate && (
              <div className="mt-3 rounded-3xl border border-amber-300/15 bg-black/35 p-4">
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-200">Gün Detayı</div>
                    <h3 className="mt-1 text-xl font-black text-white">{prettyDate(selectedRevenueFlowDate)}</h3>
                    <p className="mt-1 text-xs text-zinc-500">{revenueFlowSelectedAppointments.length} işlem · {revenueFlowSelectedCustomerCount} müşteri</p>
                  </div>
                  <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-right">
                    <div className="text-xs text-zinc-400">Toplam</div>
                    <div className="text-2xl font-black text-amber-200">{money(revenueFlowSelectedTotal)} TL</div>
                  </div>
                </div>

                {revenueFlowSelectedAppointments.length === 0 ? (
                  <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-sm text-zinc-400">Bu tarihte tamamlanan işlem yok.</div>
                ) : (
                  <div className="grid gap-3 lg:grid-cols-[0.9fr_1.1fr]">
                    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3">
                      <div className="mb-2 text-sm font-bold text-white">Personel Kazancı</div>
                      <div className="grid gap-2">
                        {revenueFlowSelectedStaffRows.map((row) => (
                          <div key={row.id} className="flex items-center justify-between gap-3 rounded-xl bg-black/30 px-3 py-2">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-bold text-zinc-100">{row.name}</div>
                              <div className="text-xs text-zinc-500">{row.count} müşteri</div>
                            </div>
                            <div className="shrink-0 font-black text-amber-200">{money(row.amount)} TL</div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3">
                      <div className="mb-2 text-sm font-bold text-white">İşlem Listesi</div>
                      <div className="app-scrollbar max-h-64 space-y-2 overflow-y-auto pr-1">
                        {revenueFlowSelectedServiceRows.map((a) => (
                          <div key={a.id} className="rounded-xl bg-black/30 px-3 py-2">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-bold text-amber-100">{a.time} · {serviceMap[a.serviceId]?.name || "Hizmet"}</div>
                                <div className="mt-0.5 truncate text-xs text-zinc-400">{a.customerName} · {staffMap[a.staffId]?.name || "Personel"}</div>
                              </div>
                              <div className="shrink-0 text-sm font-black text-white">{money(a.paidAmount)} TL</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>}

      {adminBookingSlot && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
        <Card className="w-full max-w-xl">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-2xl font-bold">Randevu Oluştur</h2>
              <p className="mt-1 text-sm text-zinc-400">{prettyDate(adminBookingSlot.date)} · {adminBookingSlot.time}</p>
            </div>
            <button onClick={() => setAdminBookingSlot(null)} className="rounded-xl bg-white/10 px-3 py-2 text-sm">Kapat</button>
          </div>

          <div className="grid gap-3">
            <label>
              <span className="mb-2 block text-sm text-zinc-400">Mevcut müşteri</span>
              <Input placeholder="Müşteri ara: ad veya telefon" value={adminBookingCustomerSearch} onChange={(e) => {
                const q = e.target.value;
                setAdminBookingCustomerSearch(q);
                const nextOptions = adminCustomerOptions.filter((c) => `${c.name} ${c.phone}`.toLowerCase().includes(q.trim().toLowerCase()));
                if (nextOptions.length && !nextOptions.some((c) => c.phone === adminBookingForm.customerPhone)) {
                  setAdminBookingForm({ ...adminBookingForm, customerPhone: nextOptions[0].phone });
                }
              }} className="mb-2 w-full" />
              <OptionPicker
                value={adminBookingForm.customerPhone}
                onChange={(value) => setAdminBookingForm({ ...adminBookingForm, customerPhone: value })}
                options={filteredAdminCustomerOptions.map((c) => ({ value: c.phone, label: c.name, description: c.phone }))}
                placeholder="Müşteri seç"
              />
              {filteredAdminCustomerOptions.length === 0 && <div className="mt-2 rounded-xl bg-red-400/10 px-3 py-2 text-sm text-red-200">Bu aramayla müşteri bulunamadı.</div>}
            </label>

            <div className="grid gap-3 md:grid-cols-2">
              <label>
                <span className="mb-2 block text-sm text-zinc-400">Hizmet</span>
                <OptionPicker
                  value={adminBookingForm.serviceId}
                  onChange={(value) => setAdminBookingForm({ ...adminBookingForm, serviceId: value })}
                  options={data.services.map((s) => ({ value: s.id, label: s.name, description: `${s.time} dk · ${s.price} TL` }))}
                  placeholder="Hizmet seç"
                />
              </label>
              <label>
                <span className="mb-2 block text-sm text-zinc-400">Personel</span>
                <OptionPicker
                  value={adminBookingForm.staffId}
                  onChange={(value) => setAdminBookingForm({ ...adminBookingForm, staffId: value })}
                  options={data.staff.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name, description: s.role }))}
                  placeholder="Personel seç"
                />
              </label>
            </div>

            <Textarea placeholder="Not / istek" value={adminBookingForm.note} onChange={(e) => setAdminBookingForm({ ...adminBookingForm, note: e.target.value })} className="min-h-24 w-full" />

            <div className="rounded-2xl border border-white/10 bg-black/30 p-4 text-sm text-zinc-300">
              Seçilen saat: <b className="text-amber-200">{adminBookingSlot.time}</b>. Randevu aynı veritabanı ve WhatsApp akışıyla kaydedilir.
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <button onClick={createAdminBooking} disabled={!adminBookingForm.customerPhone} className="flex-1 rounded-2xl bg-amber-300 px-4 py-3 font-bold text-black disabled:opacity-40">Randevuyu Oluştur</button>
            <button onClick={() => setAdminBookingSlot(null)} className="rounded-2xl bg-white/10 px-4 py-3">Vazgeç</button>
          </div>
        </Card>
      </div>}

      {installGuide && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4">
        <Card className="w-full max-w-md border-amber-300/20 bg-zinc-950/95">
          <div className="mb-4 flex items-start gap-3">
            <div className="rounded-2xl bg-amber-300/10 p-3 text-amber-200">
              <Download className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-2xl font-bold">Uygulamayı İndir</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-300">
                {installGuide === "ios"
                  ? "iPhone'da uygulamayı ana ekrana eklemek için Safari paylaş menüsünü kullanın."
                  : "Tarayıcı bu cihazda otomatik indirme penceresi açamadı. Cihazınıza göre aşağıdaki adımları kullanabilirsiniz."}
              </p>
            </div>
            <button onClick={() => setInstallGuide(null)} className="rounded-xl bg-white/10 p-2 text-zinc-300 hover:bg-white/15">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="space-y-2 rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm text-amber-50">
            {(installGuide === "ios"
              ? ["Safari'de mabelhairart.com.tr adresini açın.", "Alttaki Paylaş butonuna dokunun.", "Ana Ekrana Ekle seçeneğine basıp Ekle deyin."]
              : ["iPhone: Safari'de Paylaş butonuna dokunup Ana Ekrana Ekle deyin.", "Android: Chrome'da üç nokta menüsünden Uygulamayı yükle veya Ana ekrana ekle deyin.", "Çıkan pencerede onaylayın."]
            ).map((step, index) => (
              <div key={step} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/30 text-xs font-black text-amber-200">{index + 1}</span>
                <span>{step}</span>
              </div>
            ))}
          </div>

          <button onClick={() => setInstallGuide(null)} className="mt-5 w-full rounded-2xl bg-amber-300 px-4 py-3 font-bold text-black">Tamam</button>
        </Card>
      </div>}

      {notice && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4">
        <Card className={`w-full max-w-md bg-zinc-950/95 ${notice.tone === "success" ? "border-emerald-300/20" : notice.tone === "error" ? "border-red-300/20" : "border-amber-300/20"}`}>
          <div className="mb-4 flex items-start gap-3">
            <div className={`rounded-2xl p-3 ${notice.tone === "success" ? "bg-emerald-400/10 text-emerald-300" : notice.tone === "error" ? "bg-red-400/10 text-red-300" : "bg-amber-300/10 text-amber-200"}`}>
              {notice.tone === "success" ? <Check className="h-6 w-6" /> : <AlertTriangle className="h-6 w-6" />}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-2xl font-bold">{notice.tone === "success" ? "İşlem başarılı" : notice.tone === "error" ? "İşlem tamamlanamadı" : "Bilgilendirme"}</h2>
              <p className="mt-2 whitespace-pre-line text-sm leading-6 text-zinc-300">{notice.message}</p>
            </div>
            <button onClick={() => setNotice(null)} className="rounded-xl bg-white/10 p-2 text-zinc-300 hover:bg-white/15">
              <X className="h-5 w-5" />
            </button>
          </div>
          <button onClick={() => setNotice(null)} className="w-full rounded-2xl bg-amber-300 px-4 py-3 font-bold text-black">Tamam</button>
        </Card>
      </div>}

      {confirmDialog && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4">
        <Card className={`w-full max-w-md bg-zinc-950/95 ${confirmDialog.tone === "danger" ? "border-red-300/20" : "border-amber-300/20"}`}>
          <div className="mb-4 flex items-start gap-3">
            <div className={`rounded-2xl p-3 ${confirmDialog.tone === "danger" ? "bg-red-400/10 text-red-300" : "bg-amber-300/10 text-amber-200"}`}>
              <AlertTriangle className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-2xl font-bold">{confirmDialog.title || "Emin misiniz?"}</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-300">{confirmDialog.message}</p>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              onClick={async () => {
                const run = confirmDialog.onConfirm;
                setConfirmDialog(null);
                await run?.();
              }}
              className={`rounded-2xl px-4 py-3 font-bold ${confirmDialog.tone === "danger" ? "bg-red-400 text-black" : "bg-amber-300 text-black"}`}
            >
              {confirmDialog.confirmText || "Onayla"}
            </button>
            <button onClick={() => setConfirmDialog(null)} className="rounded-2xl bg-white/10 px-4 py-3 font-semibold text-zinc-100">Vazgeç</button>
          </div>
        </Card>
      </div>}

      {debtWarning && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
        <Card className="w-full max-w-md border-red-300/20 bg-zinc-950/95">
          <div className="mb-4 flex items-start gap-3">
            <div className="rounded-2xl bg-red-400/10 p-3 text-red-300">
              <AlertTriangle />
            </div>
            <div>
              <h2 className="text-2xl font-bold">Ödenmemiş borcunuz var</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-300">
                Yeni randevu oluşturabilmek için işletme ile iletişime geçip mevcut borcunuzu kapatmanız gerekiyor.
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-red-300/20 bg-red-400/10 p-4 text-sm text-red-100">
            Açık borç kaydı bulundu. Ödeme sonrası randevu oluşturma tekrar aktif olur.
          </div>
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            <a href={`tel:${debtWarning.phone}`} className="rounded-2xl bg-amber-300 px-4 py-3 text-center font-bold text-black">
              <PhoneCall className="mr-2 inline h-4 w-4" />İşletmeyi Ara
            </a>
            <button onClick={() => setDebtWarning(null)} className="rounded-2xl bg-white/10 px-4 py-3 font-semibold text-zinc-100">Tamam</button>
          </div>
        </Card>
      </div>}

      {complete && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
        <Card className="w-full max-w-md">
          <h2 className="mb-3 text-2xl font-bold">Randevuyu Tamamla</h2>
          <OptionPicker
            value={complete.paymentStatus}
            onChange={(st) => {
              const total = Number(complete.totalAmount ?? complete.tariff ?? 0);
              const paid = Number(complete.amount || 0);
              setComplete({
                ...complete,
                paymentStatus: st,
                amount: st === "debt" ? 0 : (st === "paid" || st === "card") ? total : complete.amount,
                remainingDebt: st === "debt" ? total : (st === "paid" || st === "card") ? 0 : Math.max(total - paid, 0),
              });
            }}
            options={[
              { value: "paid", label: "Ödendi" },
              { value: "card", label: "Kredi kartı" },
              { value: "partial", label: "Kısmi ödeme" },
              { value: "debt", label: "Veresiye" },
            ]}
            placeholder="Ödeme durumu"
            className="mb-3"
          />
          <label className="mb-3 block">
            <span className="mb-2 block text-sm text-zinc-400">İşlem tutarı</span>
            <Input
              type="number"
              min="0"
              value={complete.totalAmount ?? complete.tariff ?? 0}
              onChange={(e) => {
                const totalValue = e.target.value;
                const total = Number(totalValue || 0);
                const paid = Number(complete.amount || 0);
                setComplete({
                  ...complete,
                  totalAmount: totalValue,
                  tariff: total,
                  amount: (complete.paymentStatus === "paid" || complete.paymentStatus === "card") ? totalValue : complete.paymentStatus === "debt" ? 0 : complete.amount,
                  remainingDebt: (complete.paymentStatus === "paid" || complete.paymentStatus === "card") ? 0 : complete.paymentStatus === "debt" ? total : Math.max(total - paid, 0),
                });
              }}
              placeholder="İşlem tutarı"
              className="w-full"
            />
          </label>
          <label className="mb-3 block">
            <span className="mb-2 block text-sm text-zinc-400">Alınan ücret</span>
            <Input
              type="number"
              min="0"
              value={complete.amount}
              onChange={(e) => {
                const amount = e.target.value;
                const total = Number(complete.totalAmount ?? complete.tariff ?? 0);
                setComplete({
                  ...complete,
                  amount,
                  remainingDebt: complete.paymentStatus === "partial" ? Math.max(total - Number(amount || 0), 0) : complete.remainingDebt,
                });
              }}
              placeholder="Alınan ücret"
              className="w-full"
            />
          </label>
          <label className="mb-4 block">
            <span className="mb-2 block text-sm text-zinc-400">Kalan borç</span>
            <Input type="number" min="0" value={complete.remainingDebt} onChange={(e)=>setComplete({...complete,remainingDebt:e.target.value})} placeholder="Kalan borç" className="w-full" />
          </label>
          <div className="flex gap-2">
            <button onClick={saveComplete} className="flex-1 rounded-2xl bg-amber-300 px-4 py-3 font-bold text-black">Kaydet</button>
            <button onClick={()=>setComplete(null)} className="rounded-2xl bg-white/10 px-4 py-3">Vazgeç</button>
          </div>
        </Card>
      </div>}
      {debtPay && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><Card className="w-full max-w-md"><h2 className="mb-1 text-2xl font-bold">Borç Ödemesi</h2><p className="mb-4 text-sm text-zinc-400">{debtPay.name || "Müşteri"} · Toplam borç {debtPay.totalDebt || debtPay.amount} TL</p><Input type="number" min="0" max={debtPay.totalDebt || debtPay.amount} value={debtPay.amount} onChange={(e)=>setDebtPay({...debtPay,amount:e.target.value})} className="mb-3 w-full" /><div className="flex gap-2"><button onClick={payDebt} className="flex-1 rounded-2xl bg-amber-300 px-4 py-3 font-bold text-black">Ödemeyi Kaydet</button><button onClick={()=>setDebtPay(null)} className="rounded-2xl bg-white/10 px-4 py-3">Vazgeç</button></div></Card></div>}
    </div>
  );
}
