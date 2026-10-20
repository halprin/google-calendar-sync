var CONFIG = {
  // Calendar IDs - fill these in with your actual calendar IDs
  PRIMARY_CALENDAR_ID: '***@***.***',
  SECONDARY_CALENDAR_ID: '***@***.***',

  // Prefixes added to synced event titles
  PREFIX_FROM_PRIMARY: 'Sync: ',
  PREFIX_FROM_SECONDARY: 'Sync: ',

  // Generic title used for primary calendar events synced to secondary calendar (details stripped)
  STRIPPED_TITLE: 'Sync: Meeting',

  // Extended property keys used to track source↔synced relationships.
  // SOURCE_EVENT_ID always holds an *instance* ID (recurring series are always
  // expanded), which is what makes duplicate detection reliable.
  EXT_PROP_SOURCE_CALENDAR_ID: 'sourceCalendarId',
  EXT_PROP_SOURCE_EVENT_ID: 'sourceEventId',
  // Last-known `updated` timestamp of the source event, used to skip no-op writes.
  EXT_PROP_SOURCE_UPDATED: 'sourceUpdated',

  // How many days ahead to sync. Recurring series are expanded into instances,
  // so this also bounds how far out instances are created. Copies outside this
  // window are left completely alone (never updated, never deleted).
  SYNC_WINDOW_DAYS: 30,

  // How often the sync trigger runs, in minutes (valid values: 1, 5, 10, 15, or 30)
  TRIGGER_MINUTES: 15,

  // SAFETY: when true, the reconciliation pass only *logs* the deletions it
  // would make and does not touch any events. Review the execution log, then
  // set this to false to actually apply them.
  RECONCILE_DRY_RUN: true,

  // Upper bound on deletions per execution, to stay inside Apps Script quotas
  // and runtime limits. Leftover deletions are picked up on later runs.
  MAX_DELETES_PER_RUN: 150,

  // Stop starting new work after this many seconds, so a large backlog never
  // trips the hard 6-minute Apps Script execution limit mid-write.
  MAX_RUNTIME_SECONDS: 270
};
