import { Prisma } from '@prisma/client';

export const REALIZED_ORDER_STATUSES = ['DELIVERED', 'COMPLETED'] as const;
export const EXCLUDED_GMV_STATUSES = ['CANCELLED', 'REJECTED'] as const;
export const IN_TRANSIT_ORDER_STATUSES = ['READY_FOR_DELIVERY', 'SHIPPING'] as const;
export const PREPARING_STATUSES = ['PREPARING'] as const;
export const FAILED_DELIVERY_STATUSES = ['DELIVERY_FAILED'] as const;

export const SQL_REALIZED_STATUSES = Prisma.sql`('DELIVERED', 'COMPLETED')`;
export const SQL_EXCLUDED_GMV_STATUSES = Prisma.sql`('CANCELLED', 'REJECTED')`;
export const SQL_IN_TRANSIT_STATUSES = Prisma.sql`('READY_FOR_DELIVERY', 'SHIPPING')`;
export const SQL_FAILED_DELIVERY_STATUSES = Prisma.sql`('DELIVERY_FAILED')`;
