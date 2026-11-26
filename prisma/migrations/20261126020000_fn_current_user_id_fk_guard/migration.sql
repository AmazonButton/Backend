CREATE OR REPLACE FUNCTION "public"."fn_current_user_id"()
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_app_uid BIGINT;
  v_sub TEXT;
  v_sub_uid BIGINT;
BEGIN
  BEGIN
    v_app_uid := NULLIF(current_setting('app.current_user_id', true), '')::BIGINT;
    IF v_app_uid IS NOT NULL AND EXISTS (SELECT 1 FROM public.users WHERE user_id = v_app_uid) THEN
      RETURN v_app_uid;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_app_uid := NULL;
  END;

  BEGIN
    v_sub := NULLIF(current_setting('request.jwt.claim.sub', true), '');
    IF v_sub IS NOT NULL AND v_sub ~ '^\d+$' THEN
      v_sub_uid := v_sub::BIGINT;
      IF EXISTS (SELECT 1 FROM public.users WHERE user_id = v_sub_uid) THEN
        RETURN v_sub_uid;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  BEGIN
    RETURN (SELECT user_id FROM public.users WHERE auth_id = auth.uid() LIMIT 1);
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
END;
$function$;
