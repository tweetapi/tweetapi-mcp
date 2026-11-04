// Local parsing for the identifier forms people paste into chat: numeric IDs, @handles, and
// canonical x.com / twitter.com links. Nothing here fetches a URL or resolves one identifier into
// another; a link is only accepted when its host and path say exactly which object it names.

export type IdentifierKind =
  | "tweet"
  | "tweetList"
  | "username"
  | "usernameList"
  | "list"
  | "community"
  | "space";

export type IdentifierSource = "id" | "username" | "handle" | "link";

export type ResolvedIdentifier = {
  value: string;
  source: IdentifierSource;
};

export class IdentifierInputError extends Error {
  constructor(
    public readonly field: string,
    message: string
  ) {
    super(message);
    this.name = "IdentifierInputError";
  }
}

const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);

// X object IDs are unsigned 64-bit integers, so at most 20 digits. Kept as strings throughout.
const NUMERIC_ID = /^\d{1,20}$/;
// Usernames on X are letters, digits, and underscores. Older accounts can exceed the current
// 15-character signup limit, so allow some headroom rather than rejecting a real handle.
const USERNAME = /^[A-Za-z0-9_]{1,50}$/;
const SPACE_ID = /^[A-Za-z0-9]{1,64}$/;
const MAX_INPUT_LENGTH = 512;

// First path segments that are X app routes, not usernames.
const RESERVED_PROFILE_SEGMENTS = new Set([
  "i",
  "home",
  "explore",
  "search",
  "notifications",
  "messages",
  "settings",
  "compose",
  "hashtag",
  "intent",
  "share",
  "login",
  "logout",
  "signup",
  "tos",
  "privacy",
  "jobs",
  "about",
  "account",
  "download",
  "lists",
  "communities",
  "spaces",
  "status",
]);

// Profile tabs that still name the same account, e.g. x.com/jack/media.
const PROFILE_TABS = new Set([
  "with_replies",
  "media",
  "likes",
  "highlights",
  "articles",
  "followers",
  "following",
  "verified_followers",
  "creator-subscriptions",
]);

// Trailing views of the same post, e.g. x.com/jack/status/20/photo/1.
const TWEET_SUFFIXES =
  /^(?:photo\/\d{1,2}|video\/\d{1,2}|analytics|quotes|retweets|likes|history)$/;

type ParsedLink = {
  segments: string[];
};

function looksLikeLink(value: string) {
  return value.includes("/") || value.includes(":") || value.includes(".");
}

function parseXLink(field: string, raw: string): ParsedLink {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;

  try {
    url = new URL(withScheme);
  } catch {
    throw new IdentifierInputError(field, `${field} is not a valid link.`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new IdentifierInputError(field, `${field} links must use http or https.`);
  }

  if (url.username || url.password || url.port) {
    throw new IdentifierInputError(field, `${field} links must not include credentials or a port.`);
  }

  if (!X_HOSTS.has(url.hostname.toLowerCase())) {
    throw new IdentifierInputError(
      field,
      `${field} only accepts x.com or twitter.com links. Other sites are not fetched or followed.`
    );
  }

  const segments = url.pathname.split("/").filter(Boolean);
  return { segments };
}

function lower(value: string | undefined) {
  return value?.toLowerCase();
}

function tweetIdFromSegments(segments: string[]): string | undefined {
  const [first, second, third, fourth, ...rest] = segments;
  let id: string | undefined;
  let suffix: string[] = [];

  // /<username>/status/<id> and the older /<username>/statuses/<id>
  if (
    first &&
    lower(first) !== "i" &&
    (lower(second) === "status" || lower(second) === "statuses") &&
    third
  ) {
    if (!USERNAME.test(first)) return undefined;
    id = third;
    suffix = [fourth, ...rest].filter((part): part is string => !!part);
  }
  // /i/status/<id> and /i/web/status/<id>
  else if (lower(first) === "i" && lower(second) === "status" && third) {
    id = third;
    suffix = [fourth, ...rest].filter((part): part is string => !!part);
  } else if (lower(first) === "i" && lower(second) === "web" && lower(third) === "status") {
    id = fourth;
    suffix = rest;
  }

  if (!id || !NUMERIC_ID.test(id)) return undefined;
  if (suffix.length > 0 && !TWEET_SUFFIXES.test(suffix.join("/"))) return undefined;
  return id;
}

function usernameFromSegments(segments: string[]): string | undefined {
  const [first, second, ...rest] = segments;
  if (!first || rest.length > 0) return undefined;
  if (RESERVED_PROFILE_SEGMENTS.has(first.toLowerCase())) return undefined;
  if (!USERNAME.test(first)) return undefined;
  if (second && !PROFILE_TABS.has(second.toLowerCase())) return undefined;
  return first;
}

function idFromAppSegments(segments: string[], route: string, pattern: RegExp) {
  const [first, second, third, ...rest] = segments;
  if (lower(first) !== "i" || lower(second) !== route || !third) return undefined;
  // Allow one trailing tab such as /members or /peek, but nothing deeper.
  if (rest.length > 1) return undefined;
  return pattern.test(third) ? third : undefined;
}

function describeLinkKind(segments: string[]): string {
  if (tweetIdFromSegments(segments)) return "a post link";
  if (usernameFromSegments(segments)) return "a profile link";
  if (idFromAppSegments(segments, "lists", NUMERIC_ID)) return "a list link";
  if (idFromAppSegments(segments, "communities", NUMERIC_ID)) return "a community link";
  if (idFromAppSegments(segments, "spaces", SPACE_ID)) return "a Space link";
  return "an unsupported x.com link";
}

function assertLength(field: string, value: string) {
  if (!value) {
    throw new IdentifierInputError(field, `${field} must not be empty.`);
  }

  if (value.length > MAX_INPUT_LENGTH) {
    throw new IdentifierInputError(
      field,
      `${field} must be at most ${MAX_INPUT_LENGTH} characters.`
    );
  }
}

export function parseTweetIdentifier(field: string, input: string): ResolvedIdentifier {
  const value = input.trim();
  assertLength(field, value);

  if (NUMERIC_ID.test(value)) {
    return { value, source: "id" };
  }

  if (!looksLikeLink(value)) {
    throw new IdentifierInputError(
      field,
      `${field} must be a numeric post ID or an x.com/twitter.com post link, such as https://x.com/user/status/1234567890.`
    );
  }

  const { segments } = parseXLink(field, value);
  const id = tweetIdFromSegments(segments);

  if (!id) {
    throw new IdentifierInputError(
      field,
      `${field} must be a post link like https://x.com/user/status/1234567890, but this is ${describeLinkKind(segments)}.`
    );
  }

  return { value: id, source: "link" };
}

export function parseUsernameIdentifier(field: string, input: string): ResolvedIdentifier {
  const value = input.trim();
  assertLength(field, value);

  if (!looksLikeLink(value)) {
    const handle = value.startsWith("@") ? value.slice(1) : value;

    if (!USERNAME.test(handle)) {
      throw new IdentifierInputError(
        field,
        `${field} must be a username such as jack or @jack (letters, digits, and underscores), or a profile link such as https://x.com/jack.`
      );
    }

    return { value: handle, source: value.startsWith("@") ? "handle" : "username" };
  }

  const { segments } = parseXLink(field, value);
  const username = usernameFromSegments(segments);

  if (!username) {
    throw new IdentifierInputError(
      field,
      `${field} must be a profile link like https://x.com/jack, but this is ${describeLinkKind(segments)}.`
    );
  }

  return { value: username, source: "link" };
}

function parseAppObjectIdentifier(
  field: string,
  input: string,
  route: "lists" | "communities" | "spaces",
  label: string,
  pattern: RegExp
): ResolvedIdentifier {
  const value = input.trim();
  assertLength(field, value);

  if (!looksLikeLink(value)) {
    if (!pattern.test(value)) {
      throw new IdentifierInputError(
        field,
        `${field} must be a ${label} ID or an x.com/i/${route}/... link.`
      );
    }

    return { value, source: "id" };
  }

  const { segments } = parseXLink(field, value);
  const id = idFromAppSegments(segments, route, pattern);

  if (!id) {
    throw new IdentifierInputError(
      field,
      `${field} must be a ${label} link like https://x.com/i/${route}/123, but this is ${describeLinkKind(segments)}.`
    );
  }

  return { value: id, source: "link" };
}

export function parseListIdentifier(field: string, input: string) {
  return parseAppObjectIdentifier(field, input, "lists", "list", NUMERIC_ID);
}

export function parseCommunityIdentifier(field: string, input: string) {
  return parseAppObjectIdentifier(field, input, "communities", "community", NUMERIC_ID);
}

export function parseSpaceIdentifier(field: string, input: string) {
  return parseAppObjectIdentifier(field, input, "spaces", "Space", SPACE_ID);
}

function splitListInput(field: string, input: unknown, max: number): string[] {
  const values =
    typeof input === "string"
      ? input.split(",")
      : Array.isArray(input) && input.every((item) => typeof item === "string")
        ? (input as string[])
        : undefined;

  if (!values) {
    throw new IdentifierInputError(
      field,
      `${field} must be a comma-separated string or an array of strings.`
    );
  }

  const trimmed = values.map((value) => value.trim()).filter(Boolean);

  if (trimmed.length === 0) {
    throw new IdentifierInputError(field, `${field} must contain at least one value.`);
  }

  if (trimmed.length > max) {
    throw new IdentifierInputError(field, `${field} accepts at most ${max} values per call.`);
  }

  return trimmed;
}

export function parseIdentifierList(
  field: string,
  input: unknown,
  max: number,
  parseOne: (field: string, value: string) => ResolvedIdentifier
): ResolvedIdentifier[] {
  return splitListInput(field, input, max).map((value, index) =>
    parseOne(`${field}[${index}]`, value)
  );
}
