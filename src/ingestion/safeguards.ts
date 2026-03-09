import UploadedFile from "../models/UploadedFile.js";

const MAX_CONTENT_LENGTH = 50_000;
const MIN_CONTENT_LENGTH = 200;
const SOURCE_LIMIT = 25;

const BLOCKED_TLDS = [".gov", ".gov.in", ".nic.in", ".mil", ".edu"];

const BLOCKED_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "youtube.com",
  "tiktok.com",
  "reddit.com",
];

const BLOCKED_EXTENSIONS = [
  ".pdf", ".zip", ".exe", ".docx", ".xlsx",
  ".csv", ".mp4", ".mp3", ".png", ".jpg", ".jpeg",
];

const BLOCKED_IP_PREFIXES = ["127.", "192.168.", "10.", "0."];

export function validateContentSize(text: string, source: string): string {
  if (text.length > MAX_CONTENT_LENGTH) {
    console.warn(`[safeguards] ${source} truncated to 50k chars`);
    return text.slice(0, MAX_CONTENT_LENGTH);
  }
  return text;
}

export function validateMinContent(text: string): boolean {
  return text.trim().length >= MIN_CONTENT_LENGTH;
}

export async function checkDuplicateSource(
  adminId: string,
  source: string
): Promise<boolean> {
  const existing = await UploadedFile.findOne({ adminId, filePath: source });
  return existing !== null;
}

export async function checkAdminSourceLimit(
  adminId: string,
  type: "text" | "url"
): Promise<boolean> {
  const count = await UploadedFile.countDocuments({
    adminId,
    filePath: type === "text" ? "text-input" : { $regex: "^http" },
  });
  return count >= SOURCE_LIMIT;
}

export function validateURL(url: string): { valid: boolean; reason?: string } {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { valid: false, reason: "URL must start with http:// or https://" };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: "URL is malformed and could not be parsed" };
  }

  const hostname = parsed.hostname.toLowerCase();

  for (const tld of BLOCKED_TLDS) {
    if (hostname.endsWith(tld)) {
      return { valid: false, reason: `URLs from ${tld} domains are not allowed` };
    }
  }

  for (const domain of BLOCKED_DOMAINS) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      return { valid: false, reason: `URLs from ${domain} are not allowed` };
    }
  }

  if (hostname === "localhost") {
    return { valid: false, reason: "localhost URLs are not allowed" };
  }

  for (const prefix of BLOCKED_IP_PREFIXES) {
    if (hostname.startsWith(prefix)) {
      return { valid: false, reason: `URLs resolving to private/loopback IPs are not allowed` };
    }
  }

  const pathname = parsed.pathname.toLowerCase();
  for (const ext of BLOCKED_EXTENSIONS) {
    if (pathname.endsWith(ext)) {
      return { valid: false, reason: `URLs pointing to ${ext} files are not allowed` };
    }
  }

  return { valid: true };
}
