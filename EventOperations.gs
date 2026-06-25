/**
 * Creates or updates a synced copy of the source event in the target calendar.
 */
function createOrUpdateSyncedCopy(sourceEvent, sourceCalendarId, targetCalendarId, options, syncedCopyMap) {
  var existingCopy = findSyncedCopy(sourceEvent.id, syncedCopyMap);
  var resource = buildSyncedEventResource(sourceEvent, sourceCalendarId, options);
  var label = 'source:' + sourceEvent.id + ' summary:' + (sourceEvent.summary || '(No title)');

  if (existingCopy) {
    logInfo((options.dryRun ? '[DRY RUN] Would update: ' : 'Updated: ') + label);
    if (!options.dryRun) Calendar.Events.update(resource, targetCalendarId, existingCopy.id, { conferenceDataVersion: 1 });
  } else {
    logInfo((options.dryRun ? '[DRY RUN] Would insert: ' : 'Created: ') + label);
    if (!options.dryRun) Calendar.Events.insert(resource, targetCalendarId, { conferenceDataVersion: 1 });
  }
}

/**
 * Finds an existing synced copy by looking for matching extended properties.
 */
function findSyncedCopy(sourceEventId, syncedCopyMap) {
  return syncedCopyMap[sourceEventId] || null;
}

/**
 * Builds the event resource object for the synced copy.
 */
function buildSyncedEventResource(sourceEvent, sourceCalendarId, options) {
  var resource = {
    summary: options.stripDetails
      ? CONFIG.STRIPPED_TITLE
      : options.prefix + (sourceEvent.summary || '(No title)'),
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

  resource.extendedProperties.private[CONFIG.EXT_PROP_SOURCE_CALENDAR_ID] = sourceCalendarId;
  resource.extendedProperties.private[CONFIG.EXT_PROP_SOURCE_EVENT_ID] = sourceEvent.id;

  if (!options.useDefaultColor) {
    resource.colorId = options.colorId;
  }

  var rsvpStatus = getRsvpStatus_(sourceEvent, sourceCalendarId);

  if (options.stripDetails) {
    if (rsvpStatus) {
      resource.description = rsvpStatus;
    }
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

    if (sourceEvent.conferenceData) {
      resource.conferenceData = sourceEvent.conferenceData;
    }
  }


  if (sourceEvent.transparency) {
    resource.transparency = sourceEvent.transparency;
  }

  return resource;
}

/**
 * Finds and deletes the synced copy of a cancelled/declined event.
 */
function handleDeletion(sourceEvent, sourceCalendarId, targetCalendarId, syncedCopyMap) {
  var sourceEventId = sourceEvent.id;
  var existingCopy = findSyncedCopy(sourceEventId, syncedCopyMap);

  if (existingCopy) {
    Calendar.Events.remove(targetCalendarId, existingCopy.id);
    logInfo('Deleted synced copy for: ' + sourceEventId);
  }
}

/**
 * Gets the RSVP status string for the authenticated user, if applicable.
 */
function getRsvpStatus_(event, sourceCalendarId) {
  if (!event.attendees) {
    return null;
  }

  var userEmail = getAuthenticatedUserEmail();
  for (var i = 0; i < event.attendees.length; i++) {
    var attendee = event.attendees[i];
    if (attendee.self || attendee.email === userEmail) {
      var status = attendee.responseStatus;
      if (status && status !== 'declined') {
        var label = status.charAt(0).toUpperCase() + status.slice(1);
        if (status === 'needsAction') {
          label = 'Needs Action';
        }
        return 'RSVP: ' + label;
      }
    }
  }
  return null;
}
