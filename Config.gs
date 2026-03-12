var CONFIG = {
  // Calendar IDs - fill these in with your actual calendar IDs
  PRIMARY_CALENDAR_ID: '***@***.***',
  SECONDARY_CALENDAR_ID: '***@***.***',

  // Prefixes added to synced event titles
  PREFIX_FROM_PRIMARY: 'Sync: ',
  PREFIX_FROM_SECONDARY: 'Sync: ',

  // Generic title used for primary calendar events synced to secondary calendar (details stripped)
  STRIPPED_TITLE: 'Sync: Meeting',

  // Extended property keys used to track source↔synced relationships
  EXT_PROP_SOURCE_CALENDAR_ID: 'sourceCalendarId',
  EXT_PROP_SOURCE_EVENT_ID: 'sourceEventId',

  // How many days ahead to sync on a full sync (limits expanded recurring events)
  FULL_SYNC_DAYS: 30,

  // How often the sync trigger runs, in minutes (valid values: 1, 5, 10, 15, or 30)
  TRIGGER_MINUTES: 15,

  // PropertiesService keys for sync tokens
  SYNC_TOKEN_PRIMARY: 'syncToken_primary',
  SYNC_TOKEN_SECONDARY: 'syncToken_secondary'
};
