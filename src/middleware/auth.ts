import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export interface AuthRequest extends Request {
  adminId?: string;
}

export function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  const forwarded = req.headers["x-forwarded-for"];
  const clientIp = (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0]?.trim()) ?? req.socket.remoteAddress;

  if (env.INTERNAL_SERVER_IP && clientIp === env.INTERNAL_SERVER_IP) {
    const adminId = req.body?.user?.parent_id?.toString();
    if (!adminId) {
      res.status(401).json({ error: "Internal request missing user.parent_id" });
      return;
    }
    req.adminId = adminId;
    next();
    return;
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid authorization header" });
    return;
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as any;
    const adminId = decoded?.parent_id?.toString();

    if (!adminId) {
      res.status(401).json({ error: "Invalid token: missing parent_id" });
      return;
    }

    req.adminId = adminId;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
