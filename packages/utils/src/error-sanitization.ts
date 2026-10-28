/**
 * Error Sanitization Utilities
 *
 * Provides functions to sanitize error messages before showing them to users.
 * This prevents exposing internal database errors, stack traces, and other
 * technical details that could confuse users or leak implementation details.
 */

/**
 * Sanitize error messages to show user-friendly text instead of raw DB errors.
 * This prevents exposing internal database errors to users.
 */
export function sanitizeErrorMessage(error: string): string {
  // First check for "Row X:" prefix - preserve row info but sanitize inner message
  const rowMatch = error.match(/^Row (\d+): (.+)$/);
  if (rowMatch) {
    // Groups 1 (\d+) and 2 (.+) are always present when the match succeeds;
    // the non-null assertions satisfy the package tsconfig's
    // noUncheckedIndexedAccess without changing behaviour.
    const rowNum = rowMatch[1]!;
    const message = rowMatch[2]!;
    const cleanedMessage = sanitizeErrorMessage(message);
    return `Row ${rowNum}: ${cleanedMessage}`;
  }

  // Database connectivity / server selection errors
  if (
    error.includes("Server selection timeout") ||
    error.includes("No available servers") ||
    error.includes("ReplicaSetNoPrimary") ||
    error.includes("I/O error: timed out") ||
    error.includes("MongoServerSelectionError")
  ) {
    return "Service temporarily unavailable - please try again in a moment";
  }

  // Common database/Prisma error patterns
  if (error.includes("Unique constraint failed")) {
    if (error.includes("brokerTradeId")) {
      return "This trade already exists (duplicate trade ID)";
    }
    return "This trade already exists in your account";
  }

  if (
    error.includes("Transaction API error") ||
    error.includes("has been aborted")
  ) {
    return "Import temporarily failed - please try again";
  }

  if (error.includes("Connection") || error.includes("ECONNREFUSED")) {
    return "Connection error - please try again";
  }

  if (error.includes("timeout") || error.includes("ETIMEDOUT")) {
    return "Request timed out - please try again";
  }

  // GCP Pub/Sub / Cloud errors (resource not found, permission denied, etc.)
  if (
    error.includes("NOT_FOUND: Resource not found") ||
    error.includes("PERMISSION_DENIED") ||
    error.includes("Could not publish message") ||
    error.includes("UNAVAILABLE") ||
    error.includes("DEADLINE_EXCEEDED")
  ) {
    return "Service temporarily unavailable - please try again later";
  }

  // GCP Storage errors
  if (
    error.includes("Failed to generate signed URL") ||
    error.includes("Failed to generate upload URL") ||
    error.includes("Failed to initialize GCP Storage") ||
    error.includes("No such object") ||
    error.includes("storage.objects") ||
    error.includes("bucket")
  ) {
    return "Storage service error - please try again";
  }

  // MongoDB duplicate key (E11000)
  if (error.includes("E11000") || error.includes("duplicate key")) {
    return "This record already exists";
  }

  // GCP quota / rate limit errors
  if (
    error.includes("RESOURCE_EXHAUSTED") ||
    error.includes("Quota exceeded") ||
    error.includes("rateLimitExceeded")
  ) {
    return "Service is busy - please try again in a moment";
  }

  // Generic cleanup - remove technical details
  if (
    error.includes("prisma") ||
    error.includes("Invalid `prisma") ||
    error.includes("Raw query failed") ||
    // Prisma error *class names* carry a capital "P" and don't contain the
    // lowercase "prisma" substring above (e.g. "PrismaClientKnownRequestError:
    // ..."), so match them explicitly or they leak through verbatim.
    error.includes("Prisma") ||
    // Raw Prisma error codes (P1xxx connection, P2xxx query) must never reach
    // the user — they're internal identifiers, not user-facing copy.
    /\bP[12]\d{3}\b/.test(error)
  ) {
    return "Something went wrong - please try again";
  }

  // ---------------------------------------------------------------------------
  // SECURITY: secret / internal-detail redaction (MONEY-620).
  //
  // The patterns above map *known* service errors to friendly copy. Anything
  // that falls through to the passthrough below is returned verbatim — which
  // is fine for benign messages ("Invalid date format") but a real credential
  // / infrastructure leak for the classes below. These checks sit just before
  // the passthrough so they only fire when nothing friendlier matched, and
  // each is narrow enough not to swallow ordinary user-facing text.
  // ---------------------------------------------------------------------------

  // Connection strings with embedded credentials
  // (mongodb://, mongodb+srv://, redis://, rediss://, postgres://,
  // postgresql://, mysql://, amqp://). Leaks DB host AND password.
  if (
    /\b(?:mongodb(?:\+srv)?|rediss?|postgres(?:ql)?|mysql|amqps?):\/\//i.test(
      error,
    )
  ) {
    return "Service temporarily unavailable - please try again";
  }

  // API keys / bearer tokens / JWTs / secret env values. Covers Stripe-style
  // sk_/pk_/rk_ keys, Google AIza… keys, "Bearer <jwt>", and a JWT's
  // three-segment base64url shape, plus *_KEY / *_SECRET / *_TOKEN /
  // *_PASSWORD env assignments.
  if (
    /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]+/.test(error) ||
    /\bAIza[0-9A-Za-z\-_]{10,}/.test(error) ||
    /\bBearer\s+[A-Za-z0-9._\-]+/i.test(error) ||
    /\beyJ[A-Za-z0-9._\-]+\.[A-Za-z0-9._\-]+\.[A-Za-z0-9._\-]+/.test(error) ||
    /\b[A-Z0-9_]*(?:SECRET|TOKEN|API[_-]?KEY|PASSWORD)\s*[=:]\s*\S+/.test(
      error,
    ) ||
    /\bpassword\s+['"]?\S+['"]?/i.test(error)
  ) {
    return "Something went wrong - please try again";
  }

  // DNS / socket resolution failures expose internal hostnames + topology.
  if (
    error.includes("getaddrinfo") ||
    error.includes("ENOTFOUND") ||
    error.includes("EAI_AGAIN") ||
    error.includes("ECONNRESET") ||
    error.includes("EHOSTUNREACH") ||
    error.includes("ENETUNREACH")
  ) {
    return "Connection error - please try again";
  }

  // Stack traces / absolute filesystem paths leak server internals. The path
  // can be delimited by start-of-string, whitespace, or an opening quote /
  // paren (e.g. `open '/home/...'` or `at (/var/...)`).
  if (
    /\n\s+at\s+/.test(error) ||
    /(?:^|[\s'"(])\/(?:Users|home|var|opt|app|srv|root|tmp)\//.test(error) ||
    /\.env(?:\.[A-Za-z]+)?\b/.test(error)
  ) {
    return "Something went wrong - please try again";
  }

  // Residual MongoDB driver errors not caught by the connectivity bucket
  // above (the bucket only handles server-selection / replica-set timeouts).
  if (/\bMongo[A-Za-z]*Error\b/.test(error)) {
    return "Service temporarily unavailable - please try again";
  }

  // Return the original if no patterns match (but truncate if too long)
  if (error.length > 100) {
    return error.substring(0, 100) + "...";
  }

  return error;
}

/**
 * Sanitize an array of error messages
 */
export function sanitizeErrors(errors: string[]): string[] {
  return errors.map(sanitizeErrorMessage);
}

/**
 * Extract and sanitize the message from an unknown error.
 * Use this in catch blocks of server actions to prevent raw
 * Prisma / DB errors from reaching the UI.
 */
export function getSafeErrorMessage(
  error: unknown,
  fallback = "Something went wrong - please try again",
): string {
  if (error instanceof Error) {
    return sanitizeErrorMessage(error.message);
  }
  return fallback;
}
