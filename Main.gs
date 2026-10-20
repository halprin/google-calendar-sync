/**
 * Trigger entry point. Syncs events bidirectionally between primary and secondary calendars.
 *
 * The whole run is guarded by a script lock. Without one, a slow execution
 * could still be running when the next 15-minute trigger fired; both would
 * then see the same missing copy and both would insert it. That feedback loop
 * (more duplicates -> slower runs -> more overlap -> more duplicates) is how a
 * single mismatched event id turned into hundreds of copies.
 */
function runSync() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    logInfo('Another sync run is already in progress - exiting');
    return;
  }

  try {
    resetRunBudget();
    logInfo('Starting bidirectional sync');
    if (CONFIG.RECONCILE_DRY_RUN) {
      logInfo('RECONCILE_DRY_RUN is true - deletions will be logged but NOT applied');
    }

    // Primary → Secondary (details stripped)
    safeExecute(function() {
      syncDirection(
        CONFIG.PRIMARY_CALENDAR_ID,
        CONFIG.SECONDARY_CALENDAR_ID,
        CONFIG.PREFIX_FROM_PRIMARY,
        true
      );
    }, CONFIG.PRIMARY_CALENDAR_ID + ' → ' + CONFIG.SECONDARY_CALENDAR_ID);

    // Secondary → Primary (details preserved)
    safeExecute(function() {
      syncDirection(
        CONFIG.SECONDARY_CALENDAR_ID,
        CONFIG.PRIMARY_CALENDAR_ID,
        CONFIG.PREFIX_FROM_SECONDARY,
        false
      );
    }, CONFIG.SECONDARY_CALENDAR_ID + ' → ' + CONFIG.PRIMARY_CALENDAR_ID);

    var verb = CONFIG.RECONCILE_DRY_RUN ? 'would have deleted' : 'deleted';
    logInfo('Bidirectional sync complete in ' + elapsedSeconds().toFixed(1) + 's; ' +
      verb + ' ' + getDeleteCount() + ' copy/copies');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Creates a time-driven trigger for runSync. Removes existing triggers first.
 */
function setupTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('runSync')
    .timeBased()
    .everyMinutes(CONFIG.TRIGGER_MINUTES)
    .create();
  logInfo('Created ' + CONFIG.TRIGGER_MINUTES + '-minute trigger for runSync');
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
 * One-time cleanup of sync tokens left behind by older versions of this
 * script. Tokens are no longer used at all - the sliding 30-day window is
 * re-listed on every run, and the per-event dirty check keeps that cheap.
 */
function clearLegacySyncTokens() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('syncToken_primary');
  props.deleteProperty('syncToken_secondary');
  logInfo('Cleared legacy sync token properties (no longer used)');
}

/**
 * One-time setup: creates the trigger and logs confirmation.
 * Run this manually from the Apps Script editor after filling in Config.gs.
 */
function initialSetup() {
  setupTrigger();
  clearLegacySyncTokens();
  logInfo('Initial setup complete. Sync will run every ' + CONFIG.TRIGGER_MINUTES + ' minutes.');
  logInfo('Primary calendar: ' + CONFIG.PRIMARY_CALENDAR_ID);
  logInfo('Secondary calendar: ' + CONFIG.SECONDARY_CALENDAR_ID);
  logInfo('RECONCILE_DRY_RUN: ' + CONFIG.RECONCILE_DRY_RUN);
}
