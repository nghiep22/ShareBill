import type { FastifyRequest } from 'fastify';
import { auth, db } from '../firebase.js';
import { ApiError, tokenVerificationError } from '../http.js';

export async function adminIdentity(request: FastifyRequest, recent = false) {
  const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Đăng nhập bằng Google để tiếp tục.');
  const claims = await auth().verifyIdToken(token, true).catch(cause => {
    throw tokenVerificationError(cause);
  });
  if (claims.firebase?.sign_in_provider !== 'google.com' || claims.email_verified !== true) {
    throw new ApiError(403, 'ADMIN_FORBIDDEN', 'Cần danh tính Google đã xác minh để vào khu vực quản trị.');
  }
  const maxAge = 10 * 60;
  const now = Math.floor(Date.now() / 1000);
  if (recent && (!Number.isInteger(claims.auth_time) || claims.auth_time > now || now - claims.auth_time > maxAge)) {
    throw new ApiError(403, 'ADMIN_REAUTH_REQUIRED', 'Xác thực lại bằng Google rồi gửi lại thao tác.');
  }
  return claims.uid;
}

export async function requireAdmin(tx: FirebaseFirestore.Transaction, uid: string) {
  const store = db();
  const [grant, profile] = await Promise.all([tx.get(store.doc(`platformAdmins/${uid}`)), tx.get(store.doc(`users/${uid}`))]);
  if (grant.get('uid') !== uid || grant.get('role') !== 'platform_admin' || grant.get('status') !== 'active' || profile.get('status') !== 'active') {
    throw new ApiError(403, 'ADMIN_FORBIDDEN', 'Tài khoản chưa được cấp quyền quản trị.');
  }
}
