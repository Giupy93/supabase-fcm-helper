import { blockingProjectUserIds } from './live_participation.ts';

Deno.test('declining one live preserves other events and other members', () => {
  const members = ['alice', 'bob', 'alice'];
  const live = { type: 1, entry_exclusions: [{ user_id: 'alice' }] };
  const otherLive = { type: 1 };
  const rehearsal = { type: 2, entry_exclusions: [{ user_id: 'alice' }] };
  const personalCommitment = { type: 0 };
  const result = [live, otherLive, rehearsal, personalCommitment]
    .map((entry) => blockingProjectUserIds(entry, members));
  if (JSON.stringify(result) !== JSON.stringify([
    ['bob'], ['alice', 'bob'], ['alice', 'bob'], ['alice', 'bob'],
  ])) throw new Error('An exclusion must affect only its live');
  live.entry_exclusions = [];
  if (!blockingProjectUserIds(live, members).includes('alice')) {
    throw new Error('Rejoining must restore the commitment');
  }
});
