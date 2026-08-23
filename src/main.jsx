import { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

class AppErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError(error) {
    return { hasError: true, message: error?.message || "" };
  }

  componentDidCatch(error, info) {
    console.error("App render error", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-screen items-center justify-center bg-[#080808] px-5 text-white">
          <section className="w-full max-w-md rounded-3xl border border-amber-300/20 bg-[#16140f] p-6 text-center shadow-2xl shadow-black/50">
            <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-amber-300/40 bg-amber-300/10 text-2xl font-black text-amber-300">M</div>
            <h1 className="text-2xl font-black">Sayfa yenilenmeli</h1>
            <p className="mt-2 text-sm text-zinc-400">Uygulama açılırken geçici bir hata oluştu. Yenileyince kaldığı yerden devam eder.</p>
            <button onClick={() => window.location.reload()} className="mt-5 w-full rounded-2xl bg-yellow-400 px-5 py-3 font-black text-black shadow-lg shadow-yellow-500/20">
              Sayfayı Yenile
            </button>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)

const APP_UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const APP_UPDATE_BANNER_ID = "mabel-app-update";

function getAssetSignature(sourceDocument) {
  return [
    ...sourceDocument.querySelectorAll('script[type="module"][src], link[rel="stylesheet"][href]'),
  ]
    .map((element) => element.getAttribute("src") || element.getAttribute("href"))
    .filter(Boolean)
    .sort()
    .join("|");
}

const loadedAssetSignature = getAssetSignature(document);

function showAppUpdateNotice() {
  if (document.getElementById(APP_UPDATE_BANNER_ID)) return;

  const notice = document.createElement("aside");
  notice.id = APP_UPDATE_BANNER_ID;
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  notice.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "left:50%",
    "bottom:max(16px, env(safe-area-inset-bottom))",
    "transform:translateX(-50%)",
    "display:flex",
    "align-items:center",
    "gap:12px",
    "width:min(92vw, 560px)",
    "padding:12px 14px",
    "border:1px solid rgba(253,224,71,.45)",
    "border-radius:16px",
    "background:#17140b",
    "box-shadow:0 18px 55px rgba(0,0,0,.55)",
    "color:#fff",
    "font:600 14px/1.4 system-ui,sans-serif",
  ].join(";");

  const message = document.createElement("span");
  message.style.flex = "1";
  message.textContent = "Mabel Hair Art panelinin yeni sürümü hazır.";

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.textContent = "Şimdi güncelle";
  refreshButton.style.cssText = [
    "min-height:44px",
    "padding:0 16px",
    "border:0",
    "border-radius:12px",
    "background:#facc15",
    "color:#111",
    "font:800 14px system-ui,sans-serif",
    "cursor:pointer",
    "white-space:nowrap",
  ].join(";");
  refreshButton.addEventListener("click", () => window.location.reload());

  notice.append(message, refreshButton);
  document.body.append(notice);
}

async function checkForAppUpdate() {
  if (!loadedAssetSignature || !navigator.onLine) return;

  try {
    const response = await fetch(`/?app-update-check=${Date.now()}`, {
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "text/html",
        "Cache-Control": "no-cache",
      },
    });
    if (!response.ok) return;

    const html = await response.text();
    const latestDocument = new DOMParser().parseFromString(html, "text/html");
    const latestAssetSignature = getAssetSignature(latestDocument);

    if (latestAssetSignature && latestAssetSignature !== loadedAssetSignature) {
      showAppUpdateNotice();
    }
  } catch {
    // Ağ kesintisinde mevcut çevrimdışı sürüm çalışmaya devam eder.
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const hadActiveServiceWorker = Boolean(navigator.serviceWorker.controller);

    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" })
      .then((registration) => {
        const requestServiceWorkerUpdate = () => {
          registration.update().catch(() => undefined);
        };

        requestServiceWorkerUpdate();
        window.setInterval(requestServiceWorkerUpdate, APP_UPDATE_CHECK_INTERVAL_MS);

        if (registration.waiting) {
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }

        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              worker.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });
      })
      .catch(console.error);

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadActiveServiceWorker) showAppUpdateNotice();
    });
  });
}

window.addEventListener("load", () => {
  checkForAppUpdate();
  window.setInterval(checkForAppUpdate, APP_UPDATE_CHECK_INTERVAL_MS);
});

window.addEventListener("focus", checkForAppUpdate);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkForAppUpdate();
});
