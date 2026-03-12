/**
 * Trigger entry point. Syncs events bidirectionally between primary and secondary calendars.
 */
function runSync() {
  logInfo('Starting bidirectional sync');

  // Primary → Secondary
  safeExecute(function() {
    syncDirection(
      CONFIG.PRIMARY_CALENDAR_ID,
      CONFIG.SECONDARY_CALENDAR_ID,
      CONFIG.PREFIX_FROM_PRIMARY,
      CONFIG.SYNC_TOKEN_PRIMARY,
      true
    );
  }, 'Primary → Secondary');

  // Secondary → Primary
  safeExecute(function() {
    syncDirection(
      CONFIG.SECONDARY_CALENDAR_ID,
      CONFIG.PRIMARY_CALENDAR_ID,
      CONFIG.PREFIX_FROM_SECONDARY,
      CONFIG.SYNC_TOKEN_SECONDARY,
      false
    );
  }, 'Secondary → Primary');

  logInfo('Bidirectional sync complete');
}

/**
 * Creates a 5-minute time-driven trigger for runSync. Removes existing triggers first.
 */
function setupTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('runSync')
    .timeBased()
    .everyMinutes(15)
    .create();
  logInfo('Created 15-minute trigger for runSync');
}

/**
 * Removes all triggers that call runSync.
 */
function removeTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runSync') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  logInfo('Removed existing runSync triggers');
}

/**
 * Clears sync tokens to force a full re-sync on the next run.
 */
function resetSyncTokens() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty(CONFIG.SYNC_TOKEN_PRIMARY);
  props.deleteProperty(CONFIG.SYNC_TOKEN_SECONDARY);
  logInfo('Sync tokens cleared - next run will do a full sync');
}

/**
 * One-time setup: creates the trigger and logs confirmation.
 * Run this manually from the Apps Script editor after filling in Config.gs.
 */
function initialSetup() {
  setupTrigger();
  logInfo('Initial setup complete. Sync will run every 15 minutes.');
  logInfo('Primary calendar: ' + CONFIG.PRIMARY_CALENDAR_ID);
  logInfo('Secondary calendar: ' + CONFIG.SECONDARY_CALENDAR_ID);
}
