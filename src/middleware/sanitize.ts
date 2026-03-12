import type { Request, Response, NextFunction } from "express";

// Recursively sanitize all string values in an object
function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")  // strip script tags
      .replace(/<[^>]+>/g, "")                               // strip all HTML tags
      .replace(/javascript:/gi, "")                          // strip js: URIs
      .replace(/on\w+\s*=/gi, "")                            // strip event handlers
      .trim()
      .slice(0, 10000);                                       // cap at 10k chars
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value !== null && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      sanitized[k] = sanitizeValue(v);
    }
    return sanitized;
  }
  return value;
}

export function sanitizeInput(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === "object") {
    req.body = sanitizeValue(req.body);
  }
  next();
}
