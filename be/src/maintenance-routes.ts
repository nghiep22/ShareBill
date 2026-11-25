import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './http.js';
import { scheduledMaintenance } from './services/scheduled-maintenance.js';

export async function registerMaintenanceRoutes(app: FastifyInstance, run = scheduledMaintenance) {
  app.route({ method: 'GET', url: '/api/internal/maintenance', exposeHeadRoute: false, handler: async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const secret = process.env.CRON_SECRET;
    if (!secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) throw new ApiError(503, 'MAINTENANCE_NOT_CONFIGURED', 'Tác vụ bảo trì chưa được cấu hình.');
    const expected = Buffer.from('Bearer ' + secret), actual = Buffer.from(request.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ApiError(401, 'UNAUTHORIZED', 'Không có quyền chạy tác vụ bảo trì.');
    if (Object.keys(request.query as object).length || request.body !== undefined || request.headers['transfer-encoding'] ||
      request.headers['content-length'] && request.headers['content-length'] !== '0') {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Tác vụ bảo trì không nhận tham số hoặc nội dung.');
    }
    try {
      const result = await run();
      if (result.status === 'failed') reply.code(503);
      return { data: result };
    } catch { throw new ApiError(503, 'MAINTENANCE_UNAVAILABLE', 'Tác vụ bảo trì chưa hoàn tất. Kiểm tra kết quả trong Hệ thống quản trị.'); }
  } });
}
