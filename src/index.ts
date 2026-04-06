import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import routes from "./routes/index.js";
import connectDB from "./db/mongodb.js";
import { ensureIndex } from "./ingestion/retriever.js";
const app = express();

app.use(cors({
  origin: "*", // Vite dev server default port
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());
app.use("/api", routes);

app.get("/", (_req, res) => {
  res.json({ service: "multi-tenant-ai-agent-backend", status: "running" });
});

// Connect to MongoDB before starting the server
connectDB()
  .then(() => ensureIndex())
  .then(() => {
    app.listen(env.PORT, () => {
      console.log(`Server listening on ${env.PORT}`);
    });
  })
  .catch((err) => {
    console.error("[Startup Error]", err);
    process.exit(1);
  });
