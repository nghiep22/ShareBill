import type { Demo } from './model';

export type Profile = { name: string; email: string };
export type Report = { id: string; title: string; detail: string; at: string };
export type LocalWorkspace = {
  selected: string;
  trips: Record<string, Demo>;
  profile?: Profile;
  reports?: Report[];
  revision?: string;
};
