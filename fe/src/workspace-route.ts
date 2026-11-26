import type { Demo } from './model';

const tripScreens = new Set(['tong-quan', 'chi-tieu', 'them-khoan-chi', 'khoan-chi', 'sua-khoan-chi', 'so-du',
  'quyet-toan', 'thanh-vien', 'lich-trinh', 'hoat-dong', 'cai-dat', 'loi-moi']);
const expenseScreens = new Set(['chi-tieu', 'them-khoan-chi', 'khoan-chi', 'sua-khoan-chi']);
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export function readWorkspaceRoute(hash: string) {
  const question = hash.indexOf('?');
  const path = question < 0 ? hash : hash.slice(0, question);
  const query = new URLSearchParams(question < 0 ? '' : hash.slice(question + 1));
  const [route, id, section, resource] = path.split('/');
  if (route === 'chuyen' && id && uuid.test(id) && section && (tripScreens.has(section) || section === 'tro-giup')) {
    return { route: section, id: section === 'tro-giup' ? 'chuyen' : resource, tripId: id, query };
  }
  return { route, id, tripId: undefined, query };
}

export function tripRoute(tripId: string, route: string, id?: string, query?: string) {
  return ['chuyen', tripId, route, id].filter(Boolean).join('/') + (query ? '?' + query : '');
}

export function tripHref(data: Demo, route: string, id?: string) {
  const remote = data.remote;
  if (remote && (tripScreens.has(route) || route === 'tro-giup')) {
    return '#' + tripRoute(remote.tripId, route, id, expenseScreens.has(route) ? remote.expenseQuery : undefined);
  }
  return '#' + route + (id ? '/' + id : '');
}

export const isTripScreen = (route: string) => tripScreens.has(route);
export const isParticipantId = (id: string) => uuid.test(id);
