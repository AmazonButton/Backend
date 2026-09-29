import * as crypto from 'crypto';

export interface PayosPaymentRequestParams {
  amount: number;
  cancelUrl: string;
  description: string;
  orderCode: number;
  returnUrl: string;
}

export function signPaymentRequest(params: PayosPaymentRequestParams, checksumKey: string): string {
  const raw = [
    `amount=${params.amount}`,
    `cancelUrl=${params.cancelUrl}`,
    `description=${params.description}`,
    `orderCode=${params.orderCode}`,
    `returnUrl=${params.returnUrl}`,
  ].join('&');

  return crypto
    .createHmac('sha256', checksumKey)
    .update(raw)
    .digest('hex');
}

export function sortObjDataByKey(object: Record<string, any>): Record<string, any> {
  return Object.keys(object)
    .sort()
    .reduce((obj: Record<string, any>, key: string) => {
      obj[key] = object[key];
      return obj;
    }, {});
}

export function convertObjToQueryStr(object: Record<string, any>): string {
  return Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .map((key) => {
      let value = object[key];
      if (value && Array.isArray(value)) {
        value = JSON.stringify(value.map((item) => sortObjDataByKey(item)));
      }
      if ([null, undefined, 'undefined', 'null'].includes(value)) value = '';
      return `${key}=${value}`;
    })
    .join('&');
}

export function verifyWebhookSignature(data: any, signature: string, checksumKey: string): boolean {
  if (!data || !signature || !checksumKey) return false;
  const sortedData = sortObjDataByKey(data);
  const queryString = convertObjToQueryStr(sortedData);
  const expected = crypto
    .createHmac('sha256', checksumKey)
    .update(queryString)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}
