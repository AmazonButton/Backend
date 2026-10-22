import { MediaModule } from '../media/media.module';
﻿import { StoreSubscriptionsModule } from '../store-subscriptions/store-subscriptions.module';
import { Module } from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { ProductsRepository } from './products.repository';

import { WebSocketModule } from '../websocket/websocket.module';

@Module({
  imports: [StoreSubscriptionsModule, MediaModule, WebSocketModule],
  controllers: [ProductsController],
  providers: [ProductsService, ProductsRepository],
  exports: [ProductsService, ProductsRepository],
})
export class ProductsModule {}
