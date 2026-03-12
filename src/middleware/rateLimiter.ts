import rateLimit from "express-rate-limit";

// General API limiter — all routes
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute
  max: 60,                   // 60 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, please slow down." },
});

// Strict limiter — chat endpoint only
export const chatLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minute
  max: 20,                   // 20 chat requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Chat rate limit exceeded. Please wait before sending more messages." },
});

// Auth limiter — credentials endpoint
export const credentialsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,                   // 10 attempts per 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many credential attempts. Try again later." },
});
