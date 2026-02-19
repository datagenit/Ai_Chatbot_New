import express from "express";
import { env } from "./config/env.js";
import routes from "./routes/index.js";

const app = express();

app.use(express.json());
app.use("/api", routes);

app.get("/", (_req, res) => {
  res.json({ service: "multi-tenant-ai-agent-backend", status: "running" });
});

app.listen(env.PORT, () => {
  console.log(`Server listening on http://localhost:${env.PORT}`);
});
