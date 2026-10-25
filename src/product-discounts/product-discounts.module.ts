import { Module } from '@nestjs/common';
import { ProductDiscountsController, DiscountsController } from './product-discounts.controller';
import { ProductDiscountsService } from './product-discounts.service';
import { ProductDiscountsRepository } from './product-discounts.repository';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [ProductDiscountsController, DiscountsController],
  providers: [ProductDiscountsService, ProductDiscountsRepository],
  exports: [ProductDiscountsService, ProductDiscountsRepository],
})
export class ProductDiscountsModule {}
