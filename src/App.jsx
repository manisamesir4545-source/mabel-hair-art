// @ts-nocheck
import React, { useEffect, useMemo, useState } from "react";
import { Scissors, Search, Plus, Trash2, Check, X, MessageCircle, CreditCard, Users, Settings, CalendarDays, Clock, LogOut, Lock, UserPlus, UserRound } from "lucide-react";
import { supabase } from "./supabase";
const LS_KEY = "mabel_hair_art_clean_v1";
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
  const [customerLogin, setCustomerLogin] = useState({ username: "", password: "" });
  const [customerRegister, setCustomerRegister] = useState({ username: "", password: "", phone: "", name: "" });
  const [logged, setLogged] = useState(false);
  const [pin, setPin] = useState("");
  const [tab, setTab] = useState("appointments");
  const [search, setSearch] = useState("");
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

  const customerAppointments = selectedCustomerPhone ? data.appointments.filter((a) => a.phone === selectedCustomerPhone) : [];
  const debtAppointments = data.appointments.filter((a) => Number(a.remainingDebt || 0) > 0);
  const todayCount = data.appointments.filter((a) => a.date === todayISO(0) && a.status === "active").length;
  const density = todayCount <= 2 ? { text: "Bugün sakin", desc: "Rahat saatler mevcut", pct: 28 } : todayCount <= 5 ? { text: "Bugün orta yoğun", desc: "Uygun saatler azalıyor", pct: 58 } : { text: "Bugün yoğun", desc: "Erken randevu almanız önerilir", pct: 88 };

  async function addAppointment(payload) {
    if (!payload.customerName || normPhone(payload.phone).length < 10) return alert("Ad ve telefon girin.");
    if (isClosed(payload.date, payload.time, payload.staffId, payload.serviceId)) return alert("Bu saat uygun değil.");

    const { data: insertedData, error } = await supabase
      .from("appointments")
      .insert([
        {
  customer_name: payload.customerName,
  phone: normPhone(payload.phone),
  service: payload.serviceId,
  appointment_date: payload.date,
  appointment_time: payload.time,
  staff_id: payload.staffId,
  note: payload.note || "",
  status: "active",
  paid_amount: 0,
  remaining_debt: 0,
  payment_status: "pending",
},
      ]);

    console.log("Supabase data:", insertedData);
    console.log("Supabase error:", error);

    if (error) {
      alert("Veritabanına kayıt olmadı. Console hatasına bak.");
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
      alert("Randevu oluşturuldu.");
    }
  }

  function registerCustomer() {
    if (!customerRegister.username || !customerRegister.password || normPhone(customerRegister.phone).length < 10) return alert("Kullanıcı adı, şifre ve telefon zorunlu.");
    if ((data.customerAccounts || []).some((u) => u.username === customerRegister.username)) return alert("Bu kullanıcı adı zaten var.");
    const acc = { ...customerRegister, phone: normPhone(customerRegister.phone), name: customerRegister.name || customerRegister.username, id: id() };
    setData((d) => ({ ...d, customerAccounts: [...(d.customerAccounts || []), acc] }));
    setCurrentCustomer(acc);
    setCustomerName(acc.name);
    setPhone(acc.phone);
  }

  function loginCustomer() {
    const acc = (data.customerAccounts || []).find((u) => u.username === customerLogin.username && u.password === customerLogin.password);
    if (!acc) return alert("Kullanıcı adı veya şifre hatalı.");
    setCurrentCustomer(acc);
    setCustomerName(acc.name);
    setPhone(acc.phone);
  }

  function openComplete(a) {
    const price = Number(serviceMap[a.serviceId]?.price || 0);
    setComplete({ id: a.id, amount: price, paymentStatus: "paid", remainingDebt: 0, tariff: price });
  }

  function saveComplete() {
    let paid = Number(complete.amount || 0);
    let debt = Number(complete.remainingDebt || 0);
    if (complete.paymentStatus === "debt") { paid = 0; debt = Number(complete.tariff); }
    if (complete.paymentStatus === "partial") debt = Math.max(Number(complete.tariff) - paid, 0);
    if (complete.paymentStatus === "paid") debt = 0;
    setData((d) => ({ ...d, appointments: d.appointments.map((a) => a.id === complete.id ? { ...a, status: "done", paidAmount: paid, remainingDebt: debt, paymentStatus: complete.paymentStatus } : a) }));
    setComplete(null);
  }

  function payDebt() {
    const amount = Number(debtPay.amount || 0);
    setData((d) => ({ ...d, appointments: d.appointments.map((a) => {
      if (a.id !== debtPay.id) return a;
      const oldDebt = Number(a.remainingDebt || 0);
      const paid = Math.min(amount, oldDebt);
      return { ...a, paidAmount: Number(a.paidAmount || 0) + paid, remainingDebt: Math.max(oldDebt - paid, 0) };
    }) }));
    setDebtPay(null);
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
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <a href="#randevu" className="rounded-2xl bg-amber-300 px-6 py-4 text-center font-semibold text-black shadow-xl shadow-amber-500/20">
                  Randevu Al
                </a>
                <button onClick={() => setView("admin")} className="rounded-2xl border border-white/10 bg-white/5 px-6 py-4 font-semibold text-white">
                  Admin Paneli Gör
                </button>
              </div>
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

          <section id="randevu" className="grid gap-6 lg:grid-cols-[1fr_380px]">
            <Card>
              <div className="mb-6 flex items-center justify-between">
                <div>
                  <h2 className="text-3xl font-semibold">Randevu Oluştur</h2>
                  <p className="mt-1 text-zinc-400">Sadece seçilen hizmetin sığacağı boş saatler gösterilir.</p>
                </div>
                <div className="rounded-2xl border border-amber-300/30 bg-amber-300/10 p-3 text-amber-200">
                  <Scissors className="h-6 w-6" />
                </div>
              </div>

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

                <div>
                  <h3 className="mb-3 flex items-center gap-2 font-semibold"><CalendarDays className="h-5 w-5 text-amber-300" /> Tarih Seç</h3>
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full md:w-72" />
                </div>

                <div>
                  <h3 className="mb-3 flex items-center gap-2 font-semibold"><Clock className="h-5 w-5 text-amber-300" /> Uygun Saatler</h3>
                  <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
                    {availableSlots.map((s) => (
                      <button key={s} onClick={() => setTime(s)} className={`rounded-2xl border px-3 py-3 text-sm transition ${time === s ? "border-amber-300 bg-amber-300 text-black" : "border-white/10 bg-black/20 hover:border-white/25"}`}>
                        {s}
                      </button>
                    ))}
                    {availableSlots.length === 0 && <div className="col-span-full rounded-2xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-200">Uygun saat yok.</div>}
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
                  <div className="rounded-3xl border border-emerald-400/20 bg-emerald-400/10 p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="font-semibold text-emerald-200">{currentCustomer.name}</div>
                        <div className="text-sm text-zinc-300">{currentCustomer.phone}</div>
                      </div>
                      <button onClick={() => setCurrentCustomer(null)} className="rounded-xl bg-black/30 px-3 py-2 text-xs">Çıkış</button>
                    </div>
                    <Textarea placeholder="Not / İstek" value={note} onChange={(e) => setNote(e.target.value)} className="mt-4 min-h-24 w-full py-4" />
                  </div>
                )}
              </div>
            </Card>

            <Card className="h-fit lg:sticky lg:top-5">
              <h2 className="text-2xl font-semibold">Randevu Özeti</h2>
              <div className="mt-5 space-y-4 text-sm">
                <div className="flex justify-between gap-4 border-b border-white/10 pb-3"><span className="text-zinc-400">Hizmet</span><b>{selectedService?.name}</b></div>
                <div className="flex justify-between gap-4 border-b border-white/10 pb-3"><span className="text-zinc-400">Süre</span><b>{selectedService?.time} dk</b></div>
                <div className="flex justify-between gap-4 border-b border-white/10 pb-3"><span className="text-zinc-400">Fiyat</span><b className="text-amber-200">{selectedService?.price} TL</b></div>
                <div className="flex justify-between gap-4 border-b border-white/10 pb-3"><span className="text-zinc-400">Personel</span><b>{selectedStaff?.name}</b></div>
                <div className="flex justify-between gap-4 border-b border-white/10 pb-3"><span className="text-zinc-400">Tarih</span><b>{prettyDate(date)}</b></div>
                <div className="flex justify-between gap-4 border-b border-white/10 pb-3"><span className="text-zinc-400">Saat</span><b>{time}</b></div>
              </div>
              <button onClick={book} disabled={!availableSlots.length} className="mt-6 w-full rounded-2xl bg-amber-300 px-5 py-4 font-bold text-black shadow-xl shadow-amber-500/20 disabled:opacity-40">
                Randevuyu Oluştur
              </button>
              <p className="mt-3 text-center text-xs text-zinc-500">Randevu admin paneline düşer.</p>
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

              {tab === "appointments" && <Card><div className="mb-4 flex gap-3"><Search /><Input placeholder="Ara" value={search} onChange={(e) => setSearch(e.target.value)} /></div><div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left text-sm"><thead className="text-zinc-400"><tr><th>Tarih</th><th>Müşteri</th><th>Hizmet</th><th>Personel</th><th>Durum</th><th>İşlem</th></tr></thead><tbody>{data.appointments.filter((a) => !search || (a.customerName + a.phone).toLowerCase().includes(search.toLowerCase())).map((a) => <tr key={a.id} className="border-t border-white/10"><td className="py-3">{prettyDate(a.date)} {a.time}</td><td><button onClick={() => { setTab("customers"); setSelectedCustomerPhone(a.phone); }} className="text-amber-300">{a.customerName}</button><div className="text-xs text-zinc-500">{a.phone}</div></td><td>{serviceMap[a.serviceId]?.name}<div className="text-xs text-zinc-500">Tarife {serviceMap[a.serviceId]?.price} TL</div>{Number(a.remainingDebt || 0) > 0 && <div className="text-xs text-red-300">Borç {a.remainingDebt} TL</div>}</td><td>{staffMap[a.staffId]?.name}</td><td><Status value={a.status} /></td><td className="flex flex-wrap gap-2 py-3"><a target="_blank" rel="noreferrer" href={wa(a.phone, msg(a))} className="rounded-xl bg-emerald-400/10 px-3 py-2 text-xs text-emerald-300"><MessageCircle className="mr-1 inline h-3 w-3" />WhatsApp</a><button onClick={() => openComplete(a)} className="rounded-xl bg-blue-400/10 px-3 py-2 text-xs text-blue-300"><Check className="mr-1 inline h-3 w-3" />Tamamla</button><button onClick={() => setData((d) => ({...d, appointments: d.appointments.map((x) => x.id === a.id ? {...x, status:"cancelled"} : x)}))} className="rounded-xl bg-red-400/10 px-3 py-2 text-xs text-red-300"><X className="mr-1 inline h-3 w-3" />İptal</button><button onClick={() => setData((d) => ({...d, appointments: d.appointments.filter((x) => x.id !== a.id)}))} className="rounded-xl bg-white/10 px-3 py-2 text-xs"><Trash2 className="h-3 w-3" /></button></td></tr>)}</tbody></table></div></Card>}

              {tab === "customers" && <Card><div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between"><h2 className="text-2xl font-bold"><Users className="mr-2 inline text-amber-300" />Müşteriler</h2><div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm"><span className="text-zinc-400">Toplam müşteri:</span> <b className="text-amber-200">{customers.length}</b></div></div>{!selectedCustomerPhone ? <div className="overflow-x-auto"><table className="w-full min-w-[650px] text-left text-sm"><thead className="text-zinc-400"><tr><th>Müşteri</th><th>Telefon</th><th>Randevu</th><th>Harcama</th><th>Borç</th><th></th></tr></thead><tbody>{customers.map((c) => <tr key={c.phone} className="border-t border-white/10"><td className="py-3">{c.name}</td><td>{c.phone}</td><td>{c.count}</td><td>{c.spent} TL</td><td className="text-red-300">{c.debt} TL</td><td><button onClick={() => setSelectedCustomerPhone(c.phone)} className="rounded-xl bg-amber-300/10 px-3 py-2 text-xs text-amber-300">Detay</button></td></tr>)}</tbody></table></div> : <div><button onClick={() => setSelectedCustomerPhone(null)} className="mb-4 rounded-xl bg-white/10 px-3 py-2">Geri</button><div className="space-y-3">{customerAppointments.map((a) => <div key={a.id} className="rounded-2xl bg-black/30 p-4"><b>{prettyDate(a.date)} {a.time}</b><div className="text-sm text-zinc-400">{serviceMap[a.serviceId]?.name} · {staffMap[a.staffId]?.name}</div><div className="mt-1">Alınan: {a.paidAmount || 0} TL {Number(a.remainingDebt || 0) > 0 && <span className="ml-3 text-red-300">Borç: {a.remainingDebt} TL</span>}</div><Status value={a.status} /></div>)}</div></div>}</Card>}

              {tab === "debts" && <Card><h2 className="mb-4 text-2xl font-bold"><CreditCard className="mr-2 inline text-red-300" />Borçlar - Toplam {totalDebt} TL</h2><div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead className="text-zinc-400"><tr><th>Tarih</th><th>Müşteri</th><th>Hizmet</th><th>Alınan</th><th>Borç</th><th></th></tr></thead><tbody>{debtAppointments.map((a) => <tr key={a.id} className="border-t border-white/10"><td className="py-3">{prettyDate(a.date)} {a.time}</td><td>{a.customerName}<div className="text-xs text-zinc-500">{a.phone}</div></td><td>{serviceMap[a.serviceId]?.name}</td><td>{a.paidAmount || 0} TL</td><td className="font-bold text-red-300">{a.remainingDebt} TL</td><td><button onClick={() => setDebtPay({ id: a.id, amount: a.remainingDebt })} className="rounded-xl bg-emerald-400/10 px-3 py-2 text-xs text-emerald-300">Ödeme Al</button></td></tr>)}</tbody></table></div></Card>}

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
      {debtPay && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><Card className="w-full max-w-md"><h2 className="mb-3 text-2xl font-bold">Borç Ödemesi</h2><Input type="number" value={debtPay.amount} onChange={(e)=>setDebtPay({...debtPay,amount:e.target.value})} className="mb-3 w-full" /><div className="flex gap-2"><button onClick={payDebt} className="flex-1 rounded-2xl bg-amber-300 px-4 py-3 font-bold text-black">Ödemeyi Kaydet</button><button onClick={()=>setDebtPay(null)} className="rounded-2xl bg-white/10 px-4 py-3">Vazgeç</button></div></Card></div>}
    </div>
  );
}
