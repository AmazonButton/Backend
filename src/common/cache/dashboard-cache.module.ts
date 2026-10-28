import { Global, Module } from '@nestjs/common';
import { DashboardCacheService } from './dashboard-cache.service';

@Global()
@Module({
  providers: [DashboardCacheService],
  exports: [DashboardCacheService],
})
export class DashboardCacheModule {}
