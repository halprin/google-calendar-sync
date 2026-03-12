# google-calendar-sync

Sync Google calendar events.

## Setup

### 1. Create a New Google Apps Script Project

Go to [script.google.com](https://script.google.com) and create a new project.

### 2. Copy Files

Copy all of the `.gs` files from this repository into the project.

### 3. Configure

In `Config.gs`, set `PRIMARY_CALENDAR_ID` and `SECONDARY_CALENDAR_ID` to your actual Google Calendar IDs (generally they are your email addresses). Optionally, the other fields can be updated.

### 4. Share Calendar Access

Share the other calendar with the Google account that owns the Apps Script project. In Google Calendar, go to the other calendar's settings, find the "Share with" section, add the Apps Script account's email, and grant "Make changes to events" permission.

### 5. Initial Setup

Run `initialSetup` from the Apps Script code editor. This will prompt you to authorize the necessary calendar permissions.

After, `initialSetup` has completed, run `runSync` to perform the initial sync. Afterwards, the sync will run automatically on a schedule.
