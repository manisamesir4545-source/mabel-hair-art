# WhatsApp Otomatik Mesaj Kurulumu

## Meta template isimleri

Meta WhatsApp Manager icinde Utility kategorisinde ve Turkish dilinde bu template'leri olustur:

1. `appointment_confirmed`
   Merhaba {{1}}, randevunuz {{2}} tarihinde saat {{3}} icin olusturuldu. Hizmet: {{4}}. Mabel Hair Art

2. `appointment_reminder`
   Merhaba {{1}}, {{2}} tarihinde saat {{3}} randevunuz oldugunu hatirlatiriz. Hizmet: {{4}}. Mabel Hair Art

3. `appointment_cancelled`
   Merhaba {{1}}, {{2}} tarihinde saat {{3}} olan randevunuz iptal edilmistir. Hizmet: {{4}}. Mabel Hair Art

4. `admin_new_appointment`
   Yeni randevu: {{1}} - {{2}} saat {{3}}. Hizmet: {{4}}. Telefon: {{5}}

## Supabase secrets

Supabase Dashboard > Edge Functions > Secrets ekranina ekle:

WHATSAPP_ACCESS_TOKEN=Meta kalici token
WHATSAPP_PHONE_NUMBER_ID=1159594253901556
WHATSAPP_ADMIN_PHONE=905396201897
WHATSAPP_TEMPLATE_LANGUAGE=tr
WHATSAPP_REMINDER_HOURS=2

Opsiyonel (varsayilan 50, en fazla 100):

WHATSAPP_REMINDER_BATCH_LIMIT=50

## SQL

Ilk randevu mesaj log kurulumu gerekiyorsa Supabase SQL Editor'de
`supabase/whatsapp_setup.sql` dosyasindaki SQL'i calistir. Bu guvenli surum
`message_logs` tablosunu PUBLIC/anon/authenticated erisimine acmaz. Duyuru icin
ayrica asagidaki migration uygulanmalidir.

Hatirlatma cron'u icin
`supabase/migrations/20260823024640_secure_appointment_reminders.sql`
migration'i uygulanmalidir. Migration, cron anahtarini Supabase Vault icinde uretir;
kaynak koda veya Edge Function secret'larina kopyalamaz. `schedule_reminders.sql`
yalniz temiz kurulumlar icin ayni guvenli cron taniminin bagimsiz kopyasidir.
Aktif cron:

send-appointment-reminders-every-10-minutes -> */10 * * * *

## Deploy

Supabase CLI ile:

npx supabase functions deploy send-whatsapp-message --project-ref qtyehohkrnxudeeeuuyy
npx supabase functions deploy send-appointment-reminders --no-verify-jwt --project-ref qtyehohkrnxudeeeuuyy

Frontend degisikligi icin Vercel deploy gerekir.

`send-appointment-reminders` gateway JWT dogrulamasini kullanmaz; bunun yerine yalniz
Vault'taki `x-cron-secret` degerini service-role RPC ile dogrular. Endpoint yalniz
POST kabul eder. Hatirlatma fonksiyonu, simdiki andan `WHATSAPP_REMINDER_HOURS`
ufkuna kadar olan aktif randevulari tarar. Boylece randevu eski dar 20 dakikalik
pencereden sonra olusturulsa bile sonraki cron cagrisi onu kacirmaz. Her randevu
icin mesaj Meta'ya gonderilmeden once atomik bir `pending` kaydi ayrilir; ayni
randevu/tarih/saat icin ikinci kez mesaj gonderilmez. `sent` yine yalniz Meta API
kabulunu ifade eder; gercek teslimat asagidaki imzali webhook ile izlenir.

Son deploy:

- Edge Functions aktif: `send-whatsapp-message`, `send-appointment-reminders`
- Production site: https://mabelhairart.com.tr
- Supabase project ref: `qtyehohkrnxudeeeuuyy`

## Guvenli is yeri adres guncellemesi

Aktif duyuru serisi Edge Function icinde sabittir; istemci telefon, alici, template,
adres parametresi veya kampanya kimligi uretemez:

- Template: `is_yeri_adres_guncellemesi`
- Dil: exact `tr`
- Zorunlu Meta kategorisi: exact `UTILITY`
- Series ID ve ilk campaign ID: `mabel_is_yeri_adres_guncellemesi_v1`
- BODY parametresi (tek): `Kültür, Hükümet Cd. No:54, 35800 Aliağa/İzmir`
- Baslik: `Adres Bilgisi Güncellemesi`
- Statik buton: `Konumu Görüntüle`
- Statik Maps URL:
  `https://www.google.com/maps/search/?api=1&query=38.801010673611486%2C26.974653153176668`

Meta template BODY metni:

```text
Mabel Hair Art iş yeri adresimiz değişmiştir.

Güncel adresimiz:
{{1}}

Güncel konum bilgisine aşağıdaki bağlantı üzerinden ulaşabilirsiniz.
```

Template'te tarih veya musteri adi parametresi yoktur. Maps butonu statik oldugu
icin runtime button component/parametresi de gonderilmez; Graph API BODY icinde
yalniz adres degeri vardir.

Edge Function her `status`, `new-round` ve `send` isteginde WABA
`message_templates` endpointinden template durumunu, dilini, kategorisini ve
component listesini yeniden kontrol eder. Baslik, BODY metni ve tek statik URL
butonunun metni/Google Maps koordinati da yukaridaki fingerprint ile exact
eslesmelidir. `APPROVED + UTILITY + tr + exact components` kosullarindan biri
farkliysa fail-closed olur:
status `templateEligible=false`, `canSend=false` ve `canStartNewRound=false`
gosterir; `new-round` ile `send` HTTP 409 ile engellenir. Meta sonradan template'i
`MARKETING` olarak yeniden siniflandirirsa kod bu kategoriyi Utility gibi gostermez
ve gondermez. `send` ayrica kampanya claim'inden hemen once ve her batch'ten once
Meta fingerprint'ini tekrar sorgular; drift veya sorgu hatasinda kalan alicilara
devam etmez. Token'in hem `whatsapp_business_management` (template sorgusu) hem de
`whatsapp_business_messaging` (mesaj gonderimi) yetkisi olmalidir.

Her gonderim ayri ve degistirilemez bir tur kimligi kullanir (`...:r2`, `...:r3`).
Tamamlanan turun loglari silinmez veya sifirlanmaz. Hic attempt/log olmayan en son
`idle` tur ile yeni turlar; `app_state.data.customerAccounts` ve `appointments`
birlesiminden server-side normalize/dedupe edilerek guncellenir. Herhangi bir account
kaydindaki opt-out ayni telefonu tum kaynaklardan dislar; service-role erisimli
`broadcast_suppressions` da aday listesinden cikarilir. Suppression, snapshot'tan
sonra degisse bile Meta gonderim rezervasyonu alinirken tekrar kontrol edilir.

Status yaniti sirali normalize telefon setinin SHA-256 ozetini `recipientHash` olarak
dondurur. Send istegi exact `roundId`, `recipientCount` ve `recipientHash` tasir.
Current adaylar ile count/hash atomik refresh+claim RPC'sinde tekrar hesaplanir;
liste ayni sayida kalip telefonlardan biri degisse bile 409
`RECIPIENT_LIST_CHANGED` doner ve hicbir kisi rezerve edilmez/gonderilmez. Raw kaynak
5000 account ve 10000 appointment, nihai aday listesi 1000 ile sinirlidir. Mevcut
snapshot'a gore tek refresh buyumesi `max(25, %25)` ustundeyse fail-closed olur; bu
sinir izin veya yetkilendirme kaniti degil, yalniz blast-radius korumasidir.

Eski `mabel_reopening_2026_08_18_v2` serisi ve
`mabel_calisma_bilgisi_v2`/`MARKETING` kampanya-log gecmisi yalniz audit icin
korunur; yeni Edge runtime bu eski template veya seriye baglanmaz.

### Uygulama sirasi

1. Ilk olarak `supabase/migrations/20260816090000_secure_customer_announcements.sql`
   migration'ini uygula (`supabase db push` veya Supabase SQL Editor).
2. Tekrar kullanilabilir turlar icin
   `supabase/migrations/20260817183915_add_reusable_announcement_rounds.sql`
   migration'ini uygula.
3. Suppression'in rezervasyon aninda tekrar kontrolu icin
   `supabase/migrations/20260817185535_enforce_broadcast_suppressions_at_send.sql`
   migration'ini uygula.
4. Adres guncellemesi serisi ve ilk snapshot icin
   `supabase/migrations/20260823033550_add_service_location_update_announcement.sql`
   migration'ini uygula.
5. Current aday refresh'i, hash-bagli atomik claim ve dinamik yeni turlar icin
   `supabase/migrations/20260823103804_refresh_current_announcement_recipients.sql`
   migration'ini uygula.
6. Asagidaki Edge Function secret'larini ekle.
7. Sonra `admin-session` ve `send-customer-announcement` function'larini deploy et.

Migration; PIN brute-force rate limit tablosunu, lease tabanli kampanya kilidini ve
mesaj gonderilmeden once alinan atomik kisi rezervasyonunu kurar. Ayrica telefon ve
provider response iceren `message_logs` tablosunun eski anon/authenticated okuma
politikasini ve yetkilerini kaldirir. RPC execute yetkileri yalniz `service_role`dedir.

### Yeni secret'lar

```text
ADMIN_PIN=<eski frontend PIN'inden farkli, yeni ve guclu bir PIN/parola>
ADMIN_SESSION_SECRET=<en az 32 byte kriptografik rastgele secret>
ADMIN_ALLOWED_ORIGINS=https://mabelhairart.com.tr,https://www.mabelhairart.com.tr
WHATSAPP_BUSINESS_ACCOUNT_ID=<WABA ID>
WHATSAPP_APP_SECRET=<Meta uygulamasinin App Secret degeri>
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<en az 32 byte kriptografik rastgele token>
```

Ornek secret uretimi: `openssl rand -base64 48`. `ADMIN_PIN` ve
`ADMIN_SESSION_SECRET` kesinlikle `VITE_` degiskeni veya frontend kodu olmamalidir.
Opsiyonel ayarlar:

```text
ADMIN_SESSION_TTL_SECONDS=600
ADMIN_LOGIN_MAX_ATTEMPTS=5
ADMIN_LOGIN_GLOBAL_MAX_ATTEMPTS=50
ADMIN_LOGIN_WINDOW_SECONDS=900
WHATSAPP_BROADCAST_BATCH_SIZE=5
```

Local gelistirme gerekiyorsa canli `.env` ile interaktif preview acmayin; frontend
acilir acilmaz Supabase verisi okur/yazar. Ayrilmis local/staging Supabase projesi ve
mock WhatsApp secret'lari kullanip, ancak o zaman `ADMIN_ALLOWED_ORIGINS` listesine
acikca `http://localhost:5173` ekleyin. Admin yanitlari `Cache-Control: no-store` kullanir;
oturum token'i yalniz `sessionStorage`/bellekte tutulmali ve cikista silinmelidir.

### Deploy

```text
npx supabase functions deploy admin-session --no-verify-jwt --project-ref qtyehohkrnxudeeeuuyy
npx supabase functions deploy send-customer-announcement --no-verify-jwt --project-ref qtyehohkrnxudeeeuuyy
npx supabase functions deploy whatsapp-status-webhook --no-verify-jwt --project-ref qtyehohkrnxudeeeuuyy
```

Turkce karakterleri korumak icin function kaynagi dosya sisteminden Supabase CLI ile
deploy edilmelidir; PowerShell metin ciktisini kopyalayarak deploy paketi olusturmayin.

Bu iki function icin `--no-verify-jwt` zorunludur: frontend `sb_publishable_`
anahtari kullaniyor ve bu anahtar JWT degildir. Gateway JWT kontrolu kapali olsa da
endpointler acik degildir; `admin-session` server-side PIN + rate limit uygular,
duyuru endpointi ise kisa omurlu `x-admin-session` HMAC tokenini zorunlu tutar.

Ilk tarihsel `mabel_reopening_2026_08_18_v2` seed snapshot'i olusturulurken adaylar
server-side olarak `app_state.data.customerAccounts` ile `appointments` verilerinden
bir kez uretilmisti. Adres serisinin ilk migration'i bu frozen snapshot'i kopyaladi;
forward-only current-aday migration'i ise yalniz exact adres serisinin en son,
hic kullanilmamis `idle` turunu guncel union ile reconcile eder ve yeni turlari da
guncel uniondan kurar. Attempt/log baslamis veya tamamlanmis turlarin recipient,
campaign ve `message_logs` audit kayitlari degistirilmez. 23 Agustos 2026 preflight
aninda union 163 adaydi; bu yalniz gecici gozlemdir ve kodda/migration'da sabit sayi
degildir.

Bu aday/eligibility listesi WhatsApp opt-in kaniti degildir: eksik consent alanlari
geriye uyumluluk icin dahil edilir ve appointment telefonlarinda pozitif opt-in sarti
yoktur. `UTILITY` kategorisi de izin yerine gecmez. Gercek gonderimden once guncel
adaylarin her biri icin gecerli WhatsApp opt-in ayrica dogrulanmali; opt-out bildiren
veya iznini geri cekenler `broadcast_suppressions` ile cikarilmalidir. Listeyi
"izinli musteriler" olarak adlandirmayin.

Ayni campaign ID + normalize telefon icin `message_logs.dedupe_key` gonderimden once
atomik olarak rezerve edilir. API yanitindaki `pending` henuz rezerve edilmemis ve
sonraki cagrida islenebilecek kisileri; `processing` ise onceki bir timeout/crash
nedeniyle sonucu belirsiz kalan atomik rezervasyonlari ifade eder. `sent`, `failed`
ve `processing` alicilari ayni kampanyada tekrar gonderilmez; yeni bir kampanya icin
yeni ve degistirilemez bir tur (`...:r2`, `...:r3`) hazirlanir.

### Gercek teslimat takibi

Graph API'nin HTTP 2xx ve `message_status=accepted` yaniti yalniz Meta'nin istegi
kabul ettigini gosterir; alici cihazina teslim edildigini gostermez. Mevcut
`message_logs.status='sent'` bu API-kabul sozlesmesini korur. Imzali Meta webhook'u
geldikten sonra ayri `delivery_status` alani `sent`, `delivered`, `read`, `failed`
veya `deleted` olur.

Meta callback URL:

```text
https://qtyehohkrnxudeeeuuyy.supabase.co/functions/v1/whatsapp-status-webhook
```

Meta Developer panelinde callback ve verify token kaydedilmeli, `messages` webhook
alani etkinlestirilmeli ve uygulama WABA'ya abone edilmelidir. Uygulama
`Unpublished` durumundayken Meta yalniz panelden gonderilen test webhook'larini
iletir; gercek mesaj durumlari icin uygulama yayinlanmalidir. Yayin oncesinde kamuya
acik bir gizlilik politikasi URL'si ve gercek iletisim e-postasi gereklidir.

`whatsapp-status-webhook` Supabase JWT dogrulamasini kullanmaz; Meta GET challenge
tokenini ve POST isteklerinde ham govde uzerindeki `X-Hub-Signature-256` HMAC
imzasini kendisi dogruladigi icin `--no-verify-jwt` ile deploy edilir. Secret'lari
takip edilen `.env` dosyasina yazmayin; yalniz Supabase Edge Function Secrets
ekraninda saklayin.
