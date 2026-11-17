import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/require-permission.decorator.js';

@ApiTags('salud')
@Controller('health')
export class HealthController {
  @Get()
  @Public()
  health() {
    return { status: 'ok' };
  }
}
