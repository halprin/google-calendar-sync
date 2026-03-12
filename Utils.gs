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
 */
function safeExecute(fn, context) {
  try {
    fn();
  } catch (e) {
    logError('Failed: ' + (context || 'unknown'), e);
  }
}
