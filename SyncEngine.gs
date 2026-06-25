/**
 * Syncs events from sourceCalendar to targetCalendar.
 * Uses incremental sync tokens when available, falls back to full sync.
 */
function syncDirection(sourceCalendarId, targetCalendarId, syncTokenKey, options) {
  logInfo('Syncing: ' + sourceCalendarId + ' → ' + targetCalendarId);

  var props = PropertiesService.getScriptProperties();
  var syncToken = props.getProperty(syncTokenKey);
  var events = [];
  var pageToken = null;
  var newSyncToken = null;

  try {
    do {
      var listOptions = buildListOptions_(syncToken, pageToken);
      var response = Calendar.Events.list(sourceCalendarId, listOptions);

      if (response.items) {
        events = events.concat(response.items);
      }
      pageToken = response.nextPageToken;
      if (response.nextSyncToken) {
        newSyncToken = response.nextSyncToken;
      }
    } while (pageToken);
  } catch (e) {
    if (e.message && e.message.indexOf('410') !== -1) {
      logInfo('Sync token expired (410 Gone), falling back to full sync');
      props.deleteProperty(syncTokenKey);
      syncDirection(sourceCalendarId, targetCalendarId, syncTokenKey, options);
      return;
    }
    throw e;
  }

  if (newSyncToken) {
    props.setProperty(syncTokenKey, newSyncToken);
  }

  logInfo('Fetched ' + events.length + ' event(s) to process');

  if (options.maxEvents) {
    events = events.slice(0, options.maxEvents);
  }

  var syncedCopyMap = buildSyncedCopyMap_(targetCalendarId);

  for (var i = 0; i < events.length; i++) {
    if (!events[i]) continue;
    (function(event) {
      safeExecute(function() {
        processEvent_(event, sourceCalendarId, targetCalendarId, options, syncedCopyMap);
      }, 'Processing event: ' + (event.summary || event.id));
    })(events[i]);
  }
}

/**
 * Fetches all events in the target calendar for the sync window and builds a map
 * of sourceEventId -> copy event. Avoids per-event API lookups which are unreliable
 * on some Google Workspace domains (e.g. GSA) due to privateExtendedProperty indexing.
 */
function buildSyncedCopyMap_(targetCalendarId) {
  var map = {};
  var now = new Date();
  var maxDate = new Date(now.getTime() + CONFIG.FULL_SYNC_DAYS * 24 * 60 * 60 * 1000);
  var pageToken = null;

  do {
    var options = {
      timeMin: now.toISOString(),
      timeMax: maxDate.toISOString(),
      singleEvents: true,
      showDeleted: false,
      maxResults: 250
    };
    if (pageToken) options.pageToken = pageToken;

    var response = Calendar.Events.list(targetCalendarId, options);
    var items = response.items || [];

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.extendedProperties &&
          item.extendedProperties.private &&
          item.extendedProperties.private[CONFIG.EXT_PROP_SOURCE_EVENT_ID]) {
        var sourceId = item.extendedProperties.private[CONFIG.EXT_PROP_SOURCE_EVENT_ID];
        map[sourceId] = item;
      }
    }

    pageToken = response.nextPageToken;
  } while (pageToken);

  logInfo('Built synced copy map with ' + Object.keys(map).length + ' entries');
  return map;
}

/**
 * Builds the options object for Calendar.Events.list.
 */
function buildListOptions_(syncToken, pageToken) {
  var options = {};

  if (syncToken) {
    // Incremental sync
    options.syncToken = syncToken;
    options.showDeleted = true;
  } else {
    // Full sync - future events within configured window
    var now = new Date();
    var maxDate = new Date(now.getTime() + CONFIG.FULL_SYNC_DAYS * 24 * 60 * 60 * 1000);
    options.timeMin = now.toISOString();
    options.timeMax = maxDate.toISOString();
    options.singleEvents = true;
    options.showDeleted = true;
    options.orderBy = 'startTime';
  }

  if (pageToken) {
    options.pageToken = pageToken;
  }

  options.maxResults = 250;
  return options;
}

/**
 * Processes a single event: skip synced copies, delete or create/update as needed.
 */
function processEvent_(event, sourceCalendarId, targetCalendarId, options, syncedCopyMap) {
  if (event.eventType === 'workingLocation') {
    return;
  }

  if (isSyncedCopy(event)) {
    return;
  }

  var shouldDelete = event.status === 'cancelled' || isDeclined(event, sourceCalendarId);

  if (shouldDelete) {
    handleDeletion(event, sourceCalendarId, targetCalendarId, syncedCopyMap);
  } else {
    createOrUpdateSyncedCopy(event, sourceCalendarId, targetCalendarId, options, syncedCopyMap);
  }
}

/**
 * Returns true if the event is a synced copy (has sourceCalendarId extended property).
 */
function isSyncedCopy(event) {
  return event.extendedProperties &&
    event.extendedProperties.private &&
    event.extendedProperties.private[CONFIG.EXT_PROP_SOURCE_CALENDAR_ID];
}

/**
 * Returns true if the authenticated user has declined this event.
 */
function isDeclined(event, sourceCalendarId) {
  if (!event.attendees) {
    return false;
  }

  var userEmail = getAuthenticatedUserEmail();
  for (var i = 0; i < event.attendees.length; i++) {
    var attendee = event.attendees[i];
    if (attendee.self || attendee.email === userEmail) {
      return attendee.responseStatus === 'declined';
    }
  }
  return false;
}
