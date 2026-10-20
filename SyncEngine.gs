/**
 * Syncs events from sourceCalendar to targetCalendar.
 *
 * Both the source listing and the dedupe key use *expanded instances*
 * (singleEvents: true), always. The previous implementation used
 * singleEvents: true on the full-sync path and left it defaulted to false on
 * the incremental path, so the same recurring series was keyed by instance ID
 * ("abc_20261013") on one path and by master ID ("abc_R20261013") on the other.
 * Those never matched, so every mode flip re-inserted copies that already
 * existed and nothing ever reconciled them. Keeping exactly one query shape is
 * what makes `sourceEventId` a stable identity.
 *
 * Sync tokens are deliberately not used. A token's restrictions are baked in
 * server-side, so mixing token state with a sliding time window is what made
 * the old code fragile, and the 410-expiry recovery never fired anyway because
 * it string-matched on "410" against a message that doesn't contain it. A
 * 30-day windowed list is cheap, and the per-event dirty check below means the
 * steady-state cost is 3 list calls per direction and no writes.
 */
function syncDirection(sourceCalendarId, targetCalendarId, prefix, stripDetails) {
  logInfo('Syncing: ' + sourceCalendarId + ' → ' + targetCalendarId);

  var window = getSyncWindow_();

  var listing = listSourceEvents_(sourceCalendarId, window);
  if (!listing.complete) {
    // A partial listing must never drive the orphan sweep: an empty or
    // truncated "desired" set would look exactly like "the user deleted
    // everything" and would wipe out live copies.
    logInfo('Source listing incomplete - skipping reconciliation for this direction');
  }

  logInfo('Fetched ' + listing.events.length + ' source event(s) in window');

  var desired = {};
  var toDelete = [];

  for (var i = 0; i < listing.events.length; i++) {
    var event = listing.events[i];

    if (isSyncedCopy(event)) {
      // Our own copy echoed back from the other direction.
      continue;
    }
    if (!event.id) {
      continue;
    }

    if (event.status === 'cancelled' || isDeclined(event, sourceCalendarId)) {
      toDelete.push(event.id);
      continue;
    }
    if (!event.start || !event.end) {
      // Defensive: an event with no times cannot be written as a copy.
      logInfo('Skipping source event with no start/end: ' + event.id);
      continue;
    }

    desired[event.id] = event;
  }

  var indexing = buildSyncedCopyIndex_(sourceCalendarId, targetCalendarId, window);
  var index = indexing.index;
  if (!indexing.complete) {
    logInfo('Copy index incomplete - skipping reconciliation for this direction');
  }

  // 1. Create/update the copies that should exist.
  var sourceIds = Object.keys(desired);
  for (var j = 0; j < sourceIds.length; j++) {
    if (isOutOfTime()) {
      break;
    }
    syncOneEvent_(
      desired[sourceIds[j]],
      sourceCalendarId,
      targetCalendarId,
      prefix,
      stripDetails,
      index[sourceIds[j]] || []
    );
  }

  // 2. Remove copies for events the source explicitly cancelled or declined.
  for (var k = 0; k < toDelete.length; k++) {
    if (isOutOfTime()) {
      break;
    }
    deleteOneSource_(toDelete[k], targetCalendarId, index);
  }

  // 3. Sweep orphans: copies whose source no longer exists in the window.
  //    Requires BOTH listings to be complete - a partial view of either side
  //    makes "this copy has no source" an unsafe conclusion.
  if (listing.complete && indexing.complete) {
    reconcileOrphans_(desired, toDelete, index, targetCalendarId, sourceCalendarId);
  }
}

/**
 * Per-event wrapper so one bad event cannot abort the whole direction.
 * Kept as a named function rather than a closure inside the loop so the
 * captured values can't drift if the loop is ever refactored.
 */
function syncOneEvent_(sourceEvent, sourceCalendarId, targetCalendarId, prefix, stripDetails, existingCopies) {
  safeExecute(function() {
    createOrUpdateSyncedCopy(
      sourceEvent,
      sourceCalendarId,
      targetCalendarId,
      prefix,
      stripDetails,
      existingCopies
    );
  }, 'Processing event: ' + (sourceEvent.summary || sourceEvent.id));
}

function deleteOneSource_(sourceEventId, targetCalendarId, index) {
  safeExecute(function() {
    handleDeletion(sourceEventId, targetCalendarId, index);
  }, 'Deleting copies of: ' + sourceEventId);
}

/**
 * Returns the {timeMin, timeMax} ISO strings bounding everything this script
 * will look at. Nothing outside this window is read, written, or deleted.
 */
function getSyncWindow_() {
  var now = new Date();
  var maxDate = new Date(now.getTime() + CONFIG.SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return {
    timeMin: now.toISOString(),
    timeMax: maxDate.toISOString()
  };
}

/**
 * Lists source events in the window, expanding recurring series into
 * instances. Returns {events, complete}; `complete` is false if any page
 * failed or the runtime budget ran out mid-pagination.
 */
function listSourceEvents_(sourceCalendarId, window) {
  var events = [];
  var pageToken = null;

  do {
    if (isOutOfTime()) {
      return { events: events, complete: false };
    }

    var options = {
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      singleEvents: true,
      showDeleted: true,
      orderBy: 'startTime',
      maxResults: 250
    };
    if (pageToken) {
      options.pageToken = pageToken;
    }

    var response;
    try {
      response = withRetry(function() {
        return Calendar.Events.list(sourceCalendarId, options);
      }, 'Events.list on ' + sourceCalendarId);
    } catch (e) {
      logError('Failed listing source events on ' + sourceCalendarId, e);
      return { events: events, complete: false };
    }

    if (response.items) {
      events = events.concat(response.items);
    }
    pageToken = response.nextPageToken;
  } while (pageToken);

  return { events: events, complete: true };
}

/**
 * Builds sourceEventId -> [copy, ...] for every synced copy on the target
 * calendar that originated from sourceCalendarId.
 *
 * This replaces the old per-event `findSyncedCopy` lookup, which issued one
 * Events.list call for every single source event and capped itself at
 * maxResults: 1 - so once duplicates existed, it would only ever see one of
 * them and the rest became permanently invisible. Reading the whole set up
 * front makes duplicates detectable (any entry with length > 1) and cuts the
 * API calls from O(events) to O(pages).
 */
/**
 * Builds sourceEventId -> [copy, ...] for every synced copy on the target
 * calendar that originated from sourceCalendarId.
 *
 * This replaces the old per-event `findSyncedCopy` lookup, which issued one
 * Events.list call for every single source event and capped itself at
 * maxResults: 1 - so once duplicates existed, it would only ever see one of
 * them and the rest became permanently invisible. Reading the whole set up
 * front makes duplicates detectable and cuts the API calls from O(events) to
 * O(pages).
 *
 * Note that this search is NOT read-your-writes consistent, so the index is
 * only ever used for cleanup decisions, never to decide whether a copy needs
 * creating - that is the deterministic-id check in createOrUpdateSyncedCopy.
 *
 * Returns {index, complete}; `complete` is false when a page failed, which
 * suppresses the orphan sweep rather than risking deletion of live copies that
 * merely failed to load.
 */
function buildSyncedCopyIndex_(sourceCalendarId, targetCalendarId, window) {
  var index = {};
  var pageToken = null;

  do {
    var options = {
      privateExtendedProperty: [
        CONFIG.EXT_PROP_SOURCE_CALENDAR_ID + '=' + sourceCalendarId
      ],
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      singleEvents: true,
      showDeleted: false,
      maxResults: 250
    };
    if (pageToken) {
      options.pageToken = pageToken;
    }

    var response;
    try {
      response = withRetry(function() {
        return Calendar.Events.list(targetCalendarId, options);
      }, 'Events.list copies on ' + targetCalendarId);
    } catch (e) {
      logError('Failed indexing synced copies on ' + targetCalendarId, e);
      return { index: index, complete: false };
    }

    var items = response.items || [];
    for (var i = 0; i < items.length; i++) {
      var copy = items[i];
      var sourceEventId = getCopySourceEventId_(copy);
      if (!sourceEventId) {
        continue;
      }
      if (!index[sourceEventId]) {
        index[sourceEventId] = [];
      }
      index[sourceEventId].push(copy);
    }

    pageToken = response.nextPageToken;
  } while (pageToken);

  return { index: index, complete: true };
}

/**
 * Deletes copies in the index whose source event is no longer present. This is
 * what finally converges the calendar after a missed cancellation, a series
 * deletion, or the legacy master-vs-instance key bug (copies keyed
 * "abc_R20261013" can never match an expanded instance id, so they land here).
 *
 * Scoped to the sync window on purpose: outside it we have no source listing,
 * so "not in desired" would be meaningless and deleting would be destructive.
 *
 * Every candidate is additionally confirmed against the source calendar with a
 * direct get before anything is deleted. Absence from a list response is weaker
 * evidence than it looks - an event that merely moved, or a listing that
 * silently returned less than it should, would otherwise be read as "deleted".
 * This is the one place the script destroys data it did not just create, so it
 * pays for the extra call.
 */
function reconcileOrphans_(desired, cancelledIds, index, targetCalendarId, sourceCalendarId) {
  var cancelled = {};
  for (var c = 0; c < cancelledIds.length; c++) {
    cancelled[cancelledIds[c]] = true;
  }

  var candidateIds = [];
  var indexedIds = Object.keys(index);
  for (var i = 0; i < indexedIds.length; i++) {
    var sourceEventId = indexedIds[i];
    if (desired[sourceEventId] || cancelled[sourceEventId]) {
      // Still wanted, or already handled by the cancellation pass.
      continue;
    }
    candidateIds.push(sourceEventId);
  }

  if (candidateIds.length === 0) {
    return;
  }

  var candidateCopies = 0;
  for (var j = 0; j < candidateIds.length; j++) {
    candidateCopies += index[candidateIds[j]].length;
  }

  logInfo('Reconciliation: ' + candidateIds.length + ' candidate orphan source id(s), ' +
    candidateCopies + ' copy/copies on ' + targetCalendarId);

  for (var k = 0; k < candidateIds.length; k++) {
    if (isOutOfTime() || isDeleteBudgetExhausted()) {
      break;
    }
    var orphanId = candidateIds[k];

    if (!confirmSourceGone_(sourceCalendarId, orphanId)) {
      logInfo('Keeping copies of ' + orphanId +
        ' - source still exists on ' + sourceCalendarId);
      continue;
    }

    var copies = index[orphanId];
    for (var m = 0; m < copies.length; m++) {
      if (isOutOfTime() || isDeleteBudgetExhausted()) {
        break;
      }
      deleteSyncedCopy_(copies[m], targetCalendarId, 'orphaned source ' + orphanId);
    }
  }
}

/**
 * True only when the source event is provably gone or cancelled. Any error
 * other than a definitive 404 returns false, so uncertainty never results in
 * deletion.
 */
function confirmSourceGone_(sourceCalendarId, sourceEventId) {
  try {
    var event = withRetry(function() {
      return Calendar.Events.get(sourceCalendarId, sourceEventId);
    }, 'Events.get source ' + sourceEventId);
    return !event || event.status === 'cancelled';
  } catch (e) {
    if (isNotFoundError_(e)) {
      return true;
    }
    logError('Could not verify source ' + sourceEventId + ' - keeping its copies', e);
    return false;
  }
}

/**
 * Returns true if the event is a synced copy (has sourceCalendarId extended property).
 */
function isSyncedCopy(event) {
  return !!(event.extendedProperties &&
    event.extendedProperties.private &&
    event.extendedProperties.private[CONFIG.EXT_PROP_SOURCE_CALENDAR_ID]);
}

/**
 * Reads the source event id recorded on a synced copy, if any.
 */
function getCopySourceEventId_(copy) {
  if (!copy.extendedProperties || !copy.extendedProperties.private) {
    return null;
  }
  return copy.extendedProperties.private[CONFIG.EXT_PROP_SOURCE_EVENT_ID] || null;
}

/**
 * Returns the attendee entry corresponding to the owner of sourceCalendarId,
 * falling back to the authenticated user.
 *
 * The previous version took sourceCalendarId and never used it, comparing only
 * against Session.getEffectiveUser(). The README explicitly allows the primary
 * calendar to belong to someone other than the script owner, so for that
 * calendar neither `self` nor the effective-user email identifies the right
 * attendee. It also returned on the first attendee that matched either test,
 * which short-circuited the scan when a `self` entry wasn't the user.
 */
function findRelevantAttendee_(event, sourceCalendarId) {
  if (!event.attendees || !event.attendees.length) {
    return null;
  }

  var calendarOwner = (sourceCalendarId || '').toLowerCase();
  var userEmail = (getAuthenticatedUserEmail() || '').toLowerCase();
  var selfMatch = null;
  var userMatch = null;

  for (var i = 0; i < event.attendees.length; i++) {
    var attendee = event.attendees[i];
    var email = (attendee.email || '').toLowerCase();

    // Best match: the attendee who *is* the calendar we are reading.
    if (calendarOwner && email === calendarOwner) {
      return attendee;
    }
    if (!userMatch && userEmail && email === userEmail) {
      userMatch = attendee;
    }
    if (!selfMatch && attendee.self) {
      selfMatch = attendee;
    }
  }

  return userMatch || selfMatch;
}

/**
 * Returns true if the owner of the source calendar has declined this event.
 */
function isDeclined(event, sourceCalendarId) {
  var attendee = findRelevantAttendee_(event, sourceCalendarId);
  return !!(attendee && attendee.responseStatus === 'declined');
}
