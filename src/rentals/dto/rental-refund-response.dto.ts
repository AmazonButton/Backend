/** Whitelist both Prisma camelCase and locked SQL-row snake_case results. */
export function toRentalRefundDto(refund: any) {
  if (!refund) return null;
  const id = (value: unknown) => value == null ? null : String(value);
  return {
    refundId: id(refund.refundId ?? refund.refund_id),
    refundCode: refund.refundCode ?? refund.refund_code ?? null,
    rentalId: id(refund.rentalId ?? refund.rental_id),
    returnId: id(refund.returnId ?? refund.return_id),
    status: refund.status,
    amount: Number(refund.amount ?? 0),
    recipientAccountMasked: refund.recipientAccountNumberMasked ?? refund.recipient_account_number_masked ?? null,
    refundedAt: refund.refundedAt ?? refund.refunded_at ?? null,
    providerReferenceId: refund.providerReferenceId ?? refund.provider_reference_id ?? null,
  };
}

export function toRentalRefundOperationDto(result: any) {
  const refund = result.refund ? toRentalRefundDto(result.refund) : null;
  return {
    refundId: String(result.refundId ?? refund?.refundId ?? ''),
    status: result.status ?? refund?.status,
    amount: result.amount == null ? refund?.amount : Number(result.amount),
    providerReferenceId: result.providerReferenceId ?? refund?.providerReferenceId ?? null,
    alreadyProcessed: Boolean(result.alreadyProcessed),
    alreadyConfirmed: Boolean(result.alreadyConfirmed),
    storeWalletDebited: false,
    ...(refund ? { refund } : {}),
    ...(result.depositLedger ? { depositLedger: {
      rentalId: String(result.depositLedger.rentalId ?? ''),
      collectedAmount: Number(result.depositLedger.collectedAmount), heldAmount: Number(result.depositLedger.heldAmount),
      refundReservedAmount: Number(result.depositLedger.refundReservedAmount), refundedAmount: Number(result.depositLedger.refundedAmount),
    } } : {}),
  };
}
