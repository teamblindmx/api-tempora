import { randomInt } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Prisma } from '../../../generated/prisma/client.js';
import { Clock } from '../../common/clock.js';
import type { TransactionClient } from '../../database/prisma-client.js';
import { TenantDb } from '../../database/tenant-db.service.js';
import type { RequestContext } from '../../tenancy/request-context.js';
import { AuditService } from '../audit/audit.service.js';
import { ATTENDANCE_ERRORS } from './attendance.schemas.js';
import {
  fail,
  fromDate,
  shiftOf,
  siteCoords,
  siteOrFail,
  toDate,
  toRecordDto,
} from './attendance.records.js';
import { EXIT_REVIEW_THRESHOLD_MIN } from './rules/exit.js';
import { evaluateLateness } from './rules/lateness.js';
import { checkLocation, type Coordinates } from './rules/location.js';
import { canSelfCheckOut, DAILY_CODE_DIGITS, evaluateCheckOut, locationReview } from './rules/marking.js';
import { overtimeMinutes } from './rules/overtime.js';
import { localDate, scheduledEnd } from './rules/workday.js';
import { dayOf } from './work-calendar.js';

const MIN = 60_000;

type Location = (Coordinates & { accuracyM?: number | undefined }) | null;
type CodeRow = NonNullable<Awaited<ReturnType<TransactionClient['dailyCode']['findFirst']>>>;

export function toCodeDto(c: CodeRow) {
  return {
    id: c.id,
    siteId: c.siteId,
    code: c.code,
    createdAt: c.createdAt.toISOString(),
    expiresAt: c.expiresAt.toISOString(),
  };
}

/**
 * Código diario, entrada y salida. Todo corre en una transacción con la compañía de la petición
 * (RLS) y filtra además por companyId y sede. Cada evento deja su auditoría en la misma transacción.
 * La sede, la compañía y el usuario salen del contexto que llenó PermissionGuard, nunca del cuerpo.
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly db: TenantDb,
    private readonly audit: AuditService,
    private readonly cls: ClsService<RequestContext>,
    private readonly clock: Clock,
  ) {}

  private context() {
    const siteId = this.cls.get('siteId');
    const userId = this.cls.get('actor')?.userId;
    if (!siteId || !userId) throw new Error('El marcado necesita una ruta de sede y una sesión');
    return { siteId, userId };
  }

  /** Genera el código de la sede y vence el anterior (regla 2). */
  createDailyCode(ttlMinutes: number) {
    const { siteId, userId } = this.context();
    const now = this.clock.now();
    return this.db.run(async (tx, companyId) => {
      await siteOrFail(tx, companyId, siteId);
      // createdAt <= now: si el reloj del servidor retrocede (cambio de hora del sistema, pruebas),
      // no se vence un código "del futuro" antes de crearse (lo impediría daily_code_window).
      await tx.dailyCode.updateMany({
        where: { companyId, siteId, expiresAt: { gt: now }, createdAt: { lte: now } },
        data: { expiresAt: now },
      });
      const code = await tx.dailyCode.create({
        data: {
          companyId,
          siteId,
          code: String(randomInt(0, 10 ** DAILY_CODE_DIGITS)).padStart(DAILY_CODE_DIGITS, '0'),
          createdBy: userId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + ttlMinutes * MIN),
        },
      });
      // El código en sí no va a la auditoría: queda en daily_code, ligado a cada entrada.
      await this.audit.record(tx, companyId, {
        action: 'daily-code.create',
        targetType: 'daily-code',
        targetId: code.id,
        after: { siteId, expiresAt: code.expiresAt.toISOString(), ttlMinutes },
      });
      return code;
    });
  }

  /** Código vigente de la sede, o null. */
  currentDailyCode() {
    const { siteId } = this.context();
    const now = this.clock.now();
    return this.db.run((tx, companyId) =>
      tx.dailyCode.findFirst({
        where: { companyId, siteId, expiresAt: { gt: now } },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /**
   * Entrada (reglas 1 a 4). El código debe ser el vigente de la sede. La ubicación nunca rechaza:
   * fuera del radio o sin ubicación, la jornada se guarda "por revisar" con la distancia real. El
   * retardo se decide aquí, con el horario y la tolerancia de la sede (regla 10, ADR 0014).
   */
  checkIn(code: string, location: Location) {
    return this.register(code, location, false);
  }

  /**
   * "Registrar entrada tardía" (regla 10): el código de hoy ya venció. Pide un código de la sede
   * generado hoy (no basta con ninguno: el trabajador tuvo que estar ahí para verlo) y queda marcado.
   */
  lateCheckIn(code: string, location: Location) {
    return this.register(code, location, true);
  }

  private async register(code: string, location: Location, late: boolean) {
    const { siteId, userId } = this.context();
    const now = this.clock.now();
    try {
      return await this.db.run(async (tx, companyId) => {
        const site = await siteOrFail(tx, companyId, siteId);
        const today = localDate(now, site.timezone);
        const dailyCode = await tx.dailyCode.findFirst({
          where: { companyId, siteId, code },
          orderBy: { createdAt: 'desc' },
        });
        if (!dailyCode)
          fail(HttpStatus.UNPROCESSABLE_ENTITY, ATTENDANCE_ERRORS.codeInvalid, 'Código incorrecto');
        const expired = dailyCode.expiresAt <= now;
        if (!late && expired) {
          fail(
            HttpStatus.UNPROCESSABLE_ENTITY,
            ATTENDANCE_ERRORS.codeExpired,
            'El código ya venció. Usa "Registrar entrada tardía" o pide a tu líder uno nuevo.',
          );
        }
        if (late && !expired) {
          fail(
            HttpStatus.UNPROCESSABLE_ENTITY,
            ATTENDANCE_ERRORS.codeStillValid,
            'El código sigue vigente: registra tu entrada normal',
          );
        }
        if (late && localDate(dailyCode.createdAt, site.timezone) !== today) {
          fail(
            HttpStatus.UNPROCESSABLE_ENTITY,
            ATTENDANCE_ERRORS.codeNotToday,
            'Ese código no es de hoy. Pide a tu líder el de hoy.',
          );
        }

        const existing = await tx.attendanceRecord.findFirst({
          where: { companyId, userId, workDate: toDate(today) },
        });
        if (existing) this.alreadyCheckedIn();

        const shift = shiftOf(site);
        const day = await dayOf(tx, companyId, site, today);
        const lateness = evaluateLateness({
          checkInAt: now,
          workDate: today,
          shift,
          timeZone: site.timezone,
          toleranceMin: site.lateToleranceMin,
          workday: day.workday,
          codeExpired: late,
        });
        const check = checkLocation(siteCoords(site), location);
        const reviewReasons = locationReview('entry', check);
        const record = await tx.attendanceRecord.create({
          data: {
            companyId,
            siteId,
            userId,
            workDate: toDate(today),
            checkInAt: now,
            checkInLatitude: location?.latitude ?? null,
            checkInLongitude: location?.longitude ?? null,
            checkInAccuracyM: location?.accuracyM != null ? Math.round(location.accuracyM) : null,
            checkInDistanceM: check.distanceM,
            dailyCodeId: dailyCode.id,
            checkInLate: lateness.late,
            checkInLateMinutes: lateness.minutesAfterStart,
            checkInCodeExpired: late,
            reviewReasons,
          },
        });
        // Sin coordenadas en la auditoría (dato personal): basta la distancia.
        await this.audit.record(tx, companyId, {
          action: late ? 'attendance.late-check-in' : 'attendance.check-in',
          targetType: 'attendance-record',
          targetId: record.id,
          after: {
            siteId,
            userId,
            workDate: today,
            checkInAt: now.toISOString(),
            dailyCodeId: dailyCode.id,
            distanceM: check.distanceM,
            late: lateness.late,
            lateMinutes: lateness.minutesAfterStart,
            codeExpired: late,
            dayType: day.dayType,
            reviewReasons,
          },
        });
        return toRecordDto(record, today, shift);
      });
    } catch (e) {
      // Dos entradas simultáneas del mismo trabajador: la segunda choca con el índice único.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') this.alreadyCheckedIn();
      throw e;
    }
  }

  private alreadyCheckedIn(): never {
    fail(HttpStatus.CONFLICT, ATTENDANCE_ERRORS.alreadyCheckedIn, 'Ya registraste tu entrada hoy');
  }

  /** Salida (reglas 6 a 8). Cierra la jornada abierta del trabajador en esta sede. */
  checkOut(location: Location, reason: string | null) {
    const { siteId, userId } = this.context();
    const now = this.clock.now();
    return this.db.run(async (tx, companyId) => {
      const site = await siteOrFail(tx, companyId, siteId);
      const shift = shiftOf(site);
      const today = localDate(now, site.timezone);
      // La jornada que se puede cerrar es la de hoy (o la de ayer en un turno de noche); una más
      // vieja sin salida es "salida pendiente" y la corrige el líder (regla 7).
      const unclosed = await tx.attendanceRecord.findMany({
        where: { companyId, siteId, userId, checkOutAt: null, workDate: { lte: toDate(today) } },
        orderBy: { workDate: 'desc' },
        take: 3,
      });
      const open = unclosed.find((r) => canSelfCheckOut(fromDate(r.workDate), today, shift));
      if (!open) {
        const closedToday = await tx.attendanceRecord.findFirst({
          where: { companyId, siteId, userId, workDate: toDate(today), checkOutAt: { not: null } },
        });
        if (closedToday) {
          fail(HttpStatus.CONFLICT, ATTENDANCE_ERRORS.alreadyCheckedOut, 'Ya registraste tu salida hoy');
        }
        const pending = unclosed[0];
        if (pending) {
          fail(
            HttpStatus.CONFLICT,
            ATTENDANCE_ERRORS.exitPending,
            `La jornada del ${fromDate(pending.workDate)} quedó sin salida. Tu líder la corrige.`,
          );
        }
        fail(
          HttpStatus.CONFLICT,
          ATTENDANCE_ERRORS.notCheckedIn,
          'No tienes una entrada abierta en esta sede',
        );
      }
      const workDate = fromDate(open.workDate);

      const check = checkLocation(siteCoords(site), location);
      const end = shift ? scheduledEnd(workDate, shift, site.timezone) : null;
      const authorization = await tx.overtimeAuthorization.findFirst({
        where: { companyId, userId, workDate: open.workDate },
      });
      // Regla 8: una salida tarde no va a revisión si las horas extra estaban autorizadas (lo que
      // queda sin autorizar no pasa del margen de 30 minutos).
      const overtimeAuthorized =
        !!end &&
        !!authorization &&
        now > end &&
        overtimeMinutes(end, now, authorization).unauthorizedMinutes <= EXIT_REVIEW_THRESHOLD_MIN;
      const result = evaluateCheckOut({
        now,
        scheduledEnd: end,
        overtimeAuthorized,
        location: check,
        reason,
      });
      if (!result.ok) {
        fail(
          HttpStatus.UNPROCESSABLE_ENTITY,
          ATTENDANCE_ERRORS.earlyExitReasonRequired,
          'Es una salida anticipada: escribe el motivo',
        );
      }

      const reviewReasons = [...open.reviewReasons, ...result.reviewReasons];
      const data = {
        checkOutAt: now,
        checkOutLatitude: location?.latitude ?? null,
        checkOutLongitude: location?.longitude ?? null,
        checkOutAccuracyM: location?.accuracyM != null ? Math.round(location.accuracyM) : null,
        checkOutDistanceM: check.distanceM,
        checkOutKind: result.kind,
        checkOutReason: reason,
        checkOutSource: 'self',
        reviewReasons,
      };
      // checkOutAt: null en el where: si dos salidas llegan juntas, solo una cierra la jornada.
      const updated = await tx.attendanceRecord.updateMany({
        where: { id: open.id, companyId, checkOutAt: null },
        data,
      });
      if (updated.count === 0) {
        fail(HttpStatus.CONFLICT, ATTENDANCE_ERRORS.alreadyCheckedOut, 'Ya registraste tu salida');
      }
      await this.audit.record(tx, companyId, {
        action: 'attendance.check-out',
        targetType: 'attendance-record',
        targetId: open.id,
        before: { checkOutAt: null, reviewReasons: open.reviewReasons },
        after: {
          checkOutAt: now.toISOString(),
          kind: result.kind,
          distanceM: check.distanceM,
          reviewReasons,
        },
        ...(reason ? { reason } : {}),
      });
      return toRecordDto({ ...open, ...data }, today, shift, { timezone: site.timezone, now, authorization });
    });
  }

  /** La jornada de hoy del trabajador en esta sede y las anteriores que quedaron sin salida. */
  mine() {
    const { siteId, userId } = this.context();
    const now = this.clock.now();
    return this.db.run(async (tx, companyId) => {
      const site = await siteOrFail(tx, companyId, siteId);
      const shift = shiftOf(site);
      const today = localDate(now, site.timezone);
      const [record, open, day] = await Promise.all([
        tx.attendanceRecord.findFirst({ where: { companyId, siteId, userId, workDate: toDate(today) } }),
        tx.attendanceRecord.findMany({
          where: { companyId, siteId, userId, checkOutAt: null, workDate: { lt: toDate(today) } },
          orderBy: { workDate: 'desc' },
          take: 31,
        }),
        dayOf(tx, companyId, site, today),
      ]);
      const auths = await tx.overtimeAuthorization.findMany({
        where: {
          companyId,
          userId,
          workDate: { in: [toDate(today), ...open.slice(0, 1).map((r) => r.workDate)] },
        },
      });
      const ot = (workDate: Date) => ({
        timezone: site.timezone,
        now,
        authorization: auths.find((a) => a.workDate.getTime() === workDate.getTime()) ?? null,
      });
      const earlier = open.map((r) => toRecordDto(r, today, shift, ot(r.workDate)));
      return {
        today,
        day,
        // Turno de noche: si hoy no ha entrado, se muestra la jornada de ayer que sigue abierta.
        record: record
          ? toRecordDto(record, today, shift, ot(record.workDate))
          : (earlier.find((r) => r.status === 'open') ?? null),
        pendingExits: earlier.filter((r) => r.status === 'pending-exit'),
      };
    });
  }
}
