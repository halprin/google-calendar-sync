/**
 * Syncs events from sourceCalendar to targetCalendar.
 * Uses incremental sync tokens when available, falls back to full sync.
 */
function syncDirection(sourceCalendarId, targetCalendarId, prefix, syncTokenKey, stripDetails) {
  logInfo('Syncing: ' + sourceCalendarId + ' → ' + targetCalendarId);

  var props = PropertiesService.getScriptProperties();
  var syncToken = props.getProperty(syncTokenKey);
  var events = [];
  var pageToken = null;
  var newSyncToken = null;

  try {
    do {
      var options = buildListOptions_(syncToken, pageToken);
      var response = Calendar.Events.list(sourceCalendarId, options);

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
      syncDirection(sourceCalendarId, targetCalendarId, prefix, syncTokenKey, stripDetails);
      return;
    }
    throw e;
  }

  if (newSyncToken) {
    props.setProperty(syncTokenKey, newSyncToken);
  }

  logInfo('Fetched ' + events.length + ' event(s) to process');

  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    safeExecute(function() {
      processEvent_(event, sourceCalendarId, targetCalendarId, prefix, stripDetails);
    }, 'Processing event: ' + (event.summary || event.id));
  }
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
function processEvent_(event, sourceCalendarId, targetCalendarId, prefix, stripDetails) {
  if (isSyncedCopy(event)) {
    return;
  }

  var shouldDelete = event.status === 'cancelled' || isDeclined(event, sourceCalendarId);

  if (shouldDelete) {
    handleDeletion(event, sourceCalendarId, targetCalendarId);
  } else {
    createOrUpdateSyncedCopy(event, sourceCalendarId, targetCalendarId, prefix, stripDetails);
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
