import { performance } from "node:perf_hooks";

import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";

import anilist from "./anilist.ts";
import * as debug from "./debug.ts";
import getMe from "./get-me.ts";
import getStats from "./get-stats.ts";
import getStatus from "./get-status.ts";
import image from "./image.ts";
import search from "./search.ts";
import segmentsView from "./segments-view.ts";
import tasks from "./tasks.ts";
import create from "./user/create.ts";
import login from "./user/login.ts";
import resetKey from "./user/reset-key.ts";
import resetPassword from "./user/reset-password.ts";
import video from "./video.ts";
import github from "./webhook/github.ts";
import patreon from "./webhook/patreon.ts";

const app = express();

app.disable("x-powered-by");

app.set("trust proxy", ["loopback", "linklocal", "uniquelocal"]);

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, x-trace-secret");
  next();
});

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: true,
    ipv6Subnet: 64,
  }),
);

app.use((req, res, next) => {
  const startTime = performance.now();
  console.log("=>", new Date().toISOString(), req.ip, req.url);
  res.on("finish", () => {
    console.log(
      "<=",
      new Date().toISOString(),
      req.ip,
      req.url,
      res.statusCode,
      `${(performance.now() - startTime).toFixed(0)}ms`,
    );
  });
  next();
});

app.use(cors({ credentials: true, origin: true }));
app.use(
  express.raw({
    type: ["application/octet-stream", "application/x-www-form-urlencoded", "image/*", "video/*"],
    limit: 25 * 1024 * 1024,
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: false }));
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.get("/me", getMe);
app.get("/anilist", anilist);
app.get("/status", getStatus);
app.get("/stats", getStats);
app.all("/tasks", tasks);
app.all("/webhook/github", github);
app.all("/webhook/patreon", patreon);
app.all(
  "/search",
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  }).any(),
  search,
);
app.get("/video/:id", video);
app.get("/image/:id", image);

const userRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: true,
  ipv6Subnet: 64,
});

app.all("/user/login", userRateLimiter, login);
app.all("/user/create", userRateLimiter, create);
app.all("/user/reset-key", userRateLimiter, resetKey);
app.all("/user/reset-password", userRateLimiter, resetPassword);

// temporary, unauthenticated segment deduplication debugging surface
if (process.env.DEBUG_ENDPOINTS) {
  console.warn("DEBUG_ENDPOINTS is set, mounting unauthenticated /debug routes");
  app.get("/debug/dedup/:anilistId", debug.dedupDryRun);
  app.all("/debug/dedup/:anilistId/apply", debug.dedupApply);
  app.get("/debug/segments-view", segmentsView);
  app.get("/debug/segments", debug.listSegments);
  app.get("/debug/segments/:anilistId", debug.listSegments);
  app.get("/debug/segments/:anilistId/episodes", debug.listEpisodes);
  app.get("/debug/segments/:segmentFileId/matches", debug.segmentMatches);
  app.all("/debug/segments/:segmentFileId/prune", debug.segmentPrune);
  app.all("/debug/segments/:segmentFileId/revert", debug.segmentRevert);
  app.all("/debug/prune", debug.pruneAll);
  app.get("/debug/branding", debug.listBranding);
  app.all("/debug/branding/apply", debug.brandingApply);
  app.get("/debug/milvus/series/:anilistId", debug.milvusSeries);
  app.get("/debug/milvus/file/:fileId", debug.milvusFile);
}

app.all("/", async (req, res) => {
  res.send("ok");
});

export default app;
