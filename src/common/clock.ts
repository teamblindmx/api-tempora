import { Injectable } from '@nestjs/common';

/**
 * Reloj del servidor. La hora de todo registro sale de aquí, nunca del teléfono (regla 1). Es una
 * clase para poder fijar la hora en las pruebas.
 */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
