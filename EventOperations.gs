/**
 * Creates or updates a synced copy of the source event in the target calendar.
 *
 * Identity is carried by a *deterministic event id* derived from
 * (sourceCalendarId, sourceEventId) - see computeCopyId_. That matters because
 * the extended-property search used to find copies is not read-your-writes
 * consistent: a copy written moments ago may not come back from the next
 * query. Any design that answers "does this copy already exist?" purely from
 * that search will re-insert during the indexing gap, which is precisely how
 * duplicates pile up. With a deterministic id the target calendar itself
 * enforces uniqueness - a second insert collides instead of duplicating.
 *
 * `existingCopies` comes from the extended-property index and is still used,
 * but only to clean up legacy copies that were written with random ids by the
 * previous version of this script.
 */
function createOrUpdateSyncedCopy(sourceEvent, sourceCalendarId, targetCalendarId, prefix, stripDetails, existingCopies) {
  var copyId = computeCopyId_(sourceCalendarId, sourceEvent.id);
  var copies = existingCopies || [];
  var canonical = findById_(copies, copyId);
  var legacyCopies = filterLegacyCopies_(copies, copyId);

  // Fast path: the index already proves the canonical copy exists, so skip the
  // existence probe. Only fall back to a direct get when the index doesn't show
  // it - which is either a genuinely new event or the property-search indexing
  // gap. That keeps steady-state cost at O(pages) rather than O(events).
  if (!canonical) {
    canonical = getEventOrNull_(targetCalendarId, copyId);
  }

  if (canonical && canonical.status === 'cancelled') {
    // Events.get still returns recently-deleted events. Re-inserting at the
    // same id would collide, so revive it with an update instead.
    var revived = buildSyncedEventResource(sourceEvent, sourceCalendarId, prefix, stripDetails, copyId);
    updateSyncedCopy_(revived, targetCalendarId, copyId);
    logInfo('Revived previously deleted synced copy: ' + revived.summary);
    deleteLegacyCopies_(legacyCopies, targetCalendarId, sourceEvent.id);
    return;
  }

  if (canonical) {
    // Retire any random-id copies now that the canonical one exists.
    deleteLegacyCopies_(legacyCopies, targetCalendarId, sourceEvent.id);

    if (needsUpdate_(sourceEvent, canonical)) {
      var resource = buildSyncedEventResource(sourceEvent, sourceCalendarId, prefix, stripDetails, copyId);
      updateSyncedCopy_(resource, targetCalendarId, copyId);
      logInfo('Updated synced copy: ' + resource.summary);
    }
    return;
  }

  // No canonical copy yet.
  if (legacyCopies.length > 0) {
    // Migrating means deleting the legacy copies and inserting the canonical
    // one. Deletions are suppressed in dry-run mode, so migrating then would
    // leave both behind - exactly the duplicate we are trying to eliminate.
    // Keep maintaining the surviving legacy copy until deletes are enabled.
    if (CONFIG.RECONCILE_DRY_RUN) {
      var survivor = pickSurvivingCopy_(legacyCopies);
      if (legacyCopies.length > 1) {
        logInfo('DRY RUN - would collapse ' + legacyCopies.length +
          ' legacy copies of source ' + sourceEvent.id + ' into a canonical copy');
      }
      if (needsUpdate_(sourceEvent, survivor)) {
        var legacyResource = buildSyncedEventResource(
          sourceEvent, sourceCalendarId, prefix, stripDetails, survivor.id);
        updateSyncedCopy_(legacyResource, targetCalendarId, survivor.id);
        logInfo('Updated synced copy (legacy id): ' + legacyResource.summary);
      }
      return;
    }

    if (isOutOfTime() || isDeleteBudgetExhausted()) {
      // Try again next run rather than inserting alongside the legacy copies.
      return;
    }
    deleteLegacyCopies_(legacyCopies, targetCalendarId, sourceEvent.id);
  }

  var newResource = buildSyncedEventResource(sourceEvent, sourceCalendarId, prefix, stripDetails, copyId);
  if (insertSyncedCopy_(newResource, targetCalendarId, copyId)) {
    logInfo('Created synced copy: ' + newResource.summary);
  }
}

/**
 * Deterministic, collision-resistant event id for the copy of a given source
 * event. Calendar requires client-supplied ids to be base32hex (lowercase a-v
 * and digits 0-9) and 5-1024 characters, so the source ids - which contain
 * uppercase letters and underscores - cannot be used directly. Hashing both the
 * calendar id and the event id keeps the mapping stable across runs and keeps
 * the two sync directions from ever colliding with each other.
 */
function computeCopyId_(sourceCalendarId, sourceEventId) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    sourceCalendarId + '\u0000' + sourceEventId,
    Utilities.Charset.UTF_8);
  // 20 bytes -> 160 bits -> exactly 32 base32hex characters.
  return 'cs' + toBase32Hex_(digest, 32);
}

function toBase32Hex_(bytes, outputChars) {
  var alphabet = '0123456789abcdefghijklmnopqrstuv';
  var out = '';
  var buffer = 0;
  var bits = 0;
  var i = 0;

  while (out.length < outputChars) {
    if (bits < 5) {
      buffer = (buffer << 8) | (bytes[i++] & 0xff);
      bits += 8;
    }
    bits -= 5;
    out += alphabet.charAt((buffer >> bits) & 31);
    buffer &= (1 << bits) - 1;
  }
  return out;
}

/**
 * Copies pointing at this source that do NOT use the canonical id, i.e. copies
 * written by the previous version of the script.
 */
function filterLegacyCopies_(copies, canonicalId) {
  var legacy = [];
  for (var i = 0; i < copies.length; i++) {
    if (copies[i].id !== canonicalId) {
      legacy.push(copies[i]);
    }
  }
  return legacy;
}

function findById_(copies, id) {
  for (var i = 0; i < copies.length; i++) {
    if (copies[i].id === id) {
      return copies[i];
    }
  }
  return null;
}

function deleteLegacyCopies_(legacyCopies, targetCalendarId, sourceEventId) {
  if (legacyCopies.length === 0) {
    return;
  }
  if (legacyCopies.length > 1) {
    logInfo('Found ' + legacyCopies.length + ' legacy copies of source ' +
      sourceEventId + ' - collapsing');
  }
  for (var i = 0; i < legacyCopies.length; i++) {
    if (isOutOfTime() || isDeleteBudgetExhausted()) {
      return;
    }
    deleteSyncedCopy_(legacyCopies[i], targetCalendarId,
      'legacy/duplicate copy of source ' + sourceEventId);
  }
}

/**
 * Fetches an event by id, returning null when it does not exist. Any other
 * error is rethrown - treating e.g. a permission failure as "missing" would
 * trigger a pointless insert.
 */
function getEventOrNull_(calendarId, eventId) {
  try {
    return withRetry(function() {
      return Calendar.Events.get(calendarId, eventId);
    }, 'Events.get on ' + calendarId);
  } catch (e) {
    if (isNotFoundError_(e)) {
      return null;
    }
    throw e;
  }
}

function isNotFoundError_(error) {
  var message = (error && error.message) ? error.message.toLowerCase() : '';
  return message.indexOf('not found') !== -1 || message.indexOf('404') !== -1;
}

function isAlreadyExistsError_(error) {
  var message = (error && error.message) ? error.message.toLowerCase() : '';
  return message.indexOf('already exists') !== -1 ||
    message.indexOf('duplicate') !== -1 ||
    message.indexOf('409') !== -1;
}

/**
 * Chooses which of several duplicate copies to keep: the earliest created,
 * falling back to the lowest id so the choice is deterministic.
 */
function pickSurvivingCopy_(copies) {
  var survivor = copies[0];
  for (var i = 1; i < copies.length; i++) {
    var candidate = copies[i];
    var candidateKey = candidate.created || candidate.updated || '';
    var survivorKey = survivor.created || survivor.updated || '';

    if (candidateKey && survivorKey && candidateKey !== survivorKey) {
      if (candidateKey < survivorKey) {
        survivor = candidate;
      }
      continue;
    }
    if (candidate.id < survivor.id) {
      survivor = candidate;
    }
  }
  return survivor;
}

/**
 * True when the source event has been modified since we last wrote this copy,
 * or when the copy predates the sourceUpdated bookkeeping.
 */
function needsUpdate_(sourceEvent, copy) {
  if (!sourceEvent.updated) {
    // No timestamp to compare against - write to stay correct.
    return true;
  }
  if (!copy.extendedProperties || !copy.extendedProperties.private) {
    return true;
  }
  var recorded = copy.extendedProperties.private[CONFIG.EXT_PROP_SOURCE_UPDATED];
  if (!recorded) {
    return true;
  }
  return recorded !== sourceEvent.updated;
}

/**
 * Builds the event resource object for the synced copy.
 */
function buildSyncedEventResource(sourceEvent, sourceCalendarId, prefix, stripDetails, copyId) {
  var resource = {
    summary: stripDetails
      ? CONFIG.STRIPPED_TITLE
      : prefix + (sourceEvent.summary || '(No title)'),
    start: sourceEvent.start,
    end: sourceEvent.end,
    extendedProperties: {
      private: {}
    },
    reminders: {
      useDefault: false,
      overrides: []
    }
  };

  if (copyId) {
    resource.id = copyId;
  }

  resource.extendedProperties.private[CONFIG.EXT_PROP_SOURCE_CALENDAR_ID] = sourceCalendarId;
  resource.extendedProperties.private[CONFIG.EXT_PROP_SOURCE_EVENT_ID] = sourceEvent.id;
  if (sourceEvent.updated) {
    resource.extendedProperties.private[CONFIG.EXT_PROP_SOURCE_UPDATED] = sourceEvent.updated;
  }

  var rsvpStatus = getRsvpStatus_(sourceEvent, sourceCalendarId);

  if (stripDetails) {
    if (rsvpStatus) {
      resource.description = rsvpStatus;
    }
    // Nothing else is copied: no description, no location, and no
    // conferenceData. An obfuscated copy must never expose a way to join the
    // meeting. This is a privacy boundary rather than a preference, so it is
    // enforced structurally - the conferenceData assignment below simply
    // cannot be reached when stripping - instead of by a config flag that
    // could be flipped or a condition that could be refactored wrong.
  } else {
    var description = sourceEvent.description || '';
    if (rsvpStatus) {
      description = description ? description + '\n\n' + rsvpStatus : rsvpStatus;
    }
    if (description) {
      resource.description = description;
    }

    if (sourceEvent.location) {
      resource.location = sourceEvent.location;
    }

    // Conference/meeting details (Google Meet, Zoom, Webex, ...). For Google
    // Meet events the join link exists ONLY here, not in `location`, so this is
    // the only way a detail-preserving copy becomes joinable.
    //
    // Google's docs warn that reusing conference data across events can expose
    // a meeting to unintended users. That warning is about inviting other
    // people to a borrowed conference; here both events belong to the same
    // person, and mirroring the join link is the point.
    var conference = sanitizeConferenceData_(sourceEvent.conferenceData);
    if (conference) {
      resource.conferenceData = conference;
    }
  }

  if (sourceEvent.transparency) {
    resource.transparency = sourceEvent.transparency;
  }

  // `recurrence` is intentionally NOT copied. Source series are always read as
  // expanded instances, so each instance is written as its own standalone
  // event. Copying the RRULE instead would mean replicating EXDATEs, modified
  // instances, and per-instance RSVP state, none of which this script tracks.

  return resource;
}

/**
 * Prepares a source event's conferenceData for writing onto the copy.
 *
 * Two fields must be stripped:
 *
 *  - `createRequest` instructs the API to CREATE A NEW conference. Passing it
 *    through would mint a fresh Meet room on the copy with a different join
 *    link, so the two calendar entries would point at different meetings.
 *  - `signature` authenticates the conference for the event it was issued on;
 *    carrying a stale one to a different event risks rejection.
 *
 * Everything that actually describes how to join - entryPoints (video URI,
 * phone numbers, PIN, passcode), conferenceSolution, conferenceId, and notes -
 * is preserved verbatim.
 *
 * Returns null when there is nothing joinable to copy, so the caller omits the
 * field rather than writing an empty object.
 */
function sanitizeConferenceData_(conferenceData) {
  if (!conferenceData) {
    return null;
  }

  var copy = {};
  var preserved = ['entryPoints', 'conferenceSolution', 'conferenceId', 'notes'];
  for (var i = 0; i < preserved.length; i++) {
    var key = preserved[i];
    if (conferenceData[key] !== undefined && conferenceData[key] !== null) {
      copy[key] = conferenceData[key];
    }
  }

  // Without an entry point or a solution there is nothing to join, and the API
  // rejects a conferenceData object that carries neither.
  var hasEntryPoints = !!(copy.entryPoints && copy.entryPoints.length);
  if (!hasEntryPoints && !copy.conferenceSolution) {
    return null;
  }

  return copy;
}

/**
 * Removes every synced copy of a cancelled or declined source event.
 *
 * Takes the whole index rather than a single id so that cancelling an entire
 * recurring series also clears the per-instance copies. A cancelled series
 * arrives as one master id ("abc"), which matches none of the instance-keyed
 * copies ("abc_20261013"); matching on the base-id prefix is the fallback the
 * old code's comment promised but never implemented.
 */
function handleDeletion(sourceEventId, targetCalendarId, index) {
  var matches = collectCopiesForSource_(sourceEventId, index);

  if (matches.length === 0) {
    return;
  }

  for (var i = 0; i < matches.length; i++) {
    if (isOutOfTime() || isDeleteBudgetExhausted()) {
      return;
    }
    deleteSyncedCopy_(matches[i], targetCalendarId,
      'source cancelled/declined ' + sourceEventId);
  }
}

/**
 * Returns copies keyed by exactly sourceEventId, plus - only when sourceEventId
 * is a bare recurring master - copies of any of its instances.
 *
 * The prefix expansion is deliberately limited to bare master ids. Expanding it
 * for an id that already carries a suffix would be destructive: a single
 * cancelled instance "abc_20261013" would reduce to base "abc" and match every
 * sibling instance "abc_*", deleting copies of occurrences that are still live.
 * The same trap applies to split-series masters like "abc_R20261013". Because
 * sources are always listed with singleEvents: true, a whole-series deletion
 * shows up as its instances disappearing from the window, which the orphan
 * sweep already handles correctly; this branch is just a defensive fallback.
 */
function collectCopiesForSource_(sourceEventId, index) {
  var matches = [];

  if (index[sourceEventId]) {
    matches = matches.concat(index[sourceEventId]);
  }

  if (!isBareMasterId_(sourceEventId)) {
    return matches;
  }

  var instancePrefix = sourceEventId + '_';
  var keys = Object.keys(index);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (key === sourceEventId) {
      continue;
    }
    if (key.indexOf(instancePrefix) === 0) {
      matches = matches.concat(index[key]);
    }
  }

  return matches;
}

/**
 * True when the id carries no instance or split suffix, i.e. it is a recurring
 * series master rather than one occurrence of it. Instance ids look like
 * "abc_20261013T193000Z" or "abc_20261013"; split masters like "abc_R20261013".
 *
 * Note that some Google-generated ids are themselves underscore-prefixed
 * (e.g. "_6p13edq16sp38ba..."), so a leading underscore must not be read as a
 * separator.
 */
function isBareMasterId_(eventId) {
  return eventId.indexOf('_', 1) === -1;
}

// ---------------------------------------------------------------------------
// Write wrappers
//
// Every destructive operation funnels through deleteSyncedCopy_ so the dry-run
// switch and the delete budget cannot be bypassed.
// ---------------------------------------------------------------------------

/**
 * Inserts a copy at a caller-chosen id. Returns true when the event was
 * created, false when it already existed.
 *
 * A collision here is the safety net for the extended-property indexing gap:
 * if a previous run already created this copy but the property search hasn't
 * caught up, the API rejects the duplicate instead of silently creating a
 * second event.
 *
 * `conferenceDataVersion: 1` is required for conferenceData to be written at
 * all - at version 0 (the default) the API silently DISCARDS the field, so
 * omitting it would drop every Meet/Zoom link without any error to notice.
 */
function insertSyncedCopy_(resource, targetCalendarId, copyId) {
  try {
    writeWithConferenceFallback_(
      function(options) {
        return Calendar.Events.insert(resource, targetCalendarId, options);
      },
      resource,
      'Events.insert on ' + targetCalendarId);
    return true;
  } catch (e) {
    if (isAlreadyExistsError_(e)) {
      logInfo('Copy ' + copyId + ' already exists on ' + targetCalendarId +
        ' - treating as created');
      return false;
    }
    throw e;
  }
}

function updateSyncedCopy_(resource, targetCalendarId, eventId) {
  writeWithConferenceFallback_(
    function(options) {
      return Calendar.Events.update(resource, targetCalendarId, eventId, options);
    },
    resource,
    'Events.update on ' + targetCalendarId);
}

/**
 * Performs a write with conferenceDataVersion: 1, and if the API rejects the
 * conference payload specifically, retries once without it.
 *
 * The old code attached conferenceData unconditionally and let any rejection be
 * swallowed by the per-event safeExecute, which meant a bad conference object
 * caused the whole event to never sync - silently. Degrading to an event with
 * no join link is bad; losing the event entirely is worse.
 */
function writeWithConferenceFallback_(writeFn, resource, context) {
  try {
    return withRetry(function() {
      return writeFn({ conferenceDataVersion: 1 });
    }, context);
  } catch (e) {
    if (!resource.conferenceData || !isConferenceRejection_(e)) {
      throw e;
    }
    logError('Conference data rejected for "' + resource.summary +
      '" - retrying without the join link', e);
    delete resource.conferenceData;
    return withRetry(function() {
      return writeFn({ conferenceDataVersion: 1 });
    }, context + ' (no conference)');
  }
}

/**
 * True when an error looks like the API objecting to the conference payload
 * rather than to something else about the request.
 */
function isConferenceRejection_(error) {
  var message = (error && error.message) ? error.message.toLowerCase() : '';

  // An id collision is a different condition entirely and must not be treated
  // as a conference problem, or the retry would drop the join link and then
  // collide again anyway.
  if (isAlreadyExistsError_(error)) {
    return false;
  }
  if (message.indexOf('conference') !== -1) {
    return true;
  }
  // Generic 400s on these writes are nearly always the conference block, since
  // every other field we send is copied verbatim from an event the API already
  // accepted.
  return message.indexOf('400') !== -1 ||
    message.indexOf('invalid value') !== -1 ||
    message.indexOf('bad request') !== -1;
}

/**
 * Deletes a synced copy, honouring CONFIG.RECONCILE_DRY_RUN.
 */
function deleteSyncedCopy_(copy, targetCalendarId, reason) {
  var label = describeCopy_(copy) + ' (' + reason + ')';

  if (CONFIG.RECONCILE_DRY_RUN) {
    recordDelete_();
    logInfo('DRY RUN - would delete ' + label);
    return;
  }

  var ok = safeExecute(function() {
    withRetry(function() {
      return Calendar.Events.remove(targetCalendarId, copy.id);
    }, 'Events.remove on ' + targetCalendarId);
  }, 'Deleting ' + label);

  if (ok) {
    recordDelete_();
    logInfo('Deleted ' + label);
  }
}

/**
 * Human-readable one-liner for logs, so a dry run is reviewable.
 */
function describeCopy_(copy) {
  var when = 'unknown time';
  if (copy.start) {
    when = copy.start.dateTime || copy.start.date || when;
  }
  return 'copy id=' + copy.id +
    ' title="' + (copy.summary || '(no title)') + '"' +
    ' start=' + when;
}

/**
 * Gets the RSVP status string for the source calendar's owner, if applicable.
 */
function getRsvpStatus_(event, sourceCalendarId) {
  var attendee = findRelevantAttendee_(event, sourceCalendarId);
  if (!attendee) {
    return null;
  }

  var status = attendee.responseStatus;
  if (!status || status === 'declined') {
    return null;
  }

  var label = status.charAt(0).toUpperCase() + status.slice(1);
  if (status === 'needsAction') {
    label = 'Needs Action';
  }
  return 'RSVP: ' + label;
}
