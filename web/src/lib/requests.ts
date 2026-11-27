import type { ChoreApproval, KidRequest } from '../api/types';
import { plural } from './format';

export interface RequestCopy { text: string; tag: string; tagClass: string; yes: string; /** What the kid wrote with a friend request. */ note?: string }

/** The wording for one request from a kid, as on the approved dashboard. */
export function requestCopy(r: Pick<KidRequest, 'kind' | 'kidName' | 'minutes' | 'detail'> & Pick<Partial<KidRequest>, 'note' | 'phone'>): RequestCopy {
  if (r.kind === 'time') {
    const text = r.minutes
      ? `${r.kidName} asks for ${plural(r.minutes, 'more minute', 'more minutes')}`
      : `${r.kidName} asks for more time`;
    return { text, tag: 'More time', tagClass: 'pill-peri', yes: 'Yes' };
  }
  if (r.kind === 'app') {
    return { text: `${r.kidName} wants a new app: ${r.detail || 'unnamed app'}`, tag: 'New app', tagClass: 'pill-deep', yes: 'Allow' };
  }
  if (r.kind === 'contact') {
    const copy: RequestCopy = {
      text: `${r.kidName} wants to text a friend: ${r.detail || 'no name'}${r.phone ? ` (${r.phone})` : ''}`,
      tag: 'New contact', tagClass: 'pill-deep', yes: 'Allow',
    };
    if (r.note) copy.note = `${r.kidName} says: "${r.note}"`;
    return copy;
  }
  return { text: `${r.kidName} wants a website: ${r.detail || 'unnamed site'}`, tag: 'New site', tagClass: 'pill-deep', yes: 'Allow' };
}

/** The wording for a chore a kid marked as done. */
export function choreCopy(a: Pick<ChoreApproval, 'kidName' | 'choreName' | 'minutes'>): { text: string; reward: string } {
  return {
    text: `${a.kidName} says this chore is done: ${a.choreName}`,
    reward: a.minutes > 0 ? `Yes adds ${plural(a.minutes, 'minute', 'minutes')} today` : 'No extra time',
  };
}
