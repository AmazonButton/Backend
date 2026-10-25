import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { StoreSubscriptionsModule } from '../store-subscriptions/store-subscriptions.module';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { ProductsRepository } from './products.repository';
import { StoreInventoryController } from './store-inventory.controller';

@Module({
  imports: [StoreSubscriptionsModule, MediaModule],
  controllers: [ProductsController, StoreInventoryController],
  providers: [ProductsService, ProductsRepository],
  exports: [ProductsService, ProductsRepository],
})
export class ProductsModule {}
