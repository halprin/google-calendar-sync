/**
 * Logs an info-level message with prefix.
 */
function logInfo(message) {
  Logger.log('[CalSync] ' + message);
}

/**
 * Logs an error-level message with prefix and optional error details.
 */
function logError(message, error) {
  var errorDetail = error ? ' | Error: ' + error.message + (error.stack ? '\n' + error.stack : '') : '';
  Logger.log('[CalSync ERROR] ' + message + errorDetail);
}

var cachedUserEmail_ = null;

/**
 * Returns the email of the authenticated user (cached after first call).
 */
function getAuthenticatedUserEmail() {
  if (!cachedUserEmail_) {
    cachedUserEmail_ = Session.getEffectiveUser().getEmail();
  }
  return cachedUserEmail_;
}

/**
 * Wraps a function call in a try/catch so one failure doesn't abort the entire run.
 * Returns true when fn() completed without throwing.
 */
function safeExecute(fn, context) {
  try {
    fn();
    return true;
  } catch (e) {
    logError('Failed: ' + (context || 'unknown'), e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Run budget
//
// Tracks wall-clock time and destructive-operation count for the current
// execution. Apps Script kills a script at 6 minutes with no chance to clean
// up, and the Calendar API will start returning rate-limit errors long before
// then on a large backlog. Both budgets are deliberately conservative: work
// that doesn't fit is simply picked up by the next scheduled run.
// ---------------------------------------------------------------------------

var runBudget_ = null;

/**
 * Resets the per-execution budget. Call once at the start of each entry point.
 */
function resetRunBudget() {
  runBudget_ = {
    startMillis: Date.now(),
    deletes: 0,
    deleteBudgetWarned: false,
    timeBudgetWarned: false
  };
}

function getRunBudget_() {
  if (!runBudget_) {
    resetRunBudget();
  }
  return runBudget_;
}

/**
 * Returns elapsed seconds since the budget was reset.
 */
function elapsedSeconds() {
  return (Date.now() - getRunBudget_().startMillis) / 1000;
}

/**
 * True when the execution is close enough to the Apps Script time limit that
 * no new work should be started.
 */
function isOutOfTime() {
  var budget = getRunBudget_();
  var out = elapsedSeconds() >= CONFIG.MAX_RUNTIME_SECONDS;
  if (out && !budget.timeBudgetWarned) {
    budget.timeBudgetWarned = true;
    logInfo('Runtime budget of ' + CONFIG.MAX_RUNTIME_SECONDS +
      's reached - deferring remaining work to the next run');
  }
  return out;
}

/**
 * True when this execution has already used its deletion allowance.
 */
function isDeleteBudgetExhausted() {
  var budget = getRunBudget_();
  var exhausted = budget.deletes >= CONFIG.MAX_DELETES_PER_RUN;
  if (exhausted && !budget.deleteBudgetWarned) {
    budget.deleteBudgetWarned = true;
    logInfo('Delete budget of ' + CONFIG.MAX_DELETES_PER_RUN +
      ' reached - deferring remaining deletions to the next run');
  }
  return exhausted;
}

function recordDelete_() {
  getRunBudget_().deletes++;
}

function getDeleteCount() {
  return getRunBudget_().deletes;
}

// ---------------------------------------------------------------------------
// API call retry
// ---------------------------------------------------------------------------

/**
 * Returns true if the error looks like a transient/rate-limit failure that is
 * worth retrying rather than logging and skipping.
 */
function isRetryableError_(error) {
  var message = (error && error.message) ? error.message.toLowerCase() : '';
  return message.indexOf('rate limit') !== -1 ||
    message.indexOf('ratelimit') !== -1 ||
    message.indexOf('quota') !== -1 ||
    message.indexOf('backend error') !== -1 ||
    message.indexOf('internal error') !== -1 ||
    message.indexOf('try again') !== -1 ||
    message.indexOf('timed out') !== -1 ||
    message.indexOf('503') !== -1 ||
    message.indexOf('500') !== -1 ||
    message.indexOf('429') !== -1;
}

/**
 * Invokes fn() with exponential backoff on transient Calendar API errors.
 * Non-retryable errors are rethrown immediately so callers can handle them.
 */
function withRetry(fn, context) {
  var maxAttempts = 4;
  var delayMillis = 500;

  for (var attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt >= maxAttempts || !isRetryableError_(e)) {
        throw e;
      }
      logInfo('Transient failure on ' + (context || 'API call') +
        ' (attempt ' + attempt + '/' + maxAttempts + '), retrying in ' + delayMillis + 'ms');
      Utilities.sleep(delayMillis);
      delayMillis *= 2;
    }
  }
}
