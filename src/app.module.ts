import { Module } from '@nestjs/common';
import { AppService } from './app.service.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

@Module({
  imports: [],
  providers: [AppService],
})
export class AppModule {}
