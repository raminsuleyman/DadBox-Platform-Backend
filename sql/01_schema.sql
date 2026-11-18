-- Paybox schema for a NEW, EMPTY Supabase project (PostgreSQL 13+).
-- Run once, in its entirety, in the Supabase SQL Editor as a privileged owner.
-- This is a baseline, not a general-purpose idempotent migration: existing Paybox
-- objects or bucket names cause an error and the transaction is rolled back. Do
-- not edit, replace, or drop unrelated Auth triggers, policies, or existing data.
-- Further changes require a reviewed, versioned migration, not a blind re-run.
--
-- Express uses a privileged direct pg connection. RLS is defense in depth, NOT
-- authorization for this connection: Node must authenticate, authorize, recheck
-- state under locks, and explicitly select safe response fields for every call.
-- No client domain policies or PostgREST domain/RPC access are provided here.
-- Auth, Storage, anon, authenticated and service_role are Supabase-managed.

BEGIN;

-- A bounded array check avoids subqueries in CHECK constraints. No privileged
-- behavior or mutable data is involved. Empty arrays mean known-no-allergens.
CREATE FUNCTION public.paybox_valid_allergens(items text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT cardinality(items) <= 20
     AND (cardinality(items) = 0 OR array_ndims(items) = 1)
     AND NOT EXISTS (
       SELECT 1 FROM unnest(items) AS a(item)
       WHERE item IS NULL OR item <> btrim(item)
          OR char_length(item) NOT BETWEEN 1 AND 80
     )
     AND cardinality(items) = (SELECT count(DISTINCT item) FROM unnest(items) AS a(item));
$$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  full_name text NOT NULL CHECK (full_name = btrim(full_name) AND char_length(full_name) BETWEEN 2 AND 120),
  phone text CHECK (phone IS NULL OR phone ~ '^\+[0-9]{8,15}$'),
  role text NOT NULL DEFAULT 'CUSTOMER' CHECK (role IN ('CUSTOMER','BUSINESS_OWNER','ADMIN')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 2 AND 120),
  description text CHECK (description IS NULL OR (description = btrim(description) AND char_length(description) <= 2000)),
  category text NOT NULL CHECK (category IN ('BAKERY','CAFE','RESTAURANT','SUPERMARKET','OTHER')),
  address text NOT NULL CHECK (address = btrim(address) AND char_length(address) BETWEEN 5 AND 300),
  latitude numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  contact_phone text NOT NULL CHECK (contact_phone ~ '^\+[0-9]{8,15}$'),
  image_file_id uuid,
  verification_status text NOT NULL DEFAULT 'DRAFT'
    CHECK (verification_status IN ('DRAFT','PENDING','APPROVED','REJECTED','SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Storage path and purpose ownership are additionally checked by Node. Arrays
-- cannot have ordinary element-level FKs: application documents must be checked
-- against READY uploads, same business and VERIFICATION_DOCUMENT inside the
-- submission transaction. Node must treat the submitted snapshot as immutable.
CREATE TABLE public.business_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  verification_info text NOT NULL CHECK (verification_info = btrim(verification_info) AND char_length(verification_info) BETWEEN 10 AND 2000),
  document_file_ids uuid[] NOT NULL CHECK (
    CASE WHEN array_ndims(document_file_ids) = 1
      THEN cardinality(document_file_ids) BETWEEN 1 AND 5 AND array_position(document_file_ids, NULL) IS NULL
      ELSE false END
  ),
  business_snapshot jsonb NOT NULL CHECK (jsonb_typeof(business_snapshot) = 'object'),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  decision_reason text CHECK (decision_reason IS NULL OR (decision_reason = btrim(decision_reason) AND char_length(decision_reason) BETWEEN 5 AND 500)),
  CHECK (
    (status = 'PENDING' AND reviewed_at IS NULL AND reviewed_by IS NULL AND decision_reason IS NULL)
    OR (status = 'APPROVED' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
    OR (status = 'REJECTED' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL AND decision_reason IS NOT NULL)
  )
);
CREATE UNIQUE INDEX business_applications_one_pending_per_business
  ON public.business_applications (business_id) WHERE status = 'PENDING';

CREATE TABLE public.uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  uploaded_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('BUSINESS_IMAGE','BOX_IMAGE','VERIFICATION_DOCUMENT')),
  bucket text NOT NULL,
  object_path text NOT NULL UNIQUE CHECK (length(btrim(object_path)) > 0),
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  state text NOT NULL DEFAULT 'READY' CHECK (state = 'READY'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, business_id),
  CHECK (
    (purpose = 'BUSINESS_IMAGE' AND bucket = 'business-images'
      AND mime_type IN ('image/jpeg','image/png','image/webp') AND size_bytes <= 5242880)
    OR (purpose = 'BOX_IMAGE' AND bucket = 'surprise-box-images'
      AND mime_type IN ('image/jpeg','image/png','image/webp') AND size_bytes <= 5242880)
    OR (purpose = 'VERIFICATION_DOCUMENT' AND bucket = 'verification-documents'
      AND mime_type IN ('image/jpeg','image/png','image/webp','application/pdf') AND size_bytes <= 10485760)
  )
);
-- Same-business association is enforced; Node must additionally verify purpose.
ALTER TABLE public.businesses ADD CONSTRAINT businesses_image_same_business_fk
  FOREIGN KEY (image_file_id, id) REFERENCES public.uploads(id, business_id) ON DELETE RESTRICT;

CREATE TABLE public.surprise_boxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (title = btrim(title) AND char_length(title) BETWEEN 2 AND 120),
  description text NOT NULL CHECK (description = btrim(description) AND char_length(description) BETWEEN 10 AND 2000),
  category text NOT NULL CHECK (category IN ('BAKERY','CAFE','RESTAURANT','SUPERMARKET','OTHER')),
  original_price_minor bigint NOT NULL CHECK (original_price_minor BETWEEN 2 AND 100000000),
  discounted_price_minor bigint NOT NULL CHECK (discounted_price_minor > 0 AND discounted_price_minor < original_price_minor),
  -- An owner-supplied quantity is limited to 0..10000 by Node. The persisted
  -- value has no 10000 upper CHECK: cancellation must restore reserved units
  -- even after an owner sets free stock to 10000, including when inactive.
  available_quantity integer NOT NULL CHECK (available_quantity >= 0),
  pickup_start timestamptz NOT NULL,
  pickup_end timestamptz NOT NULL,
  allergens text[] NOT NULL CHECK (public.paybox_valid_allergens(allergens)),
  food_info text NOT NULL CHECK (food_info = btrim(food_info) AND char_length(food_info) BETWEEN 1 AND 1000),
  image_file_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DEACTIVATED','EXPIRED')),
  moderation_reason text CHECK (moderation_reason IS NULL OR (moderation_reason = btrim(moderation_reason) AND char_length(moderation_reason) BETWEEN 5 AND 500)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pickup_end > pickup_start AND pickup_end - pickup_start <= interval '24 hours'),
  UNIQUE (id, business_id),
  FOREIGN KEY (image_file_id, business_id) REFERENCES public.uploads(id, business_id) ON DELETE RESTRICT
);

-- Snapshot values and links are immutable by application contract. Node must
-- lock the profile(s), business, box and reservation in the documented order,
-- atomically decrement/restore inventory and append event/outbox records.
-- Checks cannot replace locking, transition validation, or authorization.
CREATE TABLE public.reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  surprise_box_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor BETWEEN 1 AND 99999999),
  total_price_minor bigint NOT NULL CHECK (total_price_minor = unit_price_minor * quantity),
  currency text NOT NULL DEFAULT 'AZN' CHECK (currency = 'AZN'),
  status text NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('PENDING','CONFIRMED','PICKED_UP','CANCELLED','EXPIRED')),
  box_title text NOT NULL CHECK (box_title = btrim(box_title) AND char_length(box_title) BETWEEN 2 AND 120),
  business_name text NOT NULL CHECK (business_name = btrim(business_name) AND char_length(business_name) BETWEEN 2 AND 120),
  pickup_address text NOT NULL CHECK (pickup_address = btrim(pickup_address) AND char_length(pickup_address) BETWEEN 5 AND 300),
  pickup_start timestamptz NOT NULL,
  pickup_end timestamptz NOT NULL,
  code_nonce text NOT NULL CHECK (length(code_nonce) > 0),
  code_hash text NOT NULL UNIQUE CHECK (length(code_hash) > 0),
  code_key_version integer NOT NULL CHECK (code_key_version > 0),
  picked_up_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR (cancel_reason = btrim(cancel_reason) AND char_length(cancel_reason) BETWEEN 5 AND 500)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pickup_end > pickup_start AND pickup_end - pickup_start <= interval '24 hours'),
  CHECK (
    (status = 'PICKED_UP' AND picked_up_at IS NOT NULL AND cancelled_at IS NULL AND cancel_reason IS NULL)
    OR (status = 'CANCELLED' AND picked_up_at IS NULL AND cancelled_at IS NOT NULL)
    OR (status IN ('PENDING','CONFIRMED','EXPIRED') AND picked_up_at IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL)
  ),
  FOREIGN KEY (surprise_box_id, business_id) REFERENCES public.surprise_boxes(id, business_id) ON DELETE RESTRICT,
  UNIQUE (id, customer_id, business_id)
);

CREATE TABLE public.reservation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE RESTRICT,
  actor_id uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  from_status text CHECK (from_status IS NULL OR from_status IN ('PENDING','CONFIRMED','PICKED_UP','CANCELLED','EXPIRED')),
  to_status text NOT NULL CHECK (to_status IN ('PENDING','CONFIRMED','PICKED_UP','CANCELLED','EXPIRED')),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (from_status IS NULL AND to_status IN ('PENDING','CONFIRMED'))
    OR (from_status = 'PENDING' AND to_status IN ('CONFIRMED','CANCELLED','EXPIRED'))
    OR (from_status = 'CONFIRMED' AND to_status IN ('PICKED_UP','CANCELLED','EXPIRED'))
  )
);

-- Payloads must not contain pickup codes, secrets, credentials or sensitive PII.
-- The application treats events and audit logs as append-only.
CREATE TABLE public.outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (length(btrim(event_type)) > 0),
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE RESTRICT,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text CHECK (comment IS NULL OR (comment = btrim(comment) AND char_length(comment) <= 1000)),
  status text NOT NULL DEFAULT 'VISIBLE' CHECK (status IN ('VISIBLE','HIDDEN')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (reservation_id, customer_id, business_id)
    REFERENCES public.reservations(id, customer_id, business_id) ON DELETE RESTRICT
);

-- Polymorphic target existence/visibility and terminal transitions require
-- server-side transaction checks; an ordinary FK cannot express them.
CREATE TABLE public.complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  target_type text NOT NULL CHECK (target_type IN ('BUSINESS','BOX','REVIEW','RESERVATION')),
  target_id uuid NOT NULL,
  description text NOT NULL CHECK (description = btrim(description) AND char_length(description) BETWEEN 10 AND 2000),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_REVIEW','RESOLVED','DISMISSED')),
  resolution text CHECK (resolution IS NULL OR (resolution = btrim(resolution) AND char_length(resolution) BETWEEN 5 AND 500)),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status IN ('OPEN','IN_REVIEW') AND resolution IS NULL AND resolved_at IS NULL)
    OR (status IN ('RESOLVED','DISMISSED') AND resolution IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (length(btrim(action)) > 0),
  target_type text NOT NULL CHECK (length(btrim(target_type)) > 0),
  target_id uuid NOT NULL,
  reason text CHECK (reason IS NULL OR (reason = btrim(reason) AND char_length(reason) BETWEEN 5 AND 500)),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- response_json is a redacted replay DTO or an application-encrypted JSON
-- envelope. Never store pickup codes, nonce/hash, encryption keys, API keys,
-- tokens, or other secrets here; SQL checks only catch the named common fields.
-- Prefer application-side encryption of sensitive replay data. Node may reserve
-- a row with http_status=0 inside an uncommitted transaction, but MUST update it
-- to a successful status or roll the transaction back before commit.
CREATE TABLE public.idempotency_records (
  actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  method text NOT NULL CHECK (method IN ('POST','PATCH')),
  canonical_route text NOT NULL CHECK (length(btrim(canonical_route)) > 0),
  key uuid NOT NULL,
  request_hash text NOT NULL CHECK (length(request_hash) > 0),
  http_status integer NOT NULL DEFAULT 0 CHECK (http_status = 0 OR http_status BETWEEN 200 AND 299),
  response_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(response_json) = 'object'),
  resource_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (actor_id, method, canonical_route, key),
  CHECK (expires_at >= created_at + interval '24 hours'),
  CHECK (NOT jsonb_path_exists(response_json, '$.**.pickup_code ? (@ != null)')),
  CHECK (NOT jsonb_path_exists(response_json, '$.**.pickupCode ? (@ != null)')),
  CHECK (NOT jsonb_path_exists(response_json, '$.**.code_nonce ? (@ != null)')),
  CHECK (NOT jsonb_path_exists(response_json, '$.**.code_hash ? (@ != null)')),
  CHECK (NOT jsonb_path_exists(response_json, '$.**.code_key_version ? (@ != null)'))
);

CREATE TABLE public.pickup_attempts (
  reservation_id uuid NOT NULL REFERENCES public.reservations(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  window_start timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  PRIMARY KEY (reservation_id, actor_id)
);

-- Stable predicates only: effective expiry remains a runtime time comparison.
CREATE INDEX businesses_owner_created_idx ON public.businesses (owner_id, created_at DESC, id);
CREATE INDEX businesses_status_name_idx ON public.businesses (verification_status, name, id);
CREATE INDEX business_applications_business_submitted_idx ON public.business_applications (business_id, submitted_at DESC, id);
CREATE INDEX surprise_boxes_business_created_idx ON public.surprise_boxes (business_id, created_at DESC, id);
CREATE INDEX surprise_boxes_status_category_end_idx ON public.surprise_boxes (status, category, pickup_end);
CREATE INDEX surprise_boxes_status_price_idx ON public.surprise_boxes (status, discounted_price_minor, id);
CREATE INDEX surprise_boxes_active_end_idx ON public.surprise_boxes (pickup_end, id) WHERE status = 'ACTIVE';
CREATE INDEX reservations_customer_created_idx ON public.reservations (customer_id, created_at DESC, id);
CREATE INDEX reservations_business_created_idx ON public.reservations (business_id, created_at DESC, id);
CREATE INDEX reservations_box_status_idx ON public.reservations (surprise_box_id, status);
CREATE INDEX reservations_status_end_idx ON public.reservations (status, pickup_end);
CREATE INDEX reservations_business_pickup_idx ON public.reservations (business_id, picked_up_at) WHERE picked_up_at IS NOT NULL;
CREATE INDEX reservation_events_reservation_occurred_idx ON public.reservation_events (reservation_id, occurred_at, id);
CREATE INDEX reviews_business_status_created_idx ON public.reviews (business_id, status, created_at DESC, id);
CREATE INDEX complaints_status_created_idx ON public.complaints (status, created_at DESC, id);
CREATE INDEX complaints_user_created_idx ON public.complaints (user_id, created_at DESC, id);
CREATE INDEX uploads_business_created_idx ON public.uploads (business_id, created_at DESC, id);
CREATE INDEX audit_logs_created_idx ON public.audit_logs (created_at DESC, id);
CREATE INDEX outbox_pending_next_attempt_idx ON public.outbox (next_attempt_at, id) WHERE delivered_at IS NULL;
CREATE INDEX idempotency_records_expires_idx ON public.idempotency_records (expires_at);

-- RLS defaults to deny without positive policies. No FORCE RLS: table owner and
-- a role with BYPASSRLS can serve direct pg requests. Ensure the selected server
-- login really has the required privilege and bypass; never put it in a client.
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.surprise_boxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pickup_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.profiles, public.businesses, public.business_applications,
  public.surprise_boxes, public.reservations, public.reservation_events, public.outbox,
  public.reviews, public.complaints, public.uploads, public.audit_logs,
  public.idempotency_records, public.pickup_attempts FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles, public.businesses,
  public.business_applications, public.surprise_boxes, public.reservations,
  public.reservation_events, public.outbox, public.reviews, public.complaints,
  public.uploads, public.audit_logs, public.idempotency_records, public.pickup_attempts TO service_role;
REVOKE ALL ON FUNCTION public.paybox_valid_allergens(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.paybox_valid_allergens(text[]) TO service_role;

-- Auth owns identity. This uniquely named trigger does not use caller metadata
-- for role or status, and deliberately propagates failure to roll back signup.
-- The function owner must be the trusted SQL Editor migration role which owns
-- profiles or bypasses RLS; do not change ownership to anon/authenticated.
CREATE FUNCTION public.paybox_create_profile_for_auth_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate text;
BEGIN
  IF jsonb_typeof(NEW.raw_user_meta_data -> 'full_name') = 'string' THEN
    candidate := btrim(NEW.raw_user_meta_data ->> 'full_name');
  END IF;
  IF candidate IS NULL OR char_length(candidate) NOT BETWEEN 2 AND 120 THEN
    candidate := 'İstifadəçi';
  END IF;
  INSERT INTO public.profiles (id, full_name, role, status)
    VALUES (NEW.id, candidate, 'CUSTOMER', 'ACTIVE');
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.paybox_create_profile_for_auth_user() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER paybox_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.paybox_create_profile_for_auth_user();

-- No Storage policies are added. These are private; server-side Storage access
-- must authorize the caller before generating short-lived signed URLs. Existing
-- Supabase Storage policies, if any, must be independently reviewed.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
  ('business-images', 'business-images', false, 5242880, ARRAY['image/jpeg','image/png','image/webp']),
  ('surprise-box-images', 'surprise-box-images', false, 5242880, ARRAY['image/jpeg','image/png','image/webp']),
  ('verification-documents', 'verification-documents', false, 10485760, ARRAY['image/jpeg','image/png','image/webp','application/pdf']);

COMMIT;
