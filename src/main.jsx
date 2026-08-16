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

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js")
      .then((registration) => {
        registration.update?.();

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

    let refreshed = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshed) return;
      refreshed = true;
      window.location.reload();
    });
  });
}
