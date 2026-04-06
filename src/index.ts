import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import routes from "./routes/index.js";
import connectDB from "./db/mongodb.js";
import { ensureIndex } from "./ingestion/retriever.js";

const app = express();

// ─── Middleware ───────────────────────────────────────────────
app.set("trust proxy", 1);

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Routes ───────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ service: "multi-tenant-ai-agent-backend", status: "running" });
});

app.use("/api", routes);

// ─── Global Error Handler ─────────────────────────────────────
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[Error Handler]", err);

  if (err.name === "ValidationError") {
    return res.status(400).json({
      success: false,
      message: err.message,
      errors: err.errors,
    });
  }

  res.status(err.code || err.status || 500).json({
    success: false,
    message: err.message || "Something went wrong, try again later",
  });
});

// ─── Graceful Shutdown ────────────────────────────────────────
let server: ReturnType<typeof app.listen>;

const shutdown = async (signal: string) => {
  console.log(`\n[Shutdown] ${signal} received — shutting down gracefully...`);

  try {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          console.log("[Shutdown] HTTP server closed");
          resolve();
        });
      });
    }

    process.exit(0);
  } catch (err) {
    console.error("[Shutdown] Error during shutdown:", err);
    process.exit(1);
  }
};

const registerSignalHandlers = () => {
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("uncaughtException", async (err) => {
    console.error("[uncaughtException]", err);
    await shutdown("uncaughtException");
  });

  process.on("unhandledRejection", async (reason) => {
    console.error("[unhandledRejection]", reason);
    await shutdown("unhandledRejection");
  });
};

// ─── Start Server ─────────────────────────────────────────────
const startServer = async () => {
  try {
    await connectDB();
    await ensureIndex();

    server = app.listen(env.PORT, () => {
      console.log(`[Server] Listening on port ${env.PORT}`);
    });

    registerSignalHandlers();
  } catch (err) {
    console.error("[Startup Error]", err);
    process.exit(1);
  }
};

startServer();