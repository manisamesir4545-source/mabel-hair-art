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

## SQL

Ilk randevu mesaj log kurulumu gerekiyorsa Supabase SQL Editor'de
`supabase/whatsapp_setup.sql` dosyasindaki SQL'i calistir. Bu guvenli surum
`message_logs` tablosunu PUBLIC/anon/authenticated erisimine acmaz. Duyuru icin
ayrica asagidaki migration uygulanmalidir.

Hatirlatma cron'u icin `supabase/schedule_reminders.sql` dosyasi calistirildi.
Aktif cron:

send-appointment-reminders-every-10-minutes -> */10 * * * *

## Deploy

Supabase CLI ile:

npx supabase functions deploy send-whatsapp-message --project-ref qtyehohkrnxudeeeuuyy
npx supabase functions deploy send-appointment-reminders --project-ref qtyehohkrnxudeeeuuyy

Frontend degisikligi icin Vercel deploy gerekir.

Son deploy:

- Edge Functions aktif: `send-whatsapp-message`, `send-appointment-reminders`
- Production site: https://mabelhairart.com.tr
- Supabase project ref: `qtyehohkrnxudeeeuuyy`

## Guvenli musteri duyurusu (19 Agustos 2026)

Sabit seri ayarlari Edge Function icindedir; istemci telefon, alici, template veya
kampanya kimligi uretemez:

- Template: `mabel_calisma_bilgisi_v2`
- Dil: `tr`
- Series ID: `mabel_reopening_2026_08_18_v2`
- Body parametreleri: musteri adi ve `19 Ağustos 2026`

Her gonderim ayri ve degistirilemez bir tur kimligi kullanir (`...:r2`, `...:r3`).
Tamamlanan turun loglari silinmez veya sifirlanmaz. Yeni tur, ilk dogrulanmis alici
snapshot'ini kopyalar ve yalniz service-role erisimli `broadcast_suppressions`
tablosundaki telefonlari haric tutar. Bu tablo, alici snapshot'i hazirlandiktan
sonra degisse bile Meta gonderim rezervasyonu alinirken yeniden kontrol edilir.

Meta WhatsApp Manager'da template'in ayni ad/dil ile `APPROVED` olmasi gerekir.
`mabel_calisma_bilgisi_v2` Meta tarafindan su anda `MARKETING` (Pazarlama)
kategorisinde siniflandirilmistir. API istemcisi bu kategoriyi Bilgilendirme olarak
zorlayamaz; kisa aralikli tekrarlar Meta tarafindan kabul edilip sonradan teslim
edilmeyebilir.
Edge Function her `status` ve `send` isteginde WABA `message_templates` endpointinden
durumu yeniden kontrol eder ve APPROVED degilse fail-closed davranarak gondermez.
Token'in hem `whatsapp_business_management` (template sorgusu) hem de
`whatsapp_business_messaging` (mesaj gonderimi) yetkisi olmalidir.

### Uygulama sirasi

1. Ilk olarak `supabase/migrations/20260816090000_secure_customer_announcements.sql`
   migration'ini uygula (`supabase db push` veya Supabase SQL Editor).
2. Tekrar kullanilabilir turlar icin
   `supabase/migrations/20260817183915_add_reusable_announcement_rounds.sql`
   migration'ini uygula.
3. Asagidaki Edge Function secret'larini ekle.
4. Sonra `admin-session` ve `send-customer-announcement` function'larini deploy et.

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

Local gelistirme gerekiyorsa `ADMIN_ALLOWED_ORIGINS` listesine acikca
`http://localhost:5173` ekle. Admin yanitlari `Cache-Control: no-store` kullanir;
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

Migration calistigi anda alicilar server-side olarak
`app_state.data.customerAccounts` ile `appointments` telefonlarinin birlesiminden
uretilip yalniz bu kampanyaya ait `broadcast_recipients` snapshot tablosuna
muhurlenir. Runtime Edge Function istemcinin yazabildigi bu iki kaynak tabloyu bir
daha okumaz; sadece RLS acik ve PUBLIC/anon/authenticated yetkileri kaldirilmis sabit
snapshot'i okur. E.164 benzeri 8-15 haneli telefonlar kabul edilir, normalize telefonla
tekillestirilir ve hesap adi randevu adina tercih edilir. Bir customer account'ta
`whatsappOptOut`, `marketingOptOut` veya `announcementOptOut` true ise (ya da
`whatsappConsent`, `marketingConsent`, `receiveWhatsappAnnouncements` false ise)
o telefon appointments tablosunda bulunsa da snapshot'a alinmaz. Mevcut veride acik
riza/opt-out alani yoksa isletme duyuru onayi ve yasal dayanak surecini ayrica
yonetmelidir; Edge Function bunu varsayamaz.

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
