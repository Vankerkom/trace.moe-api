import fs from "node:fs/promises";

export default async (req, res) => {
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cross-Origin-Resource-Policy", "same-origin");
  res.set(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self'",
      "font-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "form-action 'self'",
      "media-src 'self'",
      "manifest-src 'self'",
      "worker-src 'self'",
      "block-all-mixed-content",
    ].join("; "),
  );
  res.setHeader("Content-Type", "text/html").send(await fs.readFile("./src/segments-view.html"));
};
