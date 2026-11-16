const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const plans = await prisma.subscriptionPlan.findMany({ orderBy: { planId: 'asc' } });
  console.log('=== SUBSCRIPTION PLANS ===');
  console.log(JSON.stringify(plans, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));

  const pkgs = await prisma.rentalPackage.findMany({ orderBy: { packageId: 'asc' } });
  console.log('=== RENTAL PACKAGES ===');
  console.log(JSON.stringify(pkgs, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
}

main()
  .catch((err) => console.error(err))
  .finally(() => prisma.$disconnect());
