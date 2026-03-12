/**
 * Creates or updates a synced copy of the source event in the target calendar.
 */
function createOrUpdateSyncedCopy(sourceEvent, sourceCalendarId, targetCalendarId, prefix, stripDetails) {
  var existingCopy = findSyncedCopy(sourceEvent.id, sourceCalendarId, targetCalendarId);
  var resource = buildSyncedEventResource(sourceEvent, sourceCalendarId, prefix, stripDetails);

  if (existingCopy) {
    Calendar.Events.update(resource, targetCalendarId, existingCopy.id, {
      conferenceDataVersion: 1
    });
    logInfo('Updated synced copy: ' + resource.summary);
  } else {
    Calendar.Events.insert(resource, targetCalendarId, {
      conferenceDataVersion: 1
    });
    logInfo('Created synced copy: ' + resource.summary);
  }
}

/**
 * Finds an existing synced copy by looking for matching extended properties.
 */
function findSyncedCopy(sourceEventId, sourceCalendarId, targetCalendarId) {
  var response = Calendar.Events.list(targetCalendarId, {
    privateExtendedProperty: [
      CONFIG.EXT_PROP_SOURCE_CALENDAR_ID + '=' + sourceCalendarId,
      CONFIG.EXT_PROP_SOURCE_EVENT_ID + '=' + sourceEventId
    ],
    showDeleted: false,
    maxResults: 1
  });

  if (response.items && response.items.length > 0) {
    return response.items[0];
  }
  return null;
}

/**
 * Builds the event resource object for the synced copy.
 */
function buildSyncedEventResource(sourceEvent, sourceCalendarId, prefix, stripDetails) {
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

  resource.extendedProperties.private[CONFIG.EXT_PROP_SOURCE_CALENDAR_ID] = sourceCalendarId;
  resource.extendedProperties.private[CONFIG.EXT_PROP_SOURCE_EVENT_ID] = sourceEvent.id;

  var rsvpStatus = getRsvpStatus_(sourceEvent, sourceCalendarId);

  if (stripDetails) {
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
function handleDeletion(sourceEvent, sourceCalendarId, targetCalendarId) {
  var sourceEventId = sourceEvent.id;
  // For cancelled events, the id may have @google.com suffix stripped; use recurringEventId + originalStartTime if available
  var existingCopy = findSyncedCopy(sourceEventId, sourceCalendarId, targetCalendarId);

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
