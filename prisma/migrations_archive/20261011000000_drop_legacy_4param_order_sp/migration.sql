-- Drop legacy 4-parameter stored procedure overload to enforce 5-parameter idempotency function
DROP FUNCTION IF EXISTS public.sp_create_order_from_button(
  bigint,
  character varying,
  numeric,
  text
);
