# google-calendar-sync

Sync Google calendar events.

## Setup

### 1. Create a New Google Apps Script Project

Go to [script.google.com](https://script.google.com) and create a new project.

### 2. Add the Google Calendar Service

In the Apps Script editor, click the "+" next to "Services" in the left sidebar. Select "Google Calendar API" and click "Add". No need to change any of the settings.

### 3. Copy Files

Copy all of the `.gs` files from this repository into the project.

### 4. Configure

In `Config.gs`, set `PRIMARY_CALENDAR_ID` and `SECONDARY_CALENDAR_ID` to your actual Google Calendar IDs (generally they are your email addresses). Optionally, the other fields can be updated.

#### Choosing Primary vs Secondary

The primary calendar does _not_ need to be the account that owns the Apps Script project. Choose based on how much detail you want each calendar to receive.

- The primary calendar receives most details from secondary calendar events.
- The secondary calendar receives obfuscated events: just the `STRIPPED_TITLE` value in [`Config.gs`](Config.gs) (defaults to "Sync: Meeting") as the event name, plus your RSVP status (accepted, maybe, or needs action).

#### Other settings

| Key | Purpose |
| --- | --- |
| `SYNC_WINDOW_DAYS` | How far ahead to sync (default 30). Recurring series are expanded into individual instances, so this also bounds how far out instances are created. Copies outside this window are never touched. |
| `TRIGGER_MINUTES` | How often the sync runs. Must be 1, 5, 10, 15, or 30. |
| `RECONCILE_DRY_RUN` | **Starts as `true`.** While true, the script reports the copies it would delete but deletes nothing. See [Cleaning up Duplicates](#cleaning-up-duplicates). |
| `MAX_DELETES_PER_RUN` | Caps deletions per execution (default 150) so a large backlog can't blow the Apps Script quota or runtime limit. Remaining deletions happen on later runs. |
| `MAX_RUNTIME_SECONDS` | Stops starting new work near the 6-minute execution limit (default 270). |

### 5. Share Calendar Access

Share the other calendar with the Google account that owns the Apps Script project. In Google Calendar, go to the other calendar's settings, find the "Share with" section, add the Apps Script account's email, and grant "Make changes to events" permission.

### 6. Initial Setup

Run `initialSetup` from the Apps Script code editor. This will prompt you to authorize the necessary calendar permissions.

After `initialSetup` has completed, run `runSync` to perform the initial sync. Afterwards, the sync will run automatically on a schedule.

## Cleaning up Duplicates

Earlier versions of this script could create duplicate copies of the same
source event, sometimes hundreds of them, and had no way to remove copies whose
source event had been deleted. The sync now reconciles both cases, but because
reconciliation deletes events it ships disabled.

1. Leave `RECONCILE_DRY_RUN: true` and run `runSync`.
2. Open **Executions** in the Apps Script editor and read the log. Every
   prospective deletion appears as a line like:

   ```
   [CalSync] DRY RUN - would delete copy id=abc123 title="Sync: Flexion Meeting" start=2026-10-13 (orphaned source 2k3cb...)
   ```

   The reason in parentheses is one of: `orphaned source <id>` (the source event
   no longer exists), `source cancelled/declined <id>`, or
   `legacy/duplicate copy of source <id>`.
3. If the list looks right, set `RECONCILE_DRY_RUN: false` and run `runSync`
   again.
4. Large backlogs are cleared gradually — `MAX_DELETES_PER_RUN` deletions per
   execution — so let the trigger run a few more times, or invoke `runSync`
   manually until the log stops reporting deletions.
