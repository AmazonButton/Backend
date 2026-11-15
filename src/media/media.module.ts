import { PrismaModule } from '../prisma/prisma.module';
import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { ObjectStorageService } from './object-storage.service';
import { ProductsRepository } from '../products/products.repository';

@Module({
  imports: [PrismaModule],
  controllers: [MediaController],
  providers: [MediaService, ObjectStorageService, ProductsRepository],
  exports: [MediaService, ObjectStorageService],
})
export class MediaModule {}
