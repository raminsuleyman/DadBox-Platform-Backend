# PayBox Backend — Supabase + Node.js

Bu ayrıca layihədə PayBox-un Express/TypeScript API-si, Supabase Auth/Storage inteqrasiyası və PostgreSQL sxemi yerləşir. **Hazırladığım frontend hazırda demo məlumatları/localStorage istifadə edir və bu API-yə avtomatik qoşulmur.** Frontend-i API-yə bağlamaq ayrıca inteqrasiya mərhələsidir.

## 1. Supabase layihəsi və SQL sxemi

Supabase Dashboard-da yeni, boş layihə yaradın. Sonra **SQL Editor → New query** bölməsini açın, [`sql/01_schema.sql`](sql/01_schema.sql) faylının bütün məzmununu ora yapışdırın və **Run** düyməsini basın. Fayl PayBox cədvəllərini, məhdudiyyətləri, indeksləri, qeydiyyat trigger-ini, RLS qaydalarını və üç private Storage bucket-i yaradır.

**Vacib:** bu SQL yalnız yeni və boş Supabase layihəsində bir dəfə icra ediləcək ilkin sxemdir. Mövcud verilənlər bazası üçün yeniləmə migration-ı deyil. Mövcud layihədə kor-koranə işlətməyin: əvvəl ehtiyat nüsxə götürün, cədvəl və trigger-ləri yoxlayın, dəyişiklikləri ayrıca migration kimi nəzərdən keçirib təhlükəsiz tətbiq edin. Sxem Supabase-ə bənzər lokal PostgreSQL-də sınaqdan keçirilib.

Authentication → **Providers → Email** bölməsində Email provayderini aktivləşdirin. E-poçt təsdiqi və Authentication → **URL Configuration** daxilində Site URL / icazəli geri dönüş ünvanlarını tətbiqinizə uyğun qurun. Auth vasitəsilə yeni istifadəçi yaradıldıqda trigger `profiles` cədvəlində `CUSTOMER` profili yaradır. Public qeydiyyatla `ADMIN` rolu almaq mümkün deyil.

## 2. Məxfi sazlamalar

Layihə qovluğunda `.env.example` faylının surətini yaradın:

```bash
cp .env.example .env
```

Sonra Supabase Dashboard-dan real dəyərləri yalnız `.env` faylına daxil edin:

- `SUPABASE_URL` — Supabase layihəsinin URL-i.
- `SUPABASE_PUBLISHABLE_KEY` — API Keys bölməsindəki publishable açar. Köhnə layihələrdə bu açar `anon` adlana bilər.
- `SUPABASE_SECRET_KEY` — yalnız serverdə saxlanmalı secret/service-role açarı. Bunu frontend-ə yerləşdirməyin və Git-ə commit etməyin.
- `DATABASE_URL` — Supabase Connect bölməsində verilən, TLS ilə qoşulan server PostgreSQL bağlantı sətri. Node `pg` üçün Session Pooler və ya birbaşa bağlantını seçin. Transaction Pooler istifadə edilərsə, seçilən müştəri ayarlarını yoxlayın. Şifrədəki xüsusi simvolları URL-encode edin.
- `PICKUP_SECRET` — `openssl rand -base64 48` ilə yarada biləcəyiniz, ən azı 32 simvolluq sabit server açarı. Loglarda göstərməyin və qorunan yerdə ehtiyat nüsxəsini saxlayın.
- `FRONTEND_URL` — frontend-in origin ünvanı, məsələn `http://localhost:3000`.

- `SUPABASE_PUBLISHABLE_KEY` — API Keys bölməsindəki publishable açar. Köhnə layihələrdə bu açar `anon` adlana bilər.
- `SUPABASE_SECRET_KEY` — yalnız serverdə saxlanmalı secret/service-role açarı. Bunu frontend-ə yerləşdirməyin və Git-ə commit etməyin.
- `DATABASE_URL` — Supabase Connect bölməsində verilən, TLS ilə qoşulan server PostgreSQL bağlantı sətri. Node `pg` üçün Session Pooler və ya birbaşa bağlantını seçin. Transaction Pooler istifadə edilərsə, seçilən müştəri ayarlarını yoxlayın. Şifrədəki xüsusi simvolları URL-encode edin.
- `PICKUP_SECRET` — `openssl rand -base64 48` ilə yarada biləcəyiniz, ən azı 32 simvolluq sabit server açarı. Loglarda göstərməyin və qorunan yerdə ehtiyat nüsxəsini saxlayın.
Tələblər: Node.js 22.13+ və pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm start
```

İnkişaf rejimi üçün `pnpm dev` istifadə edin. API standart olaraq `http://localhost:5000` ünvanında işləyir. Sağlamlıq yoxlaması: `GET /health/live`. `TRUST_PROXY=1` yalnız tətbiqin qarşısında etibarlı tək proxy olduqda seçilməlidir.

Müddəti bitmiş təklif və sifarişləri yoxlayan worker-i API-dən ayrıca başladın:

```bash
pnpm worker
```

Yerləşdirmədə API-ni və worker-i ayrı, davamlı işləyən xidmətlər kimi başladın. HTTPS, məxfi açarların idarəsi, monitorinq, ehtiyat nüsxə/bərpa və bir neçə server instansiyası üçün ortaq rate-limit yaddaşı da ayrıca qurulmalıdır.

## 4. İlk admin istifadəçisinin təyin edilməsi

Əvvəl Supabase Auth vasitəsilə öz səlahiyyətinizdə olan hesabı yaradın və e-poçtunu təsdiqləyin. Sonra öz test layihənizin SQL Editor bölməsində aşağıdakı `YOUR_VERIFIED_EMAIL@example.com` hissəsini həmin təsdiqlənmiş ünvanla əvəz edib icra edin:

```sql
UPDATE public.profiles AS p
SET role = 'ADMIN', updated_at = now()
FROM auth.users AS u
WHERE p.id = u.id
  AND lower(u.email) = lower('YOUR_VERIFIED_EMAIL@example.com')
  AND u.email_confirmed_at IS NOT NULL
RETURNING p.id, p.full_name, p.role, p.status;
```

Nəticədə yalnız bir `ADMIN` profilinin qaytarıldığını yoxlayın. Paylaşılan və ya istehsal layihəsində dəyişiklik üçün müvafiq icazə, təsdiq və audit qeydi tələb olunur. İctimai qeydiyyat vasitəsilə admin səlahiyyəti verməyin.

## 5. Auth və API istifadəsi

Qeydiyyat, giriş, çıxış və şifrə bərpasını Supabase Auth klienti idarə edir. Backend istifadəçi parolunu saxlamır və token yaratmır. Frontend Supabase Auth sessiyasındakı `access_token` dəyərini API-yə aşağıdakı başlıqla göndərməlidir:

```http
Authorization: Bearer <supabase-access-token>
Content-Type: application/json
```

API-nin əsas yolu `/api/v1`-dir.

```bash
curl http://localhost:5000/health/live
curl -H 'Authorization: Bearer YOUR_ACCESS_TOKEN' http://localhost:5000/api/v1/auth/me
```

Yeni sifariş, ləğv və təhvil əməliyyatlarının hər biri üçün UUID formatlı `Idempotency-Key` yaradın. Eyni sorğunu şəbəkə xətasından sonra təkrar göndərərkən eyni açardan istifadə edin. Məbləğ qəpiklə tam ədəd kimi ötürülür (`690` = `6.90 AZN`); tarixlər `+04:00` kimi zaman fərqini göstərən ISO 8601 formatında göndərilməlidir.

Layihədə profil, biznes və müraciətlər, təklif axtarışı/idaretməsi, sifariş, rəy, şikayət, fayl yükləmə, biznes paneli və admin moderasiyası üçün 51 HTTP marşrut əməliyyatı var. Bütün metodlar, yollar, icazələr və request/response qaydaları [`docs/BACKEND_GUIDE.md`](docs/BACKEND_GUIDE.md) sənədindədir. İlkin məhsul və texniki tələblər [`docs/ORIGINAL_PRD_TRD.md`](docs/ORIGINAL_PRD_TRD.md) faylındadır.

## 6. Testlər

```bash
pnpm typecheck
pnpm test
```

İnteqrasiya testləri üçün Supabase-ə bənzər lokal stub və ayrıca, təcrid olunmuş PostgreSQL bazası istifadə oluna bilər. `tests/local-supabase-stub.sql` yalnız test bazasında Auth/Storage üçün ən minimal obyektləri yaradır; Supabase xidmətini əvəz etmir. Məsələn:

```bash
createdb paybox_test
psql -d paybox_test -f tests/local-supabase-stub.sql
psql -d paybox_test -v ON_ERROR_STOP=1 -f sql/01_schema.sql
TEST_DATABASE_URL='postgresql://USER@localhost/paybox_test' pnpm test
```

SQL sxemi Supabase-ə bənzər lokal PostgreSQL-də uğurla sınaqdan keçirilib. 8 unit/integration testi kodun doğrulanmasını, Auth mock-u, son vahidin paralel rezervasiyasını, idempotency təkrarını, təhvil kodunu və ləğvdən sonra stokun bərpasını yoxlayır. Bu testlər real Supabase Auth/Storage və ya sizin staging sazlamanızı yoxlamır.

## 7. Təhlükəsizlik və əhatə sərhədləri

- SQL `anon` və `authenticated` rollarına domen cədvəllərinə birbaşa giriş vermir. Bu quruluşda istifadəçi və biznes icazələrini Express serveri yoxlayır; PostgreSQL bağlantısı yalnız serverdə olmalıdır.
- Mövcud frontend API-yə qoşulmayıb; localStorage-dəki demo hesablar və məlumatlar real istifadəçilərə import edilmir.
- Sifariş və ehtiyatın azaldılması/bərpası PostgreSQL tranzaksiyasında həyata keçirilir. Auth, rol, hesab statusu və sifariş kodu serverdə yoxlanılır.
- `express-rate-limit` standart yaddaşı bir proses daxilindədir. Bir neçə instansiyalı istehsal mühitində Redis və ya ortaq rate-limit yaddaşı ilə əvəz edin. PDF virus skaneri və outbox hadisələrindən email/SMS göndərən consumer daxil deyil. Pickup HMAC açarının dəyişdirilməsi ayrıca planlaşdırılmalıdır.
- Lokal inteqrasiya testlərində Supabase Auth mock edilib. Real Supabase hesabı, açarları və server yerləşdirməsi burada sınaqdan keçirilməyib. İstehsala çıxmazdan əvvəl öz staging layihənizdə Auth, Storage, giriş icazələri, paralel sifariş, ehtiyat nüsxə/bərpa və monitorinqi yoxlayın.
