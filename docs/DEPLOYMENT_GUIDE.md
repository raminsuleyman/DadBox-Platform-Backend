# PayBox: Vercel + Render + Supabase yerləşdirmə addımları

Hədəf quruluş: istifadəçi interfeysi Vercel-də, API Render Web Service-də, vaxtı bitən sifarişləri yoxlayan fon prosesi Render Background Worker-də, verilənlər bazası, autentifikasiya və fayl saxlama sistemi isə Supabase-də işləyir.

> **Vacib ilkin qeyd:** hazırkı istifadəçi interfeysi sınaq məlumatlarını `localStorage`-da saxlayır. O, API-yə və ya Supabase Auth-a qoşulmayıb. Buna görə də indi yerləşdirilsə, sayt nümayiş rejimində, server tərəfi isə ayrıca API kimi işləyəcək; iki sistem arasında real istifadəçi və sifariş axınları hələ əlaqələndirilməyəcək. `VITE_API_URL` hazırda istifadə olunmur. Tam işlək məhsul əldə etmək üçün interfeysin məlumat anbarını server tərəfi və autentifikasiya müştərisi ilə əlaqələndirmək lazımdır. Server tərəfinin interfeys müqaviləsi ilə nümayiş rejimi arasındakı fərqlər `docs/BACKEND_GUIDE.md` sənədinin §15 bölməsində izah olunub.

## 1. İstifadəçi interfeysi və server tərəfi kodlarını GitHub üçün hazırlamaq

Ən sadə variant iki ayrı GitHub repozitoriyasından istifadə etməkdir. İstifadəçi interfeysi üçün repozitoriya artıq yaradılıbsa, ondan istifadə et. Server tərəfinin ZIP arxivini aç və `paybox-backend` qovluğunu GitHub-da yeni, boş repozitoriyaya əlavə et.

Server tərəfinin qovluğunda terminalı açıb aşağıdakı əmrləri icra et; `USERNAME` və `REPO` hissələrini öz GitHub məlumatlarınla əvəz et:

```bash
cd paybox-backend
git init -b main
git add .
git commit -m "Initial PayBox backend"
git remote add origin https://github.com/USERNAME/REPO.git
git push -u origin main
```

GitHub-da repozitoriya yaradarkən README faylının avtomatik əlavə edilməsi seçimini söndür və repozitoriyanı boş saxla. `.env` faylını Git-ə əlavə etmə. ZIP arxivində yalnız məxfi dəyərlər olmayan `.env.example` faylı var. Hazırkı layihənin qovluqları ayrı olduğuna görə ayrı repozitoriyalardan istifadə etmək uyğundur. Vahid repozitoriya seçsən, Vercel və Render-də fərqli **kök qovluqlar** göstərməlisən. [2]

## 2. Supabase layihəsi və SQL

1. Supabase idarəetmə panelində yeni, boş layihə yarat.
2. **SQL redaktoru → Yeni sorğu** bölməsini aç, server tərəfinin `sql/01_schema.sql` faylındakı bütün kodu köçür və **İcra et** düyməsini bas. Bununla PayBox cədvəlləri, Auth qeydiyyatını işə salan trigger, RLS və özəl Storage bölmələri yaradılacaq. Bu fayl ilkin sxemdir və boş layihədə bir dəfə icra olunmaq üçün nəzərdə tutulub. Onu əvvəllər istifadə edilmiş verilənlər bazasında ehtiyat nüsxə yaratmadan və yoxlama aparmadan icra etmə.
3. Autentifikasiya → **Provayderlər → E-poçt** bölməsində e-poçtla girişi aktivləşdir. E-poçtun təsdiqlənməsi qaydasını öz qərarına uyğun tənzimlə.
4. İdarəetmə panelindəki **Qoşul** düyməsindən PostgreSQL bağlantı sətrini köçür. Render bağlantısı IPv4 üzərindən ola bildiyi üçün əksər hallarda **sessiya bağlantı hovuzu**, `5432` portu uyğundur; birbaşa bağlantı seçsən, Render-in icra mühitinin IPv6 bağlantısını dəstəklədiyini yoxla. Bağlantı hovuzunun host adını və istifadəçi adını təxmin etmə, idarəetmə panelindən köçür. Şifrədə URL üçün xüsusi məna daşıyan simvollar varsa, onları URL kodlaşdırması ilə kodlaşdır. Supabase uzunmüddətli işləyən serverlər üçün birbaşa bağlantını, IPv4 mühitləri üçün isə sessiya bağlantı hovuzunu tövsiyə edir. [3]
5. Supabase layihəsinin URL-ni, yayımlana bilən/anonim açarını, məxfi/xidmət rolu açarını və verilənlər bazası şifrəsini ayrı saxla. Məxfi açar və verilənlər bazası şifrəsi yalnız Render-ə əlavə edilməlidir; onları Vercel-ə əlavə etmə.

## 3. İstifadəçi interfeysini Vercel-də yerləşdirmək

1. Vercel-ə daxil ol və **Yeni əlavə et → Layihə** seç. GitHub hesabını qoş və istifadəçi interfeysinin repozitoriyasını idxal et.
2. İstifadəçi interfeysi ayrıca repozitoriyadadırsa, kök qovluğu əsas qovluq (`./`) olaraq saxla. Vahid repozitoriyadan istifadə edirsənsə, istifadəçi interfeysinin qovluğunu seç.
3. Çərçivənin Vite olduğunu yoxla. Yığım parametrləri:
   - Quraşdırma əmri: `pnpm install --frozen-lockfile`
   - Yığım əmri: `pnpm build`
   - Çıxış qovluğu: `dist`
4. İstifadəçi interfeysinin kök qovluğundakı `vercel.json` faylı React Router-in digər yollarını `index.html` faylına yönləndirir. Bu faylı GitHub-a qeydə alıb göndər. Vercel-in Vite təlimatında tək səhifəli tətbiqin daxili keçidləri üçün yönləndirmə qaydasından istifadə nümunəsi var. [1]
5. Hazırkı sınaq məlumatları ilə işləyən interfeysə mühit dəyişənləri əlavə etmək lazım deyil. `VITE_API_URL` əlavə edilsə belə, kod ondan istifadə etməyəcək.
6. **Yerləşdir** düyməsini bas. Vercel-in yaratdığı `https://<app>.vercel.app` URL-ni qeyd et, əsas səhifəni və daxili URL-ni yeniləyərək yoxla.

Sonradan istifadəçi interfeysinin API və autentifikasiya ilə inteqrasiyası tamamlandıqda Vercel → **Layihə parametrləri → Mühit dəyişənləri** bölməsinə `VITE_API_URL=https://<api>.onrender.com/api/v1`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` dəyərlərini əlavə et və yenidən yerləşdir. `VITE_` dəyişənləri brauzer üçün hazırlanan kod paketinə daxil olduğundan yalnız açıq yayımlana bilən dəyərlərdən istifadə et. `SUPABASE_SECRET_KEY`, verilənlər bazası şifrəsi və `PICKUP_SECRET` dəyərlərini heç vaxt Vercel-ə əlavə etmə. Mühit dəyişəni dəyişdirildikdə əvvəlki yerləşdirmə yenilənmir; yeni yerləşdirmə tələb olunur. [4]

## 4. Render-də API üçün veb xidməti yaratmaq

1. Render idarəetmə panelində **Yeni → Veb xidməti** seç. Server tərəfinin GitHub repozitoriyasını və `main` budağını qoş.
2. Server tərəfi ayrıca repozitoriyadadırsa, kök qovluq əsas qovluq olmalıdır. Vahid repozitoriyadan istifadə edirsənsə, server tərəfinin qovluğunu seç.
3. Node icra mühitini seç və aşağıdakı parametrləri təyin et:
   - Yığım əmri: `npm install -g pnpm@11.25.0 && pnpm install --frozen-lockfile && pnpm build`
   - Başlatma əmri: `pnpm start`
   - İşləkliyin yoxlanması yolu: `/health/live`
   - `NODE_VERSION=22.23.4`
4. Render → **Mühit** bölməsində aşağıdakı dəyişənləri təyin et. `<...>` hissələrini öz dəyərlərinlə əvəz et. `PICKUP_SECRET` dəyərini kompüterində `openssl rand -base64 48` əmri ilə yarat və yalnız Render-in məxfi mühit dəyişənlərində saxla.

```text
NODE_ENV=production
NODE_VERSION=22.23.4
FRONTEND_URL=https://<app>.vercel.app
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<PUBLISHABLE_OR_ANON_KEY>
SUPABASE_SECRET_KEY=<SERVER_ONLY_SECRET_OR_SERVICE_ROLE_KEY>
DATABASE_URL=<SESSION_POOLER_URL_FROM_SUPABASE_CONNECT>
PICKUP_SECRET=<GENERATED_STABLE_SECRET>
TRUST_PROXY=1
```

`PORT` dəyişənini özün təyin etmə. Render onu avtomatik verir; server tərəfi həmin portda `0.0.0.0` ünvanını dinləyir. `FRONTEND_URL` istifadəçi interfeysinin mənbə ünvanı ilə tam uyğun olmalıdır. `/api/v1` kimi yollar əlavə etmə. Nümunə: `https://paybox.vercel.app`. `TRUST_PROXY=1` etibarlı proksi arxasında müştərinin IP ünvanının düzgün ötürülməsi üçün nəzərdə tutulub. Server tərəfinin CORS qaydası yalnız `FRONTEND_URL` ilə uyğun gələn mənbə ünvanına icazə verir. Render `NODE_VERSION` vasitəsilə Node versiyasını təyin etməyə imkan verir. [5] [6]

5. **Veb xidməti yarat** düyməsini bas və yerləşdirmənin tamamlanmasını gözlə. Jurnalda paketlərin quraşdırılmasının, yığımın və işə salınmanın uğurla başa çatdığını yoxla.
6. `https://<render-service>.onrender.com/health/live` ünvanını aç. `{"status":"ok"}` cavabı görünəcək. Bu son nöqtə prosesin işlədiyini yoxlayır; təkbaşına verilənlər bazasının hazır olduğunu təsdiqləmir.
7. Render idarəetmə panelində yaradılmış API URL-ni köçür və saxla. CORS üçün `FRONTEND_URL` dəyərinin Vercel-in istehsal mühiti URL-si ilə tam uyğun olduğunu yoxla.

Render veb xidməti `PORT` portunda `0.0.0.0` ünvanına bağlanmalıdır. Bu server tərəfi üçün ünvan və porta bağlanma əvvəlcədən tənzimlənib. [6]

## 5. Render-də vaxtı bitən sifarişləri yoxlayan fon prosesini işə salmaq

Fon prosesini API-dən ayrı yerləşdirmək lazımdır.

1. Render idarəetmə panelində **Yeni → Fon prosesi** seç.
2. Eyni server tərəfi repozitoriyasını, budağı və kök qovluğu göstər.
3. Yığım əmrini API ilə eyni təyin et:

```bash
npm install -g pnpm@11.25.0 && pnpm install --frozen-lockfile && pnpm build
```

4. Başlatma əmri: `pnpm worker`.
5. API xidmətinə əlavə etdiyin zəruri mühit dəyişənlərini fon prosesi üçün də təyin et. `PORT` təyin etmək lazım deyil; fon prosesi HTTP sorğuları qəbul etmir.
6. Fon prosesi üçün tarif planını seç. Render-in pulsuz planı veb xidməti kimi müəyyən xidmət növlərini əhatə edir, lakin fon prosesi üçün pulsuz hesablama resursu yoxdur. Fasiləsiz işləyən fon prosesi üçün ödənişli plan tələb olunur. Pulsuz veb xidməti 15 dəqiqə ərzində sorğu almasa dayanır və növbəti sorğu gəldikdə təxminən bir dəqiqəyə yenidən işə düşür; buna görə istehsal mühiti üçün uyğun deyil. Mövcud məhdudiyyətləri Render-də yoxla. [7] [8]

Fon prosesi hər dəqiqə vaxtı bitmiş sifarişləri yoxlayır. Render idarəetmə panelində xidmətin işlək olduğunu və jurnalda təkrarlanan qəza ilə dayanma hallarının olmadığını yoxla.

## 6. Supabase Auth yönləndirməsi və domen

Vercel-in istehsal mühiti URL-si hazır olduqdan sonra Supabase idarəetmə panelində **Autentifikasiya → URL konfiqurasiyası** bölməsində saytın URL-ni `https://<app>.vercel.app` olaraq təyin et. Yönləndirmə URL-ləri siyahısına yalnız istifadə etdiyin istehsal mühitinin geri çağırış URL-lərini və inkişaf mühitinin localhost URL-lərini əlavə et. Bütün domenləri əhatə edən ümumi uyğunluq qaydasına icazə verməkdən çəkin.

Öz domenindən istifadə edirsənsə, domeni Vercel-də təsdiqlə, sonra Supabase-də saytın URL-sini və yönləndirmə URL-lərini, Render-də isə `FRONTEND_URL` dəyərini yeni mənbə ünvanına uyğunlaşdır. Lakin hazırkı istifadəçi interfeysində Supabase Auth geri çağırışı hələ hazırlanmayıb. Yönləndirmənin tənzimlənməsi təkbaşına nümayiş rejimindəki girişi real girişə çevirmir.

## 7. Yoxlama ardıcıllığı

1. Vercel-də əsas və daxili səhifələrin açıldığını, səhifə yeniləndikdə 404 xətasının yaranmadığını yoxla.
2. Render-in `/health/live` son nöqtəsinin `200` cavabı verdiyini yoxla.
3. Server tərəfinin real autentifikasiya və verilənlər bazası bağlantısını sınamaq üçün Supabase Auth vasitəsilə sınaq istifadəçisi yarat və giriş tokeni əldə et. Sonra terminalda aşağıdakı əmri icra et:

```bash
curl -i \
  -H 'Authorization: Bearer <SUPABASE_ACCESS_TOKEN>' \
  https://<render-service>.onrender.com/api/v1/auth/me
```

Etibarlı tokeni olan istifadəçi üçün `200` statuslu profil cavabı gələcək. Token olmadıqda `401` cavabı gələcək. Tokeni çata, URL-yə, GitHub-a və ya istifadəçi interfeysinin koduna yerləşdirmə.

4. İstifadəçi interfeysindən real API çağırışını sınamaq üçün əvvəlcə sınaq məlumatları anbarı və giriş funksiyası Supabase Auth/API ilə əlaqələndirilməlidir. Bu dəyişiklikdən əvvəl interfeysdə aparılan qeydiyyatlar və yaradılan sifarişlər Supabase verilənlər bazasında saxlanılmayacaq.
5. Real istifadəçilərə giriş verməzdən əvvəl Supabase-in istehsaldan əvvəlki sınaq layihəsində e-poçt təsdiqini, Storage imzalı URL-lərini, sifariş və ləğvetmə əməliyyatlarını, stok idarəetməsini, sifarişin təhvil alınmasını, inzibatçı səlahiyyətlərini və ehtiyat nüsxədən bərpanı sınaqdan keçir.

## Tez-tez rast gəlinən xətalar

- **Render-də mühit konfiqurasiyasının etibarsız olması xətası:** server tərəfinin `.env.example` faylında göstərilən bütün zəruri dəyərləri həm veb xidmətinə, həm də fon prosesinə ayrıca əlavə et.
- **Verilənlər bazasına bağlantı qurulmur:** bağlantı URL-ni Supabase-in qoşulma bölməsindən yenidən köçür; Render-in IPv4 mühitində sessiya bağlantı hovuzundan istifadə et; şifrədəki xüsusi simvolları kodlaşdır.
- **Vercel-də daxili yolda 404 xətası:** `vercel.json` faylının qeydə alınıb göndərildiyini və Vercel-in istehsal mühiti yerləşdirməsinə daxil olduğunu yoxla.
- **Brauzerdə CORS xətası:** istifadəçi interfeysi real API çağırışı edirsə, Render-dəki `FRONTEND_URL` dəyərinin brauzerin `Origin` dəyəri ilə tam uyğun olduğunu yoxla. Hazırkı sınaq interfeysinin API çağırışı etmədiyini nəzərə al.
- **Fon prosesi başlamır:** başlatma əmrinin `pnpm worker` olduğunu, zəruri mühit dəyişənlərinin dəyərlərinin tam verildiyini və fon prosesi üçün tarif planının aktiv olduğunu yoxla.
- **Verilənlər bazası bağlantı limiti:** `src/lib/db.ts` faylında API və fon prosesinin hər biri verilənlər bazasına 10-a qədər bağlantı aça bilər. Supabase layihəsində mümkün bağlantıların ümumi sayını hesabla və izləy.

## Rəsmi sənədlər

[1] [Vercel — Vite və tək səhifəli tətbiqlər üçün yönləndirmə qaydaları](https://vercel.com/docs/frameworks/frontend/vite)  
[2] [Render — Vahid repozitoriya parametrləri](https://render.com/docs/monorepo-support)  
[3] [Supabase — PostgreSQL bağlantısı](https://supabase.com/docs/guides/database/connecting-to-postgres)  
[4] [Vercel — Mühit dəyişənləri](https://vercel.com/docs/environment-variables)  
[5] [Render — Node versiyasını təyin etmək](https://render.com/docs/node-version)  
[6] [Render — Veb xidməti və porta bağlanma](https://render.com/docs/web-services)  
[7] [Render — Fon prosesi](https://render.com/docs/background-workers)  
[8] [Render — Pulsuz planın məhdudiyyətləri](https://render.com/docs/free)
