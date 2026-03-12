# google-calendar-sync

Sync Google calendar events.

## Setup

### 1. Create a New Google Apps Script Project

Go to [script.google.com](https://script.google.com) and create a new project.

### 2. Copy Files

Copy all of the `.gs` files from this repository into the project.

### 3. Configure

In `Config.gs`, set `PRIMARY_CALENDAR_ID` and `SECONDARY_CALENDAR_ID` to your actual Google Calendar IDs (generally they are your email addresses). Optionally, the other fields can be updated.

### 4. Initial Setup

Run `initialSetup` from the Apps Script code editor. This will prompt you to authorize the necessary calendar permissions.

After, `initialSetup` has completed, run `runSync` to perform the initial sync. Afterwards, the sync will run automatically on a schedule.
