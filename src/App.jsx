// @ts-nocheck
import React, { useEffect, useMemo, useState } from "react";
import { Scissors, Search, Plus, Trash2, Check, X, MessageCircle, CreditCard, Users, Settings, CalendarDays, Clock, LogOut, Lock, UserPlus, UserRound } from "lucide-react";
import { supabase } from "./supabase";
const LS_KEY = "mabel_hair_art_clean_v1";
const CUSTOMER_SESSION_KEY = "mabel_hair_art_customer_session_v1";
const ADMIN_PIN = "Hardiler1";

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
};

function todayISO(offset = 0) {
  const d = new Date();
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
function wa(phone, text) {
  return `https://wa.me/${normPhone(phone)}?text=${encodeURIComponent(text)}`;
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

function Card({ children, className = "" }) {
  return <div className={`rounded-3xl border border-white/10 bg-white/[0.06] p-5 shadow-2xl shadow-black/30 backdrop-blur ${className}`}>{children}</div>;
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
function Status({ value }) {
  const cls = value === "done" ? "text-blue-300 bg-blue-400/10" : value === "cancelled" ? "text-red-300 bg-red-400/10" : "text-emerald-300 bg-emerald-400/10";
  const label = value === "done" ? "Tamamlandı" : value === "cancelled" ? "İptal" : "Aktif";
  return <span className={`rounded-full px-3 py-1 text-xs ${cls}`}>{label}</span>;
}

export default function MabelHairArt() {
  const [data, setData] = useState(loadData);
  const [view, setView] = useState("customer");
  const [customerAuthMode, setCustomerAuthMode] = useState("login");
  const [currentCustomer, setCurrentCustomer] = useState(null);
  const [customerPanel, setCustomerPanel] = useState("booking");
  const [customerBookingStep, setCustomerBookingStep] = useState("service");
  const [profileForm, setProfileForm] = useState({ name: "", phone: "", username: "", password: "" });
  const [customerLogin, setCustomerLogin] = useState({ username: "", password: "" });
  const [customerRegister, setCustomerRegister] = useState({ username: "", password: "", phone: "", name: "" });
  const [logged, setLogged] = useState(false);
  const [pin, setPin] = useState("");
  const [tab, setTab] = useState("appointments");
  const [search, setSearch] = useState("");
  const [adminDate, setAdminDate] = useState(todayISO(0));
  const [customerSearch, setCustomerSearch] = useState("");
  const [selectedCustomerPhone, setSelectedCustomerPhone] = useState(null);

  const [serviceId, setServiceId] = useState(data.services[0]?.id || "sac");
  const [staffId, setStaffId] = useState(data.staff[0]?.id || "mabel");
  const [date, setDate] = useState(todayISO(0));
  const [time, setTime] = useState("10:00");
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");

  const [complete, setComplete] = useState(null);
  const [debtPay, setDebtPay] = useState(null);
  const [newService, setNewService] = useState({ name: "", price: "", time: 30, desc: "" });
  const [editingService, setEditingService] = useState(null);
  const [newStaff, setNewStaff] = useState({ name: "", role: "" });
  const [newLeave, setNewLeave] = useState({ staffId: data.staff[0]?.id || "mabel", startDate: todayISO(0), endDate: todayISO(0), reason: "İzin" });
  const [newBlock, setNewBlock] = useState({ staffId: "all", date: todayISO(0), startTime: "12:00", endTime: "13:00", reason: "Kapalı" });

  const [appStateReady, setAppStateReady] = useState(false);

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

  async function loadRemoteAppState() {
    const { data: row, error } = await supabase
      .from("app_state")
      .select("data")
      .eq("id", 1)
      .maybeSingle();

    if (error) {
      console.log("App state load error:", error);
      setAppStateReady(true);
      return;
    }

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
    const { data: rows, error } = await supabase
      .from("appointments")
      .select("*")
      .order("appointment_date", { ascending: true })
      .order("appointment_time", { ascending: true });

    if (error) {
      console.log("Appointments load error:", error);
      return;
    }

    if (rows) {
      setData((d) => ({
        ...d,
        appointments: rows.map(normalizeAppointmentRow),
      }));
    }
  }

  useEffect(() => {
    loadRemoteAppointments();

    const timer = setInterval(loadRemoteAppointments, 5000);

    const channel = supabase
      .channel("appointments-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "appointments" },
        () => loadRemoteAppointments()
      )
      .subscribe();

    return () => {
      clearInterval(timer);
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    loadRemoteAppState();

    const timer = setInterval(loadRemoteAppState, 5000);

    const channel = supabase
      .channel("app-state-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "app_state" },
        () => loadRemoteAppState()
      )
      .subscribe();

    return () => {
      clearInterval(timer);
      supabase.removeChannel(channel);
    };
  }, []);


  useEffect(() => {
    const saved = localStorage.getItem(CUSTOMER_SESSION_KEY);
    if (!saved || currentCustomer) return;

    try {
      const session = JSON.parse(saved);
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
      }
    } catch {}
  }, [data.customerAccounts, currentCustomer]);

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

    const timer = setTimeout(async () => {
      const { error } = await supabase
        .from("app_state")
        .upsert({
          id: 1,
          data: adminStatePayload(),
          updated_at: new Date().toISOString(),
        });

      if (error) console.log("App state save error:", error);
    }, 500);

    return () => clearTimeout(timer);
  }, [appStateReady, adminStateJson]);

  useEffect(() => localStorage.setItem(LS_KEY, JSON.stringify(data)), [data]);

  const serviceMap = useMemo(() => Object.fromEntries(data.services.map((s) => [s.id, s])), [data.services]);
  const staffMap = useMemo(() => Object.fromEntries(data.staff.map((s) => [s.id, s])), [data.staff]);
  const selectedService = serviceMap[serviceId] || data.services[0];
  const selectedStaff = staffMap[staffId] || data.staff[0];

  const slots = useMemo(() => {
    const out = [];
    for (let m = toMin(data.settings.openTime); m <= toMin(data.settings.closeTime) - Number(data.settings.slotStep); m += Number(data.settings.slotStep)) out.push(toTime(m));
    return out;
  }, [data.settings]);

  function isClosed(d, startTime, stf, srv) {
    const srvObj = serviceMap[srv] || { time: 30 };
    const start = toMin(startTime);
    const end = start + Number(srvObj.time || 30);
    if (end > toMin(data.settings.closeTime)) return true;
    if (data.settings.lunchEnabled && overlap(start, end, toMin(data.settings.lunchStart), toMin(data.settings.lunchEnd))) return true;
    if (data.staffLeaves.some((l) => l.staffId === stf && d >= l.startDate && d <= l.endDate)) return true;
    if (data.blockedSlots.some((b) => b.date === d && (b.staffId === "all" || b.staffId === stf) && overlap(start, end, toMin(b.startTime), toMin(b.endTime)))) return true;
    return data.appointments.some((a) => {
      if (a.status !== "active" || a.date !== d || a.staffId !== stf) return false;
      const otherStart = toMin(a.time);
      const otherEnd = otherStart + Number(serviceMap[a.serviceId]?.time || 30);
      return overlap(start, end, otherStart, otherEnd);
    });
  }

  const availableSlots = slots.filter((s) => {
  if (isClosed(date, s, staffId, serviceId)) return false;

  const slotDateTime = new Date(`${date}T${s}:00`);
  const now = new Date();

  if (slotDateTime <= now) return false;

  return true;
});
  useEffect(() => {
  const today = todayISO(0);

  if (date < today) {
    setDate(today);
    return;
  }

  if (availableSlots.length && !availableSlots.includes(time)) {
    setTime(availableSlots[0]);
  }
}, [date, availableSlots.join("|"), time]);
  const completed = data.appointments.filter((a) => a.status === "done");
  const todayRevenue = completed.filter((a) => a.date === todayISO(0)).reduce((s, a) => s + Number(a.paidAmount || 0), 0);
  const totalRevenue = completed.reduce((s, a) => s + Number(a.paidAmount || 0), 0);
  const totalDebt = data.appointments.reduce((s, a) => s + Number(a.remainingDebt || 0), 0);

  const customers = useMemo(() => {
    const map = {};
    data.appointments.forEach((a) => {
      const key = a.phone;
      if (!map[key]) map[key] = { name: a.customerName, phone: a.phone, count: 0, debt: 0, spent: 0, last: a.date + " " + a.time };
      map[key].count += 1;
      map[key].debt += Number(a.remainingDebt || 0);
      map[key].spent += Number(a.paidAmount || 0);
      if ((a.date + a.time) > map[key].last.replace(" ", "")) map[key].last = a.date + " " + a.time;
    });
    return Object.values(map);
  }, [data.appointments]);

  const filteredCustomers = customers.filter((c) => {
    const q = customerSearch.trim().toLowerCase();
    if (!q) return true;
    return `${c.name} ${c.phone}`.toLowerCase().includes(q);
  });

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
  const todayCount = data.appointments.filter((a) => a.date === todayISO(0) && a.status === "active").length;
  const densityPct = Math.min(100, Math.round((todayCount / Math.max(slots.length, 1)) * 100));
  const density = todayCount === 0
    ? { text: "Bugün boş", desc: "Tüm saatler rahat görünüyor", pct: 0 }
    : densityPct <= 30
      ? { text: "Bugün sakin", desc: "Rahat saatler mevcut", pct: densityPct }
      : densityPct <= 65
        ? { text: "Bugün orta yoğun", desc: "Uygun saatler azalıyor", pct: densityPct }
        : { text: "Bugün yoğun", desc: "Erken randevu almanız önerilir", pct: densityPct };
  const myAppointments = currentCustomer
    ? data.appointments
        .filter((a) => a.phone === currentCustomer.phone)
        .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))
    : [];
  const myActiveAppointments = myAppointments.filter((a) => a.status === "active" && new Date(`${a.date}T${a.time}:00`) >= new Date());
  const myPastAppointments = myAppointments.filter((a) => a.status !== "active" || new Date(`${a.date}T${a.time}:00`) < new Date());


  async function addAppointment(payload) {
    if (!payload.customerName || normPhone(payload.phone).length < 10) return alert("Ad ve telefon girin.");
    if (isClosed(payload.date, payload.time, payload.staffId, payload.serviceId)) return alert("Bu saat uygun değil.");

    const selectedStaffKey = payload.staffId || "mabel";
    const requestedService = serviceMap[payload.serviceId] || { time: 30 };
    const requestedStart = toMin(payload.time);
    const requestedEnd = requestedStart + Number(requestedService.time || 30);

    const { data: latestRows, error: latestError } = await supabase
      .from("appointments")
      .select("*")
      .eq("appointment_date", payload.date)
      .eq("staff_key", selectedStaffKey)
      .eq("status", "active");

    if (latestError) {
      console.log("Latest appointments check error:", latestError);
    }

    const latestAppointments = latestError ? [] : (latestRows || []).map(normalizeAppointmentRow);
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

    const { error } = await supabase
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

    console.log("Supabase error:", error);

    if (error) {
      await loadRemoteAppointments();
      if (error.code === "23505") {
        alert("Bu saat az önce doldu. Lütfen başka bir saat seçin.");
      } else {
        alert(`Veritabanına kayıt olmadı: ${error.message || error.code || "Bilinmeyen hata"}`);
      }
      return false;
    }

    setData((d) => ({
      ...d,
      appointments: [
        ...d.appointments,
        {
          ...payload,
          id: id(),
          phone: normPhone(payload.phone),
          status: "active",
          paidAmount: 0,
          remainingDebt: 0,
        },
      ],
    }));

    loadRemoteAppointments();

    return true;
  }

  async function book() {
    if (!currentCustomer) return alert("Randevu almak için giriş yapın veya kayıt olun.");

    const ok = await addAppointment({
      customerName: currentCustomer.name || customerName,
      phone: currentCustomer.phone || phone,
      serviceId,
      staffId,
      date,
      time,
      note,
    });

    if (ok) {
      setCustomerName("");
      setPhone("");
      setNote("");
      setCustomerPanel("appointments");
      setCustomerBookingStep("service");
      alert("Randevu oluşturuldu.");
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
    if (!profileForm.username || !profileForm.password || normPhone(profileForm.phone).length < 10) {
      return alert("Kullanıcı adı, şifre ve telefon zorunlu.");
    }

    const normalizedPhone = normPhone(profileForm.phone);
    const usernameTaken = (data.customerAccounts || []).some((u) => u.username === profileForm.username && u.id !== currentCustomer.id);
    if (usernameTaken) return alert("Bu kullanıcı adı başka müşteri tarafından kullanılıyor.");

    const updated = {
      ...currentCustomer,
      name: profileForm.name || profileForm.username,
      phone: normalizedPhone,
      username: profileForm.username,
      password: profileForm.password,
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
        console.log("Profile appointment update error:", error);
        alert("Profil randevulara işlenemedi. Console hatasına bak.");
        return;
      }
    }

    setData((d) => ({
      ...d,
      customerAccounts: (d.customerAccounts || []).map((u) => u.id === currentCustomer.id ? updated : u),
      appointments: d.appointments.map((a) => a.phone === oldPhone ? { ...a, customerName: updated.name, phone: updated.phone } : a),
    }));
    setCurrentCustomer(updated);
    setCustomerName(updated.name);
    setPhone(updated.phone);
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

  function openComplete(a) {
    const price = Number(serviceMap[a.serviceId]?.price || 0);
    setComplete({ id: a.id, amount: price, paymentStatus: "paid", remainingDebt: 0, tariff: price });
  }

  async function saveComplete() {
    let paid = Number(complete.amount || 0);
    let debt = Number(complete.remainingDebt || 0);
    if (complete.paymentStatus === "debt") { paid = 0; debt = Number(complete.tariff); }
    if (complete.paymentStatus === "partial") debt = Math.max(Number(complete.tariff) - paid, 0);
    if (complete.paymentStatus === "paid") debt = 0;

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
      console.log("Complete appointment error:", error);
      alert("Randevu tamamlanamadı. Console hatasına bak.");
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
        return {
          id: target.id,
          paidAmount: Number(target.paidAmount || 0) + paid,
          remainingDebt: Math.max(oldDebt - paid, 0),
        };
      })
      .filter((u) => targets.some((a) => a.id === u.id && Number(a.remainingDebt || 0) !== u.remainingDebt));

    const results = await Promise.all(updates.map((u) =>
      supabase
        .from("appointments")
        .update({
          paid_amount: u.paidAmount,
          remaining_debt: u.remainingDebt,
        })
        .eq("id", u.id)
    ));

    const error = results.find((r) => r.error)?.error;
    if (error) {
      console.log("Debt payment error:", error);
      alert("Borç ödemesi kaydedilemedi. Console hatasına bak.");
      return;
    }

    setData((d) => ({ ...d, appointments: d.appointments.map((a) => {
      const update = updates.find((u) => u.id === a.id);
      if (!update) return a;
      return { ...a, paidAmount: update.paidAmount, remainingDebt: update.remainingDebt };
    }) }));
    setDebtPay(null);
    loadRemoteAppointments();
  }

  async function cancelAppointment(apptId) {
    const { error } = await supabase
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", apptId);

    if (error) {
      console.log("Cancel appointment error:", error);
      alert("Randevu iptal edilemedi. Console hatasına bak.");
      return;
    }

    setData((d) => ({ ...d, appointments: d.appointments.map((x) => x.id === apptId ? { ...x, status: "cancelled" } : x) }));
    loadRemoteAppointments();
  }

  async function deleteAppointment(apptId) {
    const ok = confirm("Bu randevu tamamen silinsin mi?");
    if (!ok) return;

    const { error } = await supabase
      .from("appointments")
      .delete()
      .eq("id", apptId);

    if (error) {
      console.log("Delete appointment error:", error);
      alert("Randevu silinemedi. Console hatasına bak.");
      return;
    }

    setData((d) => ({ ...d, appointments: d.appointments.filter((x) => x.id !== apptId) }));
    loadRemoteAppointments();
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

  function msg(a) {
    return `Sayın ${a.customerName}, Mabel Hair Art randevunuz ${prettyDate(a.date)} saat ${a.time}. Gelemeyecekseniz lütfen iptal etmeyi unutmayınız.`;
  }

  const adminDays = useMemo(() => {
    const weekday = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
    return Array.from({ length: 14 }, (_, i) => {
      const iso = todayISO(i);
      const d = new Date(`${iso}T12:00:00`);
      return {
        iso,
        day: d.getDate(),
        label: i === 0 ? "Bugün" : i === 1 ? "Yarın" : weekday[d.getDay()],
        month: d.toLocaleDateString("tr-TR", { month: "long" }),
        count: data.appointments.filter((a) => a.date === iso && a.status === "active").length,
      };
    });
  }, [data.appointments]);

  const adminSchedule = useMemo(() => {
    const q = search.trim().toLowerCase();
    return slots
      .map((slot) => {
        const appointment = data.appointments.find((a) => a.date === adminDate && a.time === slot);
        const duration = Number(serviceMap[appointment?.serviceId]?.time || data.settings.slotStep || 30);
        return {
          slot,
          end: toTime(toMin(slot) + duration),
          appointment,
        };
      })
      .filter(({ appointment }) => {
        if (!q) return true;
        if (!appointment) return false;
        return `${appointment.customerName} ${appointment.phone} ${serviceMap[appointment.serviceId]?.name || ""} ${staffMap[appointment.staffId]?.name || ""}`.toLowerCase().includes(q);
      });
  }, [adminDate, data.appointments, data.settings.slotStep, search, serviceMap, slots, staffMap]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#080808] text-white">
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute left-1/2 top-[-12rem] h-[34rem] w-[34rem] -translate-x-1/2 rounded-full bg-amber-500/20 blur-3xl" />
        <div className="absolute bottom-[-10rem] right-[-8rem] h-[28rem] w-[28rem] rounded-full bg-amber-700/10 blur-3xl" />
      </div>
      <header className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-5 py-6">
        <div className="flex items-center gap-3">
          <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl border border-amber-400/40 bg-amber-400/10 shadow-lg shadow-amber-500/10">
            <Scissors className="h-6 w-6 text-amber-300" />
            <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-amber-300" />
          </div>
          <div>
            <div className="text-xl font-semibold tracking-wide text-white">Mabel</div>
            <div className="-mt-1 text-xs tracking-[0.35em] text-amber-300">HAIR ART</div>
          </div>
        </div>
        <div className="flex gap-2 text-sm">
          <button onClick={() => setView("customer")} className={`rounded-full px-4 py-2 ${view === "customer" ? "bg-amber-300 text-black" : "border border-white/10 bg-white/5 text-zinc-200"}`}>Müşteri</button>
          <button onClick={() => setView("admin")} className={`rounded-full px-4 py-2 ${view === "admin" ? "bg-amber-300 text-black" : "border border-white/10 bg-white/5 text-zinc-200"}`}>Admin Panel</button>
        </div>
      </header>

      {view === "customer" && (
        <main className="relative z-10 mx-auto max-w-7xl px-5 pb-16">
          <section className="grid gap-8 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
            <div>
              <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-amber-300/20 bg-amber-300/10 px-4 py-2 text-sm text-amber-100">
                Premium online randevu sistemi
              </div>
              <h1 className="max-w-4xl text-5xl font-bold leading-tight md:text-7xl">
                Mabel Hair Art randevunuzu kolayca oluşturun.
              </h1>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-zinc-300">
                Modern stil, profesyonel dokunuş.Randevunuzu şimdi oluşturun..
              </p>
            </div>

            <Card className="relative overflow-hidden">
              <div className="absolute right-0 top-0 h-32 w-32 rounded-bl-full bg-amber-300/10" />
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-semibold">Bugünün yoğunluğu</h2>
                  <p className="mt-1 text-sm text-zinc-400">Müsaitlik durumuna göre genel bilgi</p>
                </div>
                <div className="rounded-2xl border border-amber-300/30 bg-amber-300/10 p-3 text-amber-200">
                  <CalendarDays className="h-6 w-6" />
                </div>
              </div>
              <div className="mt-8 rounded-3xl border border-white/10 bg-black/30 p-5">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-3xl font-bold text-amber-200">{density.text}</div>
                  <div className="text-sm text-zinc-400">{density.pct}%</div>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-amber-300" style={{ width: `${density.pct}%` }} />
                </div>
                <p className="mt-4 text-sm text-zinc-300">{density.desc}</p>
              </div>
            </Card>
          </section>

          <section id="randevu" className={`grid gap-6 ${currentCustomer ? "lg:grid-cols-[1fr_380px]" : "lg:grid-cols-[1fr_0.85fr]"}`}>
            <Card>
              <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-3xl font-semibold">{currentCustomer ? "Müşteri Paneli" : "Randevu için giriş yapın"}</h2>
                  <p className="mt-1 text-zinc-400">{currentCustomer ? "Randevunuzu adım adım oluşturun, bilgilerinizi ve randevularınızı yönetin." : "Giriş yaptıktan sonra hizmet, personel, tarih ve saat seçimi açılır."}</p>
                </div>
                <div className="rounded-2xl border border-amber-300/30 bg-amber-300/10 p-3 text-amber-200">
                  {currentCustomer ? <UserRound className="h-6 w-6" /> : <Lock className="h-6 w-6" />}
                </div>
              </div>

              {!currentCustomer ? (
                <div className="rounded-3xl border border-amber-300/20 bg-amber-300/10 p-5">
                  <div className="mb-4 flex gap-2">
                    <button onClick={() => setCustomerAuthMode("login")} className={`rounded-full px-4 py-2 text-sm ${customerAuthMode === "login" ? "bg-amber-300 text-black" : "bg-black/30 text-zinc-200"}`}>Giriş Yap</button>
                    <button onClick={() => setCustomerAuthMode("register")} className={`rounded-full px-4 py-2 text-sm ${customerAuthMode === "register" ? "bg-amber-300 text-black" : "bg-black/30 text-zinc-200"}`}>Kayıt Ol</button>
                  </div>
                  {customerAuthMode === "login" ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      <Input placeholder="Kullanıcı adı" value={customerLogin.username} onChange={(e) => setCustomerLogin({ ...customerLogin, username: e.target.value })} />
                      <Input type="password" placeholder="Şifre" value={customerLogin.password} onChange={(e) => setCustomerLogin({ ...customerLogin, password: e.target.value })} />
                      <button onClick={loginCustomer} className="rounded-2xl bg-amber-300 px-5 py-3 font-bold text-black md:col-span-2"><UserRound className="mr-2 inline h-4 w-4" /> Giriş Yap</button>
                    </div>
                  ) : (
                    <div className="grid gap-3 md:grid-cols-2">
                      <Input placeholder="Ad Soyad" value={customerRegister.name} onChange={(e) => setCustomerRegister({ ...customerRegister, name: e.target.value })} />
                      <Input placeholder="Telefon" value={customerRegister.phone} onChange={(e) => setCustomerRegister({ ...customerRegister, phone: e.target.value })} />
                      <Input placeholder="Kullanıcı adı" value={customerRegister.username} onChange={(e) => setCustomerRegister({ ...customerRegister, username: e.target.value })} />
                      <Input type="password" placeholder="Şifre" value={customerRegister.password} onChange={(e) => setCustomerRegister({ ...customerRegister, password: e.target.value })} />
                      <button onClick={registerCustomer} className="rounded-2xl bg-amber-300 px-5 py-3 font-bold text-black md:col-span-2"><UserPlus className="mr-2 inline h-4 w-4" /> Kayıt Ol</button>
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <div className="mb-5 rounded-3xl border border-emerald-400/20 bg-emerald-400/10 p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-semibold text-emerald-200">{currentCustomer.name}</div>
                        <div className="text-sm text-zinc-300">{currentCustomer.phone}</div>
                      </div>
                      <button onClick={logoutCustomer} className="rounded-xl bg-black/30 px-3 py-2 text-xs">Çıkış</button>
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button onClick={() => setCustomerPanel("booking")} className={`rounded-full px-4 py-2 text-sm ${customerPanel === "booking" ? "bg-amber-300 text-black" : "bg-black/30 text-zinc-200"}`}>Randevu Al</button>
                      <button onClick={() => setCustomerPanel("appointments")} className={`rounded-full px-4 py-2 text-sm ${customerPanel === "appointments" ? "bg-amber-300 text-black" : "bg-black/30 text-zinc-200"}`}>Randevularım</button>
                      <button onClick={() => setCustomerPanel("profile")} className={`rounded-full px-4 py-2 text-sm ${customerPanel === "profile" ? "bg-amber-300 text-black" : "bg-black/30 text-zinc-200"}`}>Profilim</button>
                    </div>
                  </div>

                  {customerPanel === "booking" && (
                    <div className="space-y-6">
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <button onClick={() => setCustomerBookingStep("service")} className={`rounded-2xl border px-4 py-3 text-left ${customerBookingStep === "service" ? "border-amber-300 bg-amber-300 text-black" : "border-white/10 bg-black/20 text-zinc-300"}`}><b>1</b> Hizmet & Personel</button>
                        <button onClick={() => setCustomerBookingStep("datetime")} className={`rounded-2xl border px-4 py-3 text-left ${customerBookingStep === "datetime" ? "border-amber-300 bg-amber-300 text-black" : "border-white/10 bg-black/20 text-zinc-300"}`}><b>2</b> Tarih & Saat</button>
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
                              {data.staff.filter((s) => s.active).map((s) => (
                                <button key={s.id} onClick={() => setStaffId(s.id)} className={`rounded-2xl border p-4 text-left transition ${staffId === s.id ? "border-amber-300 bg-amber-300/10" : "border-white/10 bg-black/20 hover:border-white/25"}`}>
                                  <b>{s.name}</b>
                                  <div className="mt-1 text-sm text-zinc-400">{s.role}</div>
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-zinc-300">
                            Seçiminiz hazır. Üstteki <b className="text-amber-200">2 Tarih & Saat</b> adımına dokunup uygun saati seçin.
                          </div>
                        </div>
                      )}

                      {customerBookingStep === "datetime" && (
                        <div className="space-y-6">
                          <div>
                            <h3 className="mb-3 flex items-center gap-2 font-semibold"><CalendarDays className="h-5 w-5 text-amber-300" /> Tarih Seç</h3>
                            <Input type="date" min={todayISO(0)} value={date} onChange={(e) => setDate(e.target.value)} className="w-full md:w-72" />
                          </div>
                          <div>
                            <h3 className="mb-3 flex items-center gap-2 font-semibold"><Clock className="h-5 w-5 text-amber-300" /> Uygun Saatler</h3>
                            <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
                              {availableSlots.map((s) => (
                                <button key={s} onClick={() => setTime(s)} className={`rounded-2xl border px-3 py-3 text-sm transition ${time === s ? "border-amber-300 bg-amber-300 text-black" : "border-white/10 bg-black/20 hover:border-white/25"}`}>{s}</button>
                              ))}
                              {availableSlots.length === 0 && <div className="col-span-full rounded-2xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-200">Uygun saat yok.</div>}
                            </div>
                          </div>
                          <Textarea placeholder="Not / İstek" value={note} onChange={(e) => setNote(e.target.value)} className="min-h-24 w-full py-4" />
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <button onClick={() => setCustomerBookingStep("service")} className="rounded-2xl bg-white/10 px-5 py-4 font-semibold">Geri</button>
                            <button onClick={book} disabled={!availableSlots.length} className="flex-1 rounded-2xl bg-amber-300 px-5 py-4 font-bold text-black shadow-xl shadow-amber-500/20 disabled:opacity-40">Randevuyu Oluştur</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {customerPanel === "appointments" && (
                    <div className="space-y-4">
                      <div>
                        <h4 className="mb-2 font-semibold text-emerald-200">Aktif Randevularım</h4>
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

                      <div>
                        <h4 className="mb-2 font-semibold text-zinc-200">Geçmiş / İptal Randevularım</h4>
                        <div className="space-y-2">
                          {myPastAppointments.length === 0 && <div className="rounded-2xl bg-black/30 p-3 text-sm text-zinc-300">Geçmiş randevunuz yok.</div>}
                          {myPastAppointments.slice(0, 8).map((a) => (
                            <div key={a.id} className="rounded-2xl bg-black/30 p-4">
                              <div className="flex items-center justify-between gap-3">
                                <div>
                                  <b>{prettyDate(a.date)} · {a.time}</b>
                                  <div className="text-sm text-zinc-400">{serviceMap[a.serviceId]?.name} · {staffMap[a.staffId]?.name}</div>
                                </div>
                                <Status value={a.status} />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {customerPanel === "profile" && (
                    <div className="grid gap-3 md:grid-cols-2">
                      <Input placeholder="Ad Soyad" value={profileForm.name} onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })} />
                      <Input placeholder="Telefon" value={profileForm.phone} onChange={(e) => setProfileForm({ ...profileForm, phone: e.target.value })} />
                      <Input placeholder="Kullanıcı adı" value={profileForm.username} onChange={(e) => setProfileForm({ ...profileForm, username: e.target.value })} />
                      <Input type="password" placeholder="Şifre" value={profileForm.password} onChange={(e) => setProfileForm({ ...profileForm, password: e.target.value })} />
                      <button onClick={updateCustomerProfile} className="rounded-2xl bg-amber-300 px-5 py-3 font-bold text-black md:col-span-2">Profili Kaydet</button>
                    </div>
                  )}
                </div>
              )}
            </Card>

            <Card className="h-fit lg:sticky lg:top-5">
              {currentCustomer ? (
                <>
                  <h2 className="text-2xl font-semibold">Randevu Özeti</h2>
                  <div className="mt-5 space-y-4 text-sm">
                    <div className="flex justify-between gap-4 border-b border-white/10 pb-3"><span className="text-zinc-400">Hizmet</span><b>{selectedService?.name}</b></div>
                    <div className="flex justify-between gap-4 border-b border-white/10 pb-3"><span className="text-zinc-400">Süre</span><b>{selectedService?.time} dk</b></div>
                    <div className="flex justify-between gap-4 border-b border-white/10 pb-3"><span className="text-zinc-400">Fiyat</span><b className="text-amber-200">{selectedService?.price} TL</b></div>
                    <div className="flex justify-between gap-4 border-b border-white/10 pb-3"><span className="text-zinc-400">Personel</span><b>{selectedStaff?.name}</b></div>
                    <div className="flex justify-between gap-4 border-b border-white/10 pb-3"><span className="text-zinc-400">Tarih</span><b>{prettyDate(date)}</b></div>
                    <div className="flex justify-between gap-4 border-b border-white/10 pb-3"><span className="text-zinc-400">Saat</span><b>{time}</b></div>
                  </div>
                  <p className="mt-3 text-center text-xs text-zinc-500">Randevu admin paneline düşer.</p>
                </>
              ) : null}
            </Card>
          </section>
        </main>
      )}

      {view === "admin" && (
        <main className="relative z-10 mx-auto max-w-7xl px-5 pb-16">
          {!logged ? <Card className="mx-auto mt-12 max-w-md"><Lock className="mb-3 text-amber-300" /><h2 className="mb-3 text-2xl font-bold">Admin Girişi</h2><Input type="password" placeholder="Şifre" value={pin} onChange={(e) => setPin(e.target.value)} /><button onClick={() => pin === ADMIN_PIN ? setLogged(true) : alert("Şifre yanlış")} className="mt-4 w-full rounded-2xl bg-amber-300 px-5 py-3 font-bold text-black">Giriş Yap</button></Card> : (
            <>
              <div className="mb-6 flex items-center justify-between"><h1 className="text-4xl font-bold">Admin Panel</h1><button onClick={() => setLogged(false)} className="rounded-2xl bg-white/10 px-4 py-2"><LogOut className="mr-2 inline h-4 w-4" />Çıkış</button></div>
              <div className="mb-6 grid gap-3 md:grid-cols-5"><Card><b>{data.appointments.filter((a) => a.date === todayISO(0)).length}</b><div className="text-sm text-zinc-400">Bugün</div></Card><Card><b>{data.appointments.filter((a) => a.status === "active").length}</b><div className="text-sm text-zinc-400">Aktif</div></Card><Card><b>{todayRevenue} TL</b><div className="text-sm text-zinc-400">Bugünkü Ciro</div></Card><Card><b>{totalRevenue} TL</b><div className="text-sm text-zinc-400">Toplam Ciro</div></Card><Card><b className="text-red-300">{totalDebt} TL</b><div className="text-sm text-zinc-400">Toplam Borç</div></Card></div>
              <div className="mb-6 flex flex-wrap gap-2">{[["appointments","Randevular"],["customers","Müşteriler"],["debts","Borçlar"],["revenue","Ciro"],["staff","Personel"],["availability","İzin/Kapalı"],["services","Hizmetler"],["settings","Ayarlar"]].map(([k,v]) => <button key={k} onClick={() => { setTab(k); setSelectedCustomerPhone(null); }} className={`rounded-full px-4 py-2 ${tab === k ? "bg-amber-300 text-black" : "bg-white/10"}`}>{v}</button>)}</div>

              {tab === "appointments" && <Card className="p-4 sm:p-5">
                <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h2 className="text-2xl font-bold">Randevu Takvimi</h2>
                    <p className="mt-1 text-sm text-zinc-400">Gün seç, o günün saat akışını tek ekranda gör.</p>
                  </div>
                  <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/30 px-3 py-2">
                    <Search className="h-5 w-5 shrink-0 text-zinc-400" />
                    <Input placeholder="Müşteri, telefon veya hizmet ara" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full border-0 bg-transparent p-0 sm:w-72" />
                  </div>
                </div>

                <div className="no-scrollbar -mx-4 mb-5 overflow-x-auto px-4 pb-2 sm:-mx-5 sm:px-5">
                  <div className="flex min-w-max gap-3">
                    {adminDays.map((d) => (
                      <button key={d.iso} onClick={() => setAdminDate(d.iso)} className={`w-32 shrink-0 rounded-2xl border p-4 text-left transition sm:w-40 ${adminDate === d.iso ? "border-amber-300 bg-amber-300 text-black shadow-lg shadow-amber-500/20" : "border-white/10 bg-black/30 text-zinc-200 hover:border-amber-300/40"}`}>
                        <div className="text-2xl font-bold leading-none">{d.day}</div>
                        <div className="mt-2 text-lg font-bold">{d.label}</div>
                        <div className={`text-sm ${adminDate === d.iso ? "text-black/70" : "text-zinc-400"}`}>{d.month}</div>
                        <div className={`mt-3 rounded-full px-2 py-1 text-center text-xs font-semibold ${adminDate === d.iso ? "bg-black/10 text-black" : "bg-white/10 text-zinc-300"}`}>{d.count} aktif</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mb-4 flex flex-col gap-2 rounded-2xl border border-white/10 bg-black/20 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-sm text-zinc-400">Seçili gün</div>
                    <div className="text-xl font-bold">{prettyDate(adminDate)}</div>
                  </div>
                  <div className="text-sm text-zinc-400">{adminSchedule.filter((x) => x.appointment).length} randevu · {adminSchedule.filter((x) => !x.appointment).length} boş saat</div>
                </div>

                <div className="space-y-3">
                  {adminSchedule.map(({ slot, end, appointment }) => appointment ? (
                    <div key={`${slot}-${appointment.id}`} className={`rounded-2xl border p-4 ${appointment.status === "active" ? "border-amber-300/30 bg-amber-300/10" : appointment.status === "done" ? "border-blue-300/20 bg-blue-400/10" : "border-white/10 bg-white/[0.04]"}`}>
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div className="min-w-0">
                          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
                            <span className="font-semibold text-zinc-200">{slot}-{end}</span>
                            <span>|</span>
                            <span>{staffMap[appointment.staffId]?.name || "Personel"}</span>
                            <Status value={appointment.status} />
                          </div>
                          <button onClick={() => { setTab("customers"); setSelectedCustomerPhone(appointment.phone); }} className="block max-w-full truncate text-left text-xl font-bold text-amber-200">{appointment.customerName}</button>
                          <div className="mt-1 text-sm text-zinc-400">{serviceMap[appointment.serviceId]?.name} · {appointment.phone}</div>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs">
                            <span className="rounded-full bg-black/30 px-3 py-1 text-zinc-300">Tarife {serviceMap[appointment.serviceId]?.price} TL</span>
                            {Number(appointment.remainingDebt || 0) > 0 && <span className="rounded-full bg-red-400/10 px-3 py-1 text-red-300">Borç {appointment.remainingDebt} TL</span>}
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
                          <a target="_blank" rel="noreferrer" href={wa(appointment.phone, msg(appointment))} className="rounded-xl bg-emerald-400/10 px-3 py-2 text-center text-xs font-semibold text-emerald-300"><MessageCircle className="mr-1 inline h-3 w-3" />WhatsApp</a>
                          <button onClick={() => openComplete(appointment)} className="rounded-xl bg-blue-400/10 px-3 py-2 text-xs font-semibold text-blue-300"><Check className="mr-1 inline h-3 w-3" />Tamamla</button>
                          <button onClick={() => cancelAppointment(appointment.id)} className="rounded-xl bg-red-400/10 px-3 py-2 text-xs font-semibold text-red-300"><X className="mr-1 inline h-3 w-3" />İptal</button>
                          <button onClick={() => deleteAppointment(appointment.id)} className="rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold"><Trash2 className="mr-1 inline h-3 w-3" />Sil</button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div key={slot} className="flex items-center justify-between gap-3 rounded-2xl border border-emerald-300/20 bg-emerald-400/10 p-4">
                      <div>
                        <div className="text-sm font-semibold text-zinc-300">{slot}-{end}</div>
                        <div className="mt-1 text-lg font-bold text-emerald-200">Boş</div>
                      </div>
                      <span className="rounded-xl bg-black/30 px-4 py-2 text-sm font-bold text-emerald-200">Müsait</span>
                    </div>
                  ))}
                  {adminSchedule.length === 0 && <div className="rounded-2xl border border-white/10 bg-black/30 p-5 text-sm text-zinc-300">Aramaya uygun randevu bulunamadı.</div>}
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
                          <button key={c.phone} onClick={() => setSelectedCustomerPhone(c.phone)} className="rounded-2xl border border-white/10 bg-black/30 p-4 text-left transition hover:border-amber-300/40 hover:bg-amber-300/5">
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
                            <div className="mt-3 flex items-center justify-between text-sm text-zinc-400">
                              <span>Harcama</span>
                              <b className="text-amber-200">{c.spent} TL</b>
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {filteredCustomers.length === 0 && <div className="rounded-2xl bg-black/30 p-5 text-sm text-zinc-300">Aramaya uygun müşteri bulunamadı.</div>}
                  </>
                ) : (
                  <div>
                    <button onClick={() => setSelectedCustomerPhone(null)} className="mb-4 rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold">Geri</button>

                    <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
                      <div className="h-fit rounded-2xl border border-amber-300/20 bg-amber-300/10 p-5">
                        <div className="text-sm text-amber-200">Müşteri Profili</div>
                        <h3 className="mt-2 text-2xl font-bold">{selectedCustomer?.name || "Müşteri"}</h3>
                        <div className="mt-1 text-sm text-zinc-300">{selectedCustomerPhone}</div>
                        <div className="mt-5 grid grid-cols-2 gap-2 text-center text-sm">
                          <div className="rounded-xl bg-black/30 px-3 py-3"><b className="block text-white">{selectedCustomer?.count || 0}</b><span className="text-xs text-zinc-400">Randevu</span></div>
                          <div className="rounded-xl bg-black/30 px-3 py-3"><b className="block text-emerald-300">{selectedCustomerActiveAppointments.length}</b><span className="text-xs text-zinc-400">Mevcut</span></div>
                          <div className="rounded-xl bg-black/30 px-3 py-3"><b className="block text-amber-200">{selectedCustomer?.spent || 0} TL</b><span className="text-xs text-zinc-400">Harcama</span></div>
                          <div className="rounded-xl bg-black/30 px-3 py-3"><b className="block text-red-300">{selectedCustomer?.debt || 0} TL</b><span className="text-xs text-zinc-400">Borç</span></div>
                        </div>
                        <a target="_blank" rel="noreferrer" href={wa(selectedCustomerPhone, "Merhaba, Mabel Hair Art randevunuz hakkında iletişime geçiyoruz.")} className="mt-4 block rounded-2xl bg-emerald-400/10 px-4 py-3 text-center font-semibold text-emerald-300"><MessageCircle className="mr-2 inline h-4 w-4" />WhatsApp</a>
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
                    <p className="mt-1 text-sm text-zinc-400">Aynı müşterinin borçları tek toplam altında takip edilir.</p>
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
                          <button onClick={() => { setTab("customers"); setSelectedCustomerPhone(group.phone); }} className="block max-w-full truncate text-left text-xl font-bold text-white">{group.name}</button>
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

              {tab === "revenue" && <Card>
                <h2 className="mb-6 text-3xl font-bold">Ciro Analizi</h2>

                <div className="grid gap-4 md:grid-cols-4">
                  <div className="rounded-3xl border border-white/10 bg-black/30 p-5">
                    <div className="text-sm text-zinc-400">Bugünkü Kazanç</div>
                    <div className="mt-2 text-3xl font-bold text-amber-300">{todayRevenue} TL</div>
                  </div>

                  <div className="rounded-3xl border border-white/10 bg-black/30 p-5">
                    <div className="text-sm text-zinc-400">Bu Haftaki Kazanç</div>
                    <div className="mt-2 text-3xl font-bold text-emerald-300">
                      {completed
                        .filter((a) => {
                          const now = new Date();
                          const d = new Date(a.date);
                          const diff = (now - d) / (1000 * 60 * 60 * 24);
                          return diff <= 7;
                        })
                        .reduce((s, a) => s + Number(a.paidAmount || 0), 0)} TL
                    </div>
                  </div>

                  <div className="rounded-3xl border border-white/10 bg-black/30 p-5">
                    <div className="text-sm text-zinc-400">Bu Ayki Kazanç</div>
                    <div className="mt-2 text-3xl font-bold text-blue-300">
                      {completed
                        .filter((a) => new Date(a.date).getMonth() === new Date().getMonth())
                        .reduce((s, a) => s + Number(a.paidAmount || 0), 0)} TL
                    </div>
                  </div>

                  <div className="rounded-3xl border border-white/10 bg-black/30 p-5">
                    <div className="text-sm text-zinc-400">Toplam Borç</div>
                    <div className="mt-2 text-3xl font-bold text-red-300">{totalDebt} TL</div>
                  </div>
                </div>

                <div className="mt-8 grid gap-6 lg:grid-cols-2">
                  <div className="rounded-3xl border border-white/10 bg-black/30 p-5">
                    <h3 className="mb-4 text-xl font-semibold">Aylık Kazançlar</h3>
                    <div className="space-y-3">
                      {[...Array(12)].map((_, i) => {
                        const amount = completed
                          .filter((a) => new Date(a.date).getMonth() === i)
                          .reduce((s, a) => s + Number(a.paidAmount || 0), 0);

                        return (
                          <div key={i} className="flex items-center justify-between rounded-2xl bg-white/[0.04] px-4 py-3">
                            <span>
                              {new Date(2026, i).toLocaleDateString("tr-TR", { month: "long" })}
                            </span>
                            <b className="text-amber-200">{amount} TL</b>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="rounded-3xl border border-white/10 bg-black/30 p-5">
                    <h3 className="mb-4 text-xl font-semibold">Son İşlemler</h3>
                    <div className="space-y-3">
                      {completed.slice(-8).reverse().map((a) => (
                        <div key={a.id} className="flex items-center justify-between rounded-2xl bg-white/[0.04] px-4 py-3 text-sm">
                          <div>
                            <div className="font-semibold">{a.customerName}</div>
                            <div className="text-zinc-500">{prettyDate(a.date)} · {serviceMap[a.serviceId]?.name}</div>
                          </div>
                          <div className="text-right">
                            <div className="font-bold text-emerald-300">{a.paidAmount || 0} TL</div>
                            {Number(a.remainingDebt || 0) > 0 && <div className="text-xs text-red-300">Borç: {a.remainingDebt} TL</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </Card>}

              {tab === "staff" && <div className="grid gap-6 lg:grid-cols-[1fr_360px]"><Card><h2 className="mb-4 text-2xl font-bold">Personel</h2>{data.staff.map((s) => <div key={s.id} className="mb-3 flex items-center justify-between rounded-2xl bg-black/30 p-4"><div><b>{s.name}</b><div className="text-sm text-zinc-400">{s.role}</div></div><div className="flex items-center gap-2"><button onClick={() => setData((d) => ({...d, staff: d.staff.map((x) => x.id === s.id ? {...x, active: !x.active} : x)}))} className="rounded-xl bg-white/10 px-3 py-2">{s.active ? "Aktif" : "Kapalı"}</button><button onClick={() => setData((d) => ({...d, staff: d.staff.filter((x) => x.id !== s.id)}))} className="rounded-xl bg-red-400/10 px-3 py-2 text-red-300"><Trash2 className="h-4 w-4" /></button></div></div>)}</Card><Card><h2 className="mb-4 text-xl font-bold">Yeni Personel</h2><Input placeholder="Ad" value={newStaff.name} onChange={(e) => setNewStaff({...newStaff, name:e.target.value})} className="mb-3 w-full" /><Input placeholder="Uzmanlık" value={newStaff.role} onChange={(e) => setNewStaff({...newStaff, role:e.target.value})} className="mb-3 w-full" /><button onClick={() => { if(newStaff.name) { setData((d)=>({...d, staff:[...d.staff,{...newStaff,id:id(),active:true}]})); setNewStaff({name:"",role:""}); } }} className="w-full rounded-2xl bg-amber-300 px-4 py-3 font-bold text-black"><Plus className="mr-1 inline" />Ekle</button></Card></div>}

              {tab === "availability" && <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                  <h2 className="mb-4 text-2xl font-bold">Personel İzni</h2>
                  <Select value={newLeave.staffId} onChange={(e)=>setNewLeave({...newLeave,staffId:e.target.value})} className="mb-3 w-full">
                    {data.staff.map((s)=><option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                  <Input type="date" value={newLeave.startDate} onChange={(e)=>setNewLeave({...newLeave,startDate:e.target.value})} className="mb-3 w-full" />
                  <Input type="date" value={newLeave.endDate} onChange={(e)=>setNewLeave({...newLeave,endDate:e.target.value})} className="mb-3 w-full" />
                  <button onClick={()=>setData((d)=>({...d,staffLeaves:[...d.staffLeaves,{...newLeave,id:id()}]}))} className="rounded-2xl bg-amber-300 px-4 py-3 font-bold text-black">İzin Ekle</button>
                  <div className="mt-5 space-y-3">
                    {data.staffLeaves.map((l)=><div key={l.id} className="flex items-center justify-between rounded-2xl bg-black/30 p-4">
                      <div><b>{staffMap[l.staffId]?.name}</b><div className="text-sm text-zinc-400">{prettyDate(l.startDate)} - {prettyDate(l.endDate)}</div></div>
                      <button onClick={()=>setData((d)=>({...d,staffLeaves:d.staffLeaves.filter((x)=>x.id!==l.id)}))} className="rounded-xl bg-red-400/10 px-3 py-2 text-red-300"><Trash2 className="h-4 w-4" /></button>
                    </div>)}
                  </div>
                </Card>

                <Card>
                  <h2 className="mb-4 text-2xl font-bold">Yemek / Kapalı Saat</h2>
                  <div className="grid gap-3 md:grid-cols-3">
                    <Select value={data.settings.lunchEnabled ? "yes" : "no"} onChange={(e)=>setData((d)=>({...d,settings:{...d.settings,lunchEnabled:e.target.value==="yes"}}))}>
                      <option value="yes">Yemek saati açık</option>
                      <option value="no">Yemek saati kapalı</option>
                    </Select>
                    <Input type="time" value={data.settings.lunchStart} onChange={(e)=>setData((d)=>({...d,settings:{...d.settings,lunchStart:e.target.value}}))} />
                    <Input type="time" value={data.settings.lunchEnd} onChange={(e)=>setData((d)=>({...d,settings:{...d.settings,lunchEnd:e.target.value}}))} />
                  </div>

                  <div className="mt-6 rounded-3xl border border-white/10 bg-black/20 p-4">
                    <h3 className="mb-3 font-semibold">İstediğin saat aralığını kapat</h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      <Select value={newBlock.staffId} onChange={(e)=>setNewBlock({...newBlock,staffId:e.target.value})}>
                        <option value="all">Tüm personel</option>
                        {data.staff.map((s)=><option key={s.id} value={s.id}>{s.name}</option>)}
                      </Select>
                      <Input placeholder="Sebep" value={newBlock.reason} onChange={(e)=>setNewBlock({...newBlock,reason:e.target.value})} />
                      <Input type="date" value={newBlock.date} onChange={(e)=>setNewBlock({...newBlock,date:e.target.value})} />
                      <div className="grid grid-cols-2 gap-2">
                        <Input type="time" value={newBlock.startTime} onChange={(e)=>setNewBlock({...newBlock,startTime:e.target.value})} />
                        <Input type="time" value={newBlock.endTime} onChange={(e)=>setNewBlock({...newBlock,endTime:e.target.value})} />
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
                </Card>
              </div>}

              {tab === "services" && <div className="grid gap-6 lg:grid-cols-[1fr_360px]"><Card><h2 className="mb-4 text-2xl font-bold">Hizmetler</h2>{data.services.map((s)=><div key={s.id} className="mb-3 rounded-2xl bg-black/30 p-4">{editingService?.id === s.id ? <div className="grid gap-3 md:grid-cols-2"><Input placeholder="Hizmet adı" value={editingService.name} onChange={(e)=>setEditingService({...editingService,name:e.target.value})} /><Input type="number" placeholder="Fiyat" value={editingService.price} onChange={(e)=>setEditingService({...editingService,price:e.target.value})} /><Input type="number" placeholder="Süre dk" value={editingService.time} onChange={(e)=>setEditingService({...editingService,time:e.target.value})} /><Input placeholder="Açıklama" value={editingService.desc || ""} onChange={(e)=>setEditingService({...editingService,desc:e.target.value})} /><div className="flex gap-2 md:col-span-2"><button onClick={saveEditService} className="rounded-xl bg-amber-300 px-4 py-2 font-bold text-black">Kaydet</button><button onClick={()=>setEditingService(null)} className="rounded-xl bg-white/10 px-4 py-2">İptal</button></div></div> : <div className="flex items-center justify-between gap-4"><div><b>{s.name}</b><div className="text-sm text-zinc-400">{s.time} dk · {s.price} TL</div>{s.desc && <div className="mt-1 text-xs text-zinc-500">{s.desc}</div>}</div><div className="flex items-center gap-2"><button onClick={()=>startEditService(s)} className="rounded-xl bg-amber-300/10 px-3 py-2 text-xs text-amber-300">Düzenle</button><button onClick={()=>setData((d)=>({...d,services:d.services.filter((x)=>x.id!==s.id)}))} className="rounded-xl bg-red-400/10 px-3 py-2 text-red-300"><Trash2 className="h-4 w-4" /></button></div></div>}</div>)}</Card><Card><h2 className="mb-4 text-xl font-bold">Yeni Hizmet</h2><Input placeholder="Ad" value={newService.name} onChange={(e)=>setNewService({...newService,name:e.target.value})} className="mb-3 w-full" /><Input type="number" placeholder="Fiyat" value={newService.price} onChange={(e)=>setNewService({...newService,price:e.target.value})} className="mb-3 w-full" /><Input type="number" placeholder="Süre" value={newService.time} onChange={(e)=>setNewService({...newService,time:e.target.value})} className="mb-3 w-full" /><Input placeholder="Açıklama" value={newService.desc} onChange={(e)=>setNewService({...newService,desc:e.target.value})} className="mb-3 w-full" /><button onClick={()=>{ if(newService.name){ setData((d)=>({...d,services:[...d.services,{...newService,id:id(),price:Number(newService.price),time:Number(newService.time)}]})); setNewService({name:"",price:"",time:30,desc:""}); } }} className="w-full rounded-2xl bg-amber-300 px-4 py-3 font-bold text-black">Ekle</button></Card></div>}

              {tab === "settings" && <Card><h2 className="mb-4 text-2xl font-bold"><Settings className="mr-2 inline text-amber-300" />Ayarlar</h2><div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4"><label><span className="mb-2 block text-sm text-zinc-400">Salon açılış saati</span><Input type="time" value={data.settings.openTime} onChange={(e)=>setData((d)=>({...d,settings:{...d.settings,openTime:e.target.value}}))} className="w-full" /></label><label><span className="mb-2 block text-sm text-zinc-400">Salon kapanış saati</span><Input type="time" value={data.settings.closeTime} onChange={(e)=>setData((d)=>({...d,settings:{...d.settings,closeTime:e.target.value}}))} className="w-full" /></label><label><span className="mb-2 block text-sm text-zinc-400">Randevu saat aralığı</span><Select value={String(data.settings.slotStep)} onChange={(e)=>setData((d)=>({...d,settings:{...d.settings,slotStep:Number(e.target.value)}}))} className="w-full"><option value="5">5 dakika</option><option value="10">10 dakika</option><option value="15">15 dakika</option><option value="20">20 dakika</option><option value="30">30 dakika</option><option value="45">45 dakika</option><option value="60">60 dakika</option></Select></label><label><span className="mb-2 block text-sm text-zinc-400">WhatsApp hatırlatma kaç saat önce</span><Input type="number" value={data.settings.reminderHours} onChange={(e)=>setData((d)=>({...d,settings:{...d.settings,reminderHours:Number(e.target.value)}}))} className="w-full" /></label></div><p className="mt-5 rounded-2xl bg-black/30 p-4 text-sm text-zinc-400">Yemek saati ve özel kapalı saatler “İzin/Kapalı” sekmesinden ayarlanır. Randevu saat aralığı müşteri ekranında saatlerin 10:00, 10:15, 10:30 gibi hangi aralıklarla görüneceğini belirler.</p></Card>}
            </>
          )}
        </main>
      )}

      {complete && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><Card className="w-full max-w-md"><h2 className="mb-3 text-2xl font-bold">Randevuyu Tamamla</h2><Select value={complete.paymentStatus} onChange={(e) => { const st = e.target.value; setComplete({...complete, paymentStatus:st, amount: st === "debt" ? 0 : complete.amount, remainingDebt: st === "debt" ? complete.tariff : st === "paid" ? 0 : complete.remainingDebt}); }} className="mb-3 w-full"><option value="paid">Ödendi</option><option value="partial">Kısmi ödeme</option><option value="debt">Veresiye</option></Select><Input type="number" value={complete.amount} onChange={(e)=>setComplete({...complete,amount:e.target.value})} placeholder="Alınan ücret" className="mb-3 w-full" /><Input type="number" value={complete.remainingDebt} onChange={(e)=>setComplete({...complete,remainingDebt:e.target.value})} placeholder="Kalan borç" className="mb-3 w-full" /><div className="flex gap-2"><button onClick={saveComplete} className="flex-1 rounded-2xl bg-amber-300 px-4 py-3 font-bold text-black">Kaydet</button><button onClick={()=>setComplete(null)} className="rounded-2xl bg-white/10 px-4 py-3">Vazgeç</button></div></Card></div>}
      {debtPay && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><Card className="w-full max-w-md"><h2 className="mb-1 text-2xl font-bold">Borç Ödemesi</h2><p className="mb-4 text-sm text-zinc-400">{debtPay.name || "Müşteri"} · Toplam borç {debtPay.totalDebt || debtPay.amount} TL</p><Input type="number" min="0" max={debtPay.totalDebt || debtPay.amount} value={debtPay.amount} onChange={(e)=>setDebtPay({...debtPay,amount:e.target.value})} className="mb-3 w-full" /><div className="flex gap-2"><button onClick={payDebt} className="flex-1 rounded-2xl bg-amber-300 px-4 py-3 font-bold text-black">Ödemeyi Kaydet</button><button onClick={()=>setDebtPay(null)} className="rounded-2xl bg-white/10 px-4 py-3">Vazgeç</button></div></Card></div>}
    </div>
  );
}
