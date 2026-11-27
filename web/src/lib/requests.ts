import type { KidRequest } from '../api/types';
import { plural } from './format';

export interface RequestCopy { text: string; tag: string; tagClass: string; yes: string }

/** The wording for one request from a kid, as on the approved dashboard. */
export function requestCopy(r: Pick<KidRequest, 'kind' | 'kidName' | 'minutes' | 'detail'>): RequestCopy {
  if (r.kind === 'time') {
    const text = r.minutes
      ? `${r.kidName} asks for ${plural(r.minutes, 'more minute', 'more minutes')}`
      : `${r.kidName} asks for more time`;
    return { text, tag: 'More time', tagClass: 'pill-peri', yes: 'Yes' };
  }
  if (r.kind === 'app') {
    return { text: `${r.kidName} wants a new app: ${r.detail || 'unnamed app'}`, tag: 'New app', tagClass: 'pill-deep', yes: 'Allow' };
  }
  return { text: `${r.kidName} wants a website: ${r.detail || 'unnamed site'}`, tag: 'New site', tagClass: 'pill-deep', yes: 'Allow' };
}
